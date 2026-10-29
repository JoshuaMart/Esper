import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import pkg from '../package.json' with { type: 'json' }

const run = promisify(execFile)
const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))

test('esper --version runs from the sources', async () => {
  const { stdout } = await run(process.execPath, [main, '--version'])
  assert.equal(stdout.trim(), `esper-cli ${pkg.version}`)
})

test('esper refuses an unknown command', async () => {
  await assert.rejects(run(process.execPath, [main, 'nope']), { code: 2 })
})

test('esper refuses an unknown option', async () => {
  await assert.rejects(run(process.execPath, [main, '--readonly']), { code: 2 })
})

test('esper index takes --precise', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'esper-cli-home-'))
  try {
    await assert.rejects(
      run(process.execPath, [main, 'index', 'nope', '--precise'], {
        env: { ...process.env, ESPER_HOME: home },
      }),
      (error: { code: number; stderr: string }) => {
        assert.equal(error.code, 1)
        assert.match(error.stderr, /no project named nope/)
        return true
      },
    )
  } finally {
    await rm(home, { recursive: true })
  }
})

test('esper serve prints its address and token, and refuses a bad port', async () => {
  const { spawn } = await import('node:child_process')
  const { mkdtemp, rm, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'esper-cli-home-'))
  try {
    await assert.rejects(
      run(process.execPath, [main, 'serve', '--port', 'eighty'], {
        env: { ...process.env, ESPER_HOME: home },
      }),
      { code: 2 },
    )
    await assert.rejects(run(process.execPath, [main, 'serve', 'chi']), { code: 2 })
    const child = spawn(process.execPath, [main, 'serve', '--port', '0'], {
      env: { ...process.env, ESPER_HOME: home },
    })
    try {
      let out = ''
      await new Promise<void>((done, fail) => {
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk
          // The token's own line is the last: `<token>` in the MCP line comes before it.
          if (out.includes('(kept in')) done()
        })
        child.once('exit', () => fail(new Error(`esper serve exited: ${out}`)))
      })
      const url = out.match(/esper serve on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
      assert.ok(url)
      const token = (await readFile(join(home, 'token'), 'utf8')).trim()
      assert.match(out, new RegExp(token))
      const projects = await fetch(`${url}/api/projects`, {
        headers: { authorization: `Bearer ${token}` },
      })
      assert.deepEqual(await projects.json(), { projects: [] })
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise((done) => child.once('exit', done))
      }
    }
  } finally {
    await rm(home, { recursive: true })
  }
})

test('esper advisories asks OSV again, page by page; esper index --offline does not ask it', async () => {
  const { createServer } = await import('node:http')
  const { cp, mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'esper-cli-home-'))
  const dir = await mkdtemp(join(tmpdir(), 'esper-cli-target-'))
  await cp(fileURLToPath(new URL('../../core/test/fixtures/chiapp/', import.meta.url)), dir, {
    recursive: true,
  })
  const asked: { name: string; page: string | undefined }[] = []
  const entry = (id: string, severity: string) => ({
    id,
    summary: id,
    database_specific: { severity },
    affected: [{ package: { name: 'example.com/app', ecosystem: 'Go' } }],
  })
  // OSV's API, as far as Esper uses it: two pages for the module, nothing for the other package.
  const osv = createServer((request, response) => {
    let text = ''
    request.on('data', (chunk) => {
      text += chunk
    })
    request.on('end', () => {
      const body = JSON.parse(text || '{}') as { package?: { name: string }; page_token?: string }
      asked.push({ name: body.package?.name ?? request.url ?? '', page: body.page_token })
      const answer =
        body.package?.name !== 'example.com/app'
          ? {}
          : body.page_token
            ? { vulns: [entry('GHSA-bbbb-bbbb-bbbb', 'LOW')] }
            : { vulns: [entry('GHSA-aaaa-aaaa-aaaa', 'HIGH')], next_page_token: 'two' }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(answer))
    })
  })
  await new Promise<void>((done) => osv.listen(0, '127.0.0.1', done))
  const { port } = osv.address() as { port: number }
  const env = { ...process.env, ESPER_HOME: home, ESPER_OSV_URL: `http://127.0.0.1:${port}` }
  try {
    await run(
      process.execPath,
      [main, 'add', dir, '--name', 'app', '--package', 'example.com/extra'],
      {
        env,
      },
    )
    const offline = await run(process.execPath, [main, 'index', 'app', '--offline'], { env })
    assert.match(offline.stdout, /advisories {3}not fetched \(offline\); 0 kept from before/)
    assert.deepEqual(asked, [])
    const fetched = await run(process.execPath, [main, 'advisories', 'app'], { env })
    assert.match(fetched.stdout, /example\.com\/app \(Go\), example\.com\/extra \(Go\)/)
    assert.match(fetched.stdout, /1 kept \(1 high\), 1 low left out/)
    assert.match(fetched.stdout, /linked none; 1 unlinked/)
    assert.deepEqual(asked, [
      { name: 'example.com/app', page: undefined },
      { name: 'example.com/app', page: 'two' },
      { name: 'example.com/extra', page: undefined },
    ])
    await assert.rejects(run(process.execPath, [main, 'advisories', 'app', '--offline'], { env }), {
      code: 2,
    })
  } finally {
    osv.close()
    await rm(home, { recursive: true })
    await rm(dir, { recursive: true })
  }
})

test('esper enrich lists the questions it would ask, and refuses an unknown provider or tier', async () => {
  const { cp, mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'esper-cli-home-'))
  const dir = await mkdtemp(join(tmpdir(), 'esper-cli-target-'))
  await cp(fileURLToPath(new URL('../../core/test/fixtures/chiapp/', import.meta.url)), dir, {
    recursive: true,
  })
  const env = { ...process.env, ESPER_HOME: home }
  try {
    await run(process.execPath, [main, 'add', dir, '--name', 'app'], { env })
    await run(process.execPath, [main, 'index', 'app', '--offline'], { env })
    const dry = await run(
      process.execPath,
      [main, 'enrich', 'app', '--dry-run', '--kind', 'guard', '--limit', '3'],
      { env },
    )
    assert.match(dry.stdout, /app: snapshot 1, \d+ questions due in the bounded tier/)
    assert.match(
      dry.stdout,
      /would ask {4}3 \(3 guard\) in 1 call to claude-sonnet-5-5 through claude-code/,
    )
    assert.match(dry.stdout, /guard:mw\/mw\.go#Audit/)
    const exploring = await run(
      process.execPath,
      [main, 'enrich', 'app', '--dry-run', '--tier', 'exploring'],
      { env },
    )
    assert.match(exploring.stdout, /2 \(1 applications, 1 authentication\) in 2 calls/)
    for (const bad of [
      ['--provider', 'openai'],
      ['--tier', 'deep'],
      ['--kind', 'vibes'],
      ['--limit', '0'],
    ]) {
      await assert.rejects(run(process.execPath, [main, 'enrich', 'app', ...bad], { env }), {
        code: 2,
      })
    }
  } finally {
    await rm(home, { recursive: true })
    await rm(dir, { recursive: true })
  }
})
