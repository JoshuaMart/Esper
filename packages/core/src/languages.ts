import { go } from './go-index.ts'
import type { Language } from './language.ts'
import { python } from './py-index.ts'
import { typescript } from './ts-index.ts'

// The languages Esper reads, each a module of its own (D10): the one place that lists them.
export const languages: Language[] = [go, typescript, python]

export function languageNamed(name: string): Language {
  const found = languages.find((l) => l.name === name)
  if (!found) throw new Error(`no language named ${name}`)
  return found
}
