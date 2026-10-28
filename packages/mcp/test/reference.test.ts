import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { withTools } from '../src/reference.ts'

test('the MCP reference page says what the tools take and return; pnpm reference rewrites it', async () => {
  const page = await readFile(
    new URL('../../../docs/src/content/docs/reference/mcp.md', import.meta.url),
    'utf8',
  )
  assert.equal(page, withTools(page))
})
