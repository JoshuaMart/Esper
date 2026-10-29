// esper-scip-python runs scip-python inside Esper's analyzer contract: `fetch` resolves the
// snapshot's dependencies from its lockfile or requirements and downloads their wheels, and
// `analyze` installs those wheels from the cache without the network, indexes the snapshot with
// scip-python, and writes what the index says in Esper's import format. Wheels only: no build
// backend and no setup script of a dependency runs, and the analysis runs no Python at all, so that
// no `.pth` file of a dependency runs either.
//
// The snapshot's source is at /esper/src, read-only; /esper/input.json lists its files; the result
// goes to /esper/out/analysis.jsonl.

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const src = '/esper/src'
const input = '/esper/input.json'
const output = '/esper/out/analysis.jsonl'
const cache = '/esper/cache'
const work = '/tmp/work'
const site = '/tmp/site'
const format = 1
// What is installed: the wheels of any Linux, since only their Python files and stubs are read.
const wheels = ['--only-binary', ':all:', '--python-platform', 'x86_64-manylinux_2_28', '--no-deps']

function fail(message) {
  process.stderr.write(`esper-scip-python: ${message}\n`)
  process.exit(1)
}
const say = (message) => process.stderr.write(`esper-scip-python: ${message}\n`)

function run(command, args, cwd, env = process.env) {
  try {
    return execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 2], env, encoding: 'utf8' })
  } catch (error) {
    fail(`${[command, ...args].join(' ')} in ${cwd}: ${error.message}`)
  }
}

// The manifest the dependencies are read from, at the root of the snapshot's tree: uv's lockfile,
// requirements files, or a `pyproject.toml` whose dependencies are resolved. A target without any
// is analyzed without its dependencies.
function manifest() {
  if (existsSync(join(src, 'uv.lock')) && existsSync(join(src, 'pyproject.toml'))) return 'uv.lock'
  const requirements = readdirSync(src)
    .filter((f) => /^requirements([-_.][\w.-]*)?\.txt$/.test(f))
    .sort()
  if (requirements.includes('requirements.txt')) return 'requirements.txt'
  if (requirements.length > 0) return requirements[0]
  if (existsSync(join(src, 'pyproject.toml'))) return 'pyproject.toml'
  return undefined
}

// Where the pinned requirements of a manifest are kept in the cache, by its content.
const pinned = (name) => {
  const hash = createHash('sha256')
  for (const file of [name, 'pyproject.toml']) {
    if (existsSync(join(src, file))) hash.update(readFileSync(join(src, file)))
  }
  return join(cache, 'requirements', `${hash.digest('hex').slice(0, 16)}.txt`)
}

// One requirement per line, pinned, without hashes, markers kept.
function pins(name) {
  mkdirSync(work, { recursive: true })
  if (name === 'uv.lock') {
    cpSync(join(src, 'uv.lock'), join(work, 'uv.lock'))
    cpSync(join(src, 'pyproject.toml'), join(work, 'pyproject.toml'))
    return run(
      'uv',
      [
        'export',
        '--frozen',
        '--no-hashes',
        '--no-emit-project',
        '--no-emit-workspace',
        '--no-header',
        '--format',
        'requirements.txt',
      ],
      work,
    )
  }
  return run(
    'uv',
    ['pip', 'compile', '--no-header', '--no-annotate', '--quiet', join(src, name), '-o', '-'],
    work,
  )
}

// Installs each requirement on its own, so that one without a wheel is left out, and said.
function install(lines, offline) {
  mkdirSync(site, { recursive: true })
  const failed = []
  for (const line of lines) {
    const result = spawnSync(
      'uv',
      ['pip', 'install', '--target', site, ...wheels, ...(offline ? ['--offline'] : []), line],
      { cwd: '/tmp', stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
    )
    if (result.status !== 0) failed.push(line.split(/[ ;=<>!~[]/)[0])
  }
  if (failed.length > 0) say(`without a wheel to install: ${failed.join(', ')}`)
}

const requirementLines = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('-'))

function fetch() {
  const name = manifest()
  if (!name) return
  const lines = requirementLines(pins(name))
  mkdirSync(join(cache, 'requirements'), { recursive: true })
  writeFileSync(pinned(name), `${lines.join('\n')}\n`)
  // Installing once fills the cache the analysis installs from.
  install(lines, false)
}

// The packages installed, as scip-python's environment lists them: each with its files, read from
// its `RECORD`, so that scip-python runs no `pip`.
function environment() {
  const packages = []
  for (const entry of existsSync(site) ? readdirSync(site) : []) {
    if (!entry.endsWith('.dist-info')) continue
    const metadata = readFileSync(join(site, entry, 'METADATA'), 'utf8')
    const name = /^Name:\s*(.+)$/m.exec(metadata)?.[1]?.trim()
    const version = /^Version:\s*(.+)$/m.exec(metadata)?.[1]?.trim()
    const record = existsSync(join(site, entry, 'RECORD'))
      ? readFileSync(join(site, entry, 'RECORD'), 'utf8')
      : ''
    const files = record
      .split('\n')
      .map((l) => l.split(',')[0])
      .filter((f) => f && /\.pyi?$/.test(f) && !f.startsWith('..'))
    if (name && version) packages.push({ name, version, files })
  }
  return packages.sort((a, b) => (a.name < b.name ? -1 : 1))
}

// The folders the snapshot's own packages are imported from: its root, and a `src` layout's.
function roots(files) {
  const dirs = new Set(['.'])
  for (const file of files) {
    if (!file.endsWith('/__init__.py')) continue
    let dir = file.slice(0, file.lastIndexOf('/'))
    while (dir.includes('/') && files.includes(`${dir.slice(0, dir.lastIndexOf('/'))}/__init__.py`))
      dir = dir.slice(0, dir.lastIndexOf('/'))
    dirs.add(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '.')
  }
  return [...dirs].sort()
}

// A SCIP symbol's descriptors: `fastapi.security.oauth2/OAuth2PasswordBearer#__call__().` is the
// namespace `fastapi.security.oauth2`, the type `OAuth2PasswordBearer` and the method `__call__`.
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

// `scip-python python <package> <version> <descriptors>`, as Esper names a symbol outside the
// snapshot: its module and its names, `fastapi.security.oauth2#OAuth2PasswordBearer.__call__`.
function external(symbol) {
  const parts = symbol.split(' ')
  if (parts.length < 5 || parts[1] !== 'python') return undefined
  const all = descriptors(parts.slice(4).join(' '))
  const module = all.find((d) => d.kind === 'namespace')?.name
  const names = all.filter((d) => d.kind !== 'namespace' && d.kind !== 'other').map((d) => d.name)
  if (!module || names.length === 0) return undefined
  return `${module.replace(/\.__init__$/, '')}#${names.join('.')}`
}

const identifier = /^[\p{L}_][\p{L}\p{Nd}_]*$/u

// A protobuf message's fields, as a list of [field number, value]: a number, or a slice of the
// message for a length-delimited field.
function fields(bytes) {
  const out = []
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
    const number = Math.floor(key / 8)
    if (wire === 2) {
      const length = varint()
      out.push([number, bytes.subarray(i, i + length)])
      i += length
    } else if (wire === 0) out.push([number, varint()])
    else if (wire === 1) i += 8
    else if (wire === 5) i += 4
    else throw new Error(`unexpected wire type ${wire} in the index`)
  }
  return out
}

const utf8 = new TextDecoder()
// A packed list of varints.
function packed(bytes) {
  const out = []
  let i = 0
  while (i < bytes.length) {
    let value = 0
    let shift = 0
    for (;;) {
      const byte = bytes[i++]
      value += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) break
      shift += 7
    }
    out.push(value)
  }
  return out
}

// SCIP's `Document`: its path (1), occurrences (2: range 1, symbol 2, roles 3) and symbols (3:
// symbol 1, relationships 4: symbol 1, is_implementation 3).
function document(slice) {
  const doc = { path: '', occurrences: [], symbols: [] }
  for (const [n, v] of fields(slice)) {
    if (n === 1) doc.path = utf8.decode(v)
    else if (n === 2) {
      const o = { range: [], symbol: '', roles: 0 }
      for (const [m, w] of fields(v)) {
        if (m === 1) o.range = typeof w === 'number' ? [...o.range, w] : packed(w)
        else if (m === 2) o.symbol = utf8.decode(w)
        else if (m === 3) o.roles = w
      }
      doc.occurrences.push(o)
    } else if (n === 3) {
      const s = { symbol: '', relationships: [] }
      for (const [m, w] of fields(v)) {
        if (m === 1) s.symbol = utf8.decode(w)
        else if (m === 4) {
          const r = { symbol: '', implementation: false }
          for (const [k, x] of fields(w)) {
            if (k === 1) r.symbol = utf8.decode(x)
            else if (k === 3) r.implementation = x === 1
          }
          s.relationships.push(r)
        }
      }
      doc.symbols.push(s)
    }
  }
  return doc
}

function analyze(request) {
  const files = request.snapshot.files
  cpSync(src, work, { recursive: true })
  const name = manifest()
  if (name && existsSync(pinned(name)))
    install(requirementLines(readFileSync(pinned(name), 'utf8')), true)
  const env = environment()
  say(`${env.length} packages installed`)
  writeFileSync('/tmp/environment.json', JSON.stringify(env))
  // Pyright reads the installed packages and the snapshot's own roots, with no interpreter.
  writeFileSync(
    join(work, 'pyrightconfig.json'),
    JSON.stringify({
      extraPaths: [site, ...roots(files).filter((d) => d !== '.')],
      pythonVersion: '3.13',
    }),
  )
  // No Python on the path: scip-python and Pyright find none to run.
  const path = '/opt/esper/node_modules/.bin:/usr/local/bin'
  run(
    process.execPath,
    [
      '/opt/esper/node_modules/@sourcegraph/scip-python/index.js',
      'index',
      '--cwd',
      work,
      '--output',
      '/tmp/index.scip',
      '--project-name',
      'snapshot',
      '--project-version',
      'HEAD',
      '--environment',
      '/tmp/environment.json',
      '--quiet',
    ],
    work,
    { ...process.env, PATH: path },
  )
  const bytes = readFileSync('/tmp/index.scip')
  say(`the index has ${bytes.length} bytes`)
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
  // SCIP's ranges count UTF-16 code units, as Pyright does; the format counts UTF-8 bytes.
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
  const documents = fields(bytes)
    .filter(([n]) => n === 2)
    .map(([, slice]) => document(slice))
    .filter((d) => snapshot.has(d.path))
  const isDefinition = (o) => (o.roles & 1) !== 0
  const defined = new Map()
  for (const doc of documents) {
    for (const o of doc.occurrences) {
      if (!isDefinition(o) || o.symbol.startsWith('local ')) continue
      const found = place(doc.path, o.range)
      if (found && !defined.has(o.symbol)) defined.set(o.symbol, found)
    }
  }
  const out = new Set()
  const references = new Map()
  for (const doc of documents) {
    for (const o of doc.occurrences) {
      if (isDefinition(o) || o.symbol.startsWith('local ')) continue
      const at = place(doc.path, o.range)
      if (!at) continue
      const definition = defined.get(o.symbol)
      let target
      // A name renamed on import (`from a import b as c`) is not the name at its definition.
      if (definition) target = definition.name === at.name ? definition.at : undefined
      else if (!o.symbol.includes(' snapshot HEAD ')) {
        const symbol = external(o.symbol)
        if (symbol) target = { external: symbol }
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
        if (!relationship.implementation) continue
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
else fail('usage: esper-scip-python fetch|analyze')
