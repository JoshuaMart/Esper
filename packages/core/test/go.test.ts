import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { defaultPackageName, extractGo, fingerprint, modulePath, parse } from '../src/index.ts'

const fixture = (path: string) =>
  readFile(new URL(`fixtures/module/${path}`, import.meta.url), 'utf8')

async function shop() {
  const files = await Promise.all(
    ['api/routes.go', 'store/db.go'].map(async (path) => ({ path, source: await fixture(path) })),
  )
  return extractGo(files, { module: modulePath(await fixture('go.mod')) ?? '' })
}

const calls = (graph: Awaited<ReturnType<typeof shop>>['graph'], from: string) =>
  graph.edges
    .filter((e) => e.kind === 'calls' && e.from === from)
    .map((e) => [e.to, e.data?.resolution, e.data?.reason])

test('names declarations by file, receiver, rank and ordinal', async () => {
  const { graph } = await shop()
  const refs = graph.nodes.filter((n) => n.kind === 'decl').map((n) => n.ref)
  assert.deepEqual(refs, [
    'api/routes.go#Server.Routes',
    'api/routes.go#Server.getItem',
    'api/routes.go#writeJSON',
    'api/routes.go#init',
    'api/routes.go#init~2',
    'api/routes.go#Server.Routes/fn1',
    'store/db.go#DB.Find',
    'store/db.go#DB.Save',
    'store/db.go#Name',
  ])
})

test('resolves calls within the module and names external ones by import path', async () => {
  const { graph } = await shop()
  assert.deepEqual(calls(graph, 'api/routes.go#Server.getItem'), [
    ['ext:github.com/go-chi/chi/v5#URLParam', 'resolved', undefined],
    ['store/db.go#DB.Find', 'resolved', undefined],
    ['api/routes.go#writeJSON', 'resolved', undefined],
  ])
  assert.deepEqual(calls(graph, 'api/routes.go#writeJSON'), [
    ['store/db.go#Name', 'resolved', undefined],
  ])
})

test('types a call by its declared result, and guesses when nothing states a type', async () => {
  const files = [
    {
      path: 'a.go',
      source: [
        'package a',
        'import "net/http"',
        'type T struct{}',
        'func (t T) Run() {}',
        'func (t T) Get(k string) {}',
        'func f(x any) { x.(T).Run(); g().Run() }',
        'func g() T { return T{} }',
        'func h(w http.ResponseWriter) { w.Header().Get("a") }',
      ].join('\n'),
    },
  ]
  const { graph } = await extractGo(files, { module: 'example.com/a' })
  assert.deepEqual(calls(graph, 'a.go#f'), [
    ['a.go#T.Run', 'guessed', 'receiver type unknown; T.Run is the only method named Run'],
    ['a.go#T.Run', 'resolved', undefined],
    ['a.go#g', 'resolved', undefined],
  ])
  // A value from a package outside the module has none of the module's methods: `Get` on the
  // header is not guessed to be `T.Get`.
  assert.deepEqual(calls(graph, 'a.go#h'), [
    ['ext:net/http#ResponseWriter.Header', 'resolved', undefined],
  ])
})

test('reaches a literal through the function that defines it', async () => {
  const { graph } = await shop()
  assert.deepEqual(calls(graph, 'api/routes.go#Server.Routes'), [
    ['api/routes.go#Server.Routes/fn1', 'resolved', undefined],
    ['ext:github.com/go-chi/chi/v5#NewRouter', 'resolved', undefined],
  ])
  const literal = calls(graph, 'api/routes.go#Server.Routes/fn1').map(([to]) => to)
  assert.deepEqual(literal, ['store/db.go#DB.Save', 'ext:net/http#Request.FormValue'])
})

test('imports point to the files of an internal package, or to an external node', async () => {
  const { graph } = await shop()
  const imports = graph.edges.filter((e) => e.kind === 'imports').map((e) => e.to)
  assert.deepEqual(imports, ['ext:net/http', 'store/db.go', 'ext:github.com/go-chi/chi/v5'])
})

test('a fingerprint ignores comments and whitespace, not tokens', async () => {
  const isComment = (n: { type: string }) => n.type === 'comment'
  const print = async (code: string) => fingerprint((await parse('go', code)).rootNode, isComment)
  const base = await print('package a\nfunc f() { g(1) }\n')
  assert.equal(await print('package a\n// note\nfunc f() {\n\tg(1)\n}\n'), base)
  assert.notEqual(await print('package a\nfunc f() { g(2) }\n'), base)
})

test('default package names drop major versions', () => {
  assert.equal(defaultPackageName('github.com/go-chi/chi/v5'), 'chi')
  assert.equal(defaultPackageName('gopkg.in/yaml.v3'), 'yaml')
  assert.equal(defaultPackageName('net/http'), 'http')
})

test("a declaration's fingerprint leaves its own name out, so that a renamed function is found again", async () => {
  const print = async (source: string) => {
    const { graph } = await extractGo([{ path: 'a.go', source }], { module: 'x' })
    return graph.nodes.find((n) => n.kind === 'decl')?.fingerprint
  }
  const base = await print('package a\nfunc f() { g(1) }\n')
  assert.equal(await print('package a\nfunc h() { g(1) }\n'), base)
  assert.notEqual(await print('package a\nfunc f() { g(2) }\n'), base)
  // A function that calls itself names itself in its body: renaming it changes its code.
  assert.notEqual(
    await print('package a\nfunc f() { f() }\n'),
    await print('package a\nfunc h() { h() }\n'),
  )
})
