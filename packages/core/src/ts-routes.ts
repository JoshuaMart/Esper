import type { Node } from 'web-tree-sitter'
import { type Callee, joinPath, type Member, normalisePattern, type Route } from './entries.ts'
import type { Citation } from './graph.ts'
import type {
  ArgRole,
  PatternSyntax,
  ResolvedProfile,
  RouterMethod,
  RouterSpec,
} from './profile.ts'
import {
  type Binding,
  type Decl,
  keyName,
  line,
  parametersOf,
  present,
  type Target,
  type TsFile,
  type TsProgram,
  type TsType,
  typeSymbol,
} from './ts.ts'

// Routes of a TypeScript or JavaScript application, from what a profile says its routers do (D10).
// Router values are followed through variables, the module's own names and its imports, the
// arguments of calls and the results of functions that build one (`apiRouter()`), so that a route
// gets the full path of the routers it is mounted under. A router whose middleware is `ordered`
// applies it to the routes registered after it, whose path its own matches, as Hono does.

interface Registration {
  // Middleware, with the path pattern it applies to.
  use?: { pattern: string; members: Member[] }
  route?: Route
  mount?: { prefix: string; router: Router }
  // Where it was registered, so that a body interpreted twice registers once.
  key: string
}

interface Router {
  id: number
  spec: RouterSpec
  site: Citation
  entries: Registration[]
  // A router mounted on another is not a root.
  parents: number
  // A router that registers on another under a prefix (`basePath`).
  view?: { router: Router; prefix: string }
  // A router parameter that no call binds: its routes are kept under `${name}`, the prefix the
  // index could not read.
  parameter?: string
}

type Env = Map<string, Router>

const defaultArgs: Record<RouterMethod['does'], ArgRole[]> = {
  route: ['path', 'handler'],
  use: [],
  with: [],
  group: ['callback'],
  subrouter: ['path', 'callback'],
  mount: ['path', 'handler'],
  prefix: ['path'],
}

const literals = new Set(['arrow_function', 'function_expression', 'generator_function'])
const wrappers = new Set([
  'parenthesized_expression',
  'await_expression',
  'as_expression',
  'satisfies_expression',
  'non_null_expression',
])

// Whether every request to a route's path also matches a middleware's path pattern: a parameter
// of the pattern matches any segment, a catch-all the rest of the path or nothing.
export function covers(pattern: string, path: string): boolean {
  const p = pattern.split('/').filter(Boolean)
  const r = path.split('/').filter(Boolean)
  for (let i = 0; i < p.length; i++) {
    const part = p[i] as string
    if (/^\{\w*\.\.\.\}$/.test(part) || part === '*') return true
    const seg = r[i]
    if (seg === undefined || /^\{\w*\.\.\.\}$/.test(seg)) return false
    if (/^\{\w+\}$/.test(part)) continue
    if (part !== seg) return false
  }
  return p.length === r.length
}

export class TsRouteInterpreter {
  private readonly routers: Router[] = []
  private readonly sites = new Map<string, Router>()
  private readonly results = new Map<string, Router | undefined>()
  private readonly stack = new Set<string>()
  private readonly modules = new Map<string, Env>()
  private readonly creators: Map<string, RouterSpec>
  private readonly adapters: Set<string>
  private readonly program: TsProgram
  private readonly context: TsType | undefined
  // The functions a profile's routes run, given the context they receive.
  readonly handlers = new Set<Node>()
  // The file a configuration's properties are written in, which may not be the route's.
  private readonly configFile = new Map<number, TsFile>()
  private readonly specs: RouterSpec[]
  // Parameter routers that some call did bind to a real router.
  private readonly bound = new Set<number>()
  // Routers built by a factory read on its own, rather than for one of its calls.
  private readonly templates = new Set<number>()

  constructor(program: TsProgram, profile: ResolvedProfile, context: TsType | undefined) {
    this.program = program
    this.context = context
    this.creators = new Map(
      profile.routers.flatMap((spec) =>
        (spec.create ?? []).map((c): [string, RouterSpec] => [`ext:${c}`, spec]),
      ),
    )
    this.adapters = new Set(profile.adapters.map((a) => `ext:${a}`))
    this.specs = profile.routers
  }

  // Every route, with its full path and chain, from the routers that are not mounted anywhere.
  routes(): Route[] {
    for (const file of this.program.files) this.module(file)
    for (const file of this.program.files) {
      for (const decl of file.decls) {
        if (decl.kind !== 'literal' && decl.kind !== 'class')
          this.interpret(decl, file, new Map(), '')
      }
    }
    const routes: Route[] = []
    for (const root of this.routers) {
      if (root.parents > 0 || root.view || this.templates.has(root.id)) continue
      if (root.parameter !== undefined && this.bound.has(root.id)) continue
      const flat: Registration[] = []
      this.flatten(
        root,
        root.parameter === undefined ? '' : `/\${${root.parameter}}`,
        flat,
        new Set(),
      )
      const ordered = root.spec.ordered ?? false
      flat.forEach((entry, i) => {
        if (!entry.route) return
        const route = entry.route
        const uses = (ordered ? flat.slice(0, i) : flat).filter(
          (e) => e.use && covers(e.use.pattern, route.path),
        )
        routes.push({
          ...route,
          chain: [...uses.flatMap((u) => u.use?.members ?? []), ...route.chain],
        })
      })
    }
    return routes
  }

  // The registrations of a router and of what is mounted on it, in order, with their full paths.
  private flatten(router: Router, prefix: string, out: Registration[], seen: Set<number>) {
    if (seen.has(router.id)) return
    const inner = new Set(seen).add(router.id)
    for (const entry of router.entries) {
      if (entry.use)
        out.push({ ...entry, use: { ...entry.use, pattern: joinPath(prefix, entry.use.pattern) } })
      else if (entry.route)
        out.push({ ...entry, route: { ...entry.route, path: joinPath(prefix, entry.route.path) } })
      else if (entry.mount)
        this.flatten(entry.mount.router, joinPath(prefix, entry.mount.prefix), out, inner)
    }
  }

  private router(key: string, spec: RouterSpec, site: Citation): Router {
    let router = this.sites.get(key)
    if (!router) {
      router = { id: this.routers.length, spec, site, entries: [], parents: 0 }
      this.routers.push(router)
      this.sites.set(key, router)
    }
    return router
  }

  // Where registrations on a router go: a view registers on the router it was taken from.
  private register(router: Router, entry: Registration) {
    let target = router
    let prefix = ''
    while (target.view) {
      prefix = joinPath(target.view.prefix, prefix)
      target = target.view.router
    }
    const shifted: Registration = entry.use
      ? { ...entry, use: { ...entry.use, pattern: joinPath(prefix, entry.use.pattern) } }
      : entry.route
        ? { ...entry, route: { ...entry.route, path: joinPath(prefix, entry.route.path) } }
        : entry.mount
          ? { ...entry, mount: { ...entry.mount, prefix: joinPath(prefix, entry.mount.prefix) } }
          : entry
    if (target.entries.some((e) => e.key === shifted.key)) return
    target.entries.push(shifted)
    if (shifted.mount) shifted.mount.router.parents++
  }

  private site(file: TsFile, node: Node): Citation {
    return { file: file.path, line: line(node) }
  }

  // The routers a file's top-level names hold, once its statements are interpreted.
  private module(file: TsFile): Env {
    let env = this.modules.get(file.path)
    if (env) return env
    env = new Map()
    this.modules.set(file.path, env)
    this.body(file.tree.rootNode, file, env, '')
    return env
  }

  // Interprets a declaration's body with routers bound to some of its names, once per binding.
  // Returns the router it returns, if it returns one.
  private interpret(decl: Decl, file: TsFile, env: Env, caller: string): Router | undefined {
    // A parameter typed as a router and bound by no caller gets a router of its own, so that what
    // is registered on it is kept, under a prefix that says it is unknown, as in Go.
    for (const param of parametersOf(decl.node)) {
      if (param.pattern.type !== 'identifier' || !param.type) continue
      const symbol = typeSymbol(this.program.typeOfAnnotation(param.type, file))
      const spec = symbol ? this.specs.find((r) => r.types.includes(symbol)) : undefined
      if (!spec) continue
      const name = param.pattern.text
      const placeholder = this.router(`param:${decl.ref}:${name}`, spec, this.site(file, decl.node))
      placeholder.parameter = name
      const given = env.get(name)
      if (given && given.id !== placeholder.id) this.bound.add(placeholder.id)
      if (!given) env.set(name, placeholder)
    }
    const key = `${decl.ref}\0${caller}\0${[...env].map(([name, r]) => `${name}=${r.id}`).join(',')}`
    if (this.results.has(key)) return this.results.get(key)
    if (this.stack.has(key)) return undefined
    const body = decl.node.childForFieldName('body')
    if (!body) return undefined
    this.stack.add(key)
    let returned: Router | undefined
    try {
      if (decl.node.type === 'arrow_function' && body.type !== 'statement_block') {
        returned = this.evaluate(body, file, env, caller)
      } else returned = this.body(body, file, env, caller)
    } finally {
      this.stack.delete(key)
    }
    this.results.set(key, returned)
    return returned
  }

  private body(body: Node, file: TsFile, env: Env, caller: string): Router | undefined {
    let returned: Router | undefined
    const visit = (node: Node) => {
      // Literals run when called; classes hold no statements that run here.
      if (
        literals.has(node.type) ||
        node.type === 'function_declaration' ||
        node.type === 'class_declaration'
      )
        return
      if (node.type === 'variable_declarator') {
        const name = node.childForFieldName('name')
        const value = node.childForFieldName('value')
        if (!value) return
        const router = this.evaluate(value, file, env, caller)
        if (name?.type === 'identifier' && router) env.set(name.text, router)
        return
      }
      if (node.type === 'assignment_expression') {
        const left = node.childForFieldName('left')
        const right = node.childForFieldName('right')
        if (!right) return
        const router = this.evaluate(right, file, env, caller)
        if (left?.type === 'identifier' && router) env.set(left.text, router)
        return
      }
      if (node.type === 'return_statement') {
        for (const value of present(node.namedChildren))
          returned ??= this.evaluate(value, file, env, caller)
        return
      }
      if (node.type === 'export_statement') {
        const value = node.childForFieldName('value')
        if (value) {
          this.evaluate(value, file, env, caller)
          return
        }
      }
      if (node.type === 'call_expression' || node.type === 'new_expression') {
        this.evaluate(node, file, env, caller)
        return
      }
      for (const child of present(node.namedChildren)) visit(child)
    }
    visit(body)
    return returned
  }

  // The router an expression evaluates to, if any; calls in it are interpreted on the way.
  private evaluate(node: Node, file: TsFile, env: Env, caller: string): Router | undefined {
    if (wrappers.has(node.type)) {
      const inner = node.namedChildren[0]
      return inner ? this.evaluate(inner, file, env, caller) : undefined
    }
    if (node.type === 'identifier') return env.get(node.text) ?? this.named(node, file)
    if (node.type === 'call_expression') return this.call(node, file, env, caller)
    if (node.type === 'new_expression') {
      const ctor = node.childForFieldName('constructor')
      for (const arg of present(node.childForFieldName('arguments')?.namedChildren ?? []))
        this.evaluate(arg, file, env, caller)
      const targets = ctor ? (this.program.targets(ctor, file) ?? []) : []
      for (const target of targets) {
        const spec = this.creators.get(target.ref)
        if (spec)
          return this.router(
            `${file.path}:${node.startIndex}\0${caller}`,
            spec,
            this.site(file, node),
          )
      }
      return undefined
    }
    if (node.type === 'member_expression') {
      const object = node.childForFieldName('object')
      if (object) this.evaluate(object, file, env, caller)
      return undefined
    }
    if (literals.has(node.type)) return undefined
    for (const child of present(node.namedChildren)) {
      if (
        child.type === 'call_expression' ||
        child.type === 'new_expression' ||
        wrappers.has(child.type) ||
        child.type === 'arguments' ||
        child.type === 'object' ||
        child.type === 'array' ||
        child.type === 'pair' ||
        child.type === 'ternary_expression' ||
        child.type === 'binary_expression'
      )
        this.evaluate(child, file, env, caller)
    }
    return undefined
  }

  // The router a name of the module, or a name it imports, holds.
  private named(node: Node, file: TsFile): Router | undefined {
    const binding = this.program.lookup(node.text, node, file)
    return binding ? this.held(binding, file) : undefined
  }

  private held(binding: Binding, file: TsFile, depth = 0): Router | undefined {
    if (depth > 8) return undefined
    if (binding.kind === 'import') {
      const ref = this.program.follow(binding, file)
      return ref?.kind === 'binding' ? this.held(ref.binding, ref.file, depth + 1) : undefined
    }
    if (binding.kind !== 'value' || binding.path) return undefined
    // A name of a module: what its top-level statements bound it to.
    const declarator = binding.node
    let top: Node | null = declarator.parent
    while (top && top.type !== 'program' && top.type !== 'statement_block') top = top.parent
    if (top?.type !== 'program') return undefined
    const name = declarator.childForFieldName('name')?.text
    const env = this.module(binding.file)
    const found = name ? env.get(name) : undefined
    if (found) return found
    // `export default <expression>`.
    if (binding.value && binding.value.id === declarator.id)
      return this.evaluate(binding.value, binding.file, env, '')
    return undefined
  }

  // Interprets a call: a router method, a router constructor, or a call that passes routers on.
  // Returns the router the call evaluates to.
  private call(node: Node, file: TsFile, env: Env, caller: string): Router | undefined {
    const fn = node.childForFieldName('function')
    const args = present(node.childForFieldName('arguments')?.namedChildren ?? [])
    if (!fn) return undefined
    if (fn.type === 'member_expression') {
      const object = fn.childForFieldName('object')
      const name = keyName(fn.childForFieldName('property'))
      const receiver = object ? this.evaluate(object, file, env, caller) : undefined
      const method = receiver?.spec.methods.find((m) => m.name === name)
      if (receiver && method) return this.apply(receiver, method, node, args, file, env, caller)
    }
    // Arguments are evaluated first: a call among them may build or pass on a router.
    const bound = args.map((arg) => this.evaluate(arg, file, env, caller))
    const targets = literals.has(fn.type)
      ? this.program.targets(fn, file)
      : this.program.callees(fn, file)
    for (const target of targets ?? []) {
      const created = this.creators.get(target.ref)
      if (created)
        return this.router(
          `${file.path}:${node.startIndex}\0${caller}`,
          created,
          this.site(file, node),
        )
    }
    // Routers passed as arguments bind the callee's parameters at the same positions, and a callee
    // that builds and returns a router gives the call its value: a router it creates is one per
    // call, so that each `apiRouter()` is a router of its own.
    let result: Router | undefined
    for (const target of targets ?? []) {
      if (!target.decl || target.resolution !== 'resolved' || target.decl.kind === 'class') continue
      const calleeFile = this.program.file(target.decl.file)
      if (!calleeFile) continue
      const calleeEnv: Env = new Map()
      parametersOf(target.decl.node).forEach((param, i) => {
        const router = bound[i]
        if (param.pattern.type === 'identifier' && router) calleeEnv.set(param.pattern.text, router)
      })
      const shared = this.interpret(target.decl, calleeFile, calleeEnv, '')
      const fresh =
        !!shared &&
        shared.site.file === calleeFile.path &&
        this.within(target.decl, shared.site.line)
      const own = fresh
        ? this.interpret(
            target.decl,
            calleeFile,
            calleeEnv,
            `${caller}>${file.path}:${node.startIndex}`,
          )
        : shared
      // The router a factory builds when read on its own stands for those its calls build.
      if (fresh && shared) this.templates.add(shared.id)
      result ??= own
    }
    return result
  }

  private within(decl: Decl, at: number): boolean {
    return at >= line(decl.node) && at <= decl.node.endPosition.row + 1
  }

  private apply(
    router: Router,
    method: RouterMethod,
    node: Node,
    args: Node[],
    file: TsFile,
    env: Env,
    caller: string,
  ): Router | undefined {
    // A chained registration is cited where its method is named: `.get(` on its own line.
    const site = this.site(
      file,
      node.childForFieldName('function')?.childForFieldName('property') ?? node,
    )
    const key = `${file.path}:${node.startIndex}`
    const chained = router.spec.chained ? router : undefined
    const syntax: PatternSyntax = method.pattern ?? router.spec.pattern
    const roles = method.args ?? defaultArgs[method.does]
    // Each argument by role: `chain` takes those between the ones before it and the last ones.
    const byRole = new Map<ArgRole, Node[]>()
    const rest = roles.indexOf('chain')
    const before = rest < 0 ? roles : roles.slice(0, rest)
    const after = rest < 0 ? [] : roles.slice(rest + 1)
    before.forEach((role, i) => {
      const arg = args[i]
      if (arg) byRole.set(role, [arg])
    })
    after.forEach((role, j) => {
      const index = args.length - after.length + j
      const arg = args[index]
      if (arg && index >= before.length) byRole.set(role, [arg])
    })
    if (rest >= 0)
      byRole.set(
        'chain',
        args.slice(before.length, Math.max(before.length, args.length - after.length)),
      )
    // A configuration object gives its properties their roles.
    const config = byRole.get('config')?.[0]
    if (config && method.config) {
      const object = this.configObject(config, file, method.through ?? [])
      for (const property of present(object?.node.namedChildren ?? [])) {
        // `{ path }` is the property `path` with the value of the name `path`.
        const shorthand = property.type === 'shorthand_property_identifier'
        if (property.type !== 'pair' && !shorthand) continue
        const role =
          method.config[
            shorthand ? property.text : (keyName(property.childForFieldName('key')) ?? '')
          ]
        const value = shorthand ? property : property.childForFieldName('value')
        if (!role || !value || !object) continue
        if (role === 'chain') {
          const members = this.listOf(value, object.file)
          byRole.set(
            'chain',
            members.map((m) => m.node),
          )
          for (const m of members) this.configFile.set(m.node.id, m.file)
        } else {
          byRole.set(role, [value])
          this.configFile.set(value.id, object.file)
        }
      }
    }
    const fileOf = (n: Node) => this.configFile.get(n.id) ?? file
    const one = (role: ArgRole) => byRole.get(role)?.[0]
    const strings = (n: Node | undefined): string[] | undefined => {
      if (!n) return undefined
      const f = fileOf(n)
      if (n.type === 'array') {
        const values = present(n.namedChildren).map((v) => this.program.stringValueOf(v, f))
        return values.every((v) => v !== undefined) ? (values as string[]) : undefined
      }
      const value = this.program.stringValueOf(n, f)
      if (value !== undefined) return [value]
      // A name a loop takes from a list of strings: `for (const path of ['/a', '/b'])`.
      if (n.type === 'identifier') {
        for (let scope = n.parent; scope; scope = scope.parent) {
          if (scope.type !== 'for_in_statement') continue
          const left = scope.childForFieldName('left')
          const right = scope.childForFieldName('right')
          if (left?.text !== n.text || right?.type !== 'array') continue
          const values = present(right.namedChildren).map((v) => this.program.stringValueOf(v, f))
          return values.every((v) => v !== undefined) ? (values as string[]) : undefined
        }
      }
      return undefined
    }

    switch (method.does) {
      case 'route': {
        const pathNode = one('path')
        const paths = strings(pathNode) ?? [pathNode ? `\${${pathNode.text}}` : '/']
        const methodNode = one('method')
        let verbs = [method.method ?? 'ANY']
        if (methodNode)
          verbs = strings(methodNode)?.map((v) => v.toUpperCase()) ?? [`\${${methodNode.text}}`]
        const handlerNode = one('handler')
        if (!handlerNode) return chained
        const handler = this.member(handlerNode, fileOf(handlerNode), env, caller)
        const chain = (byRole.get('chain') ?? []).map((m) => this.member(m, fileOf(m), env, caller))
        for (const raw of paths) {
          const pattern = normalisePattern(raw, syntax)
          for (const verb of verbs) {
            this.register(router, {
              key: `${key}\0${verb}\0${raw}`,
              route: {
                method: verb,
                path: pattern.path,
                pattern: raw,
                handler,
                chain,
                citation: site,
                group: router.id,
              },
            })
          }
        }
        return chained
      }
      case 'use': {
        let members = args
        let pattern = '/{rest...}'
        const first = args[0]
        // The first argument is a path when its value is known, or when it is a string the index
        // cannot read (`${base}/*`): kept as written, it matches no route rather than all of them.
        let paths = roles.includes('path') && first ? strings(first) : undefined
        if (!paths && roles.includes('path') && first && this.pathLike(first, file)) {
          paths = [`\${${first.text.replace(/\s+/g, ' ')}}`]
        }
        if (paths) members = args.slice(1)
        const chain = members.map((m) => this.member(m, file, env, caller))
        for (const path of paths ?? [undefined]) {
          if (path !== undefined) pattern = normalisePattern(path, syntax).path
          this.register(router, { key: `${key}\0${path ?? ''}`, use: { pattern, members: chain } })
        }
        return chained
      }
      case 'mount': {
        const pathNode = one('path')
        const prefix = normalisePattern(
          strings(pathNode)?.[0] ?? (pathNode ? `\${${pathNode.text}}` : ''),
          syntax,
        ).path
        const handlerNode = one('handler')
        if (!handlerNode) return chained
        const child = this.evaluate(handlerNode, file, env, caller)
        if (child) this.register(router, { key, mount: { prefix, router: child } })
        else {
          // A handler that is not a router serves the whole subtree.
          this.register(router, {
            key,
            route: {
              method: 'ANY',
              path: joinPath(prefix, '{rest...}'),
              pattern: prefix,
              handler: this.member(handlerNode, file, env, caller),
              chain: [],
              citation: site,
              group: router.id,
            },
          })
        }
        return chained
      }
      case 'prefix':
      case 'subrouter':
      case 'group':
      case 'with': {
        const pathNode = one('path')
        const prefix =
          method.does === 'group' || method.does === 'with'
            ? ''
            : normalisePattern(
                strings(pathNode)?.[0] ?? (pathNode ? `\${${pathNode.text}}` : ''),
                syntax,
              ).path
        const view = this.router(`${key}\0${router.id}\0${caller}`, router.spec, site)
        view.view = { router, prefix }
        if (method.does === 'with') {
          for (const mw of args)
            this.register(view, {
              key: `${key}\0with`,
              use: { pattern: '/{rest...}', members: [this.member(mw, file, env, caller)] },
            })
        }
        const callback = one('callback')
        if (callback) {
          for (const target of this.program.callees(callback, file) ?? []) {
            const calleeFile = target.decl ? this.program.file(target.decl.file) : undefined
            const [param] = target.decl ? parametersOf(target.decl.node) : []
            if (target.decl && calleeFile && param?.pattern.type === 'identifier')
              this.interpret(target.decl, calleeFile, new Map([[param.pattern.text, view]]), caller)
          }
        }
        return view
      }
    }
  }

  // Whether an expression is a string rather than a function: a string or template literal, a
  // concatenation, or a name the syntax types as no function and that names none.
  private pathLike(node: Node, file: TsFile): boolean {
    if (['string', 'template_string', 'binary_expression'].includes(node.type)) return true
    if (node.type !== 'identifier' && node.type !== 'member_expression') return false
    if ((this.program.callees(node, file) ?? []).length > 0) return false
    return this.program.typeOf(node, file)?.kind === 'outside'
  }

  // The members of a list of middleware: an array, a name that holds one, and what it spreads.
  private listOf(node: Node, file: TsFile, depth = 0): { node: Node; file: TsFile }[] {
    if (depth > 8) return []
    if (wrappers.has(node.type) && node.namedChildren[0])
      return this.listOf(node.namedChildren[0], file, depth + 1)
    if (node.type === 'array') {
      return present(node.namedChildren).flatMap((element) =>
        element.type === 'spread_element' && element.namedChildren[0]
          ? this.listOf(element.namedChildren[0], file, depth + 1)
          : [{ node: element, file }],
      )
    }
    if (node.type === 'identifier') {
      const binding = this.program.lookup(node.text, node, file)
      const ref = binding ? this.program.follow(binding, file) : undefined
      if (
        ref?.kind === 'binding' &&
        ref.binding.kind === 'value' &&
        !ref.binding.path &&
        ref.binding.value
      ) {
        const value = ref.binding.value
        const inner = wrappers.has(value.type) ? value.namedChildren[0] : value
        if (inner?.type === 'array') return this.listOf(value, ref.file, depth + 1)
      }
    }
    return [{ node, file }]
  }

  // The object literal a configuration argument is: written in place, held by a name, or given to
  // a function that returns it (`createRoute({…})`).
  private configObject(
    node: Node,
    file: TsFile,
    through: string[],
    depth = 0,
  ): { node: Node; file: TsFile } | undefined {
    if (depth > 8) return undefined
    if (wrappers.has(node.type)) {
      const inner = node.namedChildren[0]
      return inner ? this.configObject(inner, file, through, depth + 1) : undefined
    }
    if (node.type === 'object') return { node, file }
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function')
      const targets = fn ? (this.program.callees(fn, file) ?? []) : []
      const [first] = present(node.childForFieldName('arguments')?.namedChildren ?? [])
      if (first && targets.some((t) => through.includes(t.ref.slice(4))))
        return this.configObject(first, file, through, depth + 1)
      return undefined
    }
    if (node.type === 'identifier') {
      const binding = this.program.lookup(node.text, node, file)
      const ref = binding ? this.program.follow(binding, file) : undefined
      if (
        ref?.kind === 'binding' &&
        ref.binding.kind === 'value' &&
        ref.binding.value &&
        !ref.binding.path
      )
        return this.configObject(ref.binding.value, ref.file, through, depth + 1)
    }
    return undefined
  }

  // What a handler or middleware expression names: a function, a method, a literal, or the
  // function a factory call names (`cors({…})`). Adapters (`createMiddleware(fn)`) are seen
  // through, and a handler built by a call the index cannot name is the function literal it is
  // given. Each function a route runs receives the context first, when it states no type.
  member(node: Node, file: TsFile, env: Env, caller: string): Member {
    const citation = this.site(file, node)
    const text = node.text.replace(/\s+/g, ' ').slice(0, 200)
    if (wrappers.has(node.type)) {
      const inner = node.namedChildren[0]
      if (inner) return { ...this.member(inner, file, env, caller), text, citation }
    }
    let targets: Target[] = []
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function')
      const args = present(node.childForFieldName('arguments')?.namedChildren ?? [])
      targets = fn ? (this.program.callees(fn, file) ?? []) : []
      const [first] = args
      if (first && targets.some((t) => this.adapters.has(t.ref))) {
        return { ...this.member(first, file, env, caller), text, citation }
      }
      if (targets.length === 0) {
        const given = args.filter((a) => literals.has(a.type))
        targets = given.flatMap((literal) => {
          const decl = file.declsById.get(literal.id)
          return decl
            ? [
                {
                  ref: decl.ref,
                  decl,
                  resolution: 'guessed' as const,
                  reason: `built by ${fn?.text ?? 'a call'}(…), which the index cannot name`,
                },
              ]
            : []
        })
      }
      // A factory runs what it returns: the function literals it returns receive the context.
      for (const target of targets) if (target.decl) this.giveReturned(target.decl)
    } else if (['identifier', 'member_expression'].includes(node.type) || literals.has(node.type)) {
      targets =
        (literals.has(node.type)
          ? this.program.targets(node, file)
          : this.program.callees(node, file)) ?? []
      // A name that holds what a call built: `const auth = createMiddleware(…)`, `auth`.
      if (targets.length === 0 && node.type === 'identifier') {
        const binding = this.program.lookup(node.text, node, file)
        const ref = binding ? this.program.follow(binding, file) : undefined
        const value =
          ref?.kind === 'binding' && ref.binding.kind === 'value' && !ref.binding.path
            ? ref.binding.value
            : undefined
        if (
          ref?.kind === 'binding' &&
          value &&
          (value.type === 'call_expression' || wrappers.has(value.type))
        )
          return { ...this.member(value, ref.file, env, caller), text, citation }
      }
    }
    for (const target of targets) if (target.decl) this.give(target.decl.node)
    const callees: Callee[] = targets.map(({ decl: _, ...callee }) => callee)
    void env
    return { text, citation, targets: callees }
  }

  // The context a handler receives first, when its code does not state a type.
  private give(fn: Node) {
    this.handlers.add(fn)
    const [first] = parametersOf(fn)
    if (this.context && first && !first.type) this.program.giveParameter(fn, 0, this.context)
  }

  private giveReturned(decl: Decl) {
    const body = decl.node.childForFieldName('body')
    if (!body) return
    const returned =
      body.type === 'statement_block'
        ? present(body.descendantsOfType('return_statement')).flatMap((r) =>
            present(r.namedChildren),
          )
        : [body]
    for (const value of returned) {
      const inner = wrappers.has(value.type) ? value.namedChildren[0] : value
      if (inner && literals.has(inner.type)) this.give(inner)
    }
  }
}
