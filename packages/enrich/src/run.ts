import {
  type Answer,
  type Claim,
  Claims,
  EsperError,
  type Question,
  type QuestionKind,
  questionText,
  type SnapshotView,
  type Store,
  type Tier,
} from '@esper/core'
import {
  type BoundedCall,
  LimitReached,
  type Model,
  noUsage,
  type Provider,
  type Read,
  type Usage,
} from './provider.ts'

// An enrichment run (D17): the questions due on a snapshot in one tier, asked through a provider,
// each answer checked and stored as a claim. A bounded question answered `insufficient-context`
// becomes due in the exploring tier. Esper hands the questions out itself: no model orchestrates
// another.

// The models each tier runs on (D17, D31): Sonnet 5.5 at medium effort answered the measured guard
// questions as well as Opus 5.5 at low effort, with as many tokens, at half the price.
export const defaultModels: Record<Tier, Model> = {
  bounded: { id: 'claude-sonnet-5-5', effort: 'medium' },
  exploring: { id: 'claude-opus-5-5', effort: 'medium', turns: 20 },
}

export interface EnrichOptions {
  tier: Tier
  model?: Model
  kinds?: QuestionKind[]
  // How many questions to ask, at most.
  limit: number
  // How many questions one bounded call carries.
  batch?: number
  // Lists the questions without asking them.
  dryRun?: boolean
  // Only these questions, by id: a measured set.
  only?: string[]
  author?: string
  progress?: (message: string) => void
}

export interface EnrichReport {
  snapshot: number
  tier: Tier
  provider: string
  model: string
  due: number
  asked: Question[]
  calls: number
  claims: Claim[]
  accepted: number
  rejected: { question: string; rejection: string }[]
  insufficient: number
  // Questions no valid answer came back for.
  unanswered: { question: string; why: string }[]
  // Why the run stopped early: the plan's limit.
  stopped?: string
  // What its calls used, when the provider reports it.
  usage?: Usage
}

export async function enrich(
  view: SnapshotView,
  store: Store,
  provider: Provider,
  options: EnrichOptions,
): Promise<EnrichReport> {
  const before = provider.usage ? { ...provider.usage } : undefined
  const report = await ask(view, store, provider, options)
  if (before && provider.usage) {
    const after = provider.usage
    const used = noUsage()
    for (const key of Object.keys(used) as (keyof Usage)[]) used[key] = after[key] - before[key]
    report.usage = used
  }
  return report
}

async function ask(
  view: SnapshotView,
  store: Store,
  provider: Provider,
  options: EnrichOptions,
): Promise<EnrichReport> {
  const claims = new Claims(store)
  const model = options.model ?? defaultModels[options.tier]
  let due = claims.due(view, options.tier)
  if (options.kinds) due = due.filter((q) => options.kinds?.includes(q.kind))
  if (options.only) due = due.filter((q) => options.only?.includes(q.id))
  const asked = due.slice(0, options.limit)
  const report: EnrichReport = {
    snapshot: view.info.id,
    tier: options.tier,
    provider: provider.name,
    model: model.id,
    due: due.length,
    asked,
    calls: 0,
    claims: [],
    accepted: 0,
    rejected: [],
    insufficient: 0,
    unanswered: [],
  }
  if (options.dryRun || asked.length === 0) return report
  const byId = new Map(asked.map((q) => [q.id, q]))
  const author = options.author ?? `esper enrich (${provider.name})`
  const take = (answers: Answer[], questions: string[], reads: Read[] = []) => {
    const got = new Set<string>()
    for (const answer of answers) {
      const question = byId.get(answer.question)
      // An answer to a question the call did not carry, or a second one, is not taken.
      if (!question || !questions.includes(question.id) || got.has(question.id)) continue
      got.add(question.id)
      const claim = claims.add({
        question,
        answer,
        tier: options.tier,
        model: model.id,
        provider: provider.name,
        snapshot: view.info.id,
        author,
        reads: reads.flatMap((r) => targets(view, r)),
      })
      report.claims.push(claim)
      if (claim.status === 'accepted') report.accepted++
      else if (claim.status === 'insufficient') report.insufficient++
      else report.rejected.push({ question: question.id, rejection: claim.rejection ?? '' })
    }
    for (const id of questions) {
      if (!got.has(id)) report.unanswered.push({ question: id, why: 'no answer to it came back' })
    }
  }
  const text = (q: Question) => questionText(view, store, q)
  if (options.tier === 'bounded') {
    const size = options.batch ?? 10
    const calls: BoundedCall[] = []
    for (let i = 0; i < asked.length; i += size) {
      const part = asked.slice(i, i + size)
      calls.push({ questions: part.map((q) => q.id), prompt: part.map(text).join('\n\n') })
    }
    options.progress?.(`${asked.length} questions in ${calls.length} calls to ${model.id}`)
    report.calls = calls.length
    const results = await provider.bounded(calls, model)
    results.forEach((result, i) => {
      const call = calls[i] as BoundedCall
      if (result instanceof LimitReached) {
        report.stopped ??= result.message
        for (const id of call.questions)
          report.unanswered.push({ question: id, why: 'not asked: the limit was reached' })
      } else if (result instanceof Error) {
        for (const id of call.questions)
          report.unanswered.push({ question: id, why: result.message })
      } else take(result, call.questions)
    })
    return report
  }
  for (const question of asked) {
    if (report.stopped) {
      report.unanswered.push({ question: question.id, why: 'not asked: the limit was reached' })
      continue
    }
    options.progress?.(`exploring ${question.id} with ${model.id}`)
    report.calls++
    try {
      const { answers, reads } = await provider.explore(
        { questions: [question.id], prompt: text(question) },
        model,
      )
      take(answers, [question.id], reads)
    } catch (error) {
      if (error instanceof LimitReached) {
        report.stopped = error.message
        report.unanswered.push({ question: question.id, why: 'not asked: the limit was reached' })
      } else if (error instanceof EsperError || error instanceof Error) {
        report.unanswered.push({ question: question.id, why: error.message })
      } else throw error
    }
  }
  return report
}

// The nodes a tool call read, by reference: the node it named, the ends of a path, or the file of
// a range of lines.
function targets(view: SnapshotView, read: Read): { tool: string; target: string }[] {
  const out: { tool: string; target: string }[] = []
  for (const key of ['node', 'from', 'to', 'file']) {
    const value = read.input[key]
    if (typeof value !== 'string') continue
    try {
      out.push({ tool: read.tool, target: view.resolve(value).ref })
    } catch {
      // A name the snapshot does not hold was read, and refused: the claim does not rest on it.
    }
  }
  return out
}
