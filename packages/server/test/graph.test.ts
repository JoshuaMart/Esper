import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Graph, SnapshotView } from '@esper/core'
import { shared, subgraph } from '../src/graph.ts'

// The two drawings, on a graph small enough to read: two routes behind one middleware, whose
// handlers format a URL and redirect to it on the same line.

const at = (line: number) => ({ file: 'main.go', line })
const graph: Graph = {
  files: [],
  skips: [],
  nodes: [
    { ref: 'route:GET /a', kind: 'entry', name: 'GET /a', file: 'main.go', startLine: 1 },
    { ref: 'route:GET /b', kind: 'entry', name: 'GET /b', file: 'main.go', startLine: 2 },
    { ref: 'main.go#auth', kind: 'decl', name: 'auth', file: 'main.go', startLine: 5 },
    { ref: 'main.go#a', kind: 'decl', name: 'a', file: 'main.go', startLine: 10 },
    { ref: 'main.go#b', kind: 'decl', name: 'b', file: 'main.go', startLine: 20 },
    { ref: 'main.go#lookup', kind: 'decl', name: 'lookup', file: 'main.go', startLine: 30 },
    { ref: 'main.go#token', kind: 'decl', name: 'token', file: 'main.go', startLine: 40 },
    { ref: 'ext:fmt#Sprintf', kind: 'external', name: 'fmt.Sprintf' },
    { ref: 'ext:net/http#Redirect', kind: 'external', name: 'http.Redirect' },
  ],
  edges: [
    {
      kind: 'chain',
      from: 'route:GET /a',
      to: 'main.go#auth',
      citation: at(1),
      source: 't',
      data: { position: 0 },
    },
    {
      kind: 'chain',
      from: 'route:GET /b',
      to: 'main.go#auth',
      citation: at(2),
      source: 't',
      data: { position: 0 },
    },
    { kind: 'handles', from: 'route:GET /a', to: 'main.go#a', citation: at(1), source: 't' },
    { kind: 'handles', from: 'route:GET /b', to: 'main.go#b', citation: at(2), source: 't' },
    { kind: 'calls', from: 'main.go#auth', to: 'main.go#token', citation: at(6), source: 't' },
    // b's handler also calls the middleware in front of it, directly.
    { kind: 'calls', from: 'main.go#b', to: 'main.go#auth', citation: at(23), source: 't' },
    {
      kind: 'calls',
      from: 'main.go#a',
      to: 'main.go#lookup',
      citation: at(11),
      source: 't',
      data: { resolution: 'guessed' },
    },
    { kind: 'calls', from: 'main.go#a', to: 'ext:fmt#Sprintf', citation: at(12), source: 't' },
    {
      kind: 'calls',
      from: 'main.go#a',
      to: 'ext:net/http#Redirect',
      citation: at(12),
      source: 't',
    },
    { kind: 'calls', from: 'main.go#b', to: 'main.go#lookup', citation: at(21), source: 't' },
    { kind: 'calls', from: 'main.go#b', to: 'ext:fmt#Sprintf', citation: at(22), source: 't' },
    {
      kind: 'calls',
      from: 'main.go#b',
      to: 'ext:net/http#Redirect',
      citation: at(22),
      source: 't',
    },
  ],
  facts: [
    {
      node: 'main.go#a',
      kind: 'sink',
      value: 'redirect',
      citation: at(12),
      source: 't',
      data: { callee: 'ext:net/http#Redirect' },
    },
    {
      node: 'main.go#b',
      kind: 'sink',
      value: 'redirect',
      citation: at(22),
      source: 't',
      data: { callee: 'ext:net/http#Redirect' },
    },
  ],
}
const view = new SnapshotView(
  {
    id: 1,
    ref: null,
    commit: null,
    dirty: false,
    createdAt: '',
    profiles: [],
    analyzers: [],
    indexer: null,
  },
  graph,
)
const node = (ref: string) => view.nodes.get(ref) as NonNullable<ReturnType<typeof view.nodes.get>>

test('a subgraph draws the chain and the handler, then what the handler calls, not what the chain calls', () => {
  const drawn = subgraph(view, node('route:GET /a'), {
    depth: 2,
    limit: 50,
    chain: false,
    notes: new Map(),
  })
  const refs = drawn.nodes.map((n) => n.ref).sort()
  assert.deepEqual(refs, [
    'ext:fmt#Sprintf',
    'ext:net/http#Redirect',
    'main.go#a',
    'main.go#auth',
    'main.go#lookup',
    'route:GET /a',
  ])
  assert.equal(drawn.nodes.find((n) => n.ref === 'main.go#auth')?.chain, 0)
  assert.equal(drawn.nodes.find((n) => n.ref === 'main.go#a')?.sinks, 1)
  assert.equal(drawn.edges.find((e) => e.to === 'main.go#lookup')?.resolution, 'guessed')
  assert.equal(drawn.total, 5)
  // The entry's chain is drawn as a chain, not also as a call.
  assert.deepEqual(
    drawn.edges.filter((e) => e.to === 'main.go#auth').map((e) => [e.from, e.kind]),
    [['route:GET /a', 'chain']],
  )
  // A handler's own call into a chain member is drawn.
  const b = subgraph(view, node('route:GET /b'), {
    depth: 2,
    limit: 50,
    chain: false,
    notes: new Map(),
  })
  assert.deepEqual(
    b.edges
      .filter((e) => e.to === 'main.go#auth')
      .map((e) => [e.from, e.kind])
      .sort(),
    [
      ['main.go#b', 'calls'],
      ['route:GET /b', 'chain'],
    ],
  )

  // With the chain followed, its member's own call is drawn too.
  const deeper = subgraph(view, node('route:GET /a'), {
    depth: 2,
    limit: 50,
    chain: true,
    notes: new Map(),
  })
  assert.ok(deeper.nodes.some((n) => n.ref === 'main.go#token'))

  // The limit cuts the drawing, and the total says how much there was.
  const cut = subgraph(view, node('route:GET /a'), {
    depth: 2,
    limit: 3,
    chain: false,
    notes: new Map(),
  })
  assert.equal(cut.nodes.length, 3)
  assert.equal(cut.total, 5)
  for (const e of cut.edges) assert.ok(cut.nodes.some((n) => n.ref === e.to))
})

test('the map keeps the code shared by enough entry points, and a library symbol only as a sink', () => {
  const entries = [node('route:GET /a'), node('route:GET /b')]
  const sinks = shared(view, entries, { min: 2, library: 'sinks', limit: 40 })
  assert.deepEqual(
    sinks.shared.map((s) => [s.ref, s.sink, s.users]),
    [
      ['ext:net/http#Redirect', true, ['route:GET /a', 'route:GET /b']],
      ['main.go#lookup', false, ['route:GET /a', 'route:GET /b']],
    ],
  )
  // Sprintf is on the line of the redirect, but the sink fact names Redirect.
  const all = shared(view, entries, { min: 2, library: 'all', limit: 40 })
  assert.equal(all.shared.find((s) => s.ref === 'ext:fmt#Sprintf')?.sink, false)
  const none = shared(view, entries, { min: 2, library: 'none', limit: 40 })
  assert.deepEqual(
    none.shared.map((s) => s.ref),
    ['main.go#lookup'],
  )
  assert.equal(shared(view, entries, { min: 3, library: 'all', limit: 40 }).shared.length, 0)
  assert.equal(shared(view, entries, { min: 2, library: 'all', limit: 1 }).total, 3)
})
