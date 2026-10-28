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
