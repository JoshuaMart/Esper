// esper-scip-typescript runs scip-typescript inside Esper's analyzer contract: `fetch` downloads the
// snapshot's dependencies from its lockfile, with the network and scripts disabled, and `analyze`
// installs them from that cache without the network, indexes the snapshot with scip-typescript, and
// writes what the index says in Esper's import format.
//
// The snapshot's source is at /esper/src, read-only; /esper/input.json lists its files; the result
// goes to /esper/out/analysis.jsonl.

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const src = '/esper/src'
const input = '/esper/input.json'
const output = '/esper/out/analysis.jsonl'
const cache = '/esper/cache'
const work = '/tmp/work'
const registry = 'https://registry.npmjs.org/'
const format = 1
// pnpm, whatever version the target's `packageManager` names: it does not switch to another.
const pnpm = [
  '--ignore-scripts',
  `--store-dir=${cache}/pnpm`,
  '--config.manage-package-manager-versions=false',
]

const require = createRequire(import.meta.url)
const bin = (name) => join(import.meta.dirname, 'node_modules', '.bin', name)

function fail(message) {
  process.stderr.write(`esper-scip-typescript: ${message}\n`)
  process.exit(1)
}

// A command, its output on standard error so that only the analysis leaves on standard output.
function run(command, args, cwd) {
  try {
    execFileSync(command, args, { cwd, stdio: ['ignore', 2, 2], env: process.env })
  } catch (error) {
    fail(`${[command, ...args].join(' ')} in ${cwd}: ${error.message}`)
  }
}

// Which package manager the snapshot's lockfile is for, at the root of its tree: pnpm or npm. A
// target without one, such as a folder whose lockfile is in the repository above it, is analyzed
// without its dependencies.
function lockfile() {
  if (existsSync(join(src, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(src, 'package-lock.json'))) return 'npm'
  return undefined
}

// The lockfile and every `package.json` of the tree, by their path in it.
function manifests() {
  const found = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name === 'package.json')
    .map((e) => join(e.parentPath, e.name).slice(src.length + 1))
    .filter((path) => !path.split('/').includes('node_modules'))
  return ['package-lock.json', ...found.sort()]
}

// The registry is npm's own, whatever the target's `.npmrc` says, and no script of a dependency
// runs: what fetching writes is checked against the lockfile's integrity hashes.
function fetch() {
  const manager = lockfile()
  if (!manager) return
  mkdirSync(work, { recursive: true })
  if (manager === 'pnpm') {
    for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json']) {
      if (existsSync(join(src, name))) cpSync(join(src, name), join(work, name))
    }
    run(bin('pnpm'), ['fetch', ...pnpm, `--registry=${registry}`], work)
  } else {
    // npm installs a workspace's packages too, and needs each of their manifests.
    for (const name of manifests()) {
      mkdirSync(join(work, name, '..'), { recursive: true })
      cpSync(join(src, name), join(work, name))
    }
    run(
      'npm',
      [
        'ci',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        `--cache=${cache}/npm`,
        `--registry=${registry}`,
      ],
      work,
    )
  }
}

// The snapshot, copied where its dependencies can be installed, then installed from the cache.
function install() {
  cpSync(src, work, { recursive: true })
  const manager = lockfile()
  if (manager === 'pnpm') {
    run(
      bin('pnpm'),
      [
        'install',
        '--offline',
        '--frozen-lockfile',
        ...pnpm,
        '--package-import-method=copy',
        '--config.confirm-modules-purge=false',
      ],
      work,
    )
  } else if (manager === 'npm') {
    // npm writes to its cache even when offline; it reads a copy of it.
    cpSync(`${cache}/npm`, '/tmp/npm-cache', { recursive: true })
    run(
      'npm',
      ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache=/tmp/npm-cache'],
      work,
    )
  }
}

// A SCIP symbol's descriptors: `src/`context.ts`/Context#req().` is the namespaces `src` and
// `context.ts`, the type `Context` and the method `req`.
function descriptors(text) {
  const out = []
  let i = 0
  while (i < text.length) {
    let name = ''
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      if (end < 0) break
      name = text.slice(i + 1, end)
      i = end + 1
    } else {
      while (i < text.length && !'/#.:()[]`'.includes(text[i])) name += text[i++]
    }
    const suffix = text[i]
    if (suffix === '(') {
      // A method, `name(disambiguator).`, or a parameter, `(name)`.
      const end = text.indexOf(')', i)
      if (end < 0) break
      if (text[end + 1] === '.') out.push({ name, kind: 'method' })
      i = end + (text[end + 1] === '.' ? 2 : 1)
    } else if (suffix === '[') {
      const end = text.indexOf(']', i)
      if (end < 0) break
      i = end + 1
    } else {
      out.push({
        name,
        kind: { '/': 'namespace', '#': 'type', '.': 'term', ':': 'meta' }[suffix] ?? 'other',
      })
      i++
    }
  }
  return out
}

// `scip-typescript npm <package> <version> <descriptors>`, as Esper names a symbol outside the
// snapshot: the module the code imports it from and its names, `hono#Context.json`. The runtime's
// own declarations (`lib.dom.d.ts`) are `globalThis`, Node's are `node:<module>`.
function external(symbol) {
  const parts = symbol.split(' ')
  if (parts.length < 5 || parts[1] !== 'npm') return undefined
  const pkg = parts[2]
  const all = descriptors(parts.slice(4).join(' '))
  const names = all.filter((d) => d.kind !== 'namespace' && d.kind !== 'other').map((d) => d.name)
  if (names.length === 0) return undefined
  let module = pkg
  if (pkg === 'typescript') module = 'globalThis'
  else if (pkg === '@types/node') {
    const declared = all.find((d) => d.kind === 'namespace' && /^["']/.test(d.name))
    const name = declared ? declared.name.slice(1, -1).replace(/^node:/, '') : undefined
    module = name ? `node:${name}` : 'globalThis'
  } else if (pkg.startsWith('@types/')) {
    module = pkg.slice('@types/'.length).replace(/^(.+)__(.+)$/, '@$1/$2')
  }
  return `${module}#${names.join('.')}`
}

// A configuration that extends one the snapshot does not hold (a folder of a repository whose shared
// `tsconfig` is above it) is read without it, rather than not at all.
function outside(path) {
  const ts = require('typescript')
  const { config } = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'))
  if (!config?.extends) return
  const dir = path.slice(0, path.lastIndexOf('/'))
  const from = createRequire(path)
  // A parent is kept when it is a file of the tree, or of a package the install brought.
  const found = (parent) => {
    if (parent.startsWith('.')) {
      const file = resolve(dir, parent)
      return file.startsWith(`${work}/`) && [file, `${file}.json`].some((f) => existsSync(f))
    }
    return [parent, `${parent}.json`, `${parent}/tsconfig.json`].some((candidate) => {
      try {
        return from.resolve(candidate).startsWith(`${work}/`)
      } catch {
        return false
      }
    })
  }
  const all = Array.isArray(config.extends) ? config.extends : [config.extends]
  const parents = all.filter((p) => typeof p === 'string' && !found(p))
  if (parents.length === 0) return
  config.extends = all.filter((p) => !parents.includes(p))
  if (config.extends.length === 0) delete config.extends
  writeFileSync(path, JSON.stringify(config))
  process.stderr.write(
    `esper-scip-typescript: ${path.slice(work.length + 1)} is read without ${parents.join(', ')}\n`,
  )
}

const identifier = /^[\p{L}_$][\p{L}\p{Nd}_$]*$/u

// The length-delimited fields numbered `field` of a protobuf message, as slices of it, without
// decoding the rest: the documents of a SCIP index are its field 2.
function* messages(bytes, field) {
  let i = 0
  const varint = () => {
    let value = 0
    let shift = 0
    for (;;) {
      const byte = bytes[i++]
      value += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) return value
      shift += 7
    }
  }
  while (i < bytes.length) {
    const key = varint()
    const wire = key % 8
    if (wire === 2) {
      const length = varint()
      if (Math.floor(key / 8) === field) yield bytes.subarray(i, i + length)
      i += length
    } else if (wire === 0) varint()
    else if (wire === 1) i += 8
    else if (wire === 5) i += 4
    else throw new Error(`unexpected wire type ${wire} in the index`)
  }
}

function analyze(request) {
  install()
  const scipTypescript = require.resolve('@sourcegraph/scip-typescript/dist/src/main.js')
  // Each TypeScript project of the snapshot, by the folder of its `tsconfig.json`; a snapshot
  // without one is read as one project whose configuration is inferred.
  // Projects that hold none of the snapshot's files (tests, benchmarks, fixtures) are left out.
  const files = request.snapshot.files
  const projects = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name === 'tsconfig.json')
    .map((e) => e.parentPath.slice(src.length + 1) || '.')
    .filter((dir) => dir === '.' || files.some((f) => f.startsWith(`${dir}/`)))
    .sort()
  for (const dir of projects) outside(join(work, dir, 'tsconfig.json'))
  const args = [
    scipTypescript,
    'index',
    '--cwd',
    work,
    '--output',
    '/tmp/index.scip',
    '--no-progress-bar',
  ]
  if (projects.length === 0) args.push('--infer-tsconfig')
  else args.push(...projects)
  run(process.execPath, args, work)

  const { scip } = require('@sourcegraph/scip-typescript/dist/src/scip.js')
  const bytes = readFileSync('/tmp/index.scip')
  process.stderr.write(`esper-scip-typescript: the index has ${bytes.length} bytes\n`)
  const snapshot = new Set(files)
  const lines = new Map()
  const text = (file) => {
    let found = lines.get(file)
    if (!found) {
      found = readFileSync(join(work, file), 'utf8').split('\n')
      lines.set(file, found)
    }
    return found
  }
  // A place as the import format states it, with the name the source writes there: SCIP's ranges
  // count UTF-16 code units, as TypeScript does; the format counts UTF-8 bytes.
  const place = (file, range) => {
    const [line, start, end] = range.length === 3 ? range : [range[0], range[1], range[3]]
    const source = text(file)[line] ?? ''
    const name = range.length === 3 ? source.slice(start, end) : source.slice(start)
    if (!identifier.test(name)) return undefined
    return {
      at: { file, line: line + 1, column: Buffer.byteLength(source.slice(0, start), 'utf8') + 1 },
      name,
    }
  }
  // Each document is decoded on its own, as it is read: a whole index decoded at once does not fit
  // in memory for a target the size of a framework.
  const documents = []
  for (const slice of messages(bytes, 2)) {
    const path = scip.Document.deserializeBinary(slice).relative_path
    if (snapshot.has(path)) documents.push({ path, slice })
  }
  const decode = (slice) => scip.Document.deserializeBinary(slice)
  const defined = new Map()
  for (const { path, slice } of documents) {
    const doc = decode(slice)
    for (const occurrence of doc.occurrences) {
      if ((occurrence.symbol_roles & scip.SymbolRole.Definition) === 0) continue
      if (occurrence.symbol.startsWith('local ')) continue
      const found = place(path, occurrence.range)
      if (found && !defined.has(occurrence.symbol)) defined.set(occurrence.symbol, found)
    }
  }
  const out = new Set()
  // What each place refers to: a name on a value of a union type refers to the member of each
  // type, and a place that refers to several is left to the syntax.
  const references = new Map()
  for (const { path, slice } of documents) {
    const doc = decode(slice)
    for (const occurrence of doc.occurrences) {
      if ((occurrence.symbol_roles & scip.SymbolRole.Definition) !== 0) continue
      if (occurrence.symbol.startsWith('local ')) continue
      const at = place(path, occurrence.range)
      if (!at) continue
      const definition = defined.get(occurrence.symbol)
      let target
      // A name renamed on import (`import { a as b }`) is not the name at its definition.
      if (definition) target = definition.name === at.name ? definition.at : undefined
      else if (!occurrence.symbol.includes(' HEAD ')) {
        const name = external(occurrence.symbol)
        if (name) target = { external: name }
      }
      if (!target) continue
      const key = `${at.at.file}:${at.at.line}:${at.at.column}`
      const known = references.get(key) ?? new Map()
      known.set(JSON.stringify(target), { at: at.at, name: at.name, target })
      references.set(key, known)
    }
    for (const info of doc.symbols) {
      const definition = defined.get(info.symbol)
      if (!definition) continue
      for (const relationship of info.relationships) {
        if (!relationship.is_implementation) continue
        const of = defined.get(relationship.symbol)
        if (!of || of.name !== definition.name) continue
        out.add(
          JSON.stringify({
            type: 'implementation',
            at: definition.at,
            name: definition.name,
            of: of.at,
          }),
        )
      }
    }
  }
  for (const known of references.values()) {
    if (known.size !== 1) continue
    const [{ at, name, target }] = known.values()
    out.add(JSON.stringify({ type: 'reference', at, name, target }))
  }
  const header = JSON.stringify({
    type: 'analyzer',
    format,
    name: request.analyzer.name,
    version: request.analyzer.version,
  })
  writeFileSync(output, `${[header, ...[...out].sort()].join('\n')}\n`)
}

const command = process.argv[2]
const request = JSON.parse(readFileSync(input, 'utf8'))
if (command === 'fetch') fetch()
else if (command === 'analyze') analyze(request)
else fail('usage: esper-scip-typescript fetch|analyze')
