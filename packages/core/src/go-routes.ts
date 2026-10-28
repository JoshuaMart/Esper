import type { Node } from 'web-tree-sitter'
import {
  type Decl,
  declaredAt,
  type GoProgram,
  type Located,
  line,
  type ParsedFile,
  present,
  type Target,
} from './go.ts'
import type { Citation } from './graph.ts'
import type { ArgRole, ResolvedProfile, RouterMethod, RouterSpec } from './profile.ts'

// Routes of a Go application, from what a profile says its routers do (D10). Router values are
// followed through variables, the callbacks of groups and subrouters, the arguments of calls
// (`RegisterRoutes(router)`) and the results of functions that build one, so that a route gets the
// full path of the routers it is mounted under, and the middleware of each.

export interface Member {
  text: string
  citation: Citation
  targets: Target[]
}

export interface Route {
  method: string
  path: string
  pattern: string
  handler: Member
  chain: Member[]
  citation: Citation
  // The router the route is declared on, seen through `With` and `Group`: routes of one group
  // are siblings, whose guards can be compared.
  group: number
}

interface Router {
  id: number
  spec: RouterSpec
  site: Citation
  chain: Member[]
  routes: Route[]
  children: { prefix: string; router: Router; key: string }[]
  // A router reached only through another one (`With`, `Group`, a mount) is not a root.
  parents: number
  // For `With` and `Group`: the router they add to.
  inline?: Router
  // A router parameter that no call binds: its routes are kept under `${name}`, the prefix the
  // index could not read.
  parameter?: string
}

type Env = Map<string, Router>

const groupOf = (router: Router): number => (router.inline ? groupOf(router.inline) : router.id)

const routeKey = (r: Pick<Route, 'method' | 'path' | 'citation'>) =>
  `${r.method} ${r.path} ${r.citation.file}:${r.citation.line}`

const defaultArgs: Record<RouterMethod['does'], ArgRole[]> = {
  route: ['path', 'handler'],
  use: [],
  with: [],
  group: ['callback'],
  subrouter: ['path', 'callback'],
  mount: ['path', 'handler'],
}

// A path as written: a string literal, a constant of the package, or, when neither, the expression
// itself in `${…}`, so that the route is kept and says what it could not read.
function pathOf(program: GoProgram, node: Node | undefined, file: ParsedFile): string {
  if (!node) return `\${?}`
  return program.stringValue(node, file) ?? `\${${node.text}}`
}

// A route pattern, normalised (D7): parameters as `{name}`, catch-alls as `{name...}`, no trailing
// slash but on the root. `servemux` patterns may carry a method and end in `/` for a subtree.
export function normalisePattern(
  pattern: string,
  syntax: RouterSpec['pattern'],
): { method?: string; path: string } {
  let text = pattern.trim()
  let method: string | undefined
  const withMethod = /^([A-Z]+)\s+(\S.*)$/.exec(text)
  if (withMethod?.[1] && withMethod[2]) {
    method = withMethod[1]
    text = withMethod[2]
  }
  let path = text
  if (syntax === 'braces') {
    path = path.replace(/\{([A-Za-z_][\w-]*)(:[^}]*)?\}/g, '{$1}').replace(/\*$/, '{rest...}')
  } else {
    path = path.replace(/\{\$\}$/, '')
    if (path.endsWith('/') && path.length > 1 && !/\{[^}]*\.\.\.\}$/.test(path)) path += '{rest...}'
  }
  return { ...(method ? { method } : {}), path }
}

export function joinPath(prefix: string, path: string): string {
  const joined = `${prefix.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
  const clean = joined.replace(/\/{2,}/g, '/')
  return clean.length > 1 ? clean.replace(/\/$/, '') : '/'
}

export class RouteInterpreter {
  private readonly routers: Router[] = []
  private readonly sites = new Map<string, Router>()
  private readonly results = new Map<string, Router | undefined>()
  private readonly stack = new Set<string>()
  // Parameter routers that some call did bind to a real router.
  private readonly bound = new Set<number>()
  private readonly creators: Map<string, RouterSpec>
  private readonly defaults: Map<string, RouterSpec>
  private readonly adapters: Set<string>
  private readonly program: GoProgram
  private readonly profile: ResolvedProfile

  constructor(program: GoProgram, profile: ResolvedProfile) {
    this.program = program
    this.profile = profile
    // Profiles name symbols as `<import path>#<symbol>`; the call graph names them as externals.
    const symbols = (key: 'create' | 'default') =>
      new Map(
        profile.routers.flatMap((spec) =>
          (spec[key] ?? []).map((c): [string, RouterSpec] => [`ext:${c}`, spec]),
        ),
      )
    this.creators = symbols('create')
    this.defaults = symbols('default')
    this.adapters = new Set(profile.adapters.map((a) => `ext:${a}`))
  }

  // Every route, with its full path and chain, from the routers that are not mounted anywhere.
  routes(): Route[] {
    for (const file of this.program.files) {
      for (const decl of file.decls) {
        if (decl.node.type !== 'func_literal') this.interpret(decl, file, new Map())
      }
    }
    // Packages that register on the default router when imported.
    for (const spec of this.profile.routers) {
      const [defaulted] = spec.default ?? []
      if (!defaulted) continue
      for (const registration of spec.registers ?? []) {
        for (const file of this.program.files) {
          const imp = file.imports.find((i) => i.path === registration.import)
          if (!imp) continue
          const site = this.site(file, imp.node)
          const router = this.router(`default:ext:${defaulted.split('#')[0]}`, spec, site)
          for (const { pattern, handler } of registration.routes) {
            const parsed = normalisePattern(pattern, spec.pattern)
            const [path, symbol] = handler.split('#')
            const route: Route = {
              method: parsed.method ?? 'ANY',
              path: parsed.path,
              pattern,
              handler: {
                text: handler,
                citation: site,
                targets: [
                  {
                    ref: `ext:${handler}`,
                    external: `${path?.split('/').at(-1)}.${symbol}`,
                    resolution: 'resolved',
                  },
                ],
              },
              chain: [],
              citation: site,
              group: router.id,
            }
            if (!router.routes.some((r) => routeKey(r) === routeKey(route)))
              router.routes.push(route)
          }
        }
      }
    }
    const routes: Route[] = []
    const walk = (router: Router, prefix: string, chain: Member[], seen: Set<number>) => {
      if (seen.has(router.id)) return
      const inner = new Set(seen).add(router.id)
      const own = [...chain, ...router.chain]
      for (const route of router.routes) {
        routes.push({
          ...route,
          path: joinPath(prefix, route.path),
          chain: [...own, ...route.chain],
        })
      }
      for (const child of router.children)
        walk(child.router, joinPath(prefix, child.prefix), own, inner)
    }
    for (const router of this.routers) {
      if (router.parents > 0) continue
      if (router.parameter === undefined) walk(router, '', [], new Set())
      else if (!this.bound.has(router.id)) walk(router, `/\${${router.parameter}}`, [], new Set())
    }
    return routes
  }

  private router(key: string, spec: RouterSpec, site: Citation): Router {
    let router = this.sites.get(key)
    if (!router) {
      router = {
        id: this.routers.length,
        spec,
        site,
        chain: [],
        routes: [],
        children: [],
        parents: 0,
      }
      this.routers.push(router)
      this.sites.set(key, router)
    }
    return router
  }

  private attach(parent: Router, prefix: string, child: Router) {
    const key = `${prefix}\0${child.id}`
    if (parent.children.some((c) => c.key === key)) return
    parent.children.push({ prefix, router: child, key })
    child.parents++
  }

  private site(file: ParsedFile, node: Node): Citation {
    return { file: file.path, line: line(node) }
  }

  // Interprets a declaration's body with routers bound to some of its names, once per binding.
  // Returns the router it returns, if it returns one.
  private interpret(decl: Decl, file: ParsedFile, env: Env): Router | undefined {
    // A parameter typed as a router and bound by no caller gets a router of its own, so that
    // what is mounted on it is kept, under a prefix that says it is unknown.
    for (const [name, type] of this.parameterTypes(decl, file)) {
      const spec = this.profile.routers.find((r) =>
        r.types.some((t) => {
          const [path, symbol] = t.split('#')
          return 'importPath' in type && type.importPath === path && type.name === symbol
        }),
      )
      if (!spec) continue
      const placeholder = this.router(`param:${decl.ref}:${name}`, spec, this.site(file, decl.node))
      placeholder.parameter = name
      const given = env.get(name)
      if (given && given.id !== placeholder.id) this.bound.add(placeholder.id)
      if (!given) env.set(name, placeholder)
    }
    const key = `${decl.ref}\0${[...env].map(([name, r]) => `${name}=${r.id}`).join(',')}`
    if (this.results.has(key)) return this.results.get(key)
    if (this.stack.has(key)) return undefined
    const body = decl.node.childForFieldName('body')
    if (!body) return undefined
    this.stack.add(key)
    let returned: Router | undefined
    try {
      const visit = (node: Node) => {
        // Literals run when called: as callbacks of groups and subrouters, they are interpreted
        // with the router they receive.
        if (node.type === 'func_literal') return
        if (node.type === 'short_var_declaration' || node.type === 'assignment_statement') {
          const left = present(node.childForFieldName('left')?.namedChildren ?? [])
          const right = present(node.childForFieldName('right')?.namedChildren ?? [])
          for (const value of right) visit(value)
          left.forEach((name, i) => {
            const value = right[i]
            const router = value ? this.evaluate(value, file, env) : undefined
            if (name.type === 'identifier' && router) env.set(name.text, router)
          })
          return
        }
        if (node.type === 'return_statement') {
          for (const value of present(node.namedChildren)) {
            visit(value)
            returned ??= this.evaluate(value, file, env)
          }
          return
        }
        if (node.type === 'call_expression') {
          this.call(node, file, env)
          return
        }
        for (const child of present(node.namedChildren)) visit(child)
      }
      visit(body)
    } finally {
      this.stack.delete(key)
    }
    this.results.set(key, returned)
    return returned
  }

  // The router an expression evaluates to, if any.
  private evaluate(node: Node, file: ParsedFile, env: Env): Router | undefined {
    if (node.type === 'parenthesized_expression' || node.type === 'unary_expression') {
      const inner = node.childForFieldName('operand') ?? node.namedChildren[0]
      return inner ? this.evaluate(inner, file, env) : undefined
    }
    if (node.type === 'identifier') return env.get(node.text)
    if (node.type === 'call_expression') return this.call(node, file, env)
    return undefined
  }

  // Interprets a call: a router method, a router constructor, a default registration, or a call
  // that passes routers on. Returns the router the call evaluates to.
  private call(node: Node, file: ParsedFile, env: Env): Router | undefined {
    const fn = node.childForFieldName('function')
    const args = present(node.childForFieldName('arguments')?.namedChildren ?? [])
    if (!fn) return undefined

    if (fn.type === 'selector_expression') {
      const operand = fn.childForFieldName('operand')
      const name = fn.childForFieldName('field')?.text
      const receiver = operand ? this.evaluate(operand, file, env) : undefined
      const method = receiver?.spec.methods.find((m) => m.name === name)
      if (receiver && method) return this.apply(receiver, method, node, args, file, env)
    }

    // Arguments are evaluated first: a call among them may build or pass on a router.
    const bound = args.map((arg) => this.evaluate(arg, file, env))
    const targets = fn.type === 'func_literal' ? undefined : this.program.targets(fn, file)
    for (const target of targets ?? []) {
      const created = this.creators.get(target.ref)
      if (created) return this.router(`${file.path}:${node.id}`, created, this.site(file, node))
      const defaulted = this.defaults.get(target.ref)
      if (defaulted) {
        const method = defaulted.methods.find((m) => target.ref.endsWith(`#${m.name}`))
        const router = this.router(
          `default:${target.ref.split('#')[0]}`,
          defaulted,
          this.site(file, node),
        )
        if (method) this.apply(router, method, node, args, file, env)
        return undefined
      }
    }

    // Routers passed as arguments bind the callee's parameters at the same positions, and a
    // callee that builds and returns a router gives the call its value.
    let result: Router | undefined
    for (const target of targets ?? []) {
      if (!target.decl || target.resolution !== 'resolved') continue
      const calleeFile = this.program.file(target.decl.file)
      if (!calleeFile) continue
      const params = this.parameters(target.decl)
      const calleeEnv: Env = new Map()
      params.forEach((param, i) => {
        const router = bound[i]
        if (param && router) calleeEnv.set(param, router)
      })
      result ??= this.interpret(target.decl, calleeFile, calleeEnv)
    }
    return result
  }

  private parameterTypes(decl: Decl, file: ParsedFile): [string, Located][] {
    const list = decl.node.childForFieldName('parameters')
    return present(list?.namedChildren ?? []).flatMap((param) => {
      const text = param.childForFieldName('type')?.text
      const type = text ? this.program.locate(text, file) : undefined
      return type
        ? param.childrenForFieldName('name').map((n): [string, Located] => [n.text, type])
        : []
    })
  }

  private parameters(decl: Decl): (string | undefined)[] {
    const list = decl.node.childForFieldName('parameters')
    return present(list?.namedChildren ?? []).flatMap((param) => {
      const names = param.childrenForFieldName('name').map((n) => n.text)
      return names.length > 0 ? names : [undefined]
    })
  }

  private apply(
    router: Router,
    method: RouterMethod,
    node: Node,
    args: Node[],
    file: ParsedFile,
    env: Env,
  ): Router | undefined {
    const roles = method.args ?? defaultArgs[method.does]
    const arg = (role: ArgRole) => {
      const index = roles.indexOf(role)
      return index < 0 ? undefined : args[index]
    }
    const site = this.site(file, node)
    switch (method.does) {
      case 'route': {
        const raw = pathOf(this.program, arg('path'), file)
        const pattern = normalisePattern(raw, router.spec.pattern)
        const explicit = arg('method')
        let verb = method.method ?? 'ANY'
        if (explicit) verb = pathOf(this.program, explicit, file).toUpperCase()
        if (method.method === 'pattern') verb = pattern.method ?? 'ANY'
        const handlerNode = arg('handler')
        if (!handlerNode) return undefined
        const route: Route = {
          method: verb,
          path: pattern.path,
          pattern: raw,
          handler: this.member(handlerNode, file),
          chain: [],
          citation: site,
          group: groupOf(router),
        }
        if (!router.routes.some((r) => routeKey(r) === routeKey(route))) router.routes.push(route)
        return undefined
      }
      case 'use':
        for (const mw of args) {
          const member = this.member(mw, file)
          const known = router.chain.some(
            (m) => m.citation.line === member.citation.line && m.text === member.text,
          )
          if (!known) router.chain.push(member)
        }
        return undefined
      case 'with': {
        const derived = this.router(`${file.path}:${node.id}:${router.id}`, router.spec, site)
        derived.inline = router
        for (const mw of args) {
          const member = this.member(mw, file)
          if (!derived.chain.some((m) => m.text === member.text)) derived.chain.push(member)
        }
        this.attach(router, '', derived)
        return derived
      }
      case 'group':
      case 'subrouter': {
        const prefix = method.does === 'subrouter' ? pathOf(this.program, arg('path'), file) : ''
        const child = this.router(`${file.path}:${node.id}:${router.id}`, router.spec, site)
        if (method.does === 'group') child.inline = router
        this.attach(router, normalisePattern(prefix, router.spec.pattern).path, child)
        const callback = arg('callback')
        if (callback) this.callback(callback, child, file)
        return child
      }
      case 'mount': {
        const prefix = normalisePattern(
          pathOf(this.program, arg('path'), file),
          router.spec.pattern,
        ).path
        const handlerNode = arg('handler')
        if (!handlerNode) return undefined
        const child = this.evaluate(handlerNode, file, env)
        if (child) {
          this.attach(router, prefix, child)
          return undefined
        }
        // A handler that is not a router serves the whole subtree.
        const route: Route = {
          method: 'ANY',
          path: joinPath(prefix, '{rest...}'),
          pattern: prefix,
          handler: this.member(handlerNode, file),
          chain: [],
          citation: site,
          group: groupOf(router),
        }
        if (!router.routes.some((r) => routeKey(r) === routeKey(route))) router.routes.push(route)
        return undefined
      }
    }
  }

  // A callback receives a router as its first parameter: a literal, or a function it names.
  private callback(node: Node, router: Router, file: ParsedFile) {
    const targets =
      node.type === 'func_literal' ||
      node.type === 'identifier' ||
      node.type === 'selector_expression'
        ? this.program.targets(node, file)
        : undefined
    for (const target of targets ?? []) {
      if (!target.decl || target.resolution !== 'resolved') continue
      const calleeFile = this.program.file(target.decl.file)
      const [param] = this.parameters(target.decl)
      if (calleeFile && param) this.interpret(target.decl, calleeFile, new Map([[param, router]]))
    }
  }

  // What a handler or middleware expression names: a function, a method value, a literal, or the
  // function a factory call names (`NewAuth(…)` builds the middleware). Adapters such as
  // `http.HandlerFunc(f)` are seen through.
  member(node: Node, file: ParsedFile): Member {
    const citation = this.site(file, node)
    const text = node.text.replace(/\s+/g, ' ')
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function')
      const first = present(node.childForFieldName('arguments')?.namedChildren ?? [])[0]
      const targets = fn && fn.type !== 'func_literal' ? this.program.targets(fn, file) : undefined
      if (first && targets?.some((t) => this.adapters.has(t.ref))) {
        return { ...this.member(first, file), text, citation }
      }
      return { text, citation, targets: targets ?? [] }
    }
    if (['identifier', 'selector_expression', 'func_literal'].includes(node.type)) {
      const targets = this.program.targets(node, file) ?? []
      if (targets.length > 0) return { text, citation, targets }
      // A method of a value the index cannot type, such as `fs.ServeHTTP` on a value from
      // another package: the handler is what built the value, `http.FileServer(…)`.
      const operand = node.type === 'selector_expression' ? node.childForFieldName('operand') : node
      const declared =
        operand?.type === 'identifier' ? declaredAt(operand.text, operand) : undefined
      const built =
        operand?.type === 'call_expression'
          ? operand
          : declared && 'value' in declared
            ? declared.value
            : undefined
      if (built && built.id !== node.id) return { ...this.member(built, file), text, citation }
    }
    return { text, citation, targets: [] }
  }
}
