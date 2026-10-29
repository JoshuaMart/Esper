import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'

// The roadmap's M4 criterion: nothing in the shared machinery of `packages/core` (the store,
// profiles, detection, home, notes, the analyzer contract, entry points and signals as rules)
// names a language or a framework. Each language is a module of its own (`go*.ts`, `ts*.ts`),
// listed in one place (`languages.ts`) and exported with the rest (`index.ts`); frameworks are
// profiles (D10), the routes a framework declares by files included (D32).

const src = new URL('../src/', import.meta.url)
const languageModule = /^(go|ts)([-.].*)?\.ts$|^(languages|index)\.ts$/
const names =
  /\b(go|golang|typescript|javascript|tsx|jsx|hono|chi|net-http|gorilla|express|kaneo|wakapi|sveltekit|svelte|kener)\b/i

// The code of a file, its comments left out: a comment may cite an example, code may not.
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

test('the shared machinery names no language and no framework', async () => {
  const shared = (await readdir(src)).filter((f) => f.endsWith('.ts') && !languageModule.test(f))
  assert.ok(
    shared.includes('store.ts') && shared.includes('entries.ts') && shared.includes('detect.ts'),
  )
  const found: string[] = []
  for (const file of shared.sort()) {
    const lines = code(await readFile(new URL(file, src), 'utf8')).split('\n')
    lines.forEach((line, i) => {
      const match = names.exec(line)
      if (match) found.push(`${file}:${i + 1}: ${match[0]}: ${line.trim()}`)
    })
  }
  assert.deepEqual(found, [])
})
