import { EsperError } from './errors.ts'
import type { Citation, EdgeKind, Fact, Graph, GraphEdge, GraphNode, NodeKind } from './graph.ts'
import type { SnapshotInfo, Store } from './store.ts'

// A snapshot held in memory, with what the queries over it need: nodes by reference, name and
// file, edges both ways, facts by node. Queries are bounded traversals over graphs of a few
// thousand nodes (D9), so they run here rather than in SQL. Every query returns all it finds, in a
// stable order; the caller bounds what it shows.

// The edges a request follows: calls, and from an entry to its handler and its chain.
const flowEdges: ReadonlySet<EdgeKind> = new Set(['calls', 'handles', 'chain', 'flows'])

export interface EntrySummary {
  ref: string
  name: string
  method?: string
  path?: string
  file?: string
  line?: number
  handlers: string[]
  chain: string[]
  guards: string[]
  reads: string[]
  signals: string[]
}

export interface EntryFilter {
  method?: string
  // A part of the normalised path.
  path?: string
  // A part of a chain member's reference.
  chain?: string
  // A guard kind the entry has.
  guard?: string
  // A guard kind the entry lacks, or `any` for an entry with no guard.
  withoutGuard?: string
  // A read, `header` for every header or `header.X-Real-IP` for one.
  read?: string
  signal?: string
}

export interface Step {
  ref: string
  depth: number
  // The node it was reached from, and by which edge.
  via: string
  edge: EdgeKind
  citation: Citation
  resolution?: string
}

export interface PathStep {
  ref: string
  // The edge from the previous step; absent on the first.
  edge?: EdgeKind
  citation?: Citation
  resolution?: string
}

export interface EntryChange {
  ref: string
  code: boolean
  added: string[]
  removed: string[]
}

export class SnapshotView {
  readonly info: SnapshotInfo
  readonly graph: Graph
  readonly nodes = new Map<string, GraphNode>()
  readonly out = new Map<string, GraphEdge[]>()
  readonly in = new Map<string, GraphEdge[]>()
  readonly facts = new Map<string, Fact[]>()
  private readonly byName = new Map<string, GraphNode[]>()
  private readonly byFile = new Map<string, GraphNode[]>()

  constructor(info: SnapshotInfo, graph: Graph) {
    this.info = info
    this.graph = graph
    const add = <T>(map: Map<string, T[]>, key: string, value: T) => {
      const list = map.get(key)
      if (list) list.push(value)
      else map.set(key, [value])
    }
    for (const node of graph.nodes) {
      this.nodes.set(node.ref, node)
      add(this.byName, node.name, node)
      if (node.file) add(this.byFile, node.file, node)
    }
    for (const edge of graph.edges) {
      add(this.out, edge.from, edge)
      add(this.in, edge.to, edge)
    }
    for (const fact of graph.facts) add(this.facts, fact.node, fact)
  }

  static load(store: Store, id: number): SnapshotView {
    const info = store.snapshot(id)
    if (!info) throw new EsperError(`no snapshot ${id}; esper_snapshots lists them`)
    return new SnapshotView(info, store.graph(id))
  }

  // A node named by its reference, a `file:line`, or its name (D13).
  resolve(name: string): GraphNode {
    const exact = this.nodes.get(name)
    if (exact) return exact
    const at = this.at(name)
    if (at) return at
    const named = this.byName.get(name) ?? []
    if (named.length === 1) return named[0] as GraphNode
    if (named.length > 1) {
      const refs = named.map((n) => n.ref).sort()
      throw new EsperError(
        `${name} names ${refs.length} nodes; give one reference: ${refs.slice(0, 10).join(', ')}${refs.length > 10 ? ', …' : ''}`,
      )
    }
    throw new EsperError(
      `snapshot ${this.info.id} has no node ${name}; esper_search finds nodes by part of their name`,
    )
  }

  // The node at `file:line`: a route registered on that line, else the innermost declaration that
  // spans it, else the file. A framework's entry is its declaration (`data.symbol`), which the line
  // names on every one of its lines; the entry is reached by its own reference.
  private at(name: string): GraphNode | undefined {
    const match = /^(.+):(\d+)$/.exec(name)
    if (!match) return undefined
    const [, file, digits] = match as unknown as [string, string, string]
    const nodes = this.byFile.get(file)
    if (!nodes) return undefined
    const line = Number(digits)
    const entry = nodes.find((n) => n.kind === 'entry' && !n.data?.symbol && n.startLine === line)
    if (entry) return entry
    const spans = (n: GraphNode) =>
      n.startLine !== undefined &&
      n.endLine !== undefined &&
      n.startLine <= line &&
      line <= n.endLine
    const decls = nodes
      .filter((n) => n.kind === 'decl' && spans(n))
      .sort((a, b) => span(a) - span(b) || (a.ref < b.ref ? -1 : 1))
    return decls[0] ?? nodes.find((n) => n.kind === 'file' && spans(n))
  }

  // Nodes whose reference or name contains the query, best match first: the exact reference, the
  // exact name, a name that starts with it, then one that contains it.
  search(query: string, kinds?: NodeKind[]): GraphNode[] {
    const q = query.toLowerCase()
    const rank = (n: GraphNode) => {
      const name = n.name.toLowerCase()
      const ref = n.ref.toLowerCase()
      if (ref === q) return 0
      if (name === q) return 1
      if (name.startsWith(q)) return 2
      if (name.includes(q)) return 3
      if (ref.includes(q)) return 4
      return -1
    }
    const found = this.graph.nodes
      .filter((n) => !kinds || kinds.includes(n.kind))
      .map((n) => ({ n, r: rank(n) }))
      .filter(({ r }) => r >= 0)
    const at = this.at(query)
    if (at && (!kinds || kinds.includes(at.kind))) found.push({ n: at, r: -1 })
    const seen = new Set<string>()
    return found
      .sort((a, b) => a.r - b.r || (a.n.ref < b.n.ref ? -1 : 1))
      .map(({ n }) => n)
      .filter((n) => !seen.has(n.ref) && seen.add(n.ref))
  }

  summary(entry: GraphNode): EntrySummary {
    const facts = this.facts.get(entry.ref) ?? []
    const values = (kind: Fact['kind']) =>
      [...new Set(facts.filter((f) => f.kind === kind).map((f) => f.value))].sort()
    const edges = this.out.get(entry.ref) ?? []
    const chain = edges
      .filter((e) => e.kind === 'chain')
      .sort((a, b) => Number(a.data?.position ?? 0) - Number(b.data?.position ?? 0))
      .map((e) => e.to)
    const method = values('method')[0]
    const path = values('path')[0]
    return {
      ref: entry.ref,
      name: entry.name,
      ...(method ? { method } : {}),
      ...(path ? { path } : {}),
      ...(entry.file ? { file: entry.file } : {}),
      ...(entry.startLine ? { line: entry.startLine } : {}),
      handlers: edges.filter((e) => e.kind === 'handles').map((e) => e.to),
      chain: [...new Set(chain)],
      guards: values('guard'),
      reads: values('read'),
      signals: values('signal'),
    }
  }

  entrypoints(filter: EntryFilter = {}): EntrySummary[] {
    const reads = (read: string) => (value: string) => {
      const [kind, ...rest] = read.split('.')
      const [vkind, ...vrest] = value.split('.')
      if (kind !== vkind) return false
      if (rest.length === 0) return true
      return rest.join('.').toLowerCase() === vrest.join('.').toLowerCase()
    }
    return this.graph.nodes
      .filter((n) => n.kind === 'entry')
      .map((n) => this.summary(n))
      .filter(
        (e) =>
          (!filter.method || e.method === filter.method.toUpperCase()) &&
          (!filter.path || (e.path ?? '').includes(filter.path)) &&
          (!filter.chain || e.chain.some((c) => c.includes(filter.chain as string))) &&
          (!filter.guard || e.guards.includes(filter.guard)) &&
          (!filter.withoutGuard ||
            (filter.withoutGuard === 'any'
              ? e.guards.length === 0
              : !e.guards.includes(filter.withoutGuard))) &&
          (!filter.read || e.reads.some(reads(filter.read))) &&
          (!filter.signal || e.signals.includes(filter.signal)),
      )
  }

  // What a node reaches (`callees`) or what reaches it (`callers`), breadth first, up to a depth:
  // each node once, at the depth it is first reached.
  walk(ref: string, direction: 'callees' | 'callers', depth: number): Step[] {
    const steps: Step[] = []
    const seen = new Set([ref])
    let frontier = [ref]
    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const next: string[] = []
      for (const from of frontier) {
        const edges = (direction === 'callees' ? this.out : this.in).get(from) ?? []
        for (const edge of edges) {
          if (!flowEdges.has(edge.kind)) continue
          const to = direction === 'callees' ? edge.to : edge.from
          if (seen.has(to)) continue
          seen.add(to)
          next.push(to)
          const resolution = edge.data?.resolution
          steps.push({
            ref: to,
            depth: d,
            via: from,
            edge: edge.kind,
            citation: edge.citation,
            ...(typeof resolution === 'string' ? { resolution } : {}),
          })
        }
      }
      frontier = next
    }
    return steps
  }

  // The paths from a node to any node `isTarget` accepts, shortest first, without a node twice,
  // and ending at the first target they meet. The search stops after `budget` steps; `complete`
  // says whether it saw every path up to the depth.
  paths(
    from: string,
    isTarget: (ref: string) => boolean,
    maxDepth: number,
    limit: number,
    budget = 200_000,
  ): { paths: PathStep[][]; complete: boolean } {
    // How far each node is from a target, walking back from the targets.
    const distance = new Map<string, number>()
    let frontier = this.graph.nodes.map((n) => n.ref).filter(isTarget)
    for (const ref of frontier) distance.set(ref, 0)
    for (let d = 1; d <= maxDepth && frontier.length > 0; d++) {
      const next: string[] = []
      for (const to of frontier) {
        for (const edge of this.in.get(to) ?? []) {
          if (!flowEdges.has(edge.kind) || distance.has(edge.from) || isTarget(edge.from)) continue
          distance.set(edge.from, d)
          next.push(edge.from)
        }
      }
      frontier = next
    }
    const paths: PathStep[][] = []
    const start = distance.get(from)
    if (start === undefined || start === 0) return { paths, complete: true }
    let spent = 0
    let complete = true
    // Paths of each length in turn, so that the shortest come first.
    for (let length = start; length <= maxDepth && paths.length <= limit; length++) {
      const trail: PathStep[] = [{ ref: from }]
      const onTrail = new Set([from])
      const extend = (ref: string, left: number): boolean => {
        for (const edge of this.out.get(ref) ?? []) {
          if (!flowEdges.has(edge.kind) || onTrail.has(edge.to)) continue
          const d = distance.get(edge.to)
          if (d === undefined || d > left - 1) continue
          if (++spent > budget) {
            complete = false
            return false
          }
          const resolution = edge.data?.resolution
          trail.push({
            ref: edge.to,
            edge: edge.kind,
            citation: edge.citation,
            ...(typeof resolution === 'string' ? { resolution } : {}),
          })
          if (left - 1 === 0) {
            if (d === 0) paths.push([...trail])
          } else if (d !== 0) {
            onTrail.add(edge.to)
            const more = extend(edge.to, left - 1)
            onTrail.delete(edge.to)
            if (!more) return false
          }
          trail.pop()
          // One more than asked for says that there are more.
          if (paths.length > limit) return false
        }
        return true
      }
      if (!extend(from, length)) break
    }
    return { paths, complete }
  }
}

// What changed between two snapshots' entry points: those only in one, and those in both whose
// code (the fingerprint, which covers the handler and the chain) or facts changed.
export function diffEntries(
  from: SnapshotView,
  to: SnapshotView,
): { added: string[]; removed: string[]; changed: EntryChange[] } {
  const entries = (v: SnapshotView) =>
    new Map(v.graph.nodes.filter((n) => n.kind === 'entry').map((n) => [n.ref, n]))
  const before = entries(from)
  const after = entries(to)
  const facts = (v: SnapshotView, ref: string) =>
    new Set(
      (v.facts.get(ref) ?? [])
        .filter((f) => f.kind === 'read' || f.kind === 'guard' || f.kind === 'signal')
        .map((f) => `${f.kind}:${f.value}`),
    )
  const changed: EntryChange[] = []
  for (const [ref, node] of after) {
    const old = before.get(ref)
    if (!old) continue
    const a = facts(from, ref)
    const b = facts(to, ref)
    const added = [...b].filter((f) => !a.has(f)).sort()
    const removed = [...a].filter((f) => !b.has(f)).sort()
    const code = old.fingerprint !== node.fingerprint
    if (code || added.length > 0 || removed.length > 0) changed.push({ ref, code, added, removed })
  }
  return {
    added: [...after.keys()].filter((r) => !before.has(r)).sort(),
    removed: [...before.keys()].filter((r) => !after.has(r)).sort(),
    changed: changed.sort((a, b) => (a.ref < b.ref ? -1 : 1)),
  }
}

const span = (n: GraphNode) => (n.endLine ?? 0) - (n.startLine ?? 0)
