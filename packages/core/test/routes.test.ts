import assert from 'node:assert/strict'
import { glob, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  indexGo,
  joinPath,
  loadProfiles,
  modulePath,
  normalisePattern,
  resolveProfile,
} from '../src/index.ts'

const root = new URL('fixtures/chiapp/', import.meta.url)

async function app() {
  const files = []
  for await (const path of glob('**/*.go', { cwd: root.pathname })) {
    files.push({ path, source: await readFile(new URL(path, root), 'utf8') })
  }
  const profiles = await loadProfiles(new URL('../../../profiles', import.meta.url).pathname)
  const chi = profiles.find((p) => p.name === 'chi' && p.kind === 'application')
  assert.ok(chi)
  const goMod = await readFile(new URL('go.mod', root), 'utf8')
  return indexGo(files, { module: modulePath(goMod) ?? '', profile: resolveProfile(chi, profiles) })
}

test('patterns are normalised, and paths joined without trailing slashes', () => {
  assert.deepEqual(normalisePattern('/users/{id:[0-9]+}/*', 'braces'), {
    path: '/users/{id}/{rest...}',
  })
  assert.deepEqual(normalisePattern('GET /items/{id}', 'servemux'), {
    method: 'GET',
    path: '/items/{id}',
  })
  assert.deepEqual(normalisePattern('/files/', 'servemux'), { path: '/files/{rest...}' })
  assert.equal(joinPath('/api', '/'), '/api')
  assert.equal(joinPath('', '/'), '/')
  assert.equal(joinPath('/a/', '/b/'), '/a/b')
})

test('routes get the full path of the routers they are mounted under', async () => {
  const { graph } = await app()
  const entries = graph.nodes.filter((n) => n.kind === 'entry').map((n) => n.ref)
  assert.deepEqual(entries, [
    'route:ANY /files/{rest...}',
    'route:ANY /ping',
    'route:ANY /static/{rest...}',
    'route:DELETE /admin/users/{id}',
    'route:GET /admin',
    'route:GET /api/users',
    'route:GET /api/users/{id}',
    'route:GET /health',
    'route:GET /items/{id}',
    'route:POST /api/users',
  ])
})

test('a route inherits the chain of every router above it, in order', async () => {
  const { graph } = await app()
  const chain = (ref: string) =>
    graph.edges
      .filter((e) => e.kind === 'chain' && e.from === ref)
      .sort((a, b) => Number(a.data?.position) - Number(b.data?.position))
      .map((e) => e.to)
  assert.deepEqual(chain('route:GET /api/users/{id}'), [
    'ext:github.com/go-chi/chi/v5/middleware#RealIP',
    'mw/mw.go#Logger',
    'mw/mw.go#RequireUser',
  ])
  assert.deepEqual(chain('route:DELETE /admin/users/{id}'), [
    'ext:github.com/go-chi/chi/v5/middleware#RealIP',
    'mw/mw.go#Logger',
    'mw/mw.go#RequireAdmin',
    'mw/mw.go#Audit',
  ])
})

test('handlers are resolved through method values and adapters', async () => {
  const { graph } = await app()
  const handler = (ref: string) =>
    graph.edges.filter((e) => e.kind === 'handles' && e.from === ref).map((e) => e.to)
  assert.deepEqual(handler('route:GET /api/users/{id}'), ['routes/users.go#Users.get'])
  assert.deepEqual(handler('route:GET /health'), ['main.go#health'])
  assert.deepEqual(handler('route:GET /items/{id}'), ['mux.go#plain/fn1'])
  assert.deepEqual(handler('route:ANY /static/{rest...}'), ['ext:net/http#FileServer'])
})

test('an entry reads what its handler and its chain read', async () => {
  const { graph } = await app()
  const reads = (ref: string) =>
    graph.facts
      .filter((f) => f.kind === 'read' && f.node === ref)
      .map((f) => [f.value, f.data?.from])
      .sort()
  assert.deepEqual(reads('route:GET /api/users/{id}'), [
    ['header.Authorization', 'chain'],
    ['path.id', 'handler'],
  ])
  assert.deepEqual(reads('route:GET /api/users'), [
    ['header.Authorization', 'chain'],
    ['query.page', 'handler'],
  ])
  assert.deepEqual(reads('route:POST /api/users'), [
    ['body', 'handler'],
    ['header.Authorization', 'chain'],
  ])
  assert.deepEqual(reads('route:GET /items/{id}'), [['path.id', 'handler']])
})

test('a router parameter no call binds keeps its routes under an explicit unknown prefix', async () => {
  const profiles = await loadProfiles(new URL('../../../profiles', import.meta.url).pathname)
  const chi = profiles.find((p) => p.name === 'chi' && p.kind === 'application')
  assert.ok(chi)
  const source = [
    'package main',
    'import (',
    '  "net/http"',
    '  "github.com/go-chi/chi/v5"',
    ')',
    'type Handler interface { RegisterRoutes(r chi.Router) }',
    'type Board struct{}',
    'func (b *Board) RegisterRoutes(router chi.Router) {',
    '  r := chi.NewRouter()',
    '  r.Get("/", b.index)',
    '  router.Mount("/board", r)',
    '}',
    'func (b *Board) index(w http.ResponseWriter, r *http.Request) {}',
    'func main() {',
    '  root := chi.NewRouter()',
    '  var h Handler = pick()',
    '  h.RegisterRoutes(root)',
    '}',
    'func pick() Handler { return &Board{} }',
  ].join('\n')
  const { graph } = await indexGo([{ path: 'main.go', source }], {
    module: 'example.com/app',
    profile: resolveProfile(chi, profiles),
  })
  const entries = graph.nodes.filter((n) => n.kind === 'entry').map((n) => n.ref)
  assert.deepEqual(entries, [`route:GET /\${router}/board`])
})
