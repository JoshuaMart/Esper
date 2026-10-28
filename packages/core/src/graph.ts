// The graph model of D6: what a snapshot holds, before and after it is stored.

export const schemaVersion = 1

export type NodeKind = 'file' | 'decl' | 'external' | 'entry' | 'advisory'

export type EdgeKind = 'contains' | 'imports' | 'calls' | 'handles' | 'chain' | 'affects' | 'flows'

// Where a fact or an edge is seen in the code. Lines are 1-based.
export interface Citation {
  file: string
  line: number
}

export interface GraphNode {
  ref: string
  kind: NodeKind
  name: string
  // Absent for nodes outside the target: externals and advisories.
  file?: string
  startLine?: number
  endLine?: number
  fingerprint?: string
  data?: Record<string, unknown>
}

export interface GraphEdge {
  kind: EdgeKind
  from: string
  to: string
  citation: Citation
  // `tree-sitter`, `tree-sitter:<profile>`, an analyzer as `<name>@<version>`, `osv` or `git`.
  source: string
  data?: Record<string, unknown>
}

export type FactKind = 'method' | 'path' | 'read' | 'guard' | 'signal' | 'sink'

export interface Fact {
  node: string
  kind: FactKind
  value: string
  citation: Citation
  source: string
  data?: Record<string, unknown>
}

export interface SourceFile {
  path: string
  hash: string
  language: string
}

export interface Skip {
  path: string
  reason: string
}

export interface Graph {
  files: SourceFile[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  facts: Fact[]
  skips: Skip[]
}

// Sorts every list of a graph so that the same code gives the same graph, in the same order (D11).
export function canonical(graph: Graph): Graph {
  const by =
    <T>(key: (item: T) => string) =>
    (a: T, b: T) => {
      const ka = key(a)
      const kb = key(b)
      return ka < kb ? -1 : ka > kb ? 1 : 0
    }
  const at = (c: Citation) => `${c.file}\0${String(c.line).padStart(9, '0')}`
  return {
    files: [...graph.files].sort(by((f) => f.path)),
    nodes: [...graph.nodes].sort(by((n) => n.ref)),
    edges: [...graph.edges].sort(by((e) => `${e.kind}\0${e.from}\0${e.to}\0${at(e.citation)}`)),
    facts: [...graph.facts].sort(by((f) => `${f.node}\0${f.kind}\0${f.value}\0${at(f.citation)}`)),
    skips: [...graph.skips].sort(by((s) => s.path)),
  }
}
