import type { GraphEdge } from './graph.ts'

// What a set of declarations reaches through calls (D6), shared by the rules that follow calls:
// the reads and signals of an entry point, and `fix-downstream`. Each node is reached once, the
// best way first: one reached through a resolved call is not marked as guessed, even when a
// guessed call reaches it too.

export type Calls = Map<string, { to: string; guessed: boolean }[]>

export function callsOf(edges: GraphEdge[]): Calls {
  const calls: Calls = new Map()
  for (const e of edges) {
    if (e.kind !== 'calls') continue
    const list = calls.get(e.from) ?? []
    list.push({ to: e.to, guessed: e.data?.resolution === 'guessed' })
    calls.set(e.from, list)
  }
  return calls
}

// Every node reachable from `start`, the starts included, each with whether the only paths to it
// go through a guessed call.
export function reach(calls: Calls, start: string[]): Map<string, boolean> {
  const best = new Map<string, boolean>()
  const queue = start.map((ref) => ({ ref, guessed: false }))
  while (queue.length > 0) {
    const { ref, guessed } = queue.shift() as { ref: string; guessed: boolean }
    const known = best.get(ref)
    if (known === false || (known === true && guessed)) continue
    best.set(ref, guessed)
    for (const next of calls.get(ref) ?? []) {
      queue.push({ ref: next.to, guessed: guessed || next.guessed })
    }
  }
  return best
}
