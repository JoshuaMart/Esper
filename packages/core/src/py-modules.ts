import { posix } from 'node:path'
import type { Module } from './language.ts'
import type { TargetFile } from './target.ts'

// How a Python target names its projects and their dependencies (D10): `pyproject.toml`, PEP 621's
// `[project]`, Poetry's `[tool.poetry]` and uv's dependency groups, and `requirements*.txt`. Only
// the target's files are read; nothing is installed or run.

export const isManifest = (path: string) => {
  const base = posix.basename(path)
  return base === 'pyproject.toml' || /^requirements([-_.][\w.-]*)?\.(txt|in)$/.test(base)
}

type Toml = Record<string, unknown>

// A TOML document, read as far as manifests need: tables, strings, numbers, booleans, arrays and
// inline tables. What it cannot read it leaves out.
export function parseToml(text: string): Toml {
  const root: Toml = {}
  let table: Toml = root
  let i = 0
  const skipSpace = (newlines: boolean) => {
    while (i < text.length) {
      const c = text[i] as string
      if (c === '#') while (i < text.length && text[i] !== '\n') i++
      else if (c === ' ' || c === '\t' || c === '\r' || (newlines && c === '\n')) i++
      else break
    }
  }
  const key = (): string[] => {
    const parts: string[] = []
    for (;;) {
      skipSpace(false)
      const c = text[i]
      if (c === '"' || c === "'") parts.push(string())
      else {
        const start = i
        while (i < text.length && /[\w-]/.test(text[i] as string)) i++
        parts.push(text.slice(start, i))
      }
      skipSpace(false)
      if (text[i] !== '.') break
      i++
    }
    return parts
  }
  const string = (): string => {
    const quote = text[i] as string
    const triple = text.startsWith(quote.repeat(3), i)
    i += triple ? 3 : 1
    if (triple && text[i] === '\n') i++
    let out = ''
    while (i < text.length) {
      if (triple ? text.startsWith(quote.repeat(3), i) : text[i] === quote) {
        i += triple ? 3 : 1
        return out
      }
      if (quote === '"' && text[i] === '\\') {
        const next = text[i + 1] as string
        out += ({ n: '\n', t: '\t', '"': '"', '\\': '\\' } as Record<string, string>)[next] ?? next
        i += 2
      } else out += text[i++]
    }
    return out
  }
  const value = (): unknown => {
    skipSpace(true)
    const c = text[i]
    if (c === '"' || c === "'") return string()
    if (c === '[') {
      i++
      const items: unknown[] = []
      for (;;) {
        skipSpace(true)
        if (text[i] === ']') {
          i++
          return items
        }
        if (i >= text.length) return items
        const at = i
        items.push(value())
        skipSpace(true)
        if (text[i] === ',') i++
        // A character no value starts with ends the array, so that a broken file cannot loop.
        else if (i === at) return items
      }
    }
    if (c === '{') {
      i++
      const inline: Toml = {}
      for (;;) {
        skipSpace(true)
        if (text[i] === '}') {
          i++
          return inline
        }
        if (i >= text.length) return inline
        const at = i
        const path = key()
        if (text[i] === '=') i++
        set(inline, path, value())
        skipSpace(true)
        if (text[i] === ',') i++
        else if (i === at) return inline
      }
    }
    const start = i
    while (i < text.length && !/[,\]}\n#]/.test(text[i] as string)) i++
    const raw = text.slice(start, i).trim()
    if (raw === 'true') return true
    if (raw === 'false') return false
    const n = Number(raw)
    return Number.isNaN(n) ? raw : n
  }
  const set = (into: Toml, path: string[], v: unknown) => {
    let t = into
    // `__proto__` would reach the prototype every object shares, so a manifest cannot name it.
    if (path.includes('__proto__')) return
    for (const part of path.slice(0, -1)) {
      if (typeof t[part] !== 'object' || t[part] === null || Array.isArray(t[part])) t[part] = {}
      t = t[part] as Toml
    }
    t[path.at(-1) as string] = v
  }
  const open = (path: string[], array: boolean) => {
    let t = root
    if (path.includes('__proto__')) {
      table = {}
      return
    }
    for (const [n, part] of path.entries()) {
      const last = n === path.length - 1
      if (last && array) {
        const list = Array.isArray(t[part]) ? (t[part] as Toml[]) : []
        t[part] = list
        const entry: Toml = {}
        list.push(entry)
        t = entry
      } else {
        const current = t[part]
        if (Array.isArray(current)) t = current.at(-1) as Toml
        else {
          if (typeof current !== 'object' || current === null) t[part] = {}
          t = t[part] as Toml
        }
      }
    }
    table = t
  }
  while (i < text.length) {
    skipSpace(true)
    if (i >= text.length) break
    if (text[i] === '[') {
      const array = text[i + 1] === '['
      i += array ? 2 : 1
      const path = key()
      i += array ? 2 : 1
      open(path, array)
      continue
    }
    const path = key()
    skipSpace(false)
    if (text[i] !== '=') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    i++
    set(table, path, value())
    while (i < text.length && text[i] !== '\n') i++
  }
  return root
}

// A distribution's name as PEP 503 normalises it: `Typing_Extensions` is `typing-extensions`.
export const normalise = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-')

// The name a requirement names: `psycopg[binary]>=3.2,<4` is `psycopg`.
const requirementName = (requirement: string): string | undefined => {
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement)
  return match?.[1] ? normalise(match[1]) : undefined
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

const table = (value: unknown): Toml =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Toml) : {}

// The projects a target declares, one per `pyproject.toml` or folder of requirements files, each
// with its dependencies: runtime, optional, and development groups, since an application's
// framework may be listed in any of them.
export function modulesOf(files: TargetFile[]): Module[] {
  const modules = new Map<string, Module>()
  for (const file of files) {
    if (!isManifest(file.path)) continue
    const dir = posix.dirname(file.path)
    const module = modules.get(dir) ?? { path: '', dir, requires: [] }
    const requires = new Set(module.requires)
    if (posix.basename(file.path) === 'pyproject.toml') {
      const toml = parseToml(file.source)
      const project = table(toml.project)
      const poetry = table(table(toml.tool).poetry)
      const name = typeof project.name === 'string' ? project.name : poetry.name
      if (typeof name === 'string') module.path = normalise(name)
      const listed = [
        ...strings(project.dependencies),
        ...Object.values(table(project['optional-dependencies'])).flatMap(strings),
        ...Object.values(table(toml['dependency-groups'])).flatMap(strings),
        ...strings(table(table(toml.tool).uv)['dev-dependencies']),
      ]
      for (const r of listed) {
        const n = requirementName(r)
        if (n) requires.add(n)
      }
      // Poetry names its dependencies as keys.
      const groups = [
        poetry.dependencies,
        poetry['dev-dependencies'],
        ...Object.values(table(poetry.group)).map((g) => table(g).dependencies),
      ]
      for (const group of groups)
        for (const n of Object.keys(table(group))) if (n !== 'python') requires.add(normalise(n))
    } else {
      for (const raw of file.source.split('\n')) {
        const text = (raw.split('#', 1)[0] ?? '').trim()
        if (!text || text.startsWith('-')) continue
        const n = requirementName(text)
        if (n) requires.add(n)
      }
    }
    module.requires = [...requires].sort()
    modules.set(dir, module)
  }
  return [...modules.values()]
    .map((m) => ({ ...m, path: m.path || (m.dir === '.' ? '.' : posix.basename(m.dir)) }))
    .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
}
