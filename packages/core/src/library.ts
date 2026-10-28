import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'

// What a language's libraries do with what they are given (`queries/<language>/library.yaml`):
// sinks, persisted data reads and writes, decoders, and the types whose methods return themselves.

import type { SinkKind } from './profile.ts'

export type { SinkKind }

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
  // Names a program uses without declaring them: `fetch`, `Request`.
  globals: Set<string>
  // Members that values of the language's own types have (`map`, `then`): a call of one on a value
  // of unknown type is not guessed to be the target's.
  builtins: Set<string>
}

interface LibraryFile {
  fluent?: string[]
  returns?: Record<string, string>
  keeps?: string[]
  constants?: Record<string, string>
  sinks?: Partial<Record<SinkKind, string[]>>
  data?: { write?: string[]; read?: string[] }
  decoders?: string[]
  globals?: string[]
  builtins?: string[]
}

// `symbol@n` names the argument that is interpreted, `symbol@*` any argument; a module's own `@`
// (`@aws-sdk/client-s3#…`) comes before its `#`.
export function parseSink(entry: string): { symbol: string; argument: number | '*' } {
  const at = entry.indexOf('@', entry.indexOf('#'))
  if (at < 0) return { symbol: entry, argument: 0 }
  const argument = entry.slice(at + 1)
  return { symbol: entry.slice(0, at), argument: argument === '*' ? '*' : Number(argument) }
}

const libraries = new Map<string, Promise<Library>>()

export function loadLibrary(language: string): Promise<Library> {
  let library = libraries.get(language)
  if (!library) {
    const url = new URL(`../queries/${language}/library.yaml`, import.meta.url)
    library = readFile(url, 'utf8').then((text) => {
      const file = parseYaml(text) as LibraryFile
      const ext = (symbol: string) => `ext:${symbol}`
      const sinks = new Map<string, Sink>()
      for (const [kind, symbols] of Object.entries(file.sinks ?? {})) {
        for (const entry of symbols ?? []) {
          const { symbol, argument } = parseSink(entry)
          if (symbol) sinks.set(ext(symbol), { kind: kind as SinkKind, argument })
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
        globals: new Set(file.globals ?? []),
        builtins: new Set(file.builtins ?? []),
      }
    })
    libraries.set(language, library)
  }
  return library
}
