import { readFile } from 'node:fs/promises'
import { Language, Parser, Query, type Tree } from 'web-tree-sitter'

export type LanguageName = 'go'

// Each grammar is loaded from the .wasm file its official package ships (D3).
const grammars: Record<LanguageName, string> = {
  go: 'tree-sitter-go/tree-sitter-go.wasm',
}

let ready: Promise<void> | undefined
const languages = new Map<LanguageName, Promise<Language>>()

export async function loadLanguage(name: LanguageName): Promise<Language> {
  ready ??= Parser.init()
  await ready
  let language = languages.get(name)
  if (!language) {
    const url = new URL(import.meta.resolve(grammars[name]))
    language = readFile(url).then((bytes) => Language.load(bytes))
    languages.set(name, language)
  }
  return language
}

export async function parse(name: LanguageName, source: string): Promise<Tree> {
  const language = await loadLanguage(name)
  const parser = new Parser()
  try {
    parser.setLanguage(language)
    const tree = parser.parse(source)
    if (!tree) throw new Error(`tree-sitter returned no tree for ${name}`)
    return tree
  } finally {
    parser.delete()
  }
}

const queries = new Map<string, Promise<Query>>()

// Loads one of a language's extraction queries, from `queries/<language>/<name>.scm` (D10).
export function loadQuery(name: LanguageName, query: string): Promise<Query> {
  const key = `${name}/${query}`
  let loaded = queries.get(key)
  if (!loaded) {
    const url = new URL(`../queries/${key}.scm`, import.meta.url)
    loaded = Promise.all([loadLanguage(name), readFile(url, 'utf8')]).then(
      ([language, source]) => new Query(language, source),
    )
    queries.set(key, loaded)
  }
  return loaded
}
