import { readFile } from 'node:fs/promises'
import { Language, Parser, Query, type Tree } from 'web-tree-sitter'

// Grammars, by name, each loaded from the .wasm file its official package ships (D3). A language
// module declares the grammars it parses with.
const grammars = new Map<string, string>()

export function defineGrammar(name: string, wasm: string) {
  grammars.set(name, wasm)
}

let ready: Promise<void> | undefined
const languages = new Map<string, Promise<Language>>()

export async function loadLanguage(name: string): Promise<Language> {
  ready ??= Parser.init()
  await ready
  let language = languages.get(name)
  if (!language) {
    const wasm = grammars.get(name)
    if (!wasm) throw new Error(`no grammar named ${name}`)
    const url = new URL(import.meta.resolve(wasm))
    language = readFile(url).then((bytes) => Language.load(bytes))
    languages.set(name, language)
  }
  return language
}

export async function parse(name: string, source: string): Promise<Tree> {
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

// Loads one of a language's extraction queries, from `queries/<folder>/<name>.scm` (D10), for one
// of its grammars: the folder is the grammar's own name unless several grammars share it.
export function loadQuery(
  grammar: string,
  query: string,
  folder: string = grammar,
): Promise<Query> {
  const key = `${grammar}\0${folder}/${query}`
  let loaded = queries.get(key)
  if (!loaded) {
    const url = new URL(`../queries/${folder}/${query}.scm`, import.meta.url)
    loaded = Promise.all([loadLanguage(grammar), readFile(url, 'utf8')]).then(
      ([language, source]) => new Query(language, source),
    )
    queries.set(key, loaded)
  }
  return loaded
}
