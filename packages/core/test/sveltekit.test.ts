import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalisePattern } from '../src/entries.ts'
import {
  detectProfile,
  type Graph,
  indexTs,
  loadLibrary,
  loadProfiles,
  profilesDir,
  readFolder,
  TsProgram,
  typeSymbol,
} from '../src/index.ts'

// The two SvelteKit profiles (D32): routes read from the file tree, the hooks, matchers and
// layouts in front of them, the request event's reads, checks of `locals` as guards, and the
// types JavaScript states in its documentation comments.

const fixture = new URL('fixtures/sveltekitapp', import.meta.url).pathname
// What the build derives a remote module's path from, which the index writes as an expression.
const remote = `/_app/remote/$${'{hash(src/lib/todos.remote.ts)}'}`

const index = async (): Promise<Graph> => {
  const snapshot = await readFolder(fixture)
  const detection = detectProfile(snapshot.files, await loadProfiles(profilesDir))
  assert.ok('profile' in detection, 'refused' in detection ? detection.refused : '')
  assert.deepEqual(detection.profile.sources, ['sveltekit/application'])
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

test('a folder of the route tree is a path, with its groups, parameters and escapes', () => {
  const path = (id: string) => normalisePattern(id, 'brackets').path
  assert.equal(path('/'), '/')
  assert.equal(path('/(app)/items/[id=integer]'), '/items/{id}')
  assert.equal(path('/api/[[lang]]/files/[...path]'), '/api/{lang}/files/{path...}')
  assert.equal(path('/events/[MMMM]-[YYYY]'), '/events/{MMMM}-{YYYY}')
  assert.equal(path('/docs/raw/[...slug].md'), '/docs/raw/{slug...}.md')
  assert.equal(path('/[x+2e]well-known'), '/.well-known')
})

test("routes are the exports of the route tree's files, the remote functions' and the actions'", async () => {
  const graph = await index()
  const routes = graph.nodes
    .filter((n) => n.kind === 'entry')
    .map((n) => `${n.ref} ${n.file}:${n.startLine}`)
    .sort()
  assert.deepEqual(routes, [
    'route:ANY /api/{lang}/files/{path...} src/routes/api/[[lang]]/files/[...path]/+server.ts:14',
    `route:GET ${remote}/getTodos src/lib/todos.remote.ts:4`,
    'route:GET /admin src/routes/(app)/admin/+page@.server.ts:3',
    'route:GET /api/{lang}/files/{path...} src/routes/api/[[lang]]/files/[...path]/+server.ts:5',
    'route:GET /health src/routes/health/+server.ts:1',
    'route:GET /items/{id} src/routes/(app)/items/[id=integer]/+page.server.ts:5',
    'route:GET /login src/routes/login/+page.server.ts:6',
    'route:GET /reports src/routes/(app)/reports/+page.server.ts:3',
    'route:GET /reports~2 src/routes/(app)/reports/+server.ts:1',
    `route:POST ${remote}/addTodo src/lib/todos.remote.ts:9`,
    'route:POST /api/{lang}/files/{path...} src/routes/api/[[lang]]/files/[...path]/+server.ts:10',
    'route:POST /items/{id} src/routes/(app)/items/[id=integer]/+page.server.ts:11',
    'route:POST /items/{id}?/remove src/routes/(app)/items/[id=integer]/+page.server.ts:21',
    'route:POST /items/{id}?/rename src/routes/(app)/items/[id=integer]/+page.server.ts:16',
    'route:POST /login src/routes/login/+page.server.ts:11',
    'route:POST /login?/forgot src/routes/login/shared.ts:2',
  ])
  // Actions spread from an object another module holds are routes too.
  assert.deepEqual(edges(graph, 'route:POST /login?/forgot', 'handles'), [
    'src/routes/login/shared.ts#shared.forgot',
  ])
  // `export { upload as POST }` names the function it exports.
  assert.deepEqual(edges(graph, 'route:POST /api/{lang}/files/{path...}', 'handles'), [
    'src/routes/api/[[lang]]/files/[...path]/+server.ts#upload',
  ])
  // A page's server `load` and its universal one serve its `GET`.
  assert.deepEqual(edges(graph, 'route:GET /items/{id}', 'handles'), [
    'src/routes/(app)/items/[id=integer]/+page.server.ts#load',
    'src/routes/(app)/items/[id=integer]/+page.ts#load',
  ])
})

test("a route's chain is the hooks, a sequence seen through, its matchers, then its layouts", async () => {
  const graph = await index()
  const hooks = [
    'src/hooks.ts#reroute',
    'src/hooks.server.ts#session',
    'src/hooks.server.ts#logger',
  ]
  assert.deepEqual(edges(graph, 'route:GET /items/{id}', 'chain'), [
    ...hooks,
    'src/params/integer.ts#match',
    'src/routes/+layout.server.ts#load',
    'src/routes/(app)/+layout.server.ts#load',
  ])
  // Actions run before any `load`: no layout is in front of them.
  assert.deepEqual(edges(graph, 'route:POST /items/{id}?/rename', 'chain'), [
    ...hooks,
    'src/params/integer.ts#match',
  ])
  // `+page@` resets the page to the root layout.
  assert.deepEqual(edges(graph, 'route:GET /admin', 'chain'), [
    ...hooks,
    'src/routes/+layout.server.ts#load',
  ])
  // A layout's own reset keeps it, and drops the layouts between it and the root.
  assert.deepEqual(edges(graph, 'route:GET /reports', 'chain'), [
    ...hooks,
    'src/routes/+layout.server.ts#load',
    'src/routes/(app)/reports/+layout@.server.ts#load',
  ])
  // An endpoint beside a page answers its `GET` apart, without the layouts.
  assert.deepEqual(edges(graph, 'route:GET /reports~2', 'chain'), hooks)
  assert.deepEqual(edges(graph, 'route:GET /health', 'chain'), hooks)
})

test('the request event is read through what each function destructures, and its documentation', async () => {
  const graph = await index()
  const own = (ref: string, decl: string) =>
    [
      ...new Set(
        graph.facts
          .filter((f) => f.node === ref && f.kind === 'read' && f.data?.via === decl)
          .map((f) => f.value),
      ),
    ].sort()
  const files = 'src/routes/api/[[lang]]/files/[...path]/+server.ts'
  assert.deepEqual(own('route:GET /api/{lang}/files/{path...}', `${files}#GET`), [
    'path.path',
    'query.q',
  ])
  // `clientOf` is JavaScript, its parameter typed by its comment.
  assert.deepEqual(
    own('route:GET /api/{lang}/files/{path...}', 'src/lib/server/address.js#clientOf'),
    ['remoteaddr'],
  )
  const page = 'src/routes/(app)/items/[id=integer]/+page.server.ts'
  assert.deepEqual(own('route:POST /items/{id}?/rename', `${page}#actions.rename`), [
    'context.user',
    'form',
    'path.id',
  ])
  assert.deepEqual(own('route:GET /admin', 'src/routes/(app)/admin/+page@.server.ts#load'), [
    'cookie.theme',
  ])
  // A remote function reads the event `getRequestEvent` gives.
  assert.deepEqual(own(`route:POST ${remote}/addTodo`, 'src/lib/todos.remote.ts#addTodo/fn1'), [
    'cookie.session',
  ])
  // The hooks read the request and set `locals`.
  assert.ok(facts(graph, 'route:GET /health', 'read').includes('remoteaddr'))
  assert.ok(facts(graph, 'route:GET /health', 'signal').includes('retained-mutation'))
})

test('a check of locals.user guards its route, and the one action without it diverges', async () => {
  const graph = await index()
  for (const ref of [
    'route:GET /items/{id}',
    'route:POST /items/{id}',
    'route:POST /items/{id}?/rename',
  ])
    assert.deepEqual(facts(graph, ref, 'guard'), ['authn'], ref)
  assert.deepEqual(facts(graph, 'route:POST /items/{id}?/remove', 'guard'), [])
  // `if (locals.user) redirect(…)` sends a user home: it checks a user is there, guarding nothing.
  assert.deepEqual(facts(graph, 'route:GET /login', 'guard'), [])
  const divergent = (ref: string) =>
    graph.facts.find((f) => f.node === ref && f.value === 'divergent-guard')?.data?.missing
  assert.deepEqual(divergent('route:POST /items/{id}?/remove'), ['authn'])
  // The page that resets past the `(app)` layout has neither its redirect nor a check of its own.
  assert.deepEqual(divergent('route:GET /admin'), ['authn'])
  // `session` answers a request without a user on its own: every route has it in front.
  assert.ok(facts(graph, 'route:GET /health', 'signal').includes('short-circuit'))
  // better-auth's session lookup is a data read, its handler's calls are data writes.
  assert.ok(facts(graph, 'route:POST /items/{id}', 'signal').includes('data-write'))
})

test('JavaScript states types in its comments: parameters, casts, imports and results', async () => {
  const source = `/** @import { Thing } from './thing.js' */
/** @typedef {{ request: Request }} Input */

/**
 * @param {Request} request
 * @param {{ url: URL }} options
 * @returns {Thing}
 */
export function handle(request, { url }) {
  const event = /** @type {import('@sveltejs/kit').RequestEvent<{ id: string }>} */ (make());
  /** @type {Input} */
  const input = make();
  return [request, url, event, input.request];
}

export const check = (/** @type {Request} */ r) => r;
export const made = handle(check(new Request('/')), { url: new URL('/') });
`
  const files = [
    { path: 'package.json', source: '{ "name": "fixture" }' },
    { path: 'src/thing.js', source: 'export class Thing {}\n' },
    { path: 'src/a.js', source },
  ].map((f) => ({ ...f, mode: '100644' as const, hash: '', size: f.source.length }))
  const program = await TsProgram.load(files, { library: await loadLibrary('typescript') })
  try {
    const file = program.file('src/a.js')
    assert.ok(file)
    const types = (name: string) =>
      file.tree.rootNode
        .descendantsOfType(['identifier', 'member_expression'])
        .filter((n) => n?.text === name)
        .map((n) => typeSymbol(program.typeOf(n as never, file)) ?? null)
    assert.deepEqual(types('request'), ['globalThis#Request', 'globalThis#Request'])
    assert.deepEqual(types('url'), ['globalThis#URL'])
    assert.deepEqual(types('event'), ['@sveltejs/kit#RequestEvent', '@sveltejs/kit#RequestEvent'])
    assert.deepEqual(types('input.request'), ['globalThis#Request'])
    assert.deepEqual(types('r').at(-1), 'globalThis#Request')
    // `@returns` and `@import`: a class of the target, named by its package.
    assert.deepEqual(types('made'), ['fixture#Thing'])
  } finally {
    program.dispose()
  }
})
