import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Home, Notes, type OsvRecording, recordedSource, Store } from '@esper/core'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { cookieName, serve, serverToken } from '../src/index.ts'

// `esper serve` as the interface and an agent see it: the token, the API, the event stream, and
// MCP over HTTP, on a small chi application.

const fixture = new URL('../../core/test/fixtures/chiapp/', import.meta.url).pathname
const token = 'a'.repeat(43)

async function started(web?: string, recording: OsvRecording = {}) {
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-home-')), {
    advisories: recordedSource(recording),
  })
  const dir = await mkdtemp(join(tmpdir(), 'esper-target-'))
  await cp(fixture, dir, { recursive: true })
  const server = await serve(home, { port: 0, token, ...(web ? { web } : {}) })
  const request = (path: string, init: RequestInit & { json?: unknown } = {}) =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    })
  // biome-ignore lint/suspicious/noExplicitAny: answers are read as the API documents them
  const json = async (path: string, init: RequestInit & { json?: unknown } = {}): Promise<any> => {
    const response = await request(path, init)
    const body = (await response.json()) as { error?: string }
    if (!response.ok) throw new Error(`${response.status} ${body.error}`)
    return body
  }
  const stop = async () => {
    await server.close()
    await rm(dir, { recursive: true })
    await rm(home.dir, { recursive: true })
  }
  return { home, dir, server, request, json, stop }
}

// Reads server-sent events until `until` accepts one, or fails after a while.
async function events(url: string, until: (event: string, data: unknown) => boolean) {
  const controller = new AbortController()
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  })
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let text = ''
  const ready = Promise.withResolvers<void>()
  const seen: { event: string; data: unknown }[] = []
  const done = (async () => {
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) throw new Error('the stream ended')
        text += decoder.decode(value, { stream: true })
        let end = text.indexOf('\n\n')
        while (end !== -1) {
          const block = text.slice(0, end)
          text = text.slice(end + 2)
          end = text.indexOf('\n\n')
          const event = block.match(/^event: (.*)$/m)?.[1]
          const data = block.match(/^data: (.*)$/m)?.[1]
          if (!event || data === undefined) continue
          if (event === 'ready') {
            ready.resolve()
            continue
          }
          seen.push({ event, data: JSON.parse(data) })
          if (until(event, JSON.parse(data))) return seen
        }
      }
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  })()
  await ready.promise
  return done
}

// fetch cannot set Host: a request of node:http can.
function status(port: number, path: string, headers: Record<string, string>) {
  return new Promise<number>((done, fail) => {
    get({ host: '127.0.0.1', port, path, headers }, (response) => {
      response.resume()
      done(response.statusCode ?? 0)
    }).once('error', fail)
  })
}

async function job(
  json: (path: string) => Promise<{ jobs: { id: number; state: string; result?: unknown }[] }>,
  id: number,
) {
  for (let i = 0; i < 100; i++) {
    const found = (await json('/api/jobs')).jobs.find((j) => j.id === id)
    if (found && found.state !== 'running') return found
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('the job did not finish')
}

test('the API and MCP need the token, and only localhost reaches them', async () => {
  const s = await started()
  try {
    assert.equal((await fetch(`${s.server.url}/api/projects`)).status, 401)
    assert.equal(
      (await fetch(`${s.server.url}/api/projects`, { headers: { authorization: 'Bearer nope' } }))
        .status,
      401,
    )
    assert.equal((await s.request('/api/projects')).status, 200)
    // DNS rebinding: a page on another name that resolves here.
    assert.equal(
      await status(s.server.port, '/api/projects', {
        host: 'evil.example',
        authorization: `Bearer ${token}`,
      }),
      403,
    )
    assert.equal(
      (await s.request('/api/projects', { headers: { origin: 'https://evil.example' } })).status,
      403,
    )
    assert.equal((await fetch(`${s.server.url}/mcp/shop`, { method: 'POST' })).status, 401)
    // Another server on this machine is the same site, and would send the cookie: its pages are
    // refused by their port.
    const port = s.server.port
    const elsewhere = `http://127.0.0.1:${port === 3000 ? 3001 : 3000}`
    assert.equal((await s.request('/api/projects', { headers: { origin: elsewhere } })).status, 403)
    assert.equal(
      (await s.request('/api/projects', { headers: { origin: s.server.url } })).status,
      200,
    )
    assert.equal((await s.request('/api/projects', { headers: { origin: 'null' } })).status, 403)
    // A body a page can send without asking first, text/plain, is refused.
    const plain = await s.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ source: s.dir, name: 'shop' }),
    })
    assert.equal(plain.status, 415)
    assert.deepEqual((await s.json('/api/projects')).projects, [])

    // The interface trades the token for a cookie that only this site sends.
    const session = await s.request('/api/session', { method: 'POST' })
    const cookie = session.headers.get('set-cookie') ?? ''
    assert.match(cookie, new RegExp(`^${cookieName}=`))
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Strict/)
    const withCookie = await fetch(`${s.server.url}/api/projects`, {
      headers: { cookie: cookie.split(';')[0] as string },
    })
    assert.equal(withCookie.status, 200)
  } finally {
    await s.stop()
  }
})

test('the token is kept in the home, readable by its owner only', async () => {
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-home-')), {
    advisories: recordedSource(),
  })
  try {
    const first = await serverToken(home)
    assert.equal(await serverToken(home), first)
    assert.match(first, /^[A-Za-z0-9_-]{43}$/)
    assert.equal((await stat(join(home.dir, 'token'))).mode & 0o777, 0o600)
  } finally {
    await rm(home.dir, { recursive: true })
  }
})

test('an auditor adds a project, indexes it, follows an entry point and writes a note', async () => {
  const s = await started()
  try {
    const added = await s.json('/api/projects', {
      method: 'POST',
      json: { source: s.dir, name: 'shop' },
    })
    assert.equal(added.project.name, 'shop')
    await assert.rejects(
      s.json('/api/projects', { method: 'POST', json: { source: s.dir, name: 'shop' } }),
      /400 a project named shop already exists/,
    )

    const started_ = await s.json('/api/projects/shop/index', { method: 'POST', json: {} })
    assert.equal(started_.job.state, 'running')
    const done = (await job(s.json, started_.job.id)) as unknown as {
      state: string
      result: { stats: { entries: number } }
    }
    assert.equal(done.state, 'done')
    assert.equal(done.result.stats.entries, 10)

    const list = await s.json('/api/projects')
    assert.equal(list.projects[0].snapshots, 1)
    assert.equal(list.projects[0].kind, 'application')

    const entries = await s.json('/api/projects/shop/entrypoints?method=GET')
    assert.ok(entries.entrypoints.some((e: { ref: string }) => e.ref === 'route:GET /admin'))
    await assert.rejects(
      s.json('/api/projects/shop/entrypoints?limit=lots'),
      /400 limit is a number/,
    )

    // What the entry point reaches, with every edge between drawn nodes.
    const drawn = await s.json(
      `/api/projects/shop/subgraph?node=${encodeURIComponent('route:GET /admin')}&depth=2`,
    )
    assert.equal(drawn.root, 'route:GET /admin')
    const refs = new Set(drawn.nodes.map((n: { ref: string }) => n.ref))
    assert.ok(drawn.edges.length > 0)
    for (const e of drawn.edges) assert.ok(refs.has(e.from) && refs.has(e.to))
    assert.ok(drawn.edges.some((e: { kind: string }) => e.kind === 'handles'))
    const small = await s.json(
      `/api/projects/shop/subgraph?node=${encodeURIComponent('route:GET /admin')}&depth=2&limit=1`,
    )
    assert.equal(small.nodes.length, 1)
    assert.equal(small.truncated, true)

    const node = await s.json(
      `/api/projects/shop/node?node=${encodeURIComponent('route:GET /admin')}`,
    )
    const handler = node.entry.handlers[0]
    const note = await s.json('/api/projects/shop/notes', {
      method: 'POST',
      json: { kind: 'lead', body: 'is /admin guarded?', anchors: [handler], author: 'joshua' },
    })
    assert.equal(note.note.state, 'attached')
    const edited = await s.json(`/api/projects/shop/notes/${note.note.id}`, {
      method: 'PATCH',
      json: { status: 'ruled-out', author: 'joshua' },
    })
    assert.equal(edited.note.status, 'ruled-out')
    assert.equal(
      (await s.json(`/api/projects/shop/notes?id=${note.note.id}`)).notes[0].revisions.length,
      2,
    )
    await s.json(`/api/projects/shop/notes/${note.note.id}`, {
      method: 'DELETE',
      json: { author: 'joshua', reason: 'duplicate' },
    })
    assert.equal((await s.json('/api/projects/shop/notes')).total, 0)

    assert.equal((await s.request('/api/projects/nope/entrypoints')).status, 404)
    // What does not exist is a 404, whatever the words of its refusal.
    assert.equal((await s.request('/api/projects/shop/node?node=nothing')).status, 404)
    assert.equal((await s.request('/api/projects/shop/read?file=nothing.go')).status, 404)
    assert.equal((await s.request('/api/projects/shop/notes?id=99')).status, 404)
    assert.equal((await s.request('/api/projects/shop/snapshots?limit=0')).status, 400)
  } finally {
    await s.stop()
  }
})

test('the map shows the code entry points share', async () => {
  const s = await started()
  try {
    await s.home.add(s.dir, { name: 'shop' })
    await s.home.index('shop')
    const all = await s.json('/api/projects/shop/entrypoints')
    const refs = all.entrypoints.map((e: { ref: string }) => e.ref)
    const map = await s.json('/api/projects/shop/map', {
      method: 'POST',
      json: { entries: refs, min: 2, library: 'all' },
    })
    assert.equal(map.entries.length, refs.length)
    for (const item of map.shared) {
      assert.ok(item.users.length >= 2)
      for (const u of item.users) assert.ok(refs.includes(u))
    }
    const none = await s.json('/api/projects/shop/map', {
      method: 'POST',
      json: { entries: refs, min: 2, library: 'none' },
    })
    assert.ok(none.shared.every((n: { kind: string }) => n.kind !== 'external'))
    await assert.rejects(
      s.json('/api/projects/shop/map', { method: 'POST', json: { entries: ['main.go#main'] } }),
      /400/,
    )
  } finally {
    await s.stop()
  }
})

test('a note an agent writes over MCP, or from another process, reaches the event stream', async () => {
  const s = await started()
  try {
    await s.home.add(s.dir, { name: 'shop' })
    await s.home.index('shop')

    const heard = events(`${s.server.url}/api/events`, (event, data) => {
      return event === 'note' && (data as { author: string }).author === 'hunter'
    })
    const client = new Client({ name: 'hunter', version: '0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${s.server.url}/mcp/shop`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    )
    try {
      const result = await client.callTool({
        name: 'esper_note_create',
        arguments: {
          kind: 'coverage',
          body: 'checked',
          anchors: ['route:GET /admin'],
          author: 'hunter',
        },
      })
      assert.notEqual(result.isError, true)
    } finally {
      await client.close()
    }
    const [note] = (await heard).filter((e) => e.event === 'note')
    assert.deepEqual(
      { ...(note?.data as Record<string, unknown>), at: undefined },
      {
        type: 'note',
        project: 'shop',
        id: 1,
        revision: 1,
        action: 'create',
        author: 'hunter',
        kind: 'coverage',
        at: undefined,
      },
    )

    // `esper mcp` runs in a process of its own: its writes are found in the database.
    await s.json('/api/projects/shop/notes')
    const other = events(`${s.server.url}/api/events`, (event, data) => {
      return event === 'note' && (data as { author: string }).author === 'elsewhere'
    })
    const store = new Store(s.home.database('shop'))
    try {
      new Notes(store).create({
        kind: 'context',
        body: 'written by another process',
        anchors: ['route:GET /admin'],
        author: 'elsewhere',
        snapshot: 1,
      })
    } finally {
      store.close()
    }
    assert.equal((await other).at(-1)?.event, 'note')
  } finally {
    await s.stop()
  }
})

test('the interface is served, and every other path falls back to it', async () => {
  const web = await mkdtemp(join(tmpdir(), 'esper-web-'))
  await mkdir(join(web, 'assets'))
  await writeFile(join(web, 'index.html'), '<!doctype html><title>Esper</title>')
  await writeFile(join(web, 'assets', 'app.js'), 'export {}')
  const secret = join(web, '..', 'outside.txt')
  const s = await started(web)
  try {
    const page = await fetch(`${s.server.url}/p/shop/notes`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /<title>Esper/)
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/)
    const script = await fetch(`${s.server.url}/assets/app.js`)
    assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.match(script.headers.get('cache-control') ?? '', /immutable/)
    // A path that climbs out of the folder gets the page, never a file outside it.
    await writeFile(secret, 'secret')
    const climbed = await fetch(`${s.server.url}/..%2Foutside.txt`)
    assert.doesNotMatch(await climbed.text(), /secret/)
    // A malformed escape is a path like any other: the page.
    const malformed = await fetch(`${s.server.url}/%E0%A4%A`)
    assert.equal(malformed.status, 200)
    assert.match(await malformed.text(), /<title>Esper/)
    assert.equal(
      (
        await fetch(`${s.server.url}/api/nothing`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
      404,
    )
  } finally {
    await s.stop()
    await rm(web, { recursive: true })
    await rm(secret, { force: true })
  }
})

test('the server reads the projects of the home it was given', async () => {
  // A guard against reading the default home in tests.
  const s = await started()
  try {
    assert.deepEqual((await s.json('/api/projects')).projects, [])
    assert.equal(await readFile(join(s.home.dir, 'token'), 'utf8').catch(() => 'none'), 'none')
  } finally {
    await s.stop()
  }
})

test('the advisories are listed, drawn on the nodes they affect, and fetched again as a job', async () => {
  const s = await started(undefined, {
    queries: {
      'Go:example.com/app': [
        {
          id: 'GO-2026-0002',
          summary: 'A flaw in RequireUser',
          database_specific: { severity: 'HIGH' },
          affected: [
            {
              package: { name: 'example.com/app', ecosystem: 'Go' },
              ecosystem_specific: {
                imports: [{ path: 'example.com/app/mw', symbols: ['RequireUser'] }],
              },
            },
          ],
        },
      ],
    },
  })
  try {
    await s.json('/api/projects', { method: 'POST', json: { source: s.dir, name: 'shop' } })
    const indexed = await s.json('/api/projects/shop/index', { method: 'POST', json: {} })
    const done = (await job(s.json, indexed.job.id)) as unknown as {
      result: { advisories: { advisories: number } }
    }
    assert.equal(done.result.advisories.advisories, 1)
    const list = await s.json('/api/projects/shop/advisories?precision=symbol')
    assert.deepEqual(
      list.advisories.map((a: { id: string; links: { node: string }[] }) => [
        a.id,
        a.links.map((l) => l.node),
      ]),
      [['GO-2026-0002', ['mw/mw.go#RequireUser']]],
    )
    await assert.rejects(
      s.json('/api/projects/shop/advisories?offline=maybe'),
      /400 offline is true or false/,
    )
    // A route behind the middleware reaches it: the drawing says so on its node.
    const drawn = await s.json(
      `/api/projects/shop/subgraph?node=${encodeURIComponent('route:GET /api/users/{id}')}&chain=true`,
    )
    const member = drawn.nodes.find((n: { ref: string }) => n.ref === 'mw/mw.go#RequireUser')
    assert.equal(member?.advisories, 1)
    // Fetched again from the interface: a job, and an event when the advisories change.
    const heard = events(`${s.server.url}/api/events`, (event) => event === 'advisories')
    await new Promise((r) => setTimeout(r, 100))
    const again = await s.json('/api/projects/shop/advisories', { method: 'POST', json: {} })
    assert.equal(again.job.action, 'advisories')
    const fetched = (await job(s.json, again.job.id)) as unknown as {
      state: string
      result: { advisories: number; linked: { symbol: number } }
    }
    assert.equal(fetched.state, 'done')
    assert.equal(fetched.result.linked.symbol, 1)
    const seen = await heard
    assert.deepEqual(seen.at(-1), {
      event: 'advisories',
      data: { type: 'advisories', project: 'shop' },
    })
    await assert.rejects(
      s.json('/api/projects/shop/advisories', { method: 'POST', json: { offline: true } }),
      /400 the body is \{\}/,
    )
  } finally {
    await s.stop()
  }
})

test('claims by a model are listed apart, counted on the nodes drawn, and heard as they are added', async () => {
  const s = await started()
  try {
    await s.json('/api/projects', { method: 'POST', json: { source: s.dir, name: 'shop' } })
    const indexed = await s.json('/api/projects/shop/index', {
      method: 'POST',
      json: { offline: true },
    })
    await job(s.json, indexed.job.id)
    const text = await readFile(join(s.dir, 'mw/mw.go'), 'utf8')
    const line = text.split('\n').findIndex((l) => l.includes('Authorization')) + 1
    const heard = events(`${s.server.url}/api/events`, (event) => event === 'claims')
    await new Promise((r) => setTimeout(r, 100))
    // An agent answers over MCP, from its own connection.
    const client = new Client({ name: 'enricher', version: '0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${s.server.url}/mcp/shop`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    )
    try {
      const result = await client.callTool({
        name: 'esper_claim_submit',
        arguments: {
          question: 'guard:mw/mw.go#RequireUser',
          value: 'yes',
          kind: 'authn',
          citations: [{ file: 'mw/mw.go', line, identifier: 'Authorization' }],
          model: 'claude-sonnet-5-5',
          author: 'enricher',
        },
      })
      assert.ok(!result.isError)
    } finally {
      await client.close()
    }
    const seen = await heard
    assert.deepEqual(seen.at(-1), {
      event: 'claims',
      data: { type: 'claims', project: 'shop', count: 1 },
    })
    const listed = await s.json(
      '/api/projects/shop/claims?node=mw/mw.go%23RequireUser&current=true',
    )
    assert.deepEqual(
      listed.claims.map((c: { value: string; model: string }) => [c.value, c.model]),
      [['yes', 'claude-sonnet-5-5']],
    )
    const drawn = await s.json(
      `/api/projects/shop/subgraph?node=${encodeURIComponent('route:GET /api/users/{id}')}`,
    )
    const member = drawn.nodes.find((n: { ref: string }) => n.ref === 'mw/mw.go#RequireUser')
    assert.equal(member?.claims, 1)
  } finally {
    await s.stop()
  }
})
