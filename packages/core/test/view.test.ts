import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SnapshotView } from '../src/index.ts'

// A framework's entry spans the lines of its declaration; a route sits on the line that
// registers it.
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
  {
    files: [{ path: 'a.go', hash: 'h', language: 'go' }],
    skips: [],
    edges: [],
    facts: [],
    nodes: [
      { ref: 'a.go', kind: 'file', name: 'a.go', file: 'a.go', startLine: 1, endLine: 12 },
      { ref: 'a.go#F', kind: 'decl', name: 'F', file: 'a.go', startLine: 3, endLine: 5 },
      {
        ref: 'entry:a.go#F',
        kind: 'entry',
        name: 'F',
        file: 'a.go',
        startLine: 3,
        endLine: 5,
        data: { symbol: 'a.go#F' },
      },
      { ref: 'a.go#main', kind: 'decl', name: 'main', file: 'a.go', startLine: 7, endLine: 11 },
      { ref: 'route:GET /', kind: 'entry', name: 'GET /', file: 'a.go', startLine: 9, endLine: 9 },
    ],
  },
)

test('a file:line names the same declaration on each of its lines, and a route on its own line', () => {
  const at = (line: number) => view.resolve(`a.go:${line}`).ref
  assert.deepEqual([3, 4, 5, 8, 9, 10, 12].map(at), [
    'a.go#F',
    'a.go#F',
    'a.go#F',
    'a.go#main',
    'route:GET /',
    'a.go#main',
    'a.go',
  ])
  assert.equal(view.resolve('entry:a.go#F').ref, 'entry:a.go#F')
})
