import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonical, extractGo, type GoFile } from '../src/index.ts'

const go = (...lines: string[]) => lines.join('\n')

async function callsFrom(files: GoFile[], from: string) {
  const { graph } = await extractGo(files, { module: 'example.com/m' })
  return graph.edges
    .filter((e) => e.kind === 'calls' && e.from === from && !e.data?.literal)
    .map((e) => [e.to, e.data?.resolution])
}

const types = go(
  'package a',
  'type Mux struct{}',
  'type Context struct{}',
  'func (m *Mux) Reset() {}',
  'func (c *Context) Reset() {}',
  'func (c *Context) Close() {}',
  'func newContext() (*Context, error) { return nil, nil }',
)

test('the nearest declaration in scope types a variable', async () => {
  const code = go(
    'package a',
    'func f(ok bool) {',
    '  if ok {',
    '    x := &Mux{}',
    '    x.Reset()',
    '  }',
    '  x := &Context{}',
    '  x.Reset()',
    '  go func() { x := &Mux{}; _ = x }()',
    '  x.Reset()',
    '}',
  )
  const files = [
    { path: 'types.go', source: types },
    { path: 'f.go', source: code },
  ]
  assert.deepEqual(await callsFrom(files, 'f.go#f'), [
    ['types.go#Mux.Reset', 'resolved'],
    ['types.go#Context.Reset', 'resolved'],
    ['types.go#Context.Reset', 'resolved'],
  ])
})

test('a shadowing variable of unknown type hides the outer one', async () => {
  const code = go(
    'package a',
    'func f(x *Mux, items []*Mux) {',
    '  for _, x := range items { x.Close() }',
    '}',
  )
  const files = [
    { path: 'types.go', source: types },
    { path: 'f.go', source: code },
  ]
  // `x` is the range variable, not the `*Mux` parameter: `Close` is a guess, not `Mux.Close`.
  assert.deepEqual(await callsFrom(files, 'f.go#f'), [['types.go#Context.Close', 'guessed']])
})

test('each name of a multi-value assignment takes its own result type', async () => {
  const code = go(
    'package a',
    'func f() {',
    '  ctx, err := newContext()',
    '  ctx.Reset()',
    '  err.Reset()',
    '}',
  )
  const files = [
    { path: 'types.go', source: types },
    { path: 'f.go', source: code },
  ]
  // `err` is an `error`, which the module does not declare: no method of `Context` is resolved
  // for it, and `Reset` has two candidates, so it is not guessed either.
  assert.deepEqual(await callsFrom(files, 'f.go#f'), [
    ['types.go#newContext', 'resolved'],
    ['types.go#Context.Reset', 'resolved'],
  ])
})

test('a local variable shadowing an imported package is not the package', async () => {
  const code = go(
    'package a',
    'import "log"',
    'type Logger struct{}',
    'func (l *Logger) Info(m string) {}',
    'func f() {',
    '  log := &Logger{}',
    '  log.Info("x")',
    '}',
    'func g() { log.Print("x") }',
  )
  const files = [{ path: 'f.go', source: code }]
  assert.deepEqual(await callsFrom(files, 'f.go#f'), [['f.go#Logger.Info', 'resolved']])
  assert.deepEqual(await callsFrom(files, 'f.go#g'), [['ext:log#Print', 'resolved']])
})

test('a package of the module is known by the name its package clause declares', async () => {
  const files = [
    { path: 'http-utils/write.go', source: go('package httputil', 'func Write() {}') },
    {
      path: 'main.go',
      source: go(
        'package main',
        'import "example.com/m/http-utils"',
        'func main() { httputil.Write() }',
      ),
    },
  ]
  assert.deepEqual(await callsFrom(files, 'main.go#main'), [
    ['http-utils/write.go#Write', 'resolved'],
  ])
})

test('build variants are guesses, and the graph does not depend on file order', async () => {
  const files = [
    { path: 'sock_unix.go', source: go('package a', 'func listen() {}') },
    { path: 'sock_windows.go', source: go('package a', 'func listen() {}') },
    { path: 'main.go', source: go('package a', 'func serve() { listen() }') },
  ]
  assert.deepEqual(await callsFrom(files, 'main.go#serve'), [
    ['sock_unix.go#listen', 'guessed'],
    ['sock_windows.go#listen', 'guessed'],
  ])
  const forward = canonical((await extractGo(files, { module: 'example.com/m' })).graph)
  const backward = canonical(
    (await extractGo([...files].reverse(), { module: 'example.com/m' })).graph,
  )
  assert.deepEqual(backward, forward)
})

test('fields of a nested struct do not belong to the outer struct', async () => {
  const code = go(
    'package a',
    'type Inner struct{}',
    'func (i *Inner) Run() {}',
    'type Other struct{}',
    'func (o *Other) Stop() {}',
    'type Outer struct {',
    '  opts struct { db *Inner }',
    '  db *Other',
    '}',
    'func (o *Outer) f() { o.db.Stop() }',
  )
  assert.deepEqual(await callsFrom([{ path: 'a.go', source: code }], 'a.go#Outer.f'), [
    ['a.go#Other.Stop', 'resolved'],
  ])
})

test('a call through an interface is a guess to each type that implements it', async () => {
  const code = go(
    'package a',
    'type Store interface { Get(id string) string; Put(id string) }',
    'type Mem struct{}',
    'func (m *Mem) Get(id string) string { return "" }',
    'func (m *Mem) Put(id string) {}',
    'type Disk struct{}',
    'func (d *Disk) Get(id string) string { return "" }',
    'func (d *Disk) Put(id string) {}',
    'type Half struct{}',
    'func (h *Half) Get(id string) string { return "" }',
    'func use(s Store) { s.Get("x") }',
  )
  const { graph } = await extractGo([{ path: 'a.go', source: code }], { module: 'example.com/m' })
  const edges = graph.edges
    .filter((e) => e.kind === 'calls' && e.from === 'a.go#use')
    .map((e) => [e.to, e.data?.reason])
  // `Half` lacks `Put`, so it does not implement `Store`.
  assert.deepEqual(edges, [
    ['a.go#Disk.Get', 'Disk implements Store'],
    ['a.go#Mem.Get', 'Mem implements Store'],
  ])
})

test('a function that returns a method value reaches it; one that stores it does not', async () => {
  const code = go(
    'package a',
    'type C struct{}',
    'func (c *C) Handle() {}',
    'func Wrap() func() { c := &C{}; return c.Handle }',
    'type Mux struct{ h func() }',
    'func (m *Mux) route() {}',
    'func (m *Mux) Register() { m.h = m.route }',
  )
  assert.deepEqual(await callsFrom([{ path: 'a.go', source: code }], 'a.go#Wrap'), [
    ['a.go#C.Handle', 'resolved'],
  ])
  assert.deepEqual(await callsFrom([{ path: 'a.go', source: code }], 'a.go#Mux.Register'), [])
})

test('a call to a package variable holding a function is a guess to what it is assigned', async () => {
  const code = go(
    'package a',
    'var Default func() func()',
    'func init() { Default = Build("x") }',
    'func Build(s string) func() { return func() {} }',
    'func Use() { Default() }',
  )
  const { graph } = await extractGo([{ path: 'a.go', source: code }], { module: 'example.com/m' })
  const edges = graph.edges
    .filter((e) => e.kind === 'calls' && e.from === 'a.go#Use')
    .map((e) => [e.to, e.data?.resolution, e.data?.reason])
  assert.deepEqual(edges, [['a.go#Build', 'guessed', 'Default is assigned Build("x")']])
})
