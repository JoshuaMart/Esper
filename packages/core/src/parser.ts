import { readFile } from 'node:fs/promises'
import { Language, Parser, type Tree } from 'web-tree-sitter'

export type LanguageName = 'go'

// Each grammar is loaded from the .wasm file its official package ships (D3).
const grammars: Record<LanguageName, string> = {
  go: 'tree-sitter-go/tree-sitter-go.wasm',
}

let ready: Promise<void> | undefined
const languages = new Map<LanguageName, Promise<Language>>()

async function loadLanguage(name: LanguageName): Promise<Language> {
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
