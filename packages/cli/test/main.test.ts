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
