import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Graph, loadLibrary, parseJsonc, Resolver, TsProgram } from '../src/index.ts'

// The TypeScript and JavaScript call graph: references (D7), imports resolved through the target's
// own tsconfig paths and packages, and calls resolved where the syntax states what a name is.

const graphOf = async (files: Record<string, string>): Promise<Graph> => {
  const program = await TsProgram.load(
    Object.entries(files).map(([path, source]) => ({ path, source })),
    { library: await loadLibrary('typescript') },
  )
  try {
    return program.callGraph().graph
  } finally {
    program.dispose()
  }
}

const calls = (graph: Graph, from: string) =>
  graph.edges
    .filter((e) => e.kind === 'calls' && e.from === from)
    .map((e) => `${e.to}${e.data?.resolution === 'guessed' ? ' (guessed)' : ''}`)
    .sort()

test('declarations are named by what holds them, anonymous ones by their parent and rank', async () => {
  const graph = await graphOf({
    'src/app.ts': `
export function handler(c) { return [1].map((x) => x) }
export const helper = async (c) => c
export class Service {
  constructor(private db: Db) {}
  get name() { return 'x' }
  update(id) { return this.db }
  #secret() {}
  field = () => 1
}
export const actions = { create() {}, nested: { remove: () => 1 } }
export const auth = wrap(async (c, next) => next())
export default function () {}
function init() {}
function init() {}
`,
  })
  const decls = graph.nodes
    .filter((n) => n.kind === 'decl')
    .map(
      (n) => `${n.ref}${n.data?.literal ? ' literal' : ''}${n.data?.exported ? ' exported' : ''}`,
    )
    .sort()
  assert.deepEqual(decls, [
    'src/app.ts#Service exported',
    'src/app.ts#Service.#secret',
    'src/app.ts#Service.constructor exported',
    'src/app.ts#Service.field exported',
    'src/app.ts#Service.name exported',
    'src/app.ts#Service.update exported',
    'src/app.ts#actions.create exported',
    'src/app.ts#actions.nested.remove exported',
    'src/app.ts#auth/fn1 exported',
    'src/app.ts#default exported',
    'src/app.ts#handler exported',
    'src/app.ts#handler/fn1 literal',
    'src/app.ts#helper exported',
    'src/app.ts#init',
    'src/app.ts#init~2',
  ])
  // A literal is reached through the function that defines it.
  assert.deepEqual(calls(graph, 'src/app.ts#handler'), ['src/app.ts#handler/fn1'])
})

test("a declaration's fingerprint leaves its name out, whatever holds it", async () => {
  const before = await graphOf({ 'a.ts': 'export const audit = (c) => c.req.path\n' })
  const after = await graphOf({ 'a.ts': 'export const record = (c) => c.req.path\n' })
  const print = (g: Graph, ref: string) => g.nodes.find((n) => n.ref === ref)?.fingerprint
  assert.ok(print(before, 'a.ts#audit'))
  assert.equal(print(before, 'a.ts#audit'), print(after, 'a.ts#record'))
})

test("imports resolve through tsconfig paths, the target's packages, `.js` names and re-exports", async () => {
  const files = [
    {
      path: 'tsconfig.json',
      source: '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } }, }',
    },
    { path: 'package.json', source: '{ "name": "app" }' },
    {
      path: 'packages/db/package.json',
      source: '{ "name": "@app/db", "exports": { ".": "./dist/index.js" } }',
    },
    { path: 'packages/db/src/index.ts', source: "export { find } from './find.js'\n" },
    { path: 'packages/db/src/find.ts', source: 'export function find(id) { return id }\n' },
    { path: 'src/lib/index.ts', source: 'export const ok = () => 1\n' },
    {
      path: 'src/main.ts',
      source:
        "import { find } from '@app/db'\nimport { ok } from '@/lib'\nimport * as fs from 'fs'\nexport function run(id) { find(id); ok(); fs.readFileSync(id) }\n",
    },
  ]
  const resolver = new Resolver(
    files,
    files.map((f) => f.path).filter((p) => p.endsWith('.ts')),
  )
  assert.deepEqual(resolver.resolve('src/main.ts', '@app/db'), { file: 'packages/db/src/index.ts' })
  assert.deepEqual(resolver.resolve('src/main.ts', '@/lib'), { file: 'src/lib/index.ts' })
  assert.deepEqual(resolver.resolve('packages/db/src/index.ts', './find.js'), {
    file: 'packages/db/src/find.ts',
  })
  assert.deepEqual(resolver.resolve('src/main.ts', 'fs'), { external: 'node:fs' })
  assert.deepEqual(resolver.resolve('src/main.ts', 'hono/cors'), { external: 'hono/cors' })
  assert.deepEqual(parseJsonc('{ "a": "//x", /* c */ "b": [1,], }'), { a: '//x', b: [1] })

  const graph = await graphOf(Object.fromEntries(files.map((f) => [f.path, f.source])))
  assert.deepEqual(calls(graph, 'src/main.ts#run'), [
    'ext:node:fs#readFileSync',
    'packages/db/src/find.ts#find',
    'src/lib/index.ts#ok',
  ])
})

test('a call is resolved from what the syntax states, and guessed only with a reason', async () => {
  const graph = await graphOf({
    'src/store.ts': `
import type { Context } from 'hono'
export class Store {
  find(id: string) { return this.load(id) }
  load(id: string) { return id }
}
export interface Repo { save(): void }
export class SqlRepo implements Repo { save() {} }
export function use(c: Context, repo: Repo, value) {
  const store = new Store()
  store.find('1')
  c.json({})
  repo.save()
  value.load('x')
  value.map((x) => x)
}
`,
  })
  assert.deepEqual(calls(graph, 'src/store.ts#Store.find'), ['src/store.ts#Store.load'])
  // `new Store()` calls the class, which declares no constructor.
  assert.deepEqual(calls(graph, 'src/store.ts#use'), [
    'ext:hono#Context.json',
    'src/store.ts#SqlRepo.save (guessed)',
    'src/store.ts#Store',
    'src/store.ts#Store.find',
    'src/store.ts#Store.load (guessed)',
    'src/store.ts#use/fn1',
  ])
  const reasons = graph.edges
    .filter((e) => e.from === 'src/store.ts#use' && e.data?.resolution === 'guessed')
    .map((e) => e.data?.reason)
    .sort()
  assert.deepEqual(reasons, [
    'SqlRepo implements Repo',
    'receiver type unknown; Store.load is the only member named load',
  ])
})

test('a type looked up before a profile gives the parameter its type is looked up again after', async () => {
  const program = await TsProgram.load(
    [{ path: 'a.ts', source: 'export const h = (c) => c.req.path\n' }],
    {
      library: await loadLibrary('typescript'),
    },
  )
  try {
    const file = program.file('a.ts')
    assert.ok(file)
    const fn = file.tree.rootNode.descendantsOfType('arrow_function')[0]
    const c = file.tree.rootNode
      .descendantsOfType('identifier')
      .find((n) => n?.text === 'c' && n.parent?.type === 'member_expression')
    assert.ok(fn && c)
    assert.equal(program.typeOf(c, file), undefined)
    program.giveParameter(fn, 0, { kind: 'external', module: 'hono', name: 'Context' })
    assert.deepEqual(program.typeOf(c, file), { kind: 'external', module: 'hono', name: 'Context' })
  } finally {
    program.dispose()
  }
})
