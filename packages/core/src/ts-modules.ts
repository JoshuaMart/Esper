import { builtinModules } from 'node:module'
import { posix } from 'node:path'
import type { Module } from './language.ts'
import type { TargetFile } from './target.ts'

// How a TypeScript or JavaScript target names its modules, and what an import specifier refers to
// (D10): a file of the target, through relative paths, the `paths` of its own `tsconfig.json`
// and the packages of its own workspace; or a module outside it, by its specifier. Only the
// target's files are read: a `tsconfig` that extends one outside the target, or a package of
// `node_modules`, is not followed.

// A JSON file that may hold comments and trailing commas, as `tsconfig.json` does.
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i] as string
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
    } else {
      out += c
      i++
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const parse = (text: string): Record<string, unknown> | undefined => {
  try {
    const value = parseJsonc(text)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

interface PackageJson {
  name?: string
  main?: string
  module?: string
  types?: string
  typings?: string
  exports?: unknown
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

export interface Package {
  name?: string
  dir: string
  json: PackageJson
}

const isManifest = (path: string) => posix.basename(path) === 'package.json'
export const isConfig = (path: string) =>
  /^(tsconfig(\.[\w-]+)?|jsconfig)\.json$/.test(posix.basename(path))

// The packages of a target, one per `package.json`: its name is what others import it by.
export function packagesOf(files: TargetFile[]): Package[] {
  return files
    .filter((f) => isManifest(f.path))
    .flatMap((f) => {
      const json = parse(f.source) as PackageJson | undefined
      return json
        ? [{ ...(json.name ? { name: json.name } : {}), dir: posix.dirname(f.path), json }]
        : []
    })
    .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
}

// The modules of a target, for detection: each named package and its direct dependencies, those it
// needs to run (`dependencies`, `peerDependencies`, `optionalDependencies`).
export function modulesOf(files: TargetFile[]): Module[] {
  return packagesOf(files).flatMap((p) =>
    p.name
      ? [
          {
            path: p.name,
            dir: p.dir,
            requires: [
              ...Object.keys(p.json.dependencies ?? {}),
              ...Object.keys(p.json.peerDependencies ?? {}),
              ...Object.keys(p.json.optionalDependencies ?? {}),
            ].sort(),
          },
        ]
      : [],
  )
}

const builtins = new Set(builtinModules.filter((m) => !m.startsWith('_')))

// A specifier outside the target, as externals are named: Node's built-in modules always with
// their `node:` prefix, so that `fs` and `node:fs` are one module.
export function externalModule(specifier: string): string {
  if (specifier.startsWith('node:')) return specifier
  const [first] = specifier.split('/')
  return builtins.has(specifier) || (first && builtins.has(first) && first !== specifier)
    ? `node:${specifier}`
    : specifier
}

// What a specifier refers to: a file of the target, a module outside it, or a file of the target
// that is not read (a test, a stylesheet, a JSON file).
export type Resolved = { file: string } | { external: string } | { missing: string }

interface Config {
  dir: string
  // The folder `paths` are relative to.
  base: string
  paths: [string, string[]][]
}

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const conditions = ['types', 'import', 'module', 'node', 'default', 'require']

export class Resolver {
  private readonly sources: Set<string>
  private readonly all: Set<string>
  private readonly packages: Package[]
  private readonly byName = new Map<string, Package>()
  private readonly configs = new Map<string, Config | undefined>()
  private readonly texts: Map<string, string>
  private readonly cache = new Map<string, Resolved>()

  // `files` are every file the index read, `sources` those it parses.
  constructor(files: TargetFile[], sources: Iterable<string>) {
    this.sources = new Set(sources)
    this.all = new Set(files.map((f) => f.path))
    this.texts = new Map(files.map((f) => [f.path, f.source]))
    this.packages = packagesOf(files)
    for (const p of this.packages)
      if (p.name && !this.byName.has(p.name)) this.byName.set(p.name, p)
  }

  // The nearest package a file belongs to.
  packageOf(file: string): Package | undefined {
    let found: Package | undefined
    for (const p of this.packages) {
      if (p.dir === '.' || file.startsWith(`${p.dir}/`)) {
        if (!found || p.dir.length > found.dir.length) found = p
      }
    }
    return found
  }

  resolve(from: string, specifier: string): Resolved {
    const key = `${posix.dirname(from)}\0${specifier}`
    let found = this.cache.get(key)
    if (!found) {
      found = this.lookup(from, specifier)
      this.cache.set(key, found)
    }
    return found
  }

  private lookup(from: string, specifier: string): Resolved {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const path = specifier.startsWith('/')
        ? specifier.slice(1)
        : posix.join(posix.dirname(from), specifier)
      return this.file(path) ?? { missing: path }
    }
    const config = this.configFor(from)
    for (const [pattern, targets] of config?.paths ?? []) {
      const star = pattern.indexOf('*')
      let rest: string | undefined
      if (star < 0) rest = pattern === specifier ? '' : undefined
      else {
        const head = pattern.slice(0, star)
        const tail = pattern.slice(star + 1)
        if (
          specifier.startsWith(head) &&
          specifier.endsWith(tail) &&
          specifier.length >= head.length + tail.length
        ) {
          rest = specifier.slice(head.length, specifier.length - tail.length)
        }
      }
      if (rest === undefined || !config) continue
      for (const target of targets) {
        const found = this.file(posix.join(config.base, target.replace('*', rest)))
        if (found) return found
      }
    }
    const name = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : (specifier.split('/')[0] as string)
    const pkg = this.byName.get(name)
    if (pkg) {
      const sub = specifier.slice(name.length)
      const found = this.entry(pkg, sub ? `.${sub}` : '.')
      if (found) return found
    }
    return { external: externalModule(specifier) }
  }

  // A path as a source file: as written, with an extension, as the TypeScript file a `.js` import
  // names, or as a folder's index.
  private file(path: string): { file: string } | { missing: string } | undefined {
    const clean = posix.normalize(path).replace(/^\.\//, '')
    if (clean.startsWith('..')) return undefined
    const candidates = [clean, ...sourceExtensions.map((e) => clean + e)]
    const ext = posix.extname(clean)
    if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      const stem = clean.slice(0, -ext.length)
      candidates.push(...['.ts', '.tsx', '.mts', '.cts'].map((e) => stem + e))
    }
    candidates.push(...sourceExtensions.map((e) => posix.join(clean, `index${e}`)))
    for (const candidate of candidates) {
      if (this.sources.has(candidate)) return { file: candidate }
    }
    if (this.all.has(clean) || /\.(json|css|scss|svg|png|html|md|wasm)$/.test(clean)) {
      return { missing: clean }
    }
    return undefined
  }

  // The file a package's entry point or subpath is, from its `exports`, or its `main`, `module`
  // and `types` fields; a built file (`dist/index.js`) is looked for as its source (`src/index.ts`).
  private entry(pkg: Package, subpath: string): { file: string } | undefined {
    const targets: string[] = []
    const exports = pkg.json.exports
    const pick = (value: unknown): void => {
      if (typeof value === 'string') targets.push(value)
      else if (Array.isArray(value)) for (const v of value) pick(v)
      else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        for (const condition of conditions) if (condition in record) pick(record[condition])
      }
    }
    if (typeof exports === 'string' || Array.isArray(exports)) {
      if (subpath === '.') pick(exports)
    } else if (exports && typeof exports === 'object') {
      const record = exports as Record<string, unknown>
      const keys = Object.keys(record)
      if (keys.some((k) => k.startsWith('.'))) {
        if (subpath in record) pick(record[subpath])
        else {
          for (const key of keys) {
            const star = key.indexOf('*')
            if (star < 0) continue
            const head = key.slice(0, star)
            const tail = key.slice(star + 1)
            if (subpath.startsWith(head) && subpath.endsWith(tail)) {
              const rest = subpath.slice(head.length, subpath.length - tail.length)
              const value = JSON.stringify(record[key]).replaceAll('*', rest)
              pick(JSON.parse(value))
            }
          }
        }
      } else if (subpath === '.') pick(record)
    }
    if (subpath === '.') {
      for (const field of [pkg.json.types, pkg.json.typings, pkg.json.module, pkg.json.main]) {
        if (field) targets.push(field)
      }
      targets.push('index', 'src/index')
    } else targets.push(subpath, `src/${subpath.slice(2)}`)
    for (const target of targets) {
      const path = posix.join(pkg.dir, target)
      const variants = [path, path.replace(/(^|\/)(dist|lib|build|out)\//, '$1src/')]
      for (const variant of variants) {
        const stem = variant.replace(/\.d\.(m|c)?ts$/, '').replace(/\.(m|c)?js$/, '')
        const found = this.file(stem)
        if (found && 'file' in found) return found
      }
    }
    return undefined
  }

  // The `tsconfig.json` (or `jsconfig.json`) nearest a file, with the `paths` and `baseUrl` it
  // inherits through `extends` within the target.
  private configFor(file: string): Config | undefined {
    for (let dir = posix.dirname(file); ; dir = posix.dirname(dir)) {
      if (!this.configs.has(dir)) {
        const path = ['tsconfig.json', 'jsconfig.json']
          .map((n) => (dir === '.' ? n : `${dir}/${n}`))
          .find((p) => this.texts.has(p))
        this.configs.set(dir, path ? this.config(path, dir, new Set()) : undefined)
      }
      const found = this.configs.get(dir)
      if (found) return found
      if (dir === '.' || dir === '/' || dir === '') return undefined
    }
  }

  private config(path: string, leaf: string, seen: Set<string>): Config | undefined {
    if (seen.has(path)) return undefined
    seen.add(path)
    const json = parse(this.texts.get(path) ?? '')
    if (!json) return undefined
    const dir = posix.dirname(path)
    let inherited: Config | undefined
    const parents = Array.isArray(json.extends) ? json.extends : [json.extends]
    for (const parent of parents) {
      if (typeof parent !== 'string' || !parent.startsWith('.')) continue
      let target = posix.normalize(posix.join(dir, parent))
      if (!target.endsWith('.json')) target += '.json'
      if (target.startsWith('..')) continue
      inherited = this.config(target, leaf, seen) ?? inherited
    }
    const options = (json.compilerOptions ?? {}) as Record<string, unknown>
    // `${configDir}` is the folder of the configuration that is used, not of the one that says it.
    const placeholder = `$${'{configDir}'}`
    const at = (value: string) =>
      posix.normalize(posix.join(dir, value.replace(placeholder, posix.relative(dir, leaf) || '.')))
    const baseUrl = typeof options.baseUrl === 'string' ? at(options.baseUrl) : undefined
    const paths =
      options.paths && typeof options.paths === 'object'
        ? Object.entries(options.paths as Record<string, unknown>).map(
            ([pattern, targets]): [string, string[]] => [
              pattern,
              Array.isArray(targets) ? targets.filter((t) => typeof t === 'string') : [],
            ],
          )
        : undefined
    return {
      dir,
      // `paths` are relative to `baseUrl` when there is one, otherwise to the file that sets them.
      base: baseUrl ?? (paths ? dir : (inherited?.base ?? dir)),
      paths: paths ?? inherited?.paths ?? [],
    }
  }
}

export { isManifest }
