import { type Answer, answerSchema, EsperError } from '@esper/core'

// A provider answers enrichment questions with a model (D17): bounded calls with no tools, and
// exploring runs that read the snapshot through Esper's read-only tools. Nothing else in Esper
// knows which one answered, beyond the model recorded on each claim.

export interface Model {
  // The model's identifier, as the provider takes it: `claude-opus-5-5`.
  id: string
  effort: 'low' | 'medium' | 'high'
  // An exploring run's cap on turns.
  turns?: number
}

// One bounded call: the questions it carries, by id, and its prompt.
export interface BoundedCall {
  questions: string[]
  prompt: string
}

// What an exploring run read, for its claim: the tool, and the node or file it named.
export interface Read {
  tool: string
  input: Record<string, unknown>
}

// What the calls of a provider used, as it reports it: tokens, and the cost at list prices, which
// on a plan is what its limits are measured against.
export interface Usage {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

export const noUsage = (): Usage => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
})

export interface Provider {
  readonly name: string
  // What its calls have used so far, when it reports it.
  readonly usage?: Usage
  // Answers each call; a call that fails twice answers nothing. `LimitReached` stops the run.
  bounded(calls: BoundedCall[], model: Model): Promise<(Answer[] | Error)[]>
  // Answers one question with an agent confined to Esper's read-only tools of the project.
  explore(call: BoundedCall, model: Model): Promise<{ answers: Answer[]; reads: Read[] }>
}

// The plan's limit, or the API's, is reached: the run stops rather than retrying in a loop.
export class LimitReached extends EsperError {}

export const schema = answerSchema

// What a provider got back, as answers: the JSON the schema asked for, or why not.
export function parseAnswers(value: unknown): Answer[] {
  const answers = (value as { answers?: unknown } | null)?.answers
  if (!Array.isArray(answers)) throw new Error('the answer holds no list of answers')
  return answers.map((a) => {
    const x = a as Record<string, unknown>
    if (typeof x.question !== 'string' || typeof x.value !== 'string') {
      throw new Error('an answer lacks its question or its value')
    }
    const citations = Array.isArray(x.citations) ? x.citations : []
    return {
      question: x.question,
      value: x.value,
      kind: typeof x.kind === 'string' ? x.kind : null,
      text: typeof x.text === 'string' ? x.text : null,
      reason: typeof x.reason === 'string' ? x.reason : null,
      citations: citations.map((c) => {
        const y = c as Record<string, unknown>
        return {
          file: String(y.file ?? ''),
          line: Number(y.line),
          identifier: String(y.identifier ?? ''),
        }
      }),
    }
  })
}

// Runs `work` on each item, a few at once, and stops starting new ones at the first
// `LimitReached`, which it returns with what was done before it.
export async function parallel<T, R>(
  items: T[],
  width: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<{ results: (R | undefined)[]; stopped?: LimitReached }> {
  const results: (R | undefined)[] = Array.from({ length: items.length }, () => undefined)
  let next = 0
  let stop: LimitReached | undefined
  const lane = async () => {
    while (stop === undefined && next < items.length) {
      const i = next++
      try {
        results[i] = await work(items[i] as T, i)
      } catch (error) {
        if (error instanceof LimitReached) stop ??= error
        else throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, lane))
  return stop === undefined ? { results } : { results, stopped: stop as LimitReached }
}
