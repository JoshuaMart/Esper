import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  detectProfile,
  type Graph,
  Home,
  indexTs,
  loadProfiles,
  profilesDir,
  readFolder,
  resolveProfile,
  Store,
} from '../src/index.ts'

// The two Hono profiles: an application's routes with the middleware each inherits, in the order
// it was registered, and a framework's request surface.

const fixture = new URL('fixtures/honoapp', import.meta.url).pathname

const index = async (): Promise<Graph> => {
  const snapshot = await readFolder(fixture)
  const detection = detectProfile(snapshot.files, await loadProfiles(profilesDir))
  assert.ok('profile' in detection, 'refused' in detection ? detection.refused : '')
  assert.deepEqual(detection.profile.sources, ['hono/application'])
  return (await indexTs(snapshot.files, { modules: detection.modules, profile: detection.profile }))
    .graph
}

const facts = (graph: Graph, ref: string, kind: string) =>
  [
    ...new Set(graph.facts.filter((f) => f.node === ref && f.kind === kind).map((f) => f.value)),
  ].sort()
const edges = (graph: Graph, ref: string, kind: string) =>
  graph.edges
    .filter((e) => e.from === ref && e.kind === kind)
    .sort((a, b) => Number(a.data?.position ?? 0) - Number(b.data?.position ?? 0))
    .map((e) => e.to)

test('routes get the paths of their mounts and base paths, and the middleware registered before them', async () => {
  const graph = await index()
  const routes = graph.nodes
    .filter((n) => n.kind === 'entry')
    .map((n) => `${n.ref} ${n.file}:${n.startLine}`)
    .sort()
  assert.deepEqual(routes, [
    'route:GET /admin/stats src/index.ts:17',
    'route:GET /health src/index.ts:10',
    'route:GET /users/{id} src/users.ts:17',
    'route:GET /users/{id}/avatar src/users.ts:26',
    'route:POST /admin/run src/index.ts:18',
    'route:POST /users src/users.ts:21',
  ])
  // `limiter` is registered after the users routes, and `basicAuth` only for `/admin/*`.
  assert.deepEqual(edges(graph, 'route:GET /users/{id}', 'chain'), [
    'src/middleware.ts#audit',
    'src/middleware.ts#guards.owner',
  ])
  assert.deepEqual(edges(graph, 'route:POST /admin/run', 'chain'), [
    'src/middleware.ts#audit',
    'ext:hono/basic-auth#basicAuth',
  ])
  assert.deepEqual(edges(graph, 'route:POST /users', 'chain'), [
    'src/middleware.ts#audit',
    'ext:hono/csrf#csrf',
  ])
  assert.deepEqual(edges(graph, 'route:GET /users/{id}', 'handles'), ['src/users.ts#users/fn1'])
})

test('guards, reads and signals come from the profile and from what each route reaches', async () => {
  const graph = await index()
  assert.deepEqual(facts(graph, 'route:POST /admin/run', 'guard'), ['authn'])
  assert.deepEqual(facts(graph, 'route:POST /users', 'guard'), ['csrf'])
  // A handler's context is typed by the profile; a destructured read is named by its property.
  assert.deepEqual(facts(graph, 'route:GET /users/{id}', 'read'), [
    'header.X-User',
    'path',
    'path.id',
  ])
  assert.deepEqual(facts(graph, 'route:GET /admin/stats', 'read'), [
    'header.X-User',
    'path',
    'query.range',
  ])
  assert.deepEqual(facts(graph, 'route:GET /users/{id}', 'signal'), [
    'data-read',
    'live-state',
    'request-key',
    'retained-mutation',
    'short-circuit',
  ])
  assert.deepEqual(facts(graph, 'route:POST /users', 'signal'), [
    'data-write',
    'live-state',
    'mass-assignment',
    'retained-mutation',
  ])
  const sinks = (ref: string) =>
    graph.facts
      .filter((f) => f.node === ref && f.value === 'sink-reachable')
      .map((f) => f.data?.sink)
  assert.deepEqual(sinks('route:POST /admin/run'), ['process'])
  assert.deepEqual(sinks('route:GET /users/{id}/avatar'), ['redirect'])
})

const framework = {
  'package.json': '{ "name": "hono" }',
  'src/context.ts': `
import { HonoRequest } from './request'
export class Context {
  #raw: Request
  constructor(req: Request) { this.#raw = req }
  get req(): HonoRequest { return new HonoRequest(this.#raw) }
  get(key: string) { return key }
}
`,
  'src/request.ts': `
export class HonoRequest {
  raw: Request
  constructor(request: Request) { this.raw = request }
  header(name: string) { return this.raw.headers.get(name) }
  get url(): string { return this.raw.url }
}
`,
  'src/types.ts': `
import type { Context } from './context'
export type MiddlewareHandler = (c: Context, next: () => Promise<void>) => Promise<Response | void>
`,
  'src/middleware/cors.ts': `
import type { MiddlewareHandler } from '../types'
export const cors = (): MiddlewareHandler => {
  return async function cors(c, next) {
    const origin = c.req.header('Origin')
    if (!origin) return
    await next()
  }
}
export const version = () => '1'
`,
  'src/utils/url.ts': `
export const getPath = (request: Request): string => request.url
const internal = (request: Request) => request.method
`,
}

test("a framework's surface is what it exports, and its handlers, that read the request", async () => {
  const profiles = await loadProfiles(profilesDir)
  const hono = profiles.find((p) => p.name === 'hono' && p.kind === 'framework')
  assert.ok(hono)
  const profile = resolveProfile(hono, profiles)
  assert.deepEqual(profile.sources, ['hono/application', 'hono/framework'])
  const files = Object.entries(framework).map(([path, source]) => ({ path, source }))
  const detection = detectProfile(files, profiles)
  assert.ok('profile' in detection && detection.profile.kind === 'framework')
  const { graph } = await indexTs(files, { profile })
  const entries = graph.nodes
    .filter((n) => n.kind === 'entry')
    .map((n) => n.ref)
    .sort()
  assert.deepEqual(entries, [
    'entry:src/middleware/cors.ts#cors',
    'entry:src/request.ts#HonoRequest.header',
    'entry:src/request.ts#HonoRequest.url',
    'entry:src/utils/url.ts#getPath',
    'entry:src/utils/url.ts#internal',
  ])
  // The framework's own `Context` is `hono#Context`, so the application's rules name its reads.
  assert.deepEqual(facts(graph, 'entry:src/middleware/cors.ts#cors', 'read'), [
    'header',
    'header.Origin',
  ])
  // The middleware it returns can answer without calling the next handler.
  assert.deepEqual(facts(graph, 'src/middleware/cors.ts#cors/cors', 'signal'), ['short-circuit'])
})

test('a TypeScript project is added and indexed like any other, its snapshot stored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'esper-home-'))
  try {
    const home = new Home(dir)
    await home.add(fixture, { name: 'honoapp' })
    const result = await home.index('honoapp')
    assert.deepEqual(result.profiles, ['hono/application'])
    assert.equal(result.stats?.files, 5)
    assert.equal(result.stats?.entries, 6)
    const store = new Store(home.database('honoapp'))
    try {
      const files = store.graph(result.id).files.map((f) => `${f.path} ${f.language}`)
      assert.deepEqual(files, [
        'packages/db/src/index.ts typescript',
        'packages/db/src/schema.ts typescript',
        'src/index.ts typescript',
        'src/middleware.ts typescript',
        'src/users.ts typescript',
      ])
    } finally {
      store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const profileOf = async (kind: 'application' | 'framework') => {
  const profiles = await loadProfiles(profilesDir)
  const found = profiles.find((p) => p.name === 'hono' && p.kind === kind)
  assert.ok(found)
  return resolveProfile(found, profiles)
}
const indexed = async (files: Record<string, string>) =>
  (
    await indexTs(
      Object.entries(files).map(([path, source]) => ({ path, source })),
      { profile: await profileOf('application') },
    )
  ).graph

test('a router parameter no call binds keeps its routes, under the prefix the index could not read', async () => {
  const graph = await indexed({
    'app.ts': `
import { Hono } from 'hono'
export function registerUsers(app: Hono) {
  app.get('/me', (c) => c.text('me'))
}
export function registerAdmin(app: Hono) {
  app.get('/stats', (c) => c.text('stats'))
}
const app = new Hono()
registerAdmin(app)
const registrars = [registerUsers]
for (const register of registrars) register(app)
export default app
`,
  })
  const routes = graph.nodes
    .filter((n) => n.kind === 'entry')
    .map((n) => n.ref)
    .sort()
  // `registerAdmin` is bound by its call; `registerUsers` is called through a list.
  assert.deepEqual(routes, [`route:GET /\${app}/me`, 'route:GET /stats'])
})

test('middleware whose path the index cannot read guards no route, rather than every route', async () => {
  const graph = await indexed({
    'app.ts': `
import { Hono } from 'hono'
import { basicAuth } from 'hono/basic-auth'
export function mount(app: Hono, base: string) {
  app.use(\`\${base}/*\`, basicAuth({ username: 'a', password: 'b' }))
  app.get('/public', (c) => c.text('ok'))
}
`,
  })
  const route = graph.nodes.find((n) => n.kind === 'entry')
  assert.equal(route?.ref, `route:GET /\${app}/public`)
  assert.deepEqual(edges(graph, `route:GET /\${app}/public`, 'chain'), [])
  assert.deepEqual(facts(graph, `route:GET /\${app}/public`, 'guard'), [])
})

test('only a middleware short-circuits: a function that calls a callback it was given does not', async () => {
  const graph = await indexed({
    'app.ts': `
import type { Context, Next } from 'hono'
export async function auth(c: Context, next: Next) {
  if (!c.req.header('Authorization')) return c.text('no', 401)
  await next()
}
export function retry(task: () => void, done: () => void) {
  if (task.length > 1) return
  done()
}
`,
  })
  assert.deepEqual(facts(graph, 'app.ts#auth', 'signal'), ['short-circuit'])
  assert.deepEqual(facts(graph, 'app.ts#retry', 'signal'), [])
})
