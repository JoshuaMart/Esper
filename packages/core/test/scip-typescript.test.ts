import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { dockerAvailable, type Graph, Home, profilesDir, Store } from '../src/index.ts'

// scip-typescript through the analyzer contract, in Docker (D12, D22): on the hand-counted targets,
// guessed call edges and calls without one give way to resolved edges that name scip-typescript,
// and the entry points stay those counted by hand. Without Docker, or without the targets of
// `pnpm fetch-targets`, these are skipped.

const docker = await dockerAvailable()
const noDocker = docker.ok ? false : `Docker does not answer: ${docker.reason}`
const targets = process.env.ESPER_TARGETS
// The first run builds the image and fetches the dependencies.
const timeout = 15 * 60_000
const source = 'scip-typescript@0.5.2'

const calls = (graph: Graph) => graph.edges.filter((e) => e.kind === 'calls')
const guessed = (graph: Graph) => calls(graph).filter((e) => e.data?.resolution === 'guessed')
const key = (e: Graph['edges'][number]) =>
  `${e.from} ${e.to} ${e.citation.file}:${e.citation.line} ${e.data?.resolution}`

// A target indexed at its counted commit, by tree-sitter alone and then with scip-typescript.
async function both(target: string, count: string) {
  const { commit, dir, entries } = parse(
    await readFile(join(profilesDir, 'hono/counts', count), 'utf8'),
  ) as { commit: string; dir?: string; entries: { ref: string }[] }
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-scip-home-')))
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

test("scip-typescript installs Hono's dependencies and resolves its calls, entry points unchanged", {
  skip:
    noDocker || ((await present('hono')) ? false : 'set ESPER_TARGETS and run pnpm fetch-targets'),
  timeout,
}, async () => {
  const { before, after, plainStats, stats, counted } = await both('hono', 'hono@bac5c4a8bcd7.yaml')
  assert.ok(plainStats && stats)
  // Tree-sitter alone: 109 guessed of 2016 call edges, 1716 calls without one.
  assert.deepEqual(
    [plainStats.guessed, plainStats.resolved + plainStats.guessed, plainStats.unresolved],
    [109, 2016, 1716],
  )
  // With scip-typescript: 12 guessed of 3268, 432 calls without an edge.
  assert.deepEqual(
    [stats.guessed, stats.resolved + stats.guessed, stats.unresolved],
    [12, 3268, 432],
  )
  assert.equal(guessed(after).length, 12)
  assert.ok(named(before, after).length > 1000)
  const entries = after.nodes.filter((n) => n.kind === 'entry').map((n) => n.ref)
  assert.deepEqual(entries.sort(), counted)
})

test("scip-typescript resolves Kaneo's API without the dependencies of its repository, routes unchanged", {
  skip:
    noDocker || ((await present('kaneo')) ? false : 'set ESPER_TARGETS and run pnpm fetch-targets'),
  timeout,
}, async () => {
  const { before, after, plainStats, stats, counted } = await both(
    'kaneo',
    'kaneo@2c353877c7a4.yaml',
  )
  assert.ok(plainStats && stats)
  // Its lockfile is at the root of the repository, outside the folder that is the target.
  assert.ok(stats.unresolved < plainStats.unresolved - 1000, `${stats.unresolved} without an edge`)
  assert.ok(named(before, after).length > 1000)
  const entries = after.nodes.filter((n) => n.kind === 'entry').map((n) => n.ref)
  assert.deepEqual(entries.sort(), counted)
})

test('a folder that is not a git checkout, and has no lockfile, is analyzed as it is', {
  skip: noDocker,
  timeout,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'esper-scip-folder-'))
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-scip-home-')))
  try {
    await writeFile(
      join(dir, 'package.json'),
      '{ "name": "plain", "dependencies": { "hono": "^4" } }',
    )
    await writeFile(
      join(dir, 'app.ts'),
      [
        "import { Hono } from 'hono'",
        '',
        'class Repo {',
        '  save(id: string) { return id }',
        '}',
        'class Cache {',
        '  save(id: string) { return id }',
        '}',
        '',
        'const repos = [new Repo()]',
        '',
        'const app = new Hono()',
        "app.get('/:id', (c) => c.json(repos[0]?.save(c.req.param('id'))))",
        '',
        'export default app',
        '',
      ].join('\n'),
    )
    await home.add(dir, { name: 'plain' })
    const result = await home.index('plain', { precise: true })
    const store = new Store(home.database('plain'))
    try {
      const edges = calls(store.graph(result.id))
        .filter((e) => e.to.endsWith('.save'))
        .map((e) => `${e.from} ${e.to} ${e.source}`)
      // The element of an array, which the syntax does not type: two methods are named `save`.
      assert.deepEqual(edges, [`app.ts#fn1 app.ts#Repo.save ${source}`])
    } finally {
      store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(home.dir, { recursive: true, force: true })
  }
})

test('an npm workspace installs its packages, and a tsconfig extends one of them', {
  skip: noDocker,
  timeout,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'esper-scip-npm-'))
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-scip-home-')))
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'ws',
      private: true,
      workspaces: ['packages/*'],
    }),
    'package-lock.json': JSON.stringify({
      name: 'ws',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'ws', workspaces: ['packages/*'] },
        'node_modules/@ws/config': { resolved: 'packages/config', link: true },
        'packages/config': { name: '@ws/config', version: '1.0.0' },
      },
    }),
    'packages/config/package.json': JSON.stringify({ name: '@ws/config', version: '1.0.0' }),
    // Imports under `lib/` resolve only through the base URL the shared configuration sets.
    'packages/config/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '../..' } }),
    'tsconfig.json': JSON.stringify({
      extends: '@ws/config/tsconfig.json',
      include: ['*.ts', 'lib'],
    }),
    'lib/helper.ts': 'export function helper(id: string) { return id }\n',
    'app.ts': [
      "import { Hono } from 'hono'",
      "import { helper } from 'lib/helper'",
      '',
      'const app = new Hono()',
      "app.get('/:id', (c) => c.text(helper(c.req.param('id'))))",
      'export default app',
      '',
    ].join('\n'),
  }
  try {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(dir, path, '..'), { recursive: true })
      await writeFile(join(dir, path), text)
    }
    await home.add(dir, { name: 'ws' })
    const result = await home.index('ws', { precise: true })
    const store = new Store(home.database('ws'))
    try {
      const edges = calls(store.graph(result.id))
        .filter((e) => e.to.endsWith('helper'))
        .map((e) => `${e.from} ${e.to} ${e.source}`)
      assert.deepEqual(edges, [`app.ts#fn1 lib/helper.ts#helper ${source}`])
    } finally {
      store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(home.dir, { recursive: true, force: true })
  }
})
