import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  detectProfile,
  type Graph,
  indexPy,
  loadProfiles,
  parseToml,
  profilesDir,
  python,
  readFolder,
} from '../src/index.ts'

// Python and the FastAPI profiles (D36 to D39): routes declared by decorators, included routers and
// their prefixes, Starlette's route objects, middleware outermost first, dependencies as the chain
// and the guards, and what parameters read.

const fixture = new URL('fixtures/fastapiapp', import.meta.url).pathname

const index = async (): Promise<Graph> => {
  const snapshot = await readFolder(fixture)
  assert.deepEqual(
    snapshot.skips.map((s) => `${s.path} ${s.reason}`),
    ['alembic/ migrations', 'tests/ tests'],
  )
  const detection = detectProfile(snapshot.files, await loadProfiles(profilesDir))
  assert.ok('profile' in detection, 'refused' in detection ? detection.refused : '')
  assert.deepEqual(detection.profile.sources, ['starlette/application', 'fastapi/application'])
  return (await indexPy(snapshot.files, { modules: detection.modules, profile: detection.profile }))
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

test('a project declares its dependencies in pyproject.toml, its groups included', () => {
  const toml = parseToml(
    '[project]\nname = "Shop_App"\ndependencies = [\n  "fastapi>=0.115", # web\n  "psycopg[binary]>=3",\n]\n[tool.poetry.dependencies]\npython = "^3.12"\nhttpx = { version = "*" }\n',
  )
  assert.deepEqual(toml.project, {
    name: 'Shop_App',
    dependencies: ['fastapi>=0.115', 'psycopg[binary]>=3'],
  })
  const modules = python.modules([
    {
      path: 'pyproject.toml',
      source:
        '[project]\nname = "Shop_App"\ndependencies = ["fastapi>=0.115"]\n[dependency-groups]\ndev = ["pytest"]\n',
    },
    { path: 'worker/requirements.txt', source: '# jobs\nCelery[redis]==5.4\n-r base.txt\n' },
  ] as never)
  assert.deepEqual(modules, [
    { path: 'shop-app', dir: '.', requires: ['fastapi', 'pytest'] },
    { path: 'worker', dir: 'worker', requires: ['celery'] },
  ])
})

test('routes are the decorated functions of included routers, and the route objects of a list', async () => {
  const graph = await index()
  const routes = graph.nodes
    .filter((n) => n.kind === 'entry')
    .map((n) => `${n.ref} ${n.file}:${n.startLine}`)
    .sort()
  assert.deepEqual(routes, [
    'route:GET /api/items src/shop/routers/items.py:12',
    'route:GET /api/items/sync src/shop/routers/items.py:35',
    'route:GET /api/items/{item_id} src/shop/routers/items.py:17',
    'route:GET /healthz src/shop/legacy.py:11',
    'route:GET /ping src/shop/legacy.py:11',
    'route:POST /api/items src/shop/routers/items.py:22',
    'route:POST /api/items/export src/shop/routers/items.py:30',
    'route:PUT /api/items/sync src/shop/routers/items.py:35',
    'route:WEBSOCKET /ws src/shop/main.py:35',
  ])
  assert.deepEqual(edges(graph, 'route:GET /ping', 'handles'), ['src/shop/legacy.py#ping'])
})

test("a route's chain is the middleware, then its routers' dependencies, then its own, each after its own", async () => {
  const graph = await index()
  assert.deepEqual(edges(graph, 'route:POST /api/items', 'chain'), [
    // Added last, so outermost.
    'src/shop/main.py#timing',
    'ext:starlette.middleware.cors#CORSMiddleware',
    // The router's, then the decorator's, whose own come first.
    'src/shop/deps.py#tenant',
    'src/shop/deps.py#get_db',
    'ext:fastapi.security.oauth2#OAuth2PasswordBearer',
    'src/shop/deps.py#current_user',
    'src/shop/deps.py#admin',
  ])
  // The application's middleware only, for a Starlette route.
  assert.deepEqual(edges(graph, 'route:GET /ping', 'chain'), [
    'src/shop/main.py#timing',
    'ext:starlette.middleware.cors#CORSMiddleware',
  ])
})

test('guards are the security schemes, and the dependencies that refuse with 401 or 403', async () => {
  const graph = await index()
  // `OAuth2PasswordBearer`, and `NotSignedIn`, which the exception handler answers with 401.
  assert.deepEqual(facts(graph, 'route:GET /api/items/{item_id}', 'guard'), ['authn'])
  // `admin` raises `HTTPException(status.HTTP_403_FORBIDDEN)`.
  assert.deepEqual(facts(graph, 'route:POST /api/items', 'guard'), ['authn', 'authz-role'])
  assert.deepEqual(facts(graph, 'route:GET /ping', 'guard'), [])
})

test('parameters read the path, the query, a header, the body, by what they declare', async () => {
  const graph = await index()
  const reads = (ref: string) => facts(graph, ref, 'read').filter((r) => r !== 'header.x-blocked')
  assert.deepEqual(reads('route:GET /api/items'), ['header.x-tenant-id', 'query.search'])
  assert.deepEqual(reads('route:GET /api/items/{item_id}'), ['header.x-tenant-id', 'path.item_id'])
  assert.deepEqual(reads('route:POST /api/items'), ['body', 'header.x-tenant-id'])
  assert.deepEqual(reads('route:POST /api/items/export'), ['header.x-tenant-id', 'query.fmt'])
  // A Starlette endpoint receives the request; a websocket handler its websocket.
  assert.deepEqual(reads('route:GET /ping'), ['header.user-agent', 'remoteaddr'])
  assert.deepEqual(reads('route:WEBSOCKET /ws'), ['query.token'])
})

test('signals: a model spread into an ORM model, a request value in SQL text, a process', async () => {
  const graph = await index()
  const signals = (ref: string) => facts(graph, ref, 'signal')
  assert.ok(signals('route:POST /api/items').includes('mass-assignment'))
  assert.ok(signals('route:POST /api/items').includes('data-write'))
  assert.ok(signals('route:GET /api/items').includes('request-key'))
  const sinks = graph.facts
    .filter((f) => f.kind === 'sink')
    .map((f) => `${f.value} ${f.citation.file}:${f.citation.line}`)
    .sort()
  assert.deepEqual(sinks, [
    'process src/shop/routers/items.py:32',
    'sql src/shop/routers/items.py:14',
    'sql src/shop/routers/items.py:14',
  ])
  // The middleware answers on its own before `call_next`.
  assert.ok(signals('route:GET /ping').includes('short-circuit'))
})

test('declarations are named by what holds them, and imports follow `__init__` re-exports', async () => {
  const graph = await index()
  const decls = graph.nodes
    .filter((n) => n.kind === 'decl' && n.file === 'src/shop/deps.py')
    .map((n) => n.ref)
    .sort()
  assert.deepEqual(decls, [
    'src/shop/deps.py#NotSignedIn',
    'src/shop/deps.py#admin',
    'src/shop/deps.py#current_user',
    'src/shop/deps.py#get_db',
    'src/shop/deps.py#tenant',
  ])
  const imports = graph.edges
    .filter((e) => e.kind === 'imports' && e.from === 'src/shop/main.py')
    .map((e) => e.to)
    .sort()
  assert.ok(imports.includes('src/shop/routers/__init__.py'))
  assert.ok(imports.includes('ext:fastapi'))
  // The route's handler is reached through `shop.routers`' re-export of `items.router`.
  assert.deepEqual(edges(graph, 'route:GET /api/items', 'handles'), [
    'src/shop/routers/items.py#list_items',
  ])
})
