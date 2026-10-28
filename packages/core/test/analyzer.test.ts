import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  AnalysisError,
  analyzersDir,
  extractGo,
  hashFolder,
  importAnalysis,
  loadAnalyzers,
  parseManifest,
} from '../src/index.ts'

// The analyzer contract (D12): manifests, and the import of an analyzer's output, checked line by
// line against the snapshot and refused whole when one line fails.

const go = (...lines: string[]) => lines.join('\n')

const source = go(
  'package a',
  '',
  'import "sync"',
  '',
  'type Store interface {',
  '\tGet(id string) string',
  '}',
  '',
  'type Users struct{}',
  '',
  'func (u *Users) Get(id string) string { return id }',
  'func (u *Users) Put(v any)            {}',
  '',
  'type Cache struct{}',
  '',
  'func (c *Cache) Get(id int) string { return "" }',
  '',
  'func Lookup(s Store) string { return s.Get("1") }',
  '',
  'func Take(m map[string]*sync.Pool) { m["x"].Put(1) }',
  '',
  'func Label() string { return "" }',
  '',
  'func Name() string { return "é😀" + Label() }',
  '',
)
const files = [{ path: 'a.go', source }]
const snapshot = new Map(files.map((f) => [f.path, f.source]))
const analyzer = { name: 'scip-go', version: '0.2.9' }

// Where the nth `name` of a line starts, as the import format counts: 1-based, in UTF-8 bytes.
function place(line: number, name: string, nth = 0) {
  const text = source.split('\n')[line - 1] as string
  let index = -1
  for (let i = 0; i <= nth; i++) index = text.indexOf(name, index + 1)
  assert.ok(index >= 0, `${name} on line ${line}`)
  return { file: 'a.go', line, column: Buffer.byteLength(text.slice(0, index)) + 1 }
}

const header = { type: 'analyzer', format: 1, ...analyzer }
const valid = [
  header,
  // `s.Get` names Store's Get, which only Users implements: Cache.Get takes an int.
  { type: 'reference', at: place(18, 'Get'), name: 'Get', target: place(6, 'Get') },
  { type: 'implementation', at: place(11, 'Get'), name: 'Get', of: place(6, 'Get') },
  // `m["x"].Put` is sync.Pool's, not the only Put of the module.
  { type: 'reference', at: place(20, 'Put'), name: 'Put', target: { external: 'sync#Pool.Put' } },
  // A column after characters of two and four UTF-8 bytes.
  { type: 'reference', at: place(24, 'Label'), name: 'Label', target: place(22, 'Label') },
  // An interface outside the snapshot: checked, and not kept.
  { type: 'implementation', at: place(11, 'Get'), name: 'Get', of: { external: 'x#Getter.Get' } },
]
const jsonl = (lines: unknown[]) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`

async function edges(analysis?: Awaited<ReturnType<typeof importAnalysis>>) {
  const { graph, stats } = await extractGo(files, {
    module: 'example.com/a',
    ...(analysis ? { analysis } : {}),
  })
  const calls = graph.edges
    .filter((e) => e.kind === 'calls')
    .map((e) => ({
      from: e.from,
      to: e.to,
      source: e.source,
      resolution: e.data?.resolution,
      ...(e.data?.interface ? { interface: e.data.interface } : {}),
    }))
  return { calls, stats }
}

test('the analyzers of the repository have valid manifests, scip-go among them', async () => {
  const analyzers = await loadAnalyzers()
  const scip = analyzers.find((a) => a.name === 'scip-go')
  assert.ok(scip)
  assert.deepEqual(scip.languages, ['go'])
  assert.deepEqual(scip.provides, ['edges.resolve'])
  assert.equal(scip.answers, 'snapshot')
  assert.match(scip.hash, /^[0-9a-f]{64}$/)
})

test('a manifest that breaks the schema is refused, with what is wrong', async () => {
  await assert.rejects(
    parseManifest('name: x\nversion: 1\nlanguages: [cobol]\n', 'x/manifest.yaml'),
    /x\/manifest.yaml: .*(required|allowed values)/,
  )
  // A version is part of the image's tag, which takes no '+'.
  await assert.rejects(
    parseManifest(
      'name: x\nversion: 1.0+build\nlanguages: [go]\nprovides: [edges.resolve]\nanswers: snapshot\nimage: {dockerfile: Dockerfile}\nanalyze: [a]\n',
      'x/manifest.yaml',
    ),
    /\/version must match pattern/,
  )
})

test("an analyzer's image hash leaves hidden files out", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'esper-analyzer-'))
  try {
    await cp(join(analyzersDir, 'scip-go'), dir, { recursive: true })
    const before = await hashFolder(dir)
    await writeFile(join(dir, '.DS_Store'), 'finder')
    assert.equal(await hashFolder(dir), before)
    await writeFile(join(dir, 'Dockerfile'), '# changed\n', { flag: 'a' })
    assert.notEqual(await hashFolder(dir), before)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('tree-sitter alone guesses where the syntax does not state the type', async () => {
  const { calls } = await edges()
  assert.deepEqual(
    calls.filter((c) => c.from === 'a.go#Lookup' || c.from === 'a.go#Take'),
    [
      // Every type with a Get, whatever its parameters.
      { from: 'a.go#Lookup', to: 'a.go#Cache.Get', source: 'tree-sitter', resolution: 'guessed' },
      { from: 'a.go#Lookup', to: 'a.go#Users.Get', source: 'tree-sitter', resolution: 'guessed' },
      { from: 'a.go#Take', to: 'a.go#Users.Put', source: 'tree-sitter', resolution: 'guessed' },
    ],
  )
})

test("an analyzer's references resolve the call edges, each naming it as its source", async () => {
  const analysis = await importAnalysis(jsonl(valid), analyzer, snapshot)
  assert.equal(analysis.source, 'scip-go@0.2.9')
  const store = place(6, 'Get')
  assert.deepEqual([...analysis.implementations.keys()], [`a.go:${store.line}:${store.column}`])
  const { calls, stats } = await edges(analysis)
  assert.deepEqual(
    calls.filter((c) => ['a.go#Lookup', 'a.go#Take', 'a.go#Name'].includes(c.from)),
    [
      {
        from: 'a.go#Lookup',
        to: 'a.go#Users.Get',
        source: 'scip-go@0.2.9',
        resolution: 'resolved',
        interface: 'Store.Get',
      },
      {
        from: 'a.go#Take',
        to: 'ext:sync#Pool.Put',
        source: 'scip-go@0.2.9',
        resolution: 'resolved',
      },
      { from: 'a.go#Name', to: 'a.go#Label', source: 'scip-go@0.2.9', resolution: 'resolved' },
    ],
  )
  assert.equal(stats.guessed, 0)
  assert.equal(stats.analyzed, 3)
})

test('a file with one invalid line is refused whole', async () => {
  const cases: [unknown[], RegExp][] = [
    [[...valid, { type: 'reference', at: place(18, 'Get'), name: 'Get' }], /line 7 .*target/],
    [
      [valid[0], valid[1], { ...(valid[2] as object), at: { file: 'a.go', line: 0, column: 1 } }],
      /line 3 .*minimum|line 3 .*>= 1/,
    ],
    [[valid[0], { type: 'flow' }, ...valid.slice(1)], /line 2 /],
    [[{ ...header, version: '0.2.8' }, ...valid.slice(1)], /line 1 .*scip-go@0.2.8/],
    [valid.slice(1), /line 1 .*names the analyzer/],
    [[...valid, header], /line 7 .*only the first line/],
  ]
  for (const [lines, reason] of cases) {
    await assert.rejects(importAnalysis(jsonl(lines), analyzer, snapshot), (error: unknown) => {
      assert.ok(error instanceof AnalysisError)
      assert.match(error.message, /refused, and the file with it/)
      assert.match(error.message, reason)
      return true
    })
  }
  await assert.rejects(
    importAnalysis(
      `${jsonl(valid.slice(0, 2))}{"type":\n${jsonl(valid.slice(2))}`,
      analyzer,
      snapshot,
    ),
    /line 3 .*not JSON/,
  )
  await assert.rejects(importAnalysis('', analyzer, snapshot), /the file is empty/)
})

test('a file with one citation that does not match the snapshot is refused whole', async () => {
  const at = place(18, 'Get')
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ at: { ...at, file: 'b.go' } }, /b.go is not a file of the snapshot/],
    [{ at: { ...at, line: 99 } }, /a.go has no line 99/],
    [{ at: { ...at, column: at.column + 1 } }, /a.go:18:\d+ does not hold Get/],
    [{ at: { ...at, column: 400 } }, /does not hold Get/],
    [{ name: 'Put' }, /does not hold Put/],
    [{ target: { ...place(6, 'Get'), line: 5 } }, /a.go:5:\d+ does not hold Get/],
    // A part of a longer name, at its start or inside it.
    [{ name: 'Ge' }, /a.go:18:\d+ does not hold Ge/],
    [{ at: { ...at, column: at.column + 1 }, name: 'et' }, /does not hold et/],
    // In the middle of a character of four bytes.
    [
      { at: { ...place(24, 'Label'), column: place(24, 'Label').column - 2 }, name: 'Label' },
      /does not hold Label/,
    ],
  ]
  for (const [change, reason] of cases) {
    const lines = [...valid.slice(0, 1), { ...(valid[1] as object), ...change }, ...valid.slice(2)]
    await assert.rejects(importAnalysis(jsonl(lines), analyzer, snapshot), (error: unknown) => {
      assert.ok(error instanceof AnalysisError)
      assert.match(error.message, /line 2 of its output is refused, and the file with it/)
      assert.match(error.message, reason)
      return true
    })
  }
  const elsewhere = { ...(valid[1] as object), target: { external: 'sync#Pool.Get' } }
  await assert.rejects(
    importAnalysis(jsonl([...valid, elsewhere]), analyzer, snapshot),
    /line 7 .*already refers elsewhere/,
  )
})

test('a call to one of several build variants stays a guess to each, whatever the analyzer says', async () => {
  // The analyzer type-checks one platform: it sees one variant, never the others.
  const variants = [
    { path: 'sock_unix.go', source: 'package a\n\nfunc listen() {}\n' },
    { path: 'sock_windows.go', source: 'package a\n\nfunc listen() {}\n' },
    { path: 'main.go', source: 'package a\n\nfunc main() { listen() }\n' },
  ]
  const analysis = await importAnalysis(
    jsonl([
      header,
      {
        type: 'reference',
        at: { file: 'main.go', line: 3, column: 15 },
        name: 'listen',
        target: { file: 'sock_unix.go', line: 3, column: 6 },
      },
    ]),
    analyzer,
    new Map(variants.map((f) => [f.path, f.source])),
  )
  const { graph, stats } = await extractGo(variants, { module: 'example.com/a', analysis })
  assert.deepEqual(
    graph.edges.filter((e) => e.kind === 'calls').map((e) => [e.to, e.data?.resolution, e.source]),
    [
      ['sock_unix.go#listen', 'guessed', 'tree-sitter'],
      ['sock_windows.go#listen', 'guessed', 'tree-sitter'],
    ],
  )
  assert.equal(stats.analyzed, 0)
})
