import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { parse } from 'yaml'
import {
  cacheVolume,
  dockerAvailable,
  type Graph,
  Home,
  profilesDir,
  recordedSource,
  Store,
} from '../src/index.ts'

// scip-go through the analyzer contract, in Docker (D12): on the hand-counted targets, the guessed
// call edges give way to resolved ones that name scip-go, and the entry points stay those counted
// by hand. Without Docker, or without the targets of `pnpm fetch-targets`, these are skipped.

const docker = await dockerAvailable()
const noDocker = docker.ok ? false : `Docker does not answer: ${docker.reason}`
const targets = process.env.ESPER_TARGETS
// The first run builds the image and fetches the dependencies.
const timeout = 15 * 60_000

// What an entry is: its handlers and chain, and the guards and reads that come with them.
const surface = (graph: Graph) =>
  [
    ...graph.edges
      .filter((e) => e.kind === 'handles' || e.kind === 'chain')
      .map((e) => `${e.kind} ${e.from} ${e.to} ${e.data?.resolution}`),
    ...graph.facts
      .filter((f) => (f.kind === 'guard' || f.kind === 'read') && /^(route|entry):/.test(f.node))
      .map((f) => `${f.kind} ${f.node} ${f.value} ${f.data?.via ?? ''}`),
  ].sort()

const calls = (graph: Graph) => graph.edges.filter((e) => e.kind === 'calls')
const guessed = (graph: Graph) => calls(graph).filter((e) => e.data?.resolution === 'guessed')
const key = (e: Graph['edges'][number]) =>
  `${e.from} ${e.to} ${e.citation.file}:${e.citation.line} ${e.data?.resolution}`

// A target indexed at its counted commit, by tree-sitter alone and then with scip-go.
async function both(target: string, count: string) {
  const dir = join(targets as string, target)
  const { commit, entries } = parse(
    await readFile(join(profilesDir, 'chi/counts', count), 'utf8'),
  ) as { commit: string; entries: { ref: string }[] }
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-scip-home-')), {
    advisories: recordedSource(),
  })
  try {
    await home.add(dir, { name: target })
    const plain = await home.index(target, { ref: commit })
    const precise = await home.index(target, { ref: commit, precise: true })
    assert.deepEqual(precise.analyzers, ['scip-go@0.2.9'])
    assert.notEqual(precise.id, plain.id, 'an index with scip-go is a snapshot of its own')
    const store = new Store(home.database(target))
    try {
      assert.deepEqual(store.snapshot(precise.id)?.analyzers, ['scip-go@0.2.9'])
      return {
        before: store.graph(plain.id),
        after: store.graph(precise.id),
        plainStats: plain.stats,
        stats: precise.stats,
        counted: entries.map((e) => e.ref).sort(),
      }
    } finally {
      store.close()
    }
  } finally {
    await rm(home.dir, { recursive: true, force: true })
  }
}

const present = async (name: string) =>
  targets ? !!(await stat(join(targets, name, '.git')).catch(() => undefined)) : false

test('scip-go resolves what tree-sitter guessed on chi 5.3.2, and names itself', {
  skip:
    noDocker || ((await present('chi')) ? false : 'set ESPER_TARGETS and run pnpm fetch-targets'),
  timeout,
}, async () => {
  const { before, after, plainStats, stats, counted } = await both('chi', 'chi@38939062c5df.yaml')
  // Tree-sitter alone, as M1 measured it: 30 guessed of 540 call edges.
  assert.ok(plainStats && stats)
  assert.deepEqual([plainStats.guessed, plainStats.resolved + plainStats.guessed], [30, 540])
  assert.equal(guessed(before).length, 30)
  // With scip-go: one guess left, a call through a package variable that holds a function.
  assert.equal(stats.guessed, 1)
  assert.equal(guessed(after).length, 1)
  assert.equal(guessed(after)[0]?.from, 'middleware/logger.go#Logger')
  assert.ok(guessed(after).length / calls(after).length < 0.01)
  assert.ok(stats.unresolved < 106 / 2, `${stats.unresolved} calls left without an edge`)
  // Every edge that was not already resolved the same way names scip-go.
  const resolvedBefore = new Set(calls(before).map(key))
  const changed = calls(after).filter((e) => !resolvedBefore.has(key(e)))
  assert.ok(changed.length > 100)
  for (const e of changed) assert.equal(e.source, 'scip-go@0.2.9', key(e))
  for (const e of calls(after).filter((e) => e.source.startsWith('scip-go'))) {
    assert.equal(e.data?.resolution, 'resolved')
  }
  // The request surface is still the one counted by hand.
  const entries = after.nodes.filter((n) => n.kind === 'entry').map((n) => n.ref)
  assert.deepEqual(entries.sort(), counted)
})

test("scip-go fetches Wakapi's dependencies and resolves its calls, routes unchanged", {
  skip:
    noDocker ||
    ((await present('wakapi')) ? false : 'set ESPER_TARGETS and run pnpm fetch-targets'),
  timeout,
}, async () => {
  const { before, after, stats, counted } = await both('wakapi', 'wakapi@aba6a4475a79.yaml')
  assert.ok(stats)
  assert.ok(guessed(before).length > 400)
  assert.equal(guessed(after).length, 0)
  assert.ok(stats.unresolved < 400, `${stats.unresolved} calls left without an edge`)
  // The same handlers, chains, guards and reads, the handlers of the module now named by
  // scip-go; only signals reached through a wrong guess go.
  assert.deepEqual(surface(after), surface(before))
  assert.ok(after.edges.some((e) => e.kind === 'handles' && e.source === 'scip-go@0.2.9'))
  // The dependencies stay in the analyzer's cache for the next run.
  await promisify(execFile)('docker', ['volume', 'inspect', cacheVolume({ name: 'scip-go' })])
  const entries = after.nodes.filter((n) => n.kind === 'entry').map((n) => n.ref)
  assert.deepEqual(entries.sort(), counted)
})

test('a folder that is not a git checkout is analyzed as it is', {
  skip: noDocker,
  timeout,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'esper-scip-folder-'))
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-scip-home-')), {
    advisories: recordedSource(),
  })
  try {
    await writeFile(join(dir, 'go.mod'), 'module example.com/plain\n\ngo 1.24\n')
    await writeFile(
      join(dir, 'main.go'),
      [
        'package main',
        '',
        'import "net/http"',
        '',
        'type writer struct{ http.ResponseWriter }',
        '',
        'func handle(w http.ResponseWriter, r *http.Request) {',
        '\tx := writer{w}',
        '\tx.Header().Set("a", r.URL.Query().Get("b"))',
        '}',
        '',
        'func main() { http.HandleFunc("/", handle) }',
        '',
      ].join('\n'),
    )
    await home.add(dir, { name: 'plain' })
    const result = await home.index('plain', { precise: true })
    const store = new Store(home.database('plain'))
    try {
      const edges = calls(store.graph(result.id))
        .filter((e) => e.from === 'main.go#handle')
        .map((e) => `${e.to} ${e.source}`)
        .sort()
      // The method promoted from the embedded writer, which the syntax does not state.
      assert.ok(
        edges.includes('ext:net/http#ResponseWriter.Header scip-go@0.2.9'),
        edges.join('\n'),
      )
    } finally {
      store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(home.dir, { recursive: true, force: true })
  }
})
