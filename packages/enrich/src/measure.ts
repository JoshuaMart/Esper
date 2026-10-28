import type { Claim } from '@esper/core'

// How a model's guard claims score against answers given by hand (D17): the measure that picks
// the bounded tier's model. Taking a non-guard for a guard hides an unprotected route, the worst
// mistake the layer can make, so false guards are counted apart.

export type Outcome =
  | 'right'
  | 'wrong-kind'
  | 'false-guard'
  | 'missed-guard'
  | 'insufficient'
  | 'rejected'
  | 'unanswered'

export interface Score {
  questions: number
  outcomes: Record<Outcome, number>
  // Right answers, over the questions asked.
  accuracy: number
  // Questions that would move to the exploring tier.
  exploring: number
  each: { question: string; expected: string; got: string; outcome: Outcome }[]
}

// `expected` maps each question to `no` or the guard kind; a claim's answer is the last one made
// for its question.
export function scoreGuards(expected: Record<string, string>, claims: Claim[]): Score {
  const last = new Map<string, Claim>()
  for (const c of claims) last.set(c.question, c)
  const outcomes: Record<Outcome, number> = {
    right: 0,
    'wrong-kind': 0,
    'false-guard': 0,
    'missed-guard': 0,
    insufficient: 0,
    rejected: 0,
    unanswered: 0,
  }
  const each = Object.entries(expected).map(([question, want]) => {
    const c = last.get(question)
    let got = 'none'
    let outcome: Outcome
    if (!c) outcome = 'unanswered'
    else if (c.status === 'rejected') {
      got = `rejected: ${c.rejection}`
      outcome = 'rejected'
    } else if (c.status === 'insufficient') {
      got = 'insufficient-context'
      outcome = 'insufficient'
    } else {
      got = c.value === 'yes' ? (c.valueKind ?? 'yes') : 'no'
      outcome =
        got === want
          ? 'right'
          : want === 'no'
            ? 'false-guard'
            : got === 'no'
              ? 'missed-guard'
              : 'wrong-kind'
    }
    outcomes[outcome]++
    return { question, expected: String(want), got, outcome }
  })
  const n = each.length
  return {
    questions: n,
    outcomes,
    accuracy: n === 0 ? 0 : outcomes.right / n,
    exploring: outcomes.insufficient,
    each,
  }
}
