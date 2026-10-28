import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { explorerInstructions, instructions } from '@esper/core'
import {
  type BoundedCall,
  LimitReached,
  type Model,
  noUsage,
  type Provider,
  parallel,
  parseAnswers,
  type Read,
  schema,
  type Usage,
} from './provider.ts'

// The `claude-code` provider (D17, D31): the auditor's own Claude Code, signed in on this machine,
// run headless with `claude -p`. Esper never sees a credential. Every run starts in a folder of
// Esper's home, never in the audited repository, whose hooks and MCP servers a run would load.
//
// - A bounded run has no tool and no MCP server, and starts with `--safe-mode`, without the
//   auditor's hooks, plugins, skills and CLAUDE.md.
// - An exploring run has only Esper's read-only server for the project, by `--mcp-config`, which
//   `--safe-mode` would drop (measured with Claude Code 2.1.312): it starts with
//   `--setting-sources ""` instead, which loads none of the auditor's settings, and so none of
//   their hooks or plugins, and still honours `--mcp-config`.

// Runs `claude` with arguments and a prompt on stdin, in a folder: a test stands in for it.
export type ClaudeRunner = (
  args: string[],
  input: string,
  cwd: string,
) => Promise<{ code: number | null; stdout: string; stderr: string }>

export const claudeRunner: ClaudeRunner = (args, input, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk
    })
    child.on('error', (error) =>
      reject(
        (error as { code?: string }).code === 'ENOENT'
          ? new LimitReached(
              'claude is not installed, or not on the PATH: the claude-code provider runs it',
            )
          : error,
      ),
    )
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })

// The read-only tools an exploring run may call, and nothing else (D17).
export const exploringTools = [
  'esper_search',
  'esper_node',
  'esper_callers',
  'esper_callees',
  'esper_paths',
  'esper_read',
]

export function boundedArgs(model: Model): string[] {
  return [
    '-p',
    '--safe-mode',
    '--tools',
    '',
    '--strict-mcp-config',
    '--model',
    model.id,
    '--effort',
    model.effort,
    '--max-turns',
    '1',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--system-prompt',
    instructions,
  ]
}

export function exploringArgs(model: Model, mcpConfig: string): string[] {
  return [
    '-p',
    '--setting-sources',
    '',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--allowedTools',
    exploringTools.map((t) => `mcp__esper__${t}`).join(','),
    '--permission-mode',
    'dontAsk',
    '--model',
    model.id,
    '--effort',
    model.effort,
    '--max-turns',
    String(model.turns ?? 20),
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--system-prompt',
    explorerInstructions,
  ]
}

// What a run printed, as answers, or why it gave none. A run stopped by the plan's limit stops the
// whole enrichment.
function answersOf(run: { code: number | null; stdout: string; stderr: string }, usage?: Usage) {
  let result: Record<string, unknown> | undefined
  try {
    result = JSON.parse(run.stdout) as Record<string, unknown>
  } catch {
    result = undefined
  }
  // Every run counts, a failed one too: it used the plan.
  if (result && usage) {
    const u = (result.usage ?? {}) as Record<string, unknown>
    const n = (key: string) => (typeof u[key] === 'number' ? (u[key] as number) : 0)
    usage.calls++
    usage.inputTokens += n('input_tokens')
    usage.outputTokens += n('output_tokens')
    usage.cacheReadTokens += n('cache_read_input_tokens')
    usage.cacheWriteTokens += n('cache_creation_input_tokens')
    usage.costUsd += typeof result.total_cost_usd === 'number' ? result.total_cost_usd : 0
  }
  // A run that answered is never a limit, whatever its answer says: only a failed run's message
  // is read for one (an answer about a rate limiter mentions a rate limit).
  const answered =
    result !== undefined && !result.is_error && result.structured_output !== undefined
  const said = `${String(result?.result ?? '')} ${run.stderr}`
  if (
    !answered &&
    (result?.api_error_status === 429 ||
      /usage limit|limit reached|rate limit|out of (extra )?usage/i.test(said))
  ) {
    throw new LimitReached(`the plan's limit is reached: ${said.trim().slice(0, 200)}`)
  }
  if (!result) throw new Error(`claude exited with ${run.code}: ${run.stderr.trim().slice(0, 200)}`)
  if (result.is_error)
    throw new Error(
      `claude answered with an error: ${String(result.result ?? result.subtype).slice(0, 200)}`,
    )
  if (result.structured_output === undefined) throw new Error('claude gave no structured answer')
  return parseAnswers(result.structured_output)
}

export class ClaudeCode implements Provider {
  readonly name = 'claude-code'
  readonly usage: Usage = noUsage()
  private readonly folder: string
  private readonly run: ClaudeRunner
  private readonly width: number
  // How an exploring run reaches Esper: the command that runs `esper`, and its home.
  private readonly esper: { command: string; args: string[]; home: string; project: string }

  constructor(options: {
    // The folder of Esper's home the runs start in.
    folder: string
    esper: { command: string; args: string[]; home: string; project: string }
    run?: ClaudeRunner
    parallel?: number
  }) {
    this.folder = options.folder
    this.esper = options.esper
    this.run = options.run ?? claudeRunner
    this.width = options.parallel ?? 3
  }

  async bounded(calls: BoundedCall[], model: Model) {
    await mkdir(this.folder, { recursive: true })
    const args = boundedArgs(model)
    const { results, stopped } = await parallel(calls, this.width, async (call) => {
      // A run without valid output is retried once, then its questions are left unanswered.
      let last: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return answersOf(await this.run(args, call.prompt, this.folder), this.usage)
        } catch (error) {
          if (error instanceof LimitReached) throw error
          last = error
        }
      }
      return last instanceof Error ? last : new Error(String(last))
    })
    return results.map((r) => r ?? stopped ?? new Error('not run'))
  }

  async explore(
    call: BoundedCall,
    model: Model,
  ): Promise<{ answers: ReturnType<typeof parseAnswers>; reads: Read[] }> {
    await mkdir(this.folder, { recursive: true })
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const trace = join(this.folder, `trace-${stamp}.jsonl`)
    const config = join(this.folder, `esper-readonly-${stamp}.json`)
    // One server, Esper's, read-only and scoped to the project, over stdio: no token, no other
    // project. Its tool calls are traced, for the claim's reads.
    await writeFile(
      config,
      JSON.stringify({
        mcpServers: {
          esper: {
            command: this.esper.command,
            args: [...this.esper.args, 'mcp', this.esper.project, '--read-only', '--trace', trace],
            env: { ESPER_HOME: this.esper.home },
          },
        },
      }),
    )
    try {
      const answers = answersOf(
        await this.run(exploringArgs(model, config), call.prompt, this.folder),
        this.usage,
      )
      const reads = (await readFile(trace, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Read)
      return { answers, reads }
    } finally {
      await rm(config, { force: true })
      await rm(trace, { force: true })
    }
  }
}
