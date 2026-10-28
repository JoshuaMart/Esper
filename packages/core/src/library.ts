import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import type { LanguageName } from './parser.ts'

// What a language's libraries do with what they are given (`queries/<language>/library.yaml`):
// sinks, persisted data reads and writes, decoders, and the types whose methods return themselves.

export type SinkKind = 'sql' | 'process' | 'file' | 'fetch' | 'redirect' | 'unescaped'

export interface Sink {
  kind: SinkKind
  // The argument that is interpreted, or every argument.
  argument: number | '*'
}

export interface Library {
  fluent: Set<string>
  returns: Map<string, string>
  keeps: Set<string>
  constants: Map<string, string>
  // By external reference: `ext:database/sql#DB.Query`.
  sinks: Map<string, Sink>
  writes: Set<string>
  reads: Set<string>
  decoders: Set<string>
}

interface LibraryFile {
  fluent?: string[]
  returns?: Record<string, string>
  keeps?: string[]
  constants?: Record<string, string>
  sinks?: Partial<Record<SinkKind, string[]>>
  data?: { write?: string[]; read?: string[] }
  decoders?: string[]
}

const libraries = new Map<LanguageName, Promise<Library>>()

export function loadLibrary(language: LanguageName): Promise<Library> {
  let library = libraries.get(language)
  if (!library) {
    const url = new URL(`../queries/${language}/library.yaml`, import.meta.url)
    library = readFile(url, 'utf8').then((text) => {
      const file = parseYaml(text) as LibraryFile
      const ext = (symbol: string) => `ext:${symbol}`
      const sinks = new Map<string, Sink>()
      for (const [kind, symbols] of Object.entries(file.sinks ?? {})) {
        for (const entry of symbols ?? []) {
          const [symbol, at] = entry.split('@')
          if (!symbol) continue
          sinks.set(ext(symbol), {
            kind: kind as SinkKind,
            argument: at === '*' ? '*' : Number(at ?? 0),
          })
        }
      }
      return {
        fluent: new Set(file.fluent ?? []),
        returns: new Map(Object.entries(file.returns ?? {})),
        keeps: new Set(file.keeps ?? []),
        constants: new Map(Object.entries(file.constants ?? {})),
        sinks,
        writes: new Set((file.data?.write ?? []).map(ext)),
        reads: new Set((file.data?.read ?? []).map(ext)),
        decoders: new Set((file.decoders ?? []).map(ext)),
      }
    })
    libraries.set(language, library)
  }
  return library
}
