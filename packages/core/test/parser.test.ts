import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { parse } from '../src/index.ts'

test('parses a Go file into a tree', async () => {
  const source = await readFile(new URL('fixtures/handler.go', import.meta.url), 'utf8')
  const tree = await parse('go', source)

  assert.equal(tree.rootNode.type, 'source_file')
  assert.equal(tree.rootNode.hasError, false)
  const functions = tree.rootNode
    .descendantsOfType('function_declaration')
    .map((node) => node?.childForFieldName('name')?.text)
  assert.deepEqual(functions, ['Routes', 'getUser'])
})
