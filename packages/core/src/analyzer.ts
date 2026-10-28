import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { parse as parseYaml } from 'yaml'
import { EsperError } from './errors.ts'
import { textLines } from './store.ts'

// The analyzer contract (D12): a manifest per analyzer, and the import of what it writes. An
// analyzer reads the snapshot's code in its container and writes one JSON Lines file; Esper
// validates every line, checks every place it cites against the snapshot, and keeps the file
// whole or not at all.

export interface Manifest {
  name: string
  version: string
  description?: string
  languages: 'go'[]
  provides: ('edges.resolve' | 'flows')[]
  answers: 'snapshot' | 'question'
  image: { dockerfile: string }
  fetch?: string[]
  analyze: string[]
}

// A manifest with where it was read from, and a hash of its folder, which names its image.
export interface Analyzer extends Manifest {
  dir: string
  hash: string
}

export const analyzersDir = new URL('../../../analyzers', import.meta.url).pathname
const schemas = new URL('../../../schemas/', import.meta.url)

const validators = new Map<string, Promise<(value: unknown) => string[]>>()
function validator(schema: string): Promise<(value: unknown) => string[]> {
  let found = validators.get(schema)
  if (!found) {
    found = readFile(new URL(schema, schemas), 'utf8').then((text) => {
      const check = new Ajv2020({ allErrors: true }).compile(JSON.parse(text))
      return (value: unknown) =>
        check(value)
          ? []
          : (check.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`)
    })
    validators.set(schema, found)
  }
  return found
}

// Every file of a folder, hashed in path order: what an image is built from. Hidden files and
// folders (`.DS_Store`, an editor's) build nothing, and leave the hash alone.
export async function hashFolder(dir: string): Promise<string> {
  const hash = createHash('sha256')
  const entries = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .filter(
      (path) =>
        !path
          .slice(dir.length)
          .split(sep)
          .some((part) => part.startsWith('.')),
    )
    .sort()
  for (const path of entries) {
    hash.update(path.slice(dir.length))
    hash.update('\0')
    hash.update(await readFile(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export async function parseManifest(text: string, origin: string): Promise<Manifest> {
  let value: unknown
  try {
    value = parseYaml(text)
  } catch (error) {
    throw new EsperError(`${origin}: not valid YAML: ${(error as Error).message}`)
  }
  const errors = (await validator('analyzer.schema.json'))(value)
  if (errors.length > 0) throw new EsperError(`${origin}: ${errors.join('; ')}`)
  return value as Manifest
}

// The analyzers of a folder, one per subfolder with a manifest, by name.
export async function loadAnalyzers(dir: string = analyzersDir): Promise<Analyzer[]> {
  const analyzers: Analyzer[] = []
  const folders = (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .sort((a, b) => (a.name < b.name ? -1 : 1))
  for (const folder of folders) {
    const path = join(dir, folder.name, 'manifest.yaml')
    const text = await readFile(path, 'utf8').catch(() => undefined)
    if (text === undefined) continue
    const manifest = await parseManifest(text, path)
    if (manifest.name !== folder.name) {
      throw new EsperError(`${path}: names ${manifest.name}, in folder ${folder.name}`)
    }
    const home = join(dir, folder.name)
    analyzers.push({ ...manifest, dir: home, hash: await hashFolder(home) })
  }
  return analyzers
}

// The source an analyzer's facts carry (D6).
export const analyzerSource = (m: Pick<Manifest, 'name' | 'version'>) => `${m.name}@${m.version}`

// A place in a file of the snapshot, as the call graph finds it: 1-based line, and 1-based column
// in UTF-16 code units, as JavaScript and tree-sitter count them.
export interface Place {
  file: string
  line: number
  column: number
}

export type Referent = Place | { external: string }

export const placeKey = (p: Place) => `${p.file}:${p.line}:${p.column}`

// What an analyzer's file says, checked: where each name refers to, and which methods implement
// each interface method, by place.
export interface Analysis {
  source: string
  lines: number
  references: Map<string, { name: string; target: Referent }>
  implementations: Map<string, { name: string; at: Place }[]>
}

const identifierPart = /^[\p{L}\p{Nd}_]$/u

// A file refused whole: the first line that failed, and why.
export class AnalysisError extends EsperError {}

interface RawPlace {
  file: string
  line: number
  column: number
}
type RawLine =
  | { type: 'analyzer'; format: 1; name: string; version: string }
  | { type: 'reference'; at: RawPlace; name: string; target: RawPlace | { external: string } }
  | { type: 'implementation'; at: RawPlace; name: string; of: RawPlace | { external: string } }

// Imports an analyzer's output against the snapshot's files, by path. Every line is valid and
// every place it cites holds its name, or the whole file is refused.
export async function importAnalysis(
  text: string,
  analyzer: Pick<Manifest, 'name' | 'version'>,
  files: Map<string, string>,
): Promise<Analysis> {
  const validate = await validator('analysis.schema.json')
  const source = analyzerSource(analyzer)
  const split = new Map<string, string[]>()
  const lineOf = (file: string, line: number) => {
    let lines = split.get(file)
    if (!lines) {
      lines = textLines(files.get(file) ?? '')
      split.set(file, lines)
    }
    return lines[line - 1]
  }
  const analysis: Analysis = {
    source,
    lines: 0,
    references: new Map(),
    implementations: new Map(),
  }
  const rows = text.split('\n')
  if (rows.at(-1) === '') rows.pop()
  const refuse = (n: number, why: string): never => {
    throw new AnalysisError(
      `${source}: line ${n} of its output is refused, and the file with it: ${why}`,
    )
  }
  // A place the snapshot holds, with its name there, in UTF-16 columns.
  const check = (n: number, p: RawPlace, name: string): Place => {
    if (!files.has(p.file)) refuse(n, `${p.file} is not a file of the snapshot`)
    const line = lineOf(p.file, p.line)
    if (line === undefined) refuse(n, `${p.file} has no line ${p.line}`)
    const bytes = Buffer.from(line as string, 'utf8')
    const start = p.column - 1
    const end = start + Buffer.byteLength(name, 'utf8')
    const found = bytes.subarray(start, end).toString('utf8')
    // A column inside a character, or a name that does not start there, cites nothing; nor does
    // a part of a longer name (`Get` in `GetHead`).
    const before = bytes.subarray(0, start).toString('utf8')
    const after = bytes.subarray(end).toString('utf8')
    if (
      start > bytes.length ||
      found !== name ||
      Buffer.byteLength(before) !== start ||
      identifierPart.test(before.at(-1) ?? '') ||
      identifierPart.test(after.charAt(0))
    ) {
      refuse(n, `${p.file}:${p.line}:${p.column} does not hold ${name}`)
    }
    return { file: p.file, line: p.line, column: before.length + 1 }
  }
  const referent = (n: number, t: RawPlace | { external: string }, name: string): Referent =>
    'external' in t ? { external: t.external } : check(n, t, name)

  rows.forEach((row, i) => {
    const n = i + 1
    let value: unknown
    try {
      value = JSON.parse(row)
    } catch {
      refuse(n, 'not JSON')
    }
    const errors = validate(value)
    if (errors.length > 0) refuse(n, errors.join('; '))
    const line = value as RawLine
    if (n === 1) {
      if (line.type !== 'analyzer') refuse(n, 'the first line names the analyzer')
      else if (line.name !== analyzer.name || line.version !== analyzer.version) {
        refuse(n, `written by ${line.name}@${line.version}, not ${source}`)
      }
      return
    }
    if (line.type === 'analyzer') refuse(n, 'only the first line names the analyzer')
    else if (line.type === 'reference') {
      const at = check(n, line.at, line.name)
      const target = referent(n, line.target, line.name)
      const key = placeKey(at)
      const known = analysis.references.get(key)
      if (known && JSON.stringify(known.target) !== JSON.stringify(target)) {
        refuse(n, `${line.at.file}:${line.at.line}:${line.at.column} already refers elsewhere`)
      }
      analysis.references.set(key, { name: line.name, target })
    } else {
      const at = check(n, line.at, line.name)
      const of = referent(n, line.of, line.name)
      // A call through an interface outside the snapshot stays a call to that symbol (D22): what
      // implements it is checked, and not kept.
      if ('external' in of) return
      const key = placeKey(of)
      const list = analysis.implementations.get(key) ?? []
      if (!list.some((p) => placeKey(p.at) === placeKey(at))) list.push({ name: line.name, at })
      analysis.implementations.set(key, list)
    }
  })
  if (rows.length === 0) refuse(1, 'the file is empty')
  analysis.lines = rows.length
  return analysis
}
