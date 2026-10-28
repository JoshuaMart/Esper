import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Home, profilesDir } from '@esper/core'
import { tools } from '@esper/mcp'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { parse } from 'yaml'

// `esper mcp <project>` over stdio, as an agent sees it: the server and nothing else.

const run = promisify(execFile)
const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const fixture = new URL('../../core/test/fixtures/chiapp/', import.meta.url).pathname
const writes = tools.filter((t) => t.writes).map((t) => t.name)

async function agent(home: string, project: string, ...options: string[]) {
  const client = new Client({ name: 'hunter', version: '0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [main, 'mcp', project, ...options],
      env: { ESPER_HOME: home, PATH: process.env.PATH ?? '' },
      stderr: 'pipe',
    }),
  )
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    const [content] = result.content as { text: string }[]
    if (result.isError) throw new Error(content?.text)
    // The text an agent reads is the structured answer.
    assert.deepEqual(JSON.parse(content?.text ?? ''), result.structuredContent)
    // biome-ignore lint/suspicious/noExplicitAny: answers are checked against their output schema
    return result.structuredContent as any
  }
  return { client, call }
}

test('esper mcp serves one project over stdio; --read-only exposes no tool that writes', async () => {
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-home-')))
  const dir = await mkdtemp(join(tmpdir(), 'esper-target-'))
  // A client left open keeps its server waiting on stdin, and the test with it.
  const closing: Client[] = []
  try {
    await cp(fixture, dir, { recursive: true })
    await home.add(dir, { name: 'shop' })
    const writer = await agent(home.dir, 'shop')
    closing.push(writer.client)
    const all = (await writer.client.listTools()).tools.map((t) => t.name)
    assert.ok(writes.every((name) => all.includes(name)))
    assert.equal((await writer.call('esper_index')).stats.entries, 10)
    await writer.call('esper_note_create', {
      kind: 'context',
      body: 'admin routes',
      anchors: ['route:GET /admin'],
      author: 'hunter',
    })
    await writer.client.close()

    const reader = await agent(home.dir, 'shop', '--read-only')
    closing.push(reader.client)
    const tools = (await reader.client.listTools()).tools.map((t) => t.name)
    assert.deepEqual(
      tools.filter((name) => writes.includes(name)),
      [],
    )
    assert.match(reader.client.getInstructions() ?? '', /read-only/)
    assert.equal((await reader.call('esper_notes')).total, 1)
    await assert.rejects(
      reader.call('esper_note_create', {
        kind: 'lead',
        body: 'x',
        anchors: ['main.go#main'],
        author: 'x',
      }),
      /esper_note_create/,
    )
    await reader.client.close()

    await assert.rejects(
      run(process.execPath, [main, 'mcp', 'nope'], {
        env: { ...process.env, ESPER_HOME: home.dir },
      }),
      (error: { code: number; stderr: string }) =>
        error.code === 1 && /no project named nope/.test(error.stderr),
    )
    await assert.rejects(run(process.execPath, [main, 'mcp']), { code: 2 })
    await assert.rejects(run(process.execPath, [main, 'index', 'shop', '--read-only']), { code: 2 })
  } finally {
    for (const client of closing) await client.close()
    await rm(dir, { recursive: true })
    await rm(home.dir, { recursive: true })
  }
})

// The roadmap's check for M2, on chi 5.3.2 at the commit it was counted at: an agent, given only
// the MCP server, lists the entry points by read and signal, follows a path to a guard, writes a
// lead and a coverage note, and finds them after a reindex.
const targets = process.env.ESPER_TARGETS
const chi = targets ? join(targets, 'chi') : undefined
const present = chi ? await stat(join(chi, '.git')).catch(() => undefined) : undefined

test('an agent hunts chi over MCP, and its notes survive a reindex', {
  skip: present ? false : 'set ESPER_TARGETS and run pnpm fetch-targets',
}, async () => {
  const count = parse(
    await readFile(join(profilesDir, 'chi/counts/chi@38939062c5df.yaml'), 'utf8'),
  ) as {
    commit: string
  }
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-home-')))
  try {
    await home.add(chi as string, { name: 'chi' })
    const { client, call } = await agent(home.dir, 'chi')
    try {
      const indexed = await call('esper_index', { ref: count.commit })
      assert.equal(indexed.stats.entries, 40)

      // Entry points by read and by signal.
      const forwarded = await call('esper_entrypoints', { read: 'header.X-Forwarded-For' })
      assert.deepEqual(
        forwarded.entrypoints.map((e: { ref: string }) => e.ref),
        ['entry:middleware/realip.go#RealIP'],
      )
      const mutating = await call('esper_entrypoints', {
        read: 'header',
        signal: 'retained-mutation',
      })
      assert.deepEqual(
        mutating.entrypoints.map((e: { ref: string }) => e.ref),
        ['entry:middleware/nocache.go#NoCache', 'entry:middleware/realip.go#RealIP'],
      )
      const sinks = await call('esper_entrypoints', { signal: 'sink-reachable' })
      assert.deepEqual(
        sinks.entrypoints.map((e: { ref: string }) => e.ref),
        ['entry:middleware/profiler.go#Profiler', 'entry:middleware/strip.go#RedirectSlashes'],
      )

      // A path to a guard: BasicAuth refuses a request without calling the next handler.
      const toGuard = await call('esper_paths', {
        from: 'entry:middleware/basic_auth.go#BasicAuth',
        toFact: { kind: 'signal', value: 'short-circuit' },
      })
      const path = toGuard.paths[0]
      assert.deepEqual(
        path.steps.map((s: { ref: string }) => s.ref),
        [
          'entry:middleware/basic_auth.go#BasicAuth',
          'middleware/basic_auth.go#BasicAuth',
          'middleware/basic_auth.go#BasicAuth/fn1',
          'middleware/basic_auth.go#BasicAuth/fn1/fn1',
        ],
      )
      assert.ok(path.steps.slice(1).every((s: { citation?: string }) => s.citation))
      const guard = await call('esper_node', { node: path.steps.at(-1).ref })
      const stop = guard.facts.find((f: { value: string }) => f.value === 'short-circuit')
      const [file, line] = stop.citation.split(':')
      // The fact cites the return that skips the next handler; the lines above it say why.
      const code = await call('esper_read', {
        file,
        startLine: Number(line) - 2,
        endLine: Number(line),
      })
      assert.match(code.text, /if !ok \{\n\t+basicAuthFailed\(w, realm\)\n\t+return/)

      // A line of RealIP outside its literal names it, the first one included.
      for (const line of [28, 36]) {
        assert.equal(
          (await call('esper_node', { node: `middleware/realip.go:${line}` })).node.ref,
          'middleware/realip.go#RealIP',
        )
      }

      // A lead and a coverage note.
      const lead = await call('esper_note_create', {
        kind: 'lead',
        body: 'RealIP trusts `X-Forwarded-For` from any client.',
        anchors: ['entry:middleware/realip.go#RealIP'],
        citations: ['middleware/realip.go:49'],
        author: 'hunter',
      })
      const coverage = await call('esper_note_create', {
        kind: 'coverage',
        body: 'BasicAuth: credentials compared in constant time; no bypass found.',
        anchors: ['middleware/basic_auth.go#BasicAuth/fn1/fn1'],
        author: 'hunter',
      })
      assert.deepEqual([lead.note.status, coverage.note.status], ['open', null])

      // A long file is read in bounded pieces.
      const long = await call('esper_read', { file: 'tree.go', endLine: 2000 })
      assert.deepEqual([long.endLine, long.totalLines, long.truncated], [500, 925, true])

      // Reindexed, the notes are still there, attached.
      const again = await call('esper_index', { ref: count.commit, force: true })
      assert.deepEqual(again.notes, { attached: 2, moved: 0, stale: 0, orphaned: 0 })
      const notes = await call('esper_notes', { snapshot: again.snapshot.id })
      assert.deepEqual(
        notes.notes.map((n: { kind: string; state: string }) => [n.kind, n.state]),
        [
          ['lead', 'attached'],
          ['coverage', 'attached'],
        ],
      )
    } finally {
      await client.close()
    }
  } finally {
    await rm(home.dir, { recursive: true })
  }
})
