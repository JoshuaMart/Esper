import Anthropic from '@anthropic-ai/sdk'
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { explorerInstructions, instructions } from '@esper/core'
import { type Connection, tools } from '@esper/mcp'
import { z } from 'zod'
import { exploringTools } from './claude-code.ts'
import {
  type BoundedCall,
  LimitReached,
  type Model,
  type Provider,
  parseAnswers,
  type Read,
  schema,
} from './provider.ts'

// The `anthropic-api` provider (D17, D31): an API key, unattended, through the official SDK.
// Bounded questions go through the Message Batches API, at half price, with the instructions every
// question shares cached; exploring questions run through the SDK's tool runner, with Esper's
// read-only tools called in this process, on the project's own connection.

export class AnthropicApi implements Provider {
  readonly name = 'anthropic-api'
  private readonly client: Anthropic
  private readonly connection: Connection
  // How often a batch is asked whether it has ended.
  private readonly poll: number

  constructor(options: {
    connection: Connection
    // A test passes its own fetch; the key comes from ANTHROPIC_API_KEY otherwise.
    client?: ConstructorParameters<typeof Anthropic>[0]
    poll?: number
  }) {
    this.client = new Anthropic(options.client)
    this.connection = options.connection
    this.poll = options.poll ?? 30_000
  }

  private params(call: BoundedCall, model: Model) {
    return {
      model: model.id,
      max_tokens: 16_000,
      // The instructions are the same for every question, and cached.
      system: [
        {
          type: 'text' as const,
          text: instructions,
          cache_control: { type: 'ephemeral' as const },
        },
      ],
      messages: [{ role: 'user' as const, content: call.prompt }],
      output_config: {
        effort: model.effort,
        format: {
          type: 'json_schema' as const,
          schema: schema as unknown as Record<string, unknown>,
        },
      },
    }
  }

  async bounded(
    calls: BoundedCall[],
    model: Model,
  ): Promise<(ReturnType<typeof parseAnswers> | Error)[]> {
    if (calls.length === 0) return []
    let batch: Awaited<ReturnType<Anthropic['messages']['batches']['create']>>
    try {
      batch = await this.client.messages.batches.create({
        requests: calls.map((call, i) => ({
          custom_id: `call-${i}`,
          params: this.params(call, model),
        })),
      })
      while (batch.processing_status !== 'ended') {
        await new Promise((resolve) => setTimeout(resolve, this.poll))
        batch = await this.client.messages.batches.retrieve(batch.id)
      }
    } catch (error) {
      throw stopping(error)
    }
    const out: (ReturnType<typeof parseAnswers> | Error)[] = calls.map(() => new Error('no result'))
    // Results come in any order: each is placed by its id.
    for await (const result of await this.client.messages.batches.results(batch.id)) {
      const i = Number(result.custom_id.replace('call-', ''))
      if (result.result.type !== 'succeeded') {
        out[i] = new Error(`the batch request ${result.result.type}`)
        continue
      }
      const text = result.result.message.content.find((b) => b.type === 'text')
      try {
        out[i] = parseAnswers(JSON.parse(text && 'text' in text ? text.text : ''))
      } catch (error) {
        out[i] = error as Error
      }
    }
    return out
  }

  async explore(
    call: BoundedCall,
    model: Model,
  ): Promise<{ answers: ReturnType<typeof parseAnswers>; reads: Read[] }> {
    const reads: Read[] = []
    // Esper's read-only tools, called in this process on the project's connection: the agent has
    // no shell, no network, and no file outside the snapshot.
    const runnable = tools
      .filter((t) => exploringTools.includes(t.name))
      .map((tool) =>
        betaTool({
          name: tool.name,
          description: tool.description,
          inputSchema: z.toJSONSchema(tool.input, { io: 'input' }) as { type: 'object' },
          run: async (input) => {
            reads.push({ tool: tool.name, input: input as Record<string, unknown> })
            const parsed = tool.input.safeParse(input)
            if (!parsed.success)
              return `refused: ${parsed.error.issues.map((i) => i.message).join('; ')}`
            try {
              return JSON.stringify(await tool.run(this.connection, parsed.data as never))
            } catch (error) {
              return `refused: ${(error as Error).message}`
            }
          },
        }),
      )
    let message: Awaited<ReturnType<Anthropic['beta']['messages']['toolRunner']>>
    try {
      message = await this.client.beta.messages.toolRunner({
        model: model.id,
        max_tokens: 16_000,
        max_iterations: model.turns ?? 20,
        system: [
          { type: 'text', text: explorerInstructions, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: call.prompt }],
        tools: runnable,
        output_config: {
          effort: model.effort,
          format: { type: 'json_schema', schema: schema as unknown as Record<string, unknown> },
        },
      })
    } catch (error) {
      throw stopping(error)
    }
    const text = message.content.find((b) => b.type === 'text')
    return { answers: parseAnswers(JSON.parse(text && 'text' in text ? text.text : '')), reads }
  }
}

// A rate limit or an exhausted credit stops the run; anything else is the error it is.
function stopping(error: unknown): unknown {
  if (error instanceof Anthropic.RateLimitError)
    return new LimitReached(`the API's rate limit is reached: ${error.message}`)
  if (
    error instanceof Anthropic.PermissionDeniedError ||
    error instanceof Anthropic.AuthenticationError
  ) {
    return new LimitReached(`the API refused the key: ${error.message}`)
  }
  return error
}
