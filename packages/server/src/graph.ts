import type { EdgeKind, GraphNode, SnapshotView } from '@esper/core'

// The two drawings of D14, each bounded: what one node reaches (an entry point's chain, its
// handler and what that calls), and the code a group of entry points shares. Neither ever holds
// the whole graph.

export const subgraphBounds = { depth: 2, maxDepth: 4, limit: 60, max: 300 }
export const mapBounds = { entries: 100, min: 3, shared: 40 }

export interface DrawnNode {
  ref: string
  kind: string
  name: string
  file?: string
  line?: number
  depth: number
  // A chain member of the entry, with its position, outermost first.
  chain?: number
  sinks: number
  reads: number
  signals: string[]
  notes: number
  // The past advisories that affect it (D19).
  advisories: number
  // The claims by a model about it that hold on this snapshot (D17).
  claims: number
}

export interface DrawnEdge {
  from: string
  to: string
  kind: EdgeKind
  citation: string
  resolution?: string
}

const at = (c: { file: string; line: number }) => `${c.file}:${c.line}`

function drawn(
  view: SnapshotView,
  node: GraphNode,
  depth: number,
  notes: Map<string, number>,
  claims: Map<string, number> = new Map(),
): DrawnNode {
  const facts = view.facts.get(node.ref) ?? []
  return {
    ref: node.ref,
    kind: node.kind,
    name: node.name,
    ...(node.file !== undefined ? { file: node.file } : {}),
    ...(node.startLine !== undefined ? { line: node.startLine } : {}),
    depth,
    sinks: facts.filter((f) => f.kind === 'sink').length,
    reads: new Set(facts.filter((f) => f.kind === 'read').map((f) => f.value)).size,
    signals: [...new Set(facts.filter((f) => f.kind === 'signal').map((f) => f.value))].sort(),
    notes: notes.get(node.ref) ?? 0,
    advisories: (view.in.get(node.ref) ?? []).filter((e) => e.kind === 'affects').length,
    claims: claims.get(node.ref) ?? 0,
  }
}

// What a node reaches, breadth first: for an entry point, its chain and its handler at depth 1,
// then what the handler calls. A chain member's own calls are followed only with `chain`, since
// they are shared by every route behind it. Every edge between two drawn nodes is drawn.
export function subgraph(
  view: SnapshotView,
  root: GraphNode,
  options: {
    depth: number
    limit: number
    chain: boolean
    notes: Map<string, number>
    claims?: Map<string, number>
  },
) {
  const nodes = new Map<string, DrawnNode>([
    [root.ref, drawn(view, root, 0, options.notes, options.claims)],
  ])
  const seen = new Set([root.ref])
  let frontier = [root.ref]
  const members = new Set<string>()
  for (let d = 1; d <= options.depth && frontier.length > 0; d++) {
    const next: string[] = []
    for (const from of frontier) {
      if (members.has(from) && !options.chain) continue
      for (const edge of view.out.get(from) ?? []) {
        if (!['calls', 'handles', 'chain', 'flows'].includes(edge.kind)) continue
        if (seen.has(edge.to)) continue
        const node = view.nodes.get(edge.to)
        if (!node) continue
        seen.add(edge.to)
        if (nodes.size >= options.limit) continue
        const item = drawn(view, node, d, options.notes, options.claims)
        if (edge.kind === 'chain' && from === root.ref) {
          item.chain = Number(edge.data?.position ?? 0)
          members.add(edge.to)
        }
        nodes.set(edge.to, item)
        next.push(edge.to)
      }
    }
    frontier = next
  }
  const edges: DrawnEdge[] = []
  for (const from of nodes.keys()) {
    for (const edge of view.out.get(from) ?? []) {
      if (!['calls', 'handles', 'chain', 'flows'].includes(edge.kind)) continue
      if (!nodes.has(edge.to) || edge.to === from) continue
      // A chain member is drawn in the chain, not as a callee of the entry or of the members
      // before it; a handler's call into it is drawn.
      if (members.has(edge.to) && edge.kind !== 'chain' && (from === root.ref || members.has(from)))
        continue
      const resolution = edge.data?.resolution
      edges.push({
        from,
        to: edge.to,
        kind: edge.kind,
        citation: at(edge.citation),
        ...(typeof resolution === 'string' ? { resolution } : {}),
      })
    }
  }
  const unique = new Map(edges.map((e) => [`${e.from}\0${e.to}\0${e.kind}`, e]))
  return {
    nodes: [...nodes.values()],
    edges: [...unique.values()],
    // How many nodes the walk found, the root left out.
    total: seen.size - 1,
  }
}

// The callees of a declaration whose call is a sink: each sink fact names the callee it saw.
function sinkCallees(view: SnapshotView, ref: string): Set<string> {
  const found = new Set<string>()
  for (const fact of view.facts.get(ref) ?? []) {
    if (fact.kind === 'sink' && typeof fact.data?.callee === 'string') found.add(fact.data.callee)
  }
  return found
}

// The code a group of entry points shares: each entry's handlers' direct callees that at least
// `min` of the entries call. A library symbol is kept only when `library` says so: all of them,
// or only those whose call is a sink.
export function shared(
  view: SnapshotView,
  entries: GraphNode[],
  options: { min: number; library: 'all' | 'sinks' | 'none'; limit: number },
) {
  const users = new Map<string, Set<string>>()
  const sinks = new Set<string>()
  for (const entry of entries) {
    for (const handler of view.summary(entry).handlers) {
      for (const s of sinkCallees(view, handler)) sinks.add(s)
      for (const edge of view.out.get(handler) ?? []) {
        if (edge.kind !== 'calls') continue
        const set = users.get(edge.to) ?? new Set<string>()
        set.add(entry.ref)
        users.set(edge.to, set)
      }
    }
  }
  const kept = [...users]
    .filter(([ref, set]) => {
      if (set.size < options.min) return false
      const node = view.nodes.get(ref)
      if (!node) return false
      if (node.kind !== 'external') return true
      return options.library === 'all' || (options.library === 'sinks' && sinks.has(ref))
    })
    .sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1))
  return {
    entries: entries.map((e) => {
      const s = view.summary(e)
      return {
        ref: s.ref,
        name: s.name,
        ...(s.method ? { method: s.method } : {}),
        ...(s.path ? { path: s.path } : {}),
        signals: s.signals,
      }
    }),
    shared: kept.slice(0, options.limit).map(([ref, set]) => {
      const node = view.nodes.get(ref) as GraphNode
      return {
        ref,
        kind: node.kind,
        name: node.name,
        ...(node.file !== undefined ? { file: node.file } : {}),
        sink: sinks.has(ref),
        users: [...set].sort(),
      }
    }),
    total: kept.length,
  }
}
