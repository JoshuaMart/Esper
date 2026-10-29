import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import {
  dockerAvailable,
  type Graph,
  Home,
  profilesDir,
  recordedSource,
  Store,
} from '../src/index.ts'

// scip-python through the analyzer contract, in Docker (D12, D22, D40): on the hand-counted
// targets, calls without an edge give way to resolved edges that name scip-python, and the entry
// points stay those counted by hand. Without Docker, or without the targets of
// `pnpm fetch-targets`, these are skipped.

const docker = await dockerAvailable()
const noDocker = docker.ok ? false : `Docker does not answer: ${docker.reason}`
const targets = process.env.ESPER_TARGETS
// The first run builds the image and fetches the dependencies.
const timeout = 15 * 60_000
const source = 'scip-python@0.6.8'

const calls = (graph: Graph) => graph.edges.filter((e) => e.kind === 'calls')
const key = (e: Graph['edges'][number]) =>
  `${e.from} ${e.to} ${e.citation.file}:${e.citation.line} ${e.data?.resolution}`

// A target indexed at its counted commit, by tree-sitter alone and then with scip-python.
async function both(target: string, count: string) {
  const { commit, dir, entries } = parse(await readFile(join(profilesDir, count), 'utf8')) as {
    commit: string
    dir?: string
    entries: { ref: string }[]
  }
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-scip-home-')), {
    advisories: recordedSource(),
  })
  try {
    await home.add(join(targets as string, target, dir ?? ''), { name: target })
    const plain = await home.index(target, { ref: commit })
    const precise = await home.index(target, { ref: commit, precise: true })
    assert.deepEqual(precise.analyzers, [source])
    const store = new Store(home.database(target))
    try {
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

// Every edge that was not already resolved the same way names the analyzer, and is resolved.
function named(before: Graph, after: Graph) {
  const resolvedBefore = new Set(calls(before).map(key))
  const changed = calls(after).filter((e) => !resolvedBefore.has(key(e)))
  for (const e of changed) assert.equal(e.source, source, key(e))
  for (const e of calls(after).filter((e) => e.source === source)) {
    assert.equal(e.data?.resolution, 'resolved')
  }
  return changed
}

const entriesOf = (graph: Graph) =>
  graph.nodes
    .filter((n) => n.kind === 'entry')
    .map((n) => n.ref)
    .sort()

test("scip-python installs getspace's locked dependencies as wheels, routes unchanged", {
  skip:
    noDocker ||
    ((await present('getspace')) ? false : 'set ESPER_TARGETS and run pnpm fetch-targets'),
  timeout,
}, async () => {
  const { before, after, plainStats, stats, counted } = await both(
    'getspace',
    'fastapi/counts/getspace@d0941159c687.yaml',
  )
  assert.ok(plainStats && stats)
  // Calls without an edge fall from 2342 to 1451.
  assert.deepEqual([plainStats.unresolved, stats.unresolved], [2342, 1451])
  assert.ok(named(before, after).length > 500)
  assert.deepEqual(entriesOf(after), counted)
})

test('scip-python resolves FastAPI itself, its request surface unchanged', {
  skip:
    noDocker ||
    ((await present('fastapi')) ? false : 'set ESPER_TARGETS and run pnpm fetch-targets'),
  timeout,
}, async () => {
  const { before, after, plainStats, stats, counted } = await both(
    'fastapi',
    'fastapi/counts/fastapi@7a0a3f0b286c.yaml',
  )
  assert.ok(plainStats && stats)
  assert.deepEqual([plainStats.unresolved, stats.unresolved], [882, 329])
  assert.ok(named(before, after).length > 500)
  assert.deepEqual(entriesOf(after), counted)
})

test('scip-python resolves Starlette, and drops the entry point a wrong guess reached', {
  skip:
    noDocker ||
    ((await present('starlette')) ? false : 'set ESPER_TARGETS and run pnpm fetch-targets'),
  timeout,
}, async () => {
  const { before, after, plainStats, stats, counted } = await both(
    'starlette',
    'starlette/counts/starlette@8aa828ceaff7.yaml',
  )
  assert.ok(plainStats && stats)
  assert.deepEqual([plainStats.unresolved, stats.unresolved], [545, 189])
  assert.ok(named(before, after).length > 300)
  // `BaseRoute.__call__` reached a read only through "the only method named …".
  assert.deepEqual(
    entriesOf(after),
    counted.filter((ref) => ref !== 'entry:starlette/routing.py#BaseRoute.__call__'),
  )
})

test('a folder without a manifest is analyzed as it is, its calls resolved by their types', {
  skip: noDocker,
  timeout,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'esper-scip-python-'))
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-scip-home-')), {
    advisories: recordedSource(),
  })
  try {
    await writeFile(
      join(dir, 'app.py'),
      [
        'from fastapi import FastAPI',
        '',
        '',
        'class Repo:',
        '    def save(self, id: str) -> str:',
        '        return id',
        '',
        '',
        'class Cache:',
        '    def save(self, id: str) -> str:',
        '        return id',
        '',
        '',
        'repos = [Repo()]',
        'app = FastAPI()',
        '',
        '',
        '@app.get("/{id}")',
        'def read(id: str):',
        '    return repos[0].save(id)',
        '',
      ].join('\n'),
    )
    await home.add(dir, { name: 'plain', kind: 'application' })
    const result = await home.index('plain', { precise: true })
    const store = new Store(home.database('plain'))
    try {
      const edges = calls(store.graph(result.id))
        .filter((e) => e.to.endsWith('.save'))
        .map((e) => `${e.from} ${e.to} ${e.source}`)
      // The element of a list, which the syntax does not type: two methods are named `save`.
      assert.deepEqual(edges, [`app.py#read app.py#Repo.save ${source}`])
    } finally {
      store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(home.dir, { recursive: true, force: true })
  }
})
