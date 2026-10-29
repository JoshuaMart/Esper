import { posix } from 'node:path'
import type { Node } from 'web-tree-sitter'
import { type Member, normalisePattern, type Route } from './entries.ts'
import type { FileExport, FilesSpec, ResolvedProfile } from './profile.ts'
import { keyName, line, present, type TsFile, type TsProgram, type TsType } from './ts.ts'
import { TsRouteInterpreter } from './ts-routes.ts'

// Routes a TypeScript or JavaScript application declares by its files rather than by calls
// (D32): the folders of a route tree are a route's path, and the exports of each file what is
// served there, as a profile's `files` says. A route's chain is what applies to every route (the
// hooks, a sequence of them seen through), the matchers its parameters name, and, for the routes
// that take them, the layouts of its folder and those above, outermost first.

const extension = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const wrappers = new Set([
  'parenthesized_expression',
  'as_expression',
  'satisfies_expression',
  'non_null_expression',
])
const unwrap = (node: Node): Node => {
  let n = node
  while (wrappers.has(n.type) && n.namedChildren[0]) n = n.namedChildren[0]
  return n
}

// Marks the routes that take their folder's layouts, while the routes of a folder are merged.
const paged = Symbol('layouts')

// Routes of file trees get groups of their own, apart from the routers' numbers.
const groups = 1_000_000

export class TsFileRoutes {
  private readonly program: TsProgram
  private readonly spec: FilesSpec
  private readonly profile: ResolvedProfile
  private readonly typeFor: (symbol: string) => TsType
  // One interpreter per type a function receives, which gives it that type.
  private readonly interpreters = new Map<string, TsRouteInterpreter>()
  private readonly compose: Set<string>

  constructor(
    program: TsProgram,
    profile: ResolvedProfile & { files: FilesSpec },
    typeFor: (symbol: string) => TsType,
  ) {
    this.program = program
    this.profile = profile
    this.spec = profile.files
    this.typeFor = typeFor
    this.compose = new Set((profile.files.compose ?? []).map((c) => `ext:${c}`))
  }

  routes(): Route[] {
    const routes: Route[] = []
    // Each package with a route tree: its folder, from the root of the target.
    const roots = new Set<string>()
    for (const file of this.program.files) {
      const dir = file.package?.dir ?? '.'
      if (file.path.startsWith(this.under(dir, this.spec.routes))) roots.add(dir)
    }
    for (const root of [...roots].sort()) routes.push(...this.tree(root))
    return routes
  }

  private under(root: string, path: string): string {
    return `${root === '.' ? '' : `${root}/`}${path}/`
  }

  // A module of the package by its path without the extension: `src/hooks.server.ts`, or
  // `src/hooks.server/index.ts`.
  private moduleAt(root: string, path: string): TsFile | undefined {
    const stem = root === '.' ? path : `${root}/${path}`
    return this.program.files.find(
      (f) =>
        f.path.replace(extension, '') === stem || f.path.replace(extension, '') === `${stem}/index`,
    )
  }

  private tree(root: string): Route[] {
    const base = this.under(root, this.spec.routes)
    const routes: Route[] = []
    // The files of the tree, by folder: `+page.server.ts` is the module `+page.server`, and
    // `+page@(app).server.ts` too, with the layout it resets to.
    const byFolder = new Map<string, { file: TsFile; module: string; reset?: string }[]>()
    for (const file of this.program.files) {
      if (!file.path.startsWith(base) || (file.package?.dir ?? '.') !== root) continue
      const relative = file.path.slice(base.length)
      const name = posix.basename(relative).replace(extension, '')
      const parsed = /^(\+[\w-]+)(@[^.]*)?(\..+)?$/.exec(name)
      if (!parsed?.[1]) continue
      const module = `${parsed[1]}${parsed[3] ?? ''}`
      if (!this.spec.modules.some((m) => m.name === module)) continue
      const folder = posix.dirname(relative) === '.' ? '' : posix.dirname(relative)
      const list = byFolder.get(folder) ?? []
      list.push({ file, module, ...(parsed[2] ? { reset: parsed[2].slice(1) } : {}) })
      byFolder.set(folder, list)
    }
    const folders = [...byFolder.keys()].sort()
    const exportsOf = (module: string) =>
      this.spec.modules.find((m) => m.name === module)?.exports ?? []
    const layoutFolders = new Set(
      folders.filter((f) =>
        byFolder.get(f)?.some((e) => exportsOf(e.module).some((x) => x.does === 'layout')),
      ),
    )
    // The folders above a folder, the root first, and the folder itself.
    const ancestry = (folder: string) => {
      const parts = folder === '' ? [] : folder.split('/')
      return ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))]
    }
    // The routes of a folder are siblings of those under the same layout or route group.
    const groupIds = new Map<string, number>()
    const groupOf = (folder: string) => {
      const scope =
        ancestry(folder)
          .reverse()
          .find((f) => layoutFolders.has(f) || /(^|\/)\(.+\)$/.test(f)) ?? ''
      if (!groupIds.has(scope)) groupIds.set(scope, groups + groupIds.size)
      return groupIds.get(scope) as number
    }

    const hooks = this.hooks(root)
    // The reset a folder's layout names, if it does: `+layout@.server.ts` resets to the root's.
    const layoutReset = (f: string) =>
      (byFolder.get(f) ?? []).find(
        (e) => e.reset !== undefined && exportsOf(e.module).some((x) => x.does === 'layout'),
      )?.reset
    // The layouts of a folder, outermost first. A reset, the page's or a layout's, keeps those of
    // the folder above named so (`@name`), or the root's alone (`@`), above it.
    const layouts = (folder: string, reset: string | undefined): Member[] => {
      const chain = ancestry(folder)
      const above = (at: number, name: string) =>
        name === ''
          ? 0
          : chain
              .slice(0, at)
              .map((f) => posix.basename(f))
              .lastIndexOf(name)
      const kept: string[] = []
      let i = chain.length - 1
      if (reset !== undefined) {
        const to = above(chain.length - 1, reset)
        if (to >= 0) i = to
      }
      for (; i >= 0; i--) {
        const f = chain[i] as string
        kept.unshift(f)
        const own = layoutReset(f)
        const to = own === undefined ? -1 : above(i, own)
        if (to >= 0) i = to + 1
      }
      return kept.flatMap((f) =>
        this.spec.modules.flatMap((module) =>
          (byFolder.get(f) ?? [])
            .filter((e) => e.module === module.name)
            .flatMap((e) =>
              module.exports
                .filter((x) => x.does === 'layout')
                .flatMap((x) => this.exported(e.file, x)?.members ?? []),
            ),
        ),
      )
    }

    for (const folder of folders) {
      const id = `/${folder}`
      const path = normalisePattern(id, this.spec.pattern).path
      const matchers = this.matchers(root, id)
      for (const module of this.spec.modules) {
        for (const entry of byFolder.get(folder) ?? []) {
          if (entry.module !== module.name) continue
          for (const rule of module.exports) {
            if (rule.does !== 'route' && rule.does !== 'each') continue
            const found = this.exported(entry.file, rule)
            if (!found) continue
            const chain = [
              ...hooks,
              ...matchers,
              ...(rule.layouts ? layouts(folder, entry.reset) : []),
            ]
            const route = (method: string, at: string, handler: Member): Route => ({
              ...(rule.layouts ? { [paged]: true } : {}),
              method,
              path: at,
              pattern: id,
              handler,
              chain,
              citation: handler.citation,
              group: groupOf(folder),
            })
            if (rule.does === 'route') {
              for (const handler of found.members)
                routes.push(route(rule.method ?? 'ANY', path, handler))
              continue
            }
            for (const [name, handler] of this.properties(entry.file, found.node, rule)) {
              const suffix = (rule.path ?? '/{name}').replace('{name}', () => name)
              const at =
                name === rule.default
                  ? path
                  : path === '/' && suffix.startsWith('/')
                    ? suffix
                    : `${path}${suffix}`
              routes.push(route(rule.method ?? 'ANY', at, handler))
            }
          }
        }
      }
    }
    // A page's server `load` and its universal one serve the same request: one route, whose
    // handler is both, the first module's first.
    const merged: Route[] = []
    const byKey = new Map<string, Route>()
    for (const route of routes) {
      // An endpoint and a page of one folder answer the same method apart: they stay two.
      const key = `${route.pattern}\0${route.method}\0${route.path}\0${paged in route}`
      const first = byKey.get(key)
      if (!first) {
        byKey.set(key, route)
        merged.push(route)
      } else first.handler.targets.push(...route.handler.targets)
    }
    merged.push(...this.remote(root, hooks))
    return merged
  }

  // What applies to every route: each hook's exports, in order, a sequence seen through.
  private hooks(root: string): Member[] {
    return (this.spec.hooks ?? []).flatMap((hook) => {
      const file = this.moduleAt(root, hook.file)
      return file ? hook.exports.flatMap((x) => this.exported(file, x)?.members ?? []) : []
    })
  }

  // The matchers a route's parameters name: `[id=integer]` runs `integer` first.
  private matchers(root: string, id: string): Member[] {
    const names = [...id.matchAll(/\[(?:\.\.\.)?[\w$]+=([\w$]+)\]/g)].map((m) => m[1] as string)
    return names.flatMap((name) => {
      for (const rule of this.spec.matchers ?? []) {
        const file = this.moduleAt(root, rule.file.replace('{matcher}', name))
        if (!file) continue
        const found = this.exported(file, { name: rule.name, does: 'use' })
        if (!found) continue
        if (!rule.property) return found.members
        const property = rule.property.replace('{matcher}', name)
        const object = this.objectOf(found.node, file, rule.through ?? [])
        for (const [key, member] of object ? this.members(file, object) : [])
          if (key === property) return [member]
      }
      return []
    })
  }

  // Routes of modules whose exports are built by calls the profile names: `export const getUser =
  // query(…)` at `path`, its handler the last function given to the call.
  private remote(root: string, hooks: Member[]): Route[] {
    const remote = this.spec.remote
    if (!remote) return []
    const routes: Route[] = []
    const calls = new Map(remote.calls.map((c) => [`ext:${c.call}`, c.method]))
    for (const file of this.program.files) {
      if ((file.package?.dir ?? '.') !== root) continue
      if (!file.path.replace(extension, '').endsWith(remote.suffix)) continue
      const relative = root === '.' ? file.path : file.path.slice(root.length + 1)
      for (const [name, exp] of [...file.exports].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const binding = exp.local !== undefined ? file.bindings.get(exp.local) : undefined
        const value = binding?.kind === 'value' && !binding.path ? binding.value : undefined
        const call = value ? unwrap(value) : undefined
        if (call?.type !== 'call_expression') continue
        const fn = call.childForFieldName('function')
        const method = (fn ? (this.program.callees(fn, file) ?? []) : [])
          .map((t) => calls.get(t.ref))
          .find((m) => m)
        if (!method) continue
        const args = present(call.childForFieldName('arguments')?.namedChildren ?? [])
        const last = args.at(-1)
        if (!last) continue
        const handler = {
          ...this.interpreter(undefined).member(last, file, new Map(), ''),
          citation: { file: file.path, line: line(call) },
        }
        routes.push({
          method,
          path: remote.path.replace('$file', () => relative).replace('$name', () => name),
          pattern: `${relative}#${name}`,
          handler,
          chain: hooks,
          citation: handler.citation,
          group: groups - 1,
        })
      }
    }
    return routes
  }

  private interpreter(receives: string | undefined): TsRouteInterpreter {
    const key = receives ?? ''
    let found = this.interpreters.get(key)
    if (!found) {
      const context = receives
        ? this.typeFor(receives)
        : this.profile.context
          ? this.typeFor(this.profile.context)
          : undefined
      found = new TsRouteInterpreter(this.program, this.profile, context)
      this.interpreters.set(key, found)
    }
    return found
  }

  // What a file exports under a name: the members its value names (a function, a sequence of
  // them), and the node of the value, for an object of routes. A name it re-exports is followed.
  private exported(
    file: TsFile,
    rule: Pick<FileExport, 'name' | 'receives'> & { does: FileExport['does'] },
    depth = 0,
  ): { members: Member[]; node: Node; file: TsFile } | undefined {
    if (depth > 8) return undefined
    const exp = file.exports.get(rule.name)
    if (!exp) return undefined
    const citation = { file: file.path, line: 1 }
    if (exp.from !== undefined || (exp.local !== undefined && !file.bindings.has(exp.local))) {
      const ref = this.program.exported(file, rule.name)
      if (ref?.kind !== 'binding' || ref.file === file) return undefined
      const name =
        ref.binding.kind === 'decl'
          ? ref.binding.decl.name
          : ref.binding.kind === 'value'
            ? (ref.binding.node.childForFieldName('name')?.text ?? rule.name)
            : rule.name
      return this.exported(ref.file, { ...rule, name }, depth + 1)
    }
    const binding = exp.local !== undefined ? file.bindings.get(exp.local) : undefined
    if (binding?.kind === 'import') {
      const ref = this.program.follow(binding, file)
      if (ref?.kind !== 'binding') return undefined
      const target = ref.file.exports.has(binding.name) ? binding.name : undefined
      return target ? this.exported(ref.file, { ...rule, name: target }, depth + 1) : undefined
    }
    const interpreter = this.interpreter(rule.receives)
    if (binding?.kind === 'decl') {
      const node = binding.decl.node
      const statement = node.parent?.type === 'export_statement' ? node.parent : node
      const member: Member = {
        text: rule.name,
        citation: { ...citation, line: line(statement) },
        targets: [{ ref: binding.decl.ref, resolution: 'resolved' }],
      }
      interpreter.handlers.add(node)
      this.receive(node, rule.receives)
      return { members: [member], node, file }
    }
    const value = binding?.kind === 'value' && !binding.path ? binding.value : exp.value
    if (!value) return undefined
    const declarator = binding?.kind === 'value' ? binding.node : value
    const statement =
      declarator.parent?.parent?.type === 'export_statement'
        ? declarator.parent.parent
        : (declarator.parent ?? declarator)
    const at = { ...citation, line: line(statement) }
    const inner = unwrap(value)
    if (inner.type === 'object') return { members: [], node: inner, file }
    const members = this.chainOf(inner, file, rule.receives).map((m) => ({
      ...m,
      text: m.text === inner.text.replace(/\s+/g, ' ').slice(0, 200) ? rule.name : m.text,
      citation: at,
    }))
    return { members, node: inner, file }
  }

  // The members a value names, a call to a function that composes a chain seen through.
  private chainOf(node: Node, file: TsFile, receives: string | undefined): Member[] {
    const inner = unwrap(node)
    if (inner.type === 'call_expression') {
      const fn = inner.childForFieldName('function')
      const targets = fn ? (this.program.callees(fn, file) ?? []) : []
      if (targets.some((t) => this.compose.has(t.ref)))
        return present(inner.childForFieldName('arguments')?.namedChildren ?? []).flatMap((arg) =>
          this.chainOf(arg, file, receives),
        )
    }
    return [this.interpreter(receives).member(inner, file, new Map(), '')]
  }

  // Gives a function the type it receives first, before the interpreter gives the context.
  private receive(fn: Node, receives: string | undefined) {
    const symbol = receives ?? this.profile.context
    if (symbol) this.program.giveParameter(fn, 0, this.typeFor(symbol))
  }

  // The routes an exported object holds, by property: `actions = { default, create }`.
  private properties(file: TsFile, node: Node, rule: FileExport): [string, Member][] {
    const object = this.objectAt(node, file)
    return object ? this.members(object.file, object.node, rule.receives) : []
  }

  // The object literal a value is: written in place, or held by a name of the module or one it
  // imports.
  private objectAt(node: Node, file: TsFile, depth = 0): { node: Node; file: TsFile } | undefined {
    if (depth > 8) return undefined
    const inner = unwrap(node)
    if (inner.type === 'object') return { node: inner, file }
    if (inner.type !== 'identifier') return undefined
    const binding = this.program.lookup(inner.text, inner, file)
    const ref = binding ? this.program.follow(binding, file) : undefined
    if (ref?.kind !== 'binding' || ref.binding.kind !== 'value' || ref.binding.path)
      return undefined
    return ref.binding.value ? this.objectAt(ref.binding.value, ref.file, depth + 1) : undefined
  }

  private members(file: TsFile, object: Node, receives?: string, depth = 0): [string, Member][] {
    const found: [string, Member][] = []
    for (const property of present(object.namedChildren)) {
      const citation = { file: file.path, line: line(property) }
      // `{ ...shared, save }` holds the properties of what it spreads.
      if (property.type === 'spread_element') {
        const spread = property.namedChildren[0]
        const inner = spread && depth < 8 ? this.objectAt(spread, file) : undefined
        if (inner) found.push(...this.members(inner.file, inner.node, receives, depth + 1))
        continue
      }
      if (property.type === 'method_definition') {
        const decl = file.declsById.get(property.id)
        const name = keyName(property.childForFieldName('name'))
        if (!decl || !name) continue
        this.interpreter(receives).handlers.add(property)
        this.receive(property, receives)
        found.push([
          name,
          { text: name, citation, targets: [{ ref: decl.ref, resolution: 'resolved' }] },
        ])
        continue
      }
      const name =
        property.type === 'shorthand_property_identifier'
          ? property.text
          : property.type === 'pair'
            ? keyName(property.childForFieldName('key'))
            : undefined
      const value =
        property.type === 'shorthand_property_identifier'
          ? property
          : property.childForFieldName('value')
      if (!name || !value) continue
      const member = this.interpreter(receives).member(unwrap(value), file, new Map(), '')
      found.push([name, { ...member, text: name, citation }])
    }
    return found
  }

  // The object a value is, seen through the functions given it (`defineParams({…})`).
  private objectOf(node: Node, file: TsFile, through: string[]): Node | undefined {
    const inner = unwrap(node)
    if (inner.type === 'object') return inner
    if (inner.type !== 'call_expression') return undefined
    const fn = inner.childForFieldName('function')
    const [first] = present(inner.childForFieldName('arguments')?.namedChildren ?? [])
    const targets = fn ? (this.program.callees(fn, file) ?? []) : []
    return first && targets.some((t) => through.includes(t.ref.slice(4)))
      ? this.objectOf(first, file, through)
      : undefined
  }
}
