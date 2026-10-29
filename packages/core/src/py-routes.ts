import type { Node } from 'web-tree-sitter'
import { type Callee, joinPath, type Member, normalisePattern, type Route } from './entries.ts'
import type { Citation } from './graph.ts'
import type { ArgRole, Declare, ResolvedProfile, RouterMethod, RouterSpec } from './profile.ts'
import {
  argumentsOf,
  line,
  type PyDecl,
  type PyFile,
  type PyProgram,
  parametersOf,
  present,
  symbolType,
  type Target,
  typeSymbol,
} from './py.ts'

// The routes of a Python application, read from the routers a profile describes (D10): routes
// declared by decorators (`@router.get('/items/{id}')`) and by calls (`add_api_route`), route
// objects given as lists (`Route('/', endpoint)`, `Mount('/api', routes=[…])`), routers included
// under a prefix (`include_router(users.router, prefix='/users')`) and applications mounted under
// another. Each route's chain is the middleware of its applications, outermost first, then, for
// a route whose parameters declare its dependencies, the dependencies of its routers, of the
// include, of its declaration and of its parameters, each after its own.

interface Router {
  id: number
  spec: RouterSpec
  site: Node
  file: PyFile
  prefix: string
  // Dependencies every route of the router takes, from its constructor.
  dependencies: Member[]
  // Middleware, outermost first, for an application.
  middleware: Member[]
  entries: Entry[]
  parents: number
}

type RouteEntry = Omit<Route, 'chain' | 'group'> & { dependencies: Member[]; parameters: boolean }

type Entry =
  | { route: RouteEntry }
  | { include: { router: Router; prefix: string; dependencies: Member[] } }
  | { mount: { router: Router; prefix: string } }

// What a scope binds while a list of routes is read: `path` in `(Route(path, …) for path in …)`.
type Env = Map<string, string>

const defaultArgs: Record<string, ArgRole[]> = {
  route: ['path', 'handler'],
  use: ['middleware'],
  mount: ['path', 'handler'],
  routes: ['routes'],
  include: ['handler'],
}

export interface PyRoutes {
  routes: Route[]
  // The handlers and dependencies whose parameters the profile reads, each with the paths of the
  // routes it serves.
  parameterized: Map<string, Set<string>>
}

export class PyRouteInterpreter {
  private readonly program: PyProgram
  private readonly profile: ResolvedProfile
  private readonly routers = new Map<number, Router>()
  private readonly evaluating = new Set<number>()
  private readonly creates = new Map<string, RouterSpec>()
  private readonly declares = new Map<string, Declare>()
  private readonly depends: Set<string>
  private readonly wraps: Set<string>
  private readonly parameterized = new Map<string, Set<string>>()
  private nextId = 1

  constructor(program: PyProgram, profile: ResolvedProfile) {
    this.program = program
    this.profile = profile
    for (const spec of profile.routers) {
      for (const symbol of [...(spec.create ?? []), ...spec.types]) this.creates.set(symbol, spec)
    }
    for (const d of profile.declares) this.declares.set(d.call, d)
    this.depends = new Set((profile.parameters?.depends ?? []).map((s) => `ext:${s}`))
    this.wraps = new Set(profile.middleware.wrap.map((s) => `ext:${s}`))
  }

  routes(): PyRoutes {
    // Only a call of a method some router has can register: `get`, `include_router`, `extend`.
    const names = new Set(
      this.profile.routers.flatMap((r) => r.methods.map((m) => m.name.split('.').at(-1))),
    )
    for (const file of this.program.files) {
      for (const call of present(file.tree.rootNode.descendantsOfType('call'))) {
        const fn = call.childForFieldName('function')
        if (fn?.type !== 'attribute' || !names.has(fn.childForFieldName('attribute')?.text))
          continue
        this.registration(call, file)
      }
    }
    const routes: Route[] = []
    const roots = [...this.routers.values()]
      .filter((r) => r.parents === 0)
      .sort((a, b) => a.id - b.id)
    for (const root of roots) this.flatten(root, '', [], [], routes)
    return { routes, parameterized: this.parameterized }
  }

  // Every route under a router, with its full path and chain.
  private flatten(
    router: Router,
    prefix: string,
    middleware: Member[],
    dependencies: Member[],
    out: Route[],
  ) {
    const mw = [...middleware, ...router.middleware]
    const deps = [...dependencies, ...router.dependencies]
    const base = joinPath(prefix, router.prefix)
    for (const entry of router.entries) {
      if ('route' in entry) {
        const r = entry.route
        const path = joinPath(base, r.path)
        const own = r.parameters
          ? [...deps, ...r.dependencies, ...this.parameterDependencies(r.handler, path)]
          : []
        if (r.parameters) for (const member of [r.handler, ...own]) this.served(member, path)
        out.push({ ...r, path, chain: [...mw, ...once(own)], group: router.id })
      } else if ('include' in entry) {
        this.flatten(
          entry.include.router,
          joinPath(base, entry.include.prefix),
          mw,
          [...deps, ...entry.include.dependencies],
          out,
        )
      } else {
        this.flatten(entry.mount.router, joinPath(base, entry.mount.prefix), mw, [], out)
      }
    }
  }

  // Records the handlers and dependencies whose parameters the profile reads, with the path.
  private served(member: Member, path: string) {
    for (const t of member.targets) {
      const set = this.parameterized.get(t.ref) ?? new Set<string>()
      set.add(path)
      this.parameterized.set(t.ref, set)
    }
  }

  // The dependencies a handler's parameters declare, each after its own, depth first.
  private parameterDependencies(handler: Member, path: string, seen = new Set<string>()): Member[] {
    const found: Member[] = []
    for (const target of handler.targets) {
      const decl = this.program.decl(target.ref)
      if (!decl || seen.has(target.ref)) continue
      seen.add(target.ref)
      const file = this.program.file(decl.file) as PyFile
      const fn = decl.kind === 'class' ? undefined : decl.node
      if (!fn) continue
      for (const [index, param] of parametersOf(fn).entries()) {
        if (index === 0 && decl.kind === 'method') continue
        const marker = this.dependencyOf(param, file)
        if (!marker) continue
        const member = this.dependencyMember(marker.call, marker.file, param.type, file)
        if (!member) continue
        found.push(...this.parameterDependencies(member, path, seen), member)
        this.served(member, path)
      }
    }
    return found
  }

  // The `Depends(…)` a parameter declares: its default, a name holding one, a call that returns
  // one, or its annotation's `Annotated` metadata, type aliases followed.
  private dependencyOf(
    param: { type?: Node; value?: Node },
    file: PyFile,
  ): { call: Node; file: PyFile } | undefined {
    const fromValue = param.value ? this.dependsCall(param.value, file) : undefined
    if (fromValue) return fromValue
    for (const meta of this.program.annotated(param.type, file)) {
      const found = this.dependsCall(meta.node, meta.file)
      if (found) return found
    }
    return undefined
  }

  // The `Depends(…)` call an expression gives.
  private dependsCall(
    node: Node,
    file: PyFile,
    depth = 0,
  ): { call: Node; file: PyFile } | undefined {
    if (depth > 6) return undefined
    if (node.type === 'call') {
      const fn = node.childForFieldName('function')
      const targets = fn ? (this.program.callees(fn, file) ?? []) : []
      if (targets.some((t) => this.depends.has(`ext:${this.program.symbolOf(t)}`)))
        return { call: node, file }
      // `read = key_access(False)`, where `key_access` returns `Depends(admitted)`.
      for (const t of targets) {
        if (!t.decl || t.decl.kind === 'class') continue
        const tfile = this.program.file(t.decl.file) as PyFile
        for (const value of returnedValues(t.decl, tfile, this.program)) {
          const found = this.dependsCall(value, tfile, depth + 1)
          if (found) return found
        }
      }
      return undefined
    }
    if (node.type === 'identifier' || node.type === 'attribute') {
      const ref = this.program.resolve(node, file)
      if (ref?.kind === 'binding' && ref.binding.kind === 'value' && ref.binding.value)
        return this.dependsCall(ref.binding.value, ref.binding.file, depth + 1)
    }
    return undefined
  }

  // The member a `Depends(x)` names: the function, the class, or the instance whose `__call__`
  // runs; `Depends()` alone names the parameter's annotation.
  private dependencyMember(
    call: Node,
    file: PyFile,
    annotation: Node | undefined,
    paramFile: PyFile,
  ): Member | undefined {
    const { positional, keywords } = argumentsOf(call)
    const given = keywords.get('dependency') ?? positional[0]
    if (!given) {
      const type = this.program.typeOfAnnotation(annotation, paramFile)
      if (type?.kind === 'external')
        return {
          text: type.name,
          citation: cite(file, call),
          targets: [
            { ref: `ext:${typeSymbol(type)}`, external: type.name, resolution: 'resolved' },
          ],
        }
      if (type?.kind !== 'class') return undefined
      return {
        text: type.decl.name,
        citation: cite(file, call),
        targets: [this.classTarget(type.decl)],
      }
    }
    return this.member(given, file, new Map(), cite(file, call))
  }

  // Calling a class runs its `__init__`, whose parameters are its dependencies.
  private classTarget(decl: PyDecl): Target {
    const init = this.program.classMember(decl, '__init__')
    return init
      ? { ref: init.ref, decl: init, resolution: 'resolved' }
      : { ref: decl.ref, decl, resolution: 'resolved' }
  }

  // What a handler, a dependency or a middleware expression names.
  private member(
    node: Node,
    file: PyFile,
    env: Env,
    citation = cite(file, node),
    receives?: string,
  ): Member {
    const text = node.text.replace(/\s+/g, ' ')
    const targets = this.targetsOf(node, file, env, receives)
    return { text, citation, targets }
  }

  private targetsOf(node: Node, file: PyFile, env: Env, receives?: string, depth = 0): Callee[] {
    if (depth > 6) return []
    if (node.type === 'lambda') {
      const decl = file.declsById.get(node.id)
      if (decl) this.give(decl, 0, receives)
      return decl ? [{ ref: decl.ref, resolution: 'resolved' }] : []
    }
    if (node.type === 'call') {
      // A handler built by a call: its callee, and the functions it is given, guessed.
      const fn = node.childForFieldName('function')
      const targets: Callee[] = fn ? [...(this.program.callees(fn, file) ?? [])] : []
      // An instance a class builds, used as a function, runs its `__call__`: `HTTPBearer(…)`. A
      // function of the target that returns one wraps the functions it is given, which stay.
      const constructs =
        targets.length === 0 ||
        targets.some(
          (t) => t.ref.endsWith('.__init__') || this.program.decl(t.ref)?.kind === 'class',
        ) ||
        targets.every((t) => !this.program.decl(t.ref))
      const called = constructs ? this.callable(this.program.typeOf(node, file)) : undefined
      if (called) return [this.passes(called, node)]
      for (const arg of argumentsOf(node).positional) {
        if (arg.type !== 'identifier' && arg.type !== 'attribute') continue
        for (const t of this.targetsOf(arg, file, env, receives, depth + 1))
          targets.push({ ...t, resolution: 'guessed', reason: `given to ${fn?.text ?? 'a call'}` })
      }
      return targets
    }
    if (node.type !== 'identifier' && node.type !== 'attribute') return []
    const ref = this.program.resolve(node, file)
    if (ref?.kind === 'decl') {
      if (ref.decl.kind === 'class') {
        const target = this.classTarget(ref.decl)
        return [target]
      }
      this.give(ref.decl, ref.decl.kind === 'method' ? 1 : 0, receives)
      return [{ ref: ref.decl.ref, resolution: 'resolved' }]
    }
    if (ref?.kind === 'external')
      return [{ ref: `ext:${ref.module}#${ref.name}`, external: ref.name, resolution: 'resolved' }]
    if (ref?.kind === 'binding' && ref.binding.kind === 'value' && ref.binding.value) {
      // A name that holds what a call built: the instance's `__call__`, or the call that built it.
      return this.targetsOf(ref.binding.value, ref.binding.file, env, receives, depth + 1)
    }
    // A method of a value: `MetadataHandler(server).handle`.
    if (node.type === 'attribute') {
      const object = node.childForFieldName('object')
      const name = node.childForFieldName('attribute')?.text
      const owner = object ? this.program.typeOf(object, file) : undefined
      if (owner?.kind === 'class' && name) {
        const found = this.program.classMember(owner.decl, name)
        if (found) {
          this.give(found, 1, receives)
          return [{ ref: found.ref, resolution: 'resolved' }]
        }
      }
      if (owner?.kind === 'external' && name)
        return [
          {
            ref: `ext:${owner.module}#${owner.name}.${name}`,
            external: `${owner.name}.${name}`,
            resolution: 'resolved',
          },
        ]
    }
    return []
  }

  // What an instance runs when it is called: its class's `__call__`, or the class outside the
  // target, by which guard rules name it.
  private callable(type: ReturnType<PyProgram['typeOf']>): Callee | undefined {
    if (type?.kind === 'class') {
      const call = this.program.classMember(type.decl, '__call__')
      return call ? { ref: call.ref, resolution: 'resolved' } : undefined
    }
    if (type?.kind === 'external') {
      const symbol = typeSymbol(type) as string
      if (this.declares.has(symbol) || this.creates.has(symbol)) return undefined
      return { ref: `ext:${symbol}`, external: type.name, resolution: 'resolved' }
    }
    return undefined
  }

  // A guard built with an argument its rule's `unless` names refuses nothing.
  private passes(callee: Callee, call: Node): Callee {
    const rule = this.profile.guards.find((g) => 'call' in g && `ext:${g.call}` === callee.ref)
    if (!rule || !('unless' in rule) || !rule.unless) return callee
    const { keywords } = argumentsOf(call)
    const off = Object.entries(rule.unless).some(([k, v]) => keywords.get(k)?.text === v)
    return off ? { ...callee, passes: true } : callee
  }

  // A handler's or a middleware's parameter given the type the profile says it receives.
  private give(decl: PyDecl, index: number, receives?: string) {
    if (!receives) return
    const params = parametersOf(decl.node)
    const param = params[index]
    if (!param || param.type) return
    this.program.giveParameter(decl.node, index, symbolType(receives))
  }

  // The routers an expression evaluates to.
  private routersOf(node: Node | undefined, file: PyFile, depth = 0): Router[] {
    if (!node || depth > 10) return []
    if (node.type === 'parenthesized_expression' || node.type === 'await')
      return this.routersOf(node.namedChildren[0] ?? undefined, file, depth + 1)
    if (node.type === 'call') {
      const created = this.created(node, file)
      if (created) return [created]
      // What a function of the target builds and returns.
      const fn = node.childForFieldName('function')
      const found: Router[] = []
      for (const t of fn ? (this.program.callees(fn, file) ?? []) : []) {
        if (!t.decl || t.decl.kind === 'class' || this.evaluating.has(t.decl.node.id)) continue
        this.evaluating.add(t.decl.node.id)
        const tfile = this.program.file(t.decl.file) as PyFile
        for (const value of returnedValues(t.decl, tfile, this.program))
          found.push(...this.routersOf(value, tfile, depth + 1))
        this.evaluating.delete(t.decl.node.id)
      }
      return unique(found)
    }
    if (node.type === 'attribute') {
      const object = node.childForFieldName('object')
      const name = node.childForFieldName('attribute')?.text ?? ''
      // `app.router` is the application's own router.
      const owners = object ? this.routersOf(object, file, depth + 1) : []
      const own = owners.filter((r) => (r.spec.self ?? []).includes(name))
      if (own.length > 0) return own
    }
    if (node.type === 'identifier' || node.type === 'attribute') {
      const ref = this.program.resolve(node, file)
      if (ref?.kind === 'binding') {
        const binding = ref.binding
        if (binding.kind === 'value' && binding.value)
          return this.routersOf(binding.value, binding.file, depth + 1)
        if (binding.kind === 'param')
          return this.argumentsFor(binding.fn, binding.index, binding.name, binding.file, depth)
      }
    }
    return []
  }

  // The routers the callers of a function pass it as a parameter.
  private readonly passed = new Map<string, Router[]>()
  private argumentsFor(
    fn: Node,
    index: number,
    name: string,
    file: PyFile,
    depth: number,
  ): Router[] {
    const key = `${fn.id}\0${index}`
    const known = this.passed.get(key)
    if (known) return known
    const found = this.callersPass(fn, index, name, file, depth)
    if (depth === 0) this.passed.set(key, found)
    return found
  }

  private callersPass(
    fn: Node,
    index: number,
    name: string,
    file: PyFile,
    depth: number,
  ): Router[] {
    const decl = file.declsById.get(fn.id)
    if (!decl || this.evaluating.has(fn.id)) return []
    this.evaluating.add(fn.id)
    const found: Router[] = []
    const offset = decl.kind === 'method' ? 1 : 0
    for (const { call, file: f } of this.callersOf(decl.ref)) {
      const { positional, keywords } = argumentsOf(call)
      const arg = keywords.get(name) ?? positional[index - offset]
      if (arg) found.push(...this.routersOf(arg, f, depth + 1))
    }
    this.evaluating.delete(fn.id)
    return unique(found)
  }

  // The calls of each declaration of the target, found once.
  private callers?: Map<string, { call: Node; file: PyFile }[]>
  private callersOf(ref: string): { call: Node; file: PyFile }[] {
    if (!this.callers) {
      this.callers = new Map()
      for (const f of this.program.files) {
        for (const call of present(f.tree.rootNode.descendantsOfType('call'))) {
          const callee = call.childForFieldName('function')
          if (!callee || (callee.type !== 'identifier' && callee.type !== 'attribute')) continue
          for (const t of this.program.callees(callee, f) ?? []) {
            if (!t.decl) continue
            this.callers.set(t.ref, [...(this.callers.get(t.ref) ?? []), { call, file: f }])
          }
        }
      }
    }
    return this.callers.get(ref) ?? []
  }

  // A router created by a call to one of the profile's types.
  private created(call: Node, file: PyFile): Router | undefined {
    const existing = this.routers.get(call.id)
    if (existing) return existing
    const fn = call.childForFieldName('function')
    if (!fn) return undefined
    const spec = this.specOf(fn, file)
    if (!spec) return undefined
    const router: Router = {
      id: this.nextId++,
      spec,
      site: call,
      file,
      prefix: '',
      dependencies: [],
      middleware: [],
      entries: [],
      parents: 0,
    }
    this.routers.set(call.id, router)
    const roles = this.roles(call, [], spec.construct ?? {})
    if (roles.path[0]) router.prefix = this.path(roles.path[0], file, new Map(), spec)
    for (const node of roles.chain) router.dependencies.push(...this.dependencyList(node, file))
    for (const node of roles.middleware) router.middleware.push(...this.middlewareList(node, file))
    for (const node of roles.routes) this.addObjects(router, node, file, new Map())
    return router
  }

  private specOf(fn: Node, file: PyFile): RouterSpec | undefined {
    for (const t of this.program.callees(fn, file) ?? []) {
      if (t.decl?.kind === 'class' || t.decl?.name.endsWith('.__init__')) {
        const cls = t.decl.kind === 'class' ? t.decl : t.decl.owner
        if (!cls) continue
        const type = {
          kind: 'class' as const,
          decl: cls,
          file: this.program.file(cls.file) as PyFile,
        }
        for (const symbol of this.program.symbolsOf(type)) {
          const spec = this.creates.get(symbol)
          if (spec) return spec
        }
      }
      const spec = this.creates.get(t.ref.slice('ext:'.length))
      if (spec) return spec
    }
    return undefined
  }

  // The arguments of a call, by role, from its positions and its keywords.
  private roles(
    call: Node,
    args: ArgRole[],
    keywords: Record<string, ArgRole>,
  ): Record<ArgRole, Node[]> {
    const out: Record<ArgRole, Node[]> = {
      method: [],
      path: [],
      handler: [],
      callback: [],
      chain: [],
      config: [],
      routes: [],
      middleware: [],
      other: [],
    }
    const { positional, keywords: given } = argumentsOf(call)
    positional.forEach((node, i) => {
      const role = args[i]
      if (role && node.type !== 'list_splat' && node.type !== 'dictionary_splat')
        out[role].push(node)
    })
    for (const [name, node] of given) {
      const role = keywords[name]
      if (role) out[role].push(node)
    }
    return out
  }

  private path(
    node: Node,
    file: PyFile,
    env: Env,
    spec?: { pattern: RouterSpec['pattern'] },
  ): string {
    const value =
      node.type === 'identifier' && env.has(node.text)
        ? env.get(node.text)
        : this.program.stringValueOf(node, file)
    const written = value ?? `\${${node.text}}`
    // Starlette's `{rest:path}` convertor takes the rest of the path.
    const converted = written.replace(/\{([A-Za-z_]\w*):path\}/g, '{$1...}')
    return normalisePattern(converted, spec?.pattern ?? 'braces').path
  }

  private methods(nodes: Node[], file: PyFile, fallback: string | undefined): string[] {
    const listed = nodes.flatMap((n) => this.program.stringsOf(n, file) ?? [])
    const methods = listed.length > 0 ? listed.map((m) => m.toUpperCase()) : [fallback ?? 'GET']
    return [...new Set(methods)]
  }

  // A list of dependencies: `[Depends(a), Depends(b)]`, each after its own.
  private dependencyList(node: Node, file: PyFile): Member[] {
    const found: Member[] = []
    const items =
      node.type === 'list' || node.type === 'tuple' ? present(node.namedChildren) : [node]
    for (const item of items) {
      const dep = this.dependsCall(item, file)
      if (!dep) continue
      const member = this.dependencyMember(dep.call, dep.file, undefined, dep.file)
      if (!member) continue
      found.push(...this.parameterDependencies(member, ''), member)
    }
    return found
  }

  // A list of middleware: `[Middleware(CORSMiddleware, …)]`, outermost first.
  private middlewareList(node: Node, file: PyFile): Member[] {
    const items =
      node.type === 'list' || node.type === 'tuple' ? present(node.namedChildren) : [node]
    return items.flatMap((item) => {
      if (item.type !== 'call') return []
      const fn = item.childForFieldName('function')
      if (!fn || !(this.program.callees(fn, file) ?? []).some((t) => this.wraps.has(t.ref)))
        return []
      const cls = argumentsOf(item).positional[0]
      return cls ? [this.middlewareMember(cls, file, cite(file, item))] : []
    })
  }

  // A middleware class: the method that handles a request, given what it receives.
  private middlewareMember(node: Node, file: PyFile, citation: Citation): Member {
    const ref = this.program.resolve(node, file)
    if (ref?.kind === 'decl' && ref.decl.kind === 'class') {
      for (const [name, receives] of Object.entries(this.profile.middleware.classes)) {
        const method = this.program.classMember(ref.decl, name)
        if (!method) continue
        this.give(method, 1, receives)
        return { text: node.text, citation, targets: [{ ref: method.ref, resolution: 'resolved' }] }
      }
      // A subclass of a middleware outside the target that does not override it.
      for (const base of this.program.bases(ref.decl))
        if (base.kind === 'external')
          return {
            text: node.text,
            citation,
            targets: [
              { ref: `ext:${typeSymbol(base)}`, external: base.name, resolution: 'resolved' },
            ],
          }
    }
    return this.member(node, file, new Map(), citation, this.profile.context)
  }

  // Route objects given to a router: `[Route(…), Mount(…), *(Route(p, h) for p in paths)]`.
  private addObjects(router: Router, node: Node, file: PyFile, env: Env, depth = 0) {
    if (depth > 8) return
    if (node.type === 'list' || node.type === 'tuple' || node.type === 'parenthesized_expression') {
      for (const item of present(node.namedChildren))
        this.addObjects(router, item, file, env, depth + 1)
      return
    }
    if (node.type === 'list_splat') {
      const inner = node.namedChildren[0]
      if (inner) this.addObjects(router, inner, file, env, depth + 1)
      return
    }
    if (node.type === 'generator_expression' || node.type === 'list_comprehension') {
      const body = node.childForFieldName('body')
      const clause = node.namedChildren.find((n) => n?.type === 'for_in_clause')
      const name = clause?.childForFieldName('left')
      const values = clause
        ? this.program.stringsOf(clause.childForFieldName('right'), file)
        : undefined
      if (!body) return
      if (name?.type === 'identifier' && values)
        for (const value of values)
          this.addObjects(router, body, file, new Map([...env, [name.text, value]]), depth + 1)
      else this.addObjects(router, body, file, env, depth + 1)
      return
    }
    if (node.type === 'identifier' || node.type === 'attribute') {
      const ref = this.program.resolve(node, file)
      if (ref?.kind === 'binding' && ref.binding.kind === 'value' && ref.binding.value)
        this.addObjects(router, ref.binding.value, ref.binding.file, env, depth + 1)
      return
    }
    if (node.type !== 'call') return
    const fn = node.childForFieldName('function')
    if (!fn) return
    const targets = this.program.callees(fn, file) ?? []
    const declare = targets.map((t) => this.declares.get(t.ref.slice('ext:'.length))).find((d) => d)
    if (declare) {
      this.declared(router, declare, node, file, env)
      return
    }
    // A function of the target that returns a list of routes.
    for (const t of targets) {
      if (!t.decl || t.decl.kind === 'class' || this.evaluating.has(t.decl.node.id)) continue
      this.evaluating.add(t.decl.node.id)
      const tfile = this.program.file(t.decl.file) as PyFile
      for (const value of returnedValues(t.decl, tfile, this.program))
        this.addObjects(router, value, tfile, new Map(), depth + 1)
      this.evaluating.delete(t.decl.node.id)
    }
  }

  // A route or a mount a route object declares.
  private declared(router: Router, declare: Declare, call: Node, file: PyFile, env: Env) {
    const roles = this.roles(
      call,
      declare.args ?? defaultArgs[declare.does] ?? [],
      declare.keywords ?? {},
    )
    const citation = cite(file, call)
    if (declare.does === 'mount') {
      const prefix = roles.path[0] ? this.path(roles.path[0], file, env, router.spec) : ''
      const child = this.childRouter(file)
      for (const node of roles.routes) this.addObjects(child, node, file, env)
      for (const node of roles.middleware) child.middleware.push(...this.middlewareList(node, file))
      const handler = roles.handler[0]
      const mounted = handler ? this.routersOf(handler, file) : []
      if (handler && mounted.length === 0) {
        child.entries.push({ route: this.subtree('', this.member(handler, file, env), citation) })
      }
      for (const m of mounted) {
        m.parents++
        child.entries.push({ mount: { router: m, prefix: '' } })
      }
      router.entries.push({ mount: { router: child, prefix } })
      child.parents++
      return
    }
    this.addRoutes(router, declare, roles, file, env, citation, undefined)
  }

  // A router of its own for a `Mount`, so that what is in it shares its prefix.
  private childRouter(file: PyFile): Router {
    return {
      id: this.nextId++,
      spec: { types: [], pattern: 'braces', methods: [] },
      site: file.tree.rootNode,
      file,
      prefix: '',
      dependencies: [],
      middleware: [],
      entries: [],
      parents: 0,
    }
  }

  private subtree(prefix: string, handler: Member, citation: Citation): RouteEntry {
    return {
      method: 'ANY',
      path: joinPath(prefix, '{rest...}'),
      pattern: prefix || '/',
      handler,
      citation,
      dependencies: [],
      parameters: false,
    }
  }

  // The routes a registration declares: one per method, and for an endpoint class, one per method
  // it defines.
  private addRoutes(
    router: Router,
    method: Pick<RouterMethod, 'method' | 'receives' | 'parameters'>,
    roles: Record<ArgRole, Node[]>,
    file: PyFile,
    env: Env,
    citation: Citation,
    decorated: Node | undefined,
  ) {
    const pathNode = roles.path[0]
    const path = pathNode ? this.path(pathNode, file, env, router.spec) : '/'
    const pattern = pathNode ? (this.program.stringValueOf(pathNode, file) ?? pathNode.text) : '/'
    const handlerNode = decorated ?? roles.handler[0]
    if (!handlerNode) return
    // A handler whose parameters are not read receives the request first: a Starlette endpoint.
    const receives = method.receives ?? (method.parameters ? undefined : this.profile.context)
    const handler =
      decorated !== undefined
        ? this.decoratedMember(decorated, file, receives)
        : this.member(handlerNode, file, env, cite(file, handlerNode), receives)
    const dependencies = roles.chain.flatMap((n) => this.dependencyList(n, file))
    // An endpoint class answers each method it defines.
    const cls = handler.targets.length === 1 ? this.endpointClass(handlerNode, file) : undefined
    if (cls) {
      for (const verb of ['get', 'head', 'post', 'put', 'patch', 'delete', 'options']) {
        const m = this.program.classMember(cls, verb)
        if (!m || m.owner?.ref !== cls.ref) continue
        this.give(m, 1, this.profile.context)
        router.entries.push({
          route: {
            method: verb.toUpperCase(),
            path,
            pattern,
            handler: {
              text: `${handler.text}.${verb}`,
              citation: handler.citation,
              targets: [{ ref: m.ref, resolution: 'resolved' }],
            },
            citation,
            dependencies: [],
            parameters: false,
          },
        })
      }
      return
    }
    for (const verb of this.methods(roles.method, file, method.method)) {
      router.entries.push({
        route: {
          method: verb,
          path,
          pattern,
          handler,
          citation,
          dependencies,
          parameters: method.parameters === true,
        },
      })
    }
  }

  private endpointClass(node: Node, file: PyFile): PyDecl | undefined {
    const ref =
      node.type === 'identifier' || node.type === 'attribute'
        ? this.program.resolve(node, file)
        : undefined
    return ref?.kind === 'decl' && ref.decl.kind === 'class' ? ref.decl : undefined
  }

  private decoratedMember(def: Node, file: PyFile, receives?: string): Member {
    const decl = file.declsById.get(def.id)
    if (decl) this.give(decl, decl.kind === 'method' ? 1 : 0, receives)
    const name = def.childForFieldName('name')
    return {
      text: name?.text ?? def.text.slice(0, 40),
      citation: cite(file, def),
      targets: decl ? [{ ref: decl.ref, resolution: 'resolved' }] : [],
    }
  }

  // A call on a router, or a decorator of one.
  private registration(call: Node, file: PyFile) {
    const fn = call.childForFieldName('function')
    if (fn?.type !== 'attribute') return
    // `app.router.routes.extend(…)`: the method's name may span several attributes.
    const names: string[] = []
    let object: Node | null = fn
    for (let k = 0; k < 3 && object?.type === 'attribute'; k++) {
      names.unshift(object.childForFieldName('attribute')?.text ?? '')
      object = object.childForFieldName('object')
      if (!object) return
      const name = names.join('.')
      const routers = this.routersOf(object, file)
      if (routers.length === 0) continue
      for (const router of routers) {
        const method = router.spec.methods.find((m) => m.name === name)
        if (method) this.apply(router, method, call, file)
      }
      return
    }
  }

  private apply(router: Router, method: RouterMethod, call: Node, file: PyFile) {
    const decorator = call.parent?.type === 'decorator'
    const decorated = decorator ? decoratedDefinition(call.parent) : undefined
    const roles = this.roles(
      call,
      method.args ?? defaultArgs[method.does] ?? [],
      method.keywords ?? {},
    )
    const citation = cite(file, call)
    switch (method.does) {
      case 'route':
        this.addRoutes(router, method, roles, file, new Map(), citation, decorated)
        return
      case 'use': {
        // `@app.middleware("http")` decorates its middleware function; `add_middleware(Cls)`
        // names its class.
        if (decorated)
          router.middleware.unshift(
            this.decoratedMember(decorated, file, method.receives ?? this.profile.context),
          )
        else
          for (const node of roles.middleware)
            router.middleware.unshift(this.middlewareMember(node, file, citation))
        return
      }
      case 'routes':
        for (const node of roles.routes) this.addObjects(router, node, file, new Map())
        return
      case 'include':
      case 'mount': {
        const prefix = roles.path[0] ? this.path(roles.path[0], file, new Map(), router.spec) : ''
        const dependencies = roles.chain.flatMap((n) => this.dependencyList(n, file))
        const handlerNode = roles.handler[0]
        const children = handlerNode ? this.routersOf(handlerNode, file) : []
        // `include_router` adds the router's routes with its dependencies; `mount` an application.
        const include = method.does === 'include'
        for (const child of children) {
          if (child === router) continue
          child.parents++
          router.entries.push(
            include
              ? { include: { router: child, prefix, dependencies } }
              : { mount: { router: child, prefix } },
          )
        }
        if (children.length === 0) {
          // A handler that is not a router serves the whole subtree; without one, the call itself
          // does (`app.frontend('/', directory=…)`).
          const handler = handlerNode
            ? this.member(handlerNode, file, new Map())
            : {
                text: call.text.replace(/\s+/g, ' ').slice(0, 80),
                citation,
                targets: (this.program.callees(fn(call), file) ?? []) as Callee[],
              }
          if (handlerNode || !include)
            router.entries.push({ route: this.subtree(prefix, handler, citation) })
        }
        return
      }
      default:
        return
    }
  }
}

const fn = (call: Node) => call.childForFieldName('function') as Node

const cite = (file: PyFile, node: Node): Citation => ({ file: file.path, line: line(node) })

// Dependencies run once per request, at their first place: FastAPI caches what each returns.
function once(members: Member[]): Member[] {
  const seen = new Set<string>()
  return members.filter((m) => {
    const key =
      m.targets
        .map((t) => t.ref)
        .sort()
        .join('\0') || m.text
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

// The function or class a decorator decorates.
function decoratedDefinition(decorator: Node | null): Node | undefined {
  const parent = decorator?.parent
  if (parent?.type !== 'decorated_definition') return undefined
  return parent.childForFieldName('definition') ?? undefined
}

// The expressions a function returns, its own `return`s only.
export function returnedValues(decl: PyDecl, file: PyFile, program: PyProgram): Node[] {
  if (decl.kind === 'literal') {
    const body = decl.node.childForFieldName('body')
    return body ? [body] : []
  }
  const body = decl.node.childForFieldName('body')
  return present(body?.descendantsOfType('return_statement') ?? [])
    .filter((r) => program.enclosing(file, r)?.ref === decl.ref)
    .map((r) => r.namedChildren[0])
    .filter((v): v is Node => !!v)
}
