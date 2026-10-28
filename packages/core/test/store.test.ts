import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { canonical, extractGo, modulePath, Store } from '../src/index.ts'

const fixture = (path: string) =>
  readFile(new URL(`fixtures/module/${path}`, import.meta.url), 'utf8')

async function shop() {
  const files = await Promise.all(
    ['api/routes.go', 'store/db.go'].map(async (path) => ({ path, source: await fixture(path) })),
  )
  return (await extractGo(files, { module: modulePath(await fixture('go.mod')) ?? '' })).graph
}

test('a snapshot reads back as the graph that was written, in canonical order', async () => {
  const graph = await shop()
  const store = new Store(':memory:')
  const id = store.addSnapshot(graph, {
    ref: 'v1',
    commit: 'abc',
    createdAt: '2026-10-28T00:00:00Z',
  })
  assert.deepEqual(store.graph(id), canonical(graph))
  assert.deepEqual(store.snapshots(), [
    { id, ref: 'v1', commit: 'abc', dirty: false, createdAt: '2026-10-28T00:00:00Z', profiles: [] },
  ])
  store.close()
})

test('the same code gives the same graph', async () => {
  assert.deepEqual(canonical(await shop()), canonical(await shop()))
})

test('a second writer waits for the lock instead of failing', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'esper-store-'))
  const path = join(dir, 'esper.db')
  const first = new Store(path)
  const second = new Store(path)
  const busy = second.db.prepare('PRAGMA busy_timeout').get()
  assert.equal(Object.values(busy ?? {})[0], 5000)
  first.addSnapshot(await shop())
  second.addSnapshot(await shop())
  assert.equal(first.snapshots().length, 2)
  first.close()
  second.close()
  await rm(dir, { recursive: true })
})
