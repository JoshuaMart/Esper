import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { promisify } from 'node:util'
import { Home } from '@esper/core'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { bounds, Connection, createServer, tools } from '../src/index.ts'

// The MCP tools over a copy of the chi fixture, indexed at two versions through esper_index.

const run = promisify(execFile)
const fixture = new URL('../../core/test/fixtures/chiapp/', import.meta.url).pathname

let dir: string
let home: Home
let git: (...args: string[]) => Promise<unknown>

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'esper-mcp-target-'))
  home = new Home(await mkdtemp(join(tmpdir(), 'esper-mcp-home-')))
  await cp(fixture, dir, { recursive: true })
  git = (...args: string[]) =>
    run('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  await git('init', '--quiet')
  await git('add', '.')
  await git('commit', '--quiet', '-m', 'v1')
  await git('tag', 'v1')
  await home.add(dir, { name: 'shop' })
})

after(async () => {
  await rm(dir, { recursive: true })
  await rm(home.dir, { recursive: true })
})

async function connect(options: { readOnly?: boolean } = {}) {
  const connection = new Connection(home, 'shop')
  const server = createServer(connection, options)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    if (result.isError) {
      const [content] = result.content as { text: string }[]
      throw new Error(content?.text)
    }
    // Every answer says whether it was cut, and what was.
    const out = result.structuredContent as Record<string, unknown>
    assert.equal(typeof out.truncated, 'boolean', `${name} says whether it was cut`)
    assert.ok(Array.isArray(out.cut), `${name} says what was cut`)
    assert.equal(out.truncated, (out.cut as string[]).length > 0)
    // biome-ignore lint/suspicious/noExplicitAny: answers are checked against their output schema
    return out as any
  }
  return {
    client,
    call,
    close: async () => {
      await client.close()
      connection.close()
    },
  }
}

// What the read-only tests leave out is what the tools say about themselves; which ones write is
// checked once against D13's table.
const writes = tools.filter((t) => t.writes).map((t) => t.name)

test('each tool has an input and an output schema, and every output says when it was cut', async () => {
  const { client, close } = await connect()
  const listed = (await client.listTools()).tools
  assert.deepEqual(writes, [
    'esper_index',
    'esper_note_create',
    'esper_note_update',
    'esper_note_delete',
  ])
  assert.deepEqual(listed.map((t) => t.name).sort(), tools.map((t) => t.name).sort())
  for (const tool of listed) {
    assert.equal(tool.inputSchema.type, 'object', tool.name)
    const properties = Object.keys(tool.outputSchema?.properties ?? {})
    assert.ok(properties.includes('truncated') && properties.includes('cut'), tool.name)
    assert.equal(tool.annotations?.readOnlyHint, !writes.includes(tool.name), tool.name)
  }
  await close()
})

test('a read-only connection exposes no tool that writes, and cannot call one', async () => {
  const { client, call, close } = await connect({ readOnly: true })
  const names = (await client.listTools()).tools.map((t) => t.name)
  assert.deepEqual(
    names.filter((n) => writes.includes(n)),
    [],
  )
  assert.equal(names.length, tools.length - writes.length)
  for (const name of writes) {
    await assert.rejects(call(name, { id: 1, author: 'x' }), new RegExp(name))
  }
  await close()
})

test('the tools read a snapshot indexed over MCP, within their bounds', async () => {
  const { call, close } = await connect()
  await assert.rejects(call('esper_entrypoints'), /has no snapshot yet; esper_index/)
  await assert.rejects(call('esper_index', { ref: '--output=/tmp/x' }), /is not a git ref/)
  // A ref that does not exist is refused in one line, without git's command or the folder.
  await assert.rejects(call('esper_index', { ref: 'no-such-ref' }), (error: Error) => {
    assert.equal(error.message, 'no-such-ref is not a commit, tag or branch of the repository')
    return true
  })
  const indexed = await call('esper_index', { ref: 'v1' })
  assert.deepEqual(
    [indexed.snapshot.ref, indexed.unchanged, indexed.stats.entries],
    ['v1', false, 10],
  )
  assert.equal((await call('esper_index', { ref: 'v1' })).unchanged, true)

  const all = await call('esper_entrypoints')
  assert.deepEqual([all.total, all.truncated], [10, false])
  const page = await call('esper_entrypoints', { limit: 3, offset: 3 })
  assert.equal(page.entrypoints.length, 3)
  assert.equal(page.truncated, true)
  assert.match(page.cut[0], /3 of 10 shown from 3/)
  await assert.rejects(
    call('esper_entrypoints', { limit: bounds.entrypoints.max + 1 }),
    /Too big|less than or equal/,
  )

  const byRead = await call('esper_entrypoints', { read: 'header.authorization' })
  assert.deepEqual(
    byRead.entrypoints.map((e: { ref: string }) => e.ref),
    ['route:GET /api/users', 'route:GET /api/users/{id}', 'route:POST /api/users'],
  )
  const byChain = await call('esper_entrypoints', { chain: 'mw.go#Audit', method: 'delete' })
  assert.deepEqual(byChain.entrypoints[0].chain, [
    'ext:github.com/go-chi/chi/v5/middleware#RealIP',
    'mw/mw.go#Logger',
    'mw/mw.go#RequireAdmin',
    'mw/mw.go#Audit',
  ])
  assert.equal((await call('esper_entrypoints', { withoutGuard: 'any' })).total, 10)

  const node = await call('esper_node', { node: 'route:GET /api/users/{id}' })
  assert.deepEqual(node.entry.handlers, ['routes/users.go#Users.get'])
  assert.ok(node.facts.some((f: { value: string }) => f.value === 'path.id'))
  assert.equal(node.excerpt.text, '\tr.Get("/{id}", u.get)')
  const get = await call('esper_node', { node: 'routes/users.go:28', excerptLines: 1 })
  assert.equal(get.node.ref, 'routes/users.go#Users.get')
  assert.match(get.cut[0], /excerpt: lines 27 to 27 of 30/)
  await assert.rejects(call('esper_node', { node: 'nowhere' }), /no node nowhere; esper_search/)

  const callees = await call('esper_callees', { node: 'route:GET /api/users/{id}', depth: 2 })
  assert.deepEqual(
    callees.nodes.map((n: { ref: string; depth: number; edge: string }) => [
      n.ref,
      n.depth,
      n.edge,
    ]),
    [
      ['ext:github.com/go-chi/chi/v5/middleware#RealIP', 1, 'chain'],
      ['mw/mw.go#Logger', 1, 'chain'],
      ['mw/mw.go#RequireUser', 1, 'chain'],
      ['routes/users.go#Users.get', 1, 'handles'],
      ['mw/mw.go#RequireUser/fn1', 2, 'calls'],
      ['ext:github.com/go-chi/chi/v5#URLParam', 2, 'calls'],
      ['routes/users.go#load', 2, 'calls'],
    ],
  )
  const one = await call('esper_callees', { node: 'route:GET /api/users/{id}', limit: 1 })
  assert.deepEqual([one.nodes.length, one.total, one.truncated], [1, 4, true])
  const callers = await call('esper_callers', { node: 'load', depth: 3 })
  assert.deepEqual(
    callers.nodes.map((n: { ref: string }) => n.ref),
    ['routes/users.go#Users.get', 'route:GET /api/users/{id}'],
  )

  const paths = await call('esper_paths', {
    from: 'route:GET /api/users',
    toFact: { kind: 'read', value: 'header.Authorization' },
  })
  assert.deepEqual(
    paths.paths[0].steps.map((s: { ref: string; edge?: string }) => [s.ref, s.edge]),
    [
      ['route:GET /api/users', undefined],
      ['mw/mw.go#RequireUser', 'chain'],
      ['mw/mw.go#RequireUser/fn1', 'calls'],
      ['mw/mw.go#RequireUser/fn1/fn1', 'calls'],
    ],
  )
  const short = await call('esper_paths', { from: 'route:GET /api/users', to: 'load', depth: 1 })
  assert.deepEqual(short.paths, [])
  await assert.rejects(call('esper_paths', { from: 'load' }), /give either to/)

  const search = await call('esper_search', { query: 'require', limit: 1 })
  assert.deepEqual(
    [search.nodes[0].ref, search.total, search.truncated],
    [
      'mw/mw.go#RequireAdmin',
      // RequireAdmin, RequireUser and the two literals inside RequireUser.
      4,
      true,
    ],
  )
  const files = await call('esper_search', { query: 'users', kinds: ['file'] })
  assert.deepEqual(
    files.nodes.map((n: { ref: string }) => n.ref),
    ['routes/users.go'],
  )

  const read = await call('esper_read', { file: 'mw/mw.go', startLine: 5, endLine: 5 })
  assert.deepEqual(
    [read.text, read.totalLines],
    ['func Logger(next http.Handler) http.Handler { return next }', 19],
  )
  const head = await call('esper_read', { file: 'routes/users.go' })
  assert.deepEqual([head.startLine, head.endLine, head.truncated], [1, 39, false])
  for (const file of ['../go.mod', '/etc/hosts', 'go.mod', 'nope.go']) {
    await assert.rejects(call('esper_read', { file }), /has no file/)
  }
  await close()
})

test('notes are written over MCP, and after a reindex on another version each has an anchor state that esper_diff reports', async () => {
  const { call, close } = await connect()
  const first = (await call('esper_index', { ref: 'v1' })).snapshot.id
  const note = async (anchor: string, kind = 'lead') =>
    (
      await call('esper_note_create', {
        kind,
        body: `about ${anchor}`,
        anchors: [anchor],
        author: 'hunter',
      })
    ).note
  const kept = await note('routes/users.go#Users.list', 'coverage')
  const edited = await note('routes/users.go#Users.get')
  const renamed = await note('mw/mw.go#Audit')
  const removed = await note('routes/users.go#DeleteUser', 'finding')
  const route = await note('route:GET /api/users/{id}')
  assert.deepEqual(
    [kept.status, edited.status, removed.status, kept.state],
    [null, 'open', 'open', 'attached'],
  )
  const cited = await call('esper_note_create', {
    kind: 'context',
    body: 'the router mounts users here',
    anchors: ['routes/users.go:15'],
    citations: ['routes/users.go:19'],
    author: 'hunter',
  })
  assert.deepEqual(cited.note.anchors[0].ref, 'routes/users.go#Users.RegisterRoutes')
  await assert.rejects(
    call('esper_note_create', {
      kind: 'lead',
      body: 'x',
      anchors: ['load'],
      author: 'h',
      citations: ['routes/users.go:900'],
    }),
    /has lines 1 to/,
  )

  // v2: Users.get changes, Audit is renamed, DeleteUser is removed.
  const edit = async (path: string, from: string, to: string) => {
    const file = join(dir, path)
    const text = await readFile(file, 'utf8')
    assert.ok(text.includes(from), `${path} has ${from}`)
    await writeFile(file, text.replace(from, to))
  }
  await edit('routes/users.go', '\tload(id)\n', '\tload(id)\n\tload(id)\n')
  await edit('routes/users.go', 'func DeleteUser(w http.ResponseWriter, r *http.Request) {}\n', '')
  await edit('main.go', 'routes.DeleteUser', 'adminHome')
  await edit('mw/mw.go', 'func Audit(', 'func Record(')
  await edit('main.go', 'mw.Audit', 'mw.Record')
  await git('commit', '--quiet', '-am', 'v2')
  await git('tag', 'v2')
  const second = await call('esper_index', { ref: 'v2' })
  assert.deepEqual(second.notes, { attached: 2, moved: 1, stale: 2, orphaned: 1 })

  const states = await call('esper_notes')
  assert.equal(states.total, 6)
  assert.deepEqual(
    states.notes.map((n: { id: number; state: string; anchors: { node: string | null }[] }) => [
      n.id,
      n.state,
      n.anchors[0]?.node,
    ]),
    [
      [kept.id, 'attached', 'routes/users.go#Users.list'],
      [edited.id, 'stale', 'routes/users.go#Users.get'],
      [renamed.id, 'moved', 'mw/mw.go#Record'],
      [removed.id, 'orphaned', null],
      [route.id, 'stale', 'route:GET /api/users/{id}'],
      [cited.note.id, 'attached', 'routes/users.go#Users.RegisterRoutes'],
    ],
  )
  const stale = await call('esper_notes', { anchorState: 'stale' })
  assert.deepEqual(
    stale.notes.map((n: { id: number }) => n.id),
    [edited.id, route.id],
  )
  const onRecord = await call('esper_notes', { node: 'Record' })
  assert.deepEqual(
    onRecord.notes.map((n: { id: number }) => n.id),
    [renamed.id],
  )
  // On v1, nothing moved.
  assert.equal((await call('esper_notes', { snapshot: first, anchorState: 'attached' })).total, 6)

  const diff = await call('esper_diff')
  assert.deepEqual(
    diff.notes.map((n: { id: number; from: string; to: string }) => [n.id, n.from, n.to]),
    [
      [edited.id, 'attached', 'stale'],
      [renamed.id, 'attached', 'moved'],
      [removed.id, 'attached', 'orphaned'],
      [route.id, 'attached', 'stale'],
    ],
  )
  assert.deepEqual(diff.entrypoints.added, [])
  assert.deepEqual(diff.entrypoints.removed, [])
  assert.deepEqual(
    diff.entrypoints.changed.map((c: { ref: string; code: boolean }) => [c.ref, c.code]),
    [
      ['route:DELETE /admin/users/{id}', true],
      ['route:GET /api/users/{id}', true],
    ],
  )
  const one = await call('esper_diff', { limit: 1 })
  assert.equal(one.truncated, true)

  // Reviewed: anchored again on v2, the stale note is attached; its revisions are kept.
  await call('esper_note_update', {
    id: edited.id,
    author: 'reviewer',
    status: 'ruled-out',
    anchors: ['routes/users.go#Users.get'],
  })
  const deleted = await call('esper_note_delete', {
    id: removed.id,
    author: 'reviewer',
    reason: 'gone',
  })
  assert.equal(deleted.note.deleted.by, 'reviewer')
  const history = (await call('esper_notes', { id: edited.id })).notes[0]
  assert.deepEqual(
    [history.state, history.status, history.revisions.map((r: { action: string }) => r.action)],
    ['attached', 'ruled-out', ['create', 'update']],
  )
  assert.equal((await call('esper_notes')).total, 5)
  assert.equal((await call('esper_notes', { includeDeleted: true })).total, 6)

  const snapshots = await call('esper_snapshots')
  assert.deepEqual(
    snapshots.snapshots.map((s: { ref: string; notes: Record<string, number> }) => [
      s.ref,
      s.notes,
    ]),
    [
      ['v2', { attached: 3, moved: 1, stale: 1, orphaned: 0 }],
      // Anchored again on v2, the reviewed note is stale when read on v1.
      ['v1', { attached: 4, moved: 0, stale: 1, orphaned: 0 }],
    ],
  )
  await close()
})
