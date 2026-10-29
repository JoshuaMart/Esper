import type { Node } from 'web-tree-sitter'
import type { Fact } from './graph.ts'
import { type Library, parseSink, type Sink } from './library.ts'
import type { ReadKind, ReadRule, ResolvedProfile } from './profile.ts'
import {
  argumentsOf,
  line,
  type PyDecl,
  type PyFile,
  type PyProgram,
  parametersOf,
  present,
  stringValue,
} from './py.ts'

// Facts on Python declarations, computed by rules from the syntax (D6): what each reads from the
// request, through the request's attributes and methods or through its parameters, the sinks it
// calls, the persisted data it reads and writes, and what it does with the request and with state
// that outlives it. Entry points get their signals from what they reach.

interface ChainItem {
  field?: string
  call?: { name: boolean }
  property?: true
}

// `headers.get(name)` is the field `headers`, then a call whose argument names what is read;
// `headers[name]` the field `headers`, then a key that names it.
function parseChain(chain: string): ChainItem[] {
  const items: ChainItem[] = []
  for (const match of chain.matchAll(/\[name\]|([A-Za-z_$][\w$]*)(\((name)?\))?/g)) {
    if (match[0] === '[name]') items.push({ property: true })
    else if (match[1]) {
      items.push({ field: match[1] })
      if (match[2]) items.push({ call: { name: match[3] === 'name' } })
    }
  }
  return items
}

interface Observed {
  field?: string
  // A key read by subscript: `headers["x-api-key"]`.
  key?: Node
  args?: Node[]
  node: Node
}

// The attributes, subscripts and calls applied to a value, outward from it.
function chainFrom(node: Node): Observed[] {
  const items: Observed[] = []
  let current = node
  for (let parent = current.parent; parent; current = parent, parent = parent.parent) {
    if (parent.type === 'await' || parent.type === 'parenthesized_expression') continue
    if (parent.type === 'attribute' && parent.childForFieldName('object')?.id === current.id) {
      items.push({ field: parent.childForFieldName('attribute')?.text ?? '', node: parent })
    } else if (
      parent.type === 'subscript' &&
      parent.childForFieldName('value')?.id === current.id
    ) {
      const key = parent.childForFieldName('subscript') ?? undefined
      items.push({ ...(key ? { key } : {}), node: parent })
    } else if (parent.type === 'call' && parent.childForFieldName('function')?.id === current.id) {
      items.push({ args: argumentsOf(parent).positional, node: parent })
    } else break
  }
  return items
}

const fits = (items: ChainItem[], observed: Observed[]) =>
  items.length <= observed.length &&
  items.every((item, i) => {
    const seen = observed[i]
    // A key, or an attribute that is not a method called: `state.user`, not `scope.pop(…)`.
    if (item.property)
      return (
        seen?.key !== undefined ||
        (seen?.field !== undefined && observed[i + 1]?.args === undefined)
      )
    return item.field !== undefined ? seen?.field === item.field : seen?.args !== undefined
  })

const assignedTo = (node: Node) => {
  const parent = node.parent
  return (
    (parent?.type === 'assignment' || parent?.type === 'augmented_assignment') &&
    parent.childForFieldName('left')?.id === node.id
  )
}

// A parameter's own name as a header: `user_agent` is `user-agent`.
const hyphenated = (name: string) => name.replace(/_/g, '-')

export function extractReads(
  program: PyProgram,
  profile: ResolvedProfile,
  parameterized: Map<string, Set<string>>,
): Fact[] {
  const facts: Fact[] = []
  const source = `tree-sitter:${profile.name}`
  const chains = profile.reads
    .filter((r): r is Extract<ReadRule, { chain: string }> => 'chain' in r)
    .map((rule) => ({ rule, items: parseChain(rule.chain), on: rule.on ?? profile.request }))
    .sort((a, b) => b.items.length - a.items.length)
  const ons = new Set(chains.map((c) => c.on))
  const calls = new Map(
    profile.reads
      .filter((r): r is Extract<ReadRule, { call: string }> => 'call' in r)
      .map((rule) => [`ext:${rule.call}`, rule]),
  )
  const stated = new Set<string>()
  const push = (fact: Fact) => {
    const key = `${fact.node}\0${fact.value}\0${fact.citation.line}`
    if (stated.has(key)) return
    stated.add(key)
    facts.push(fact)
  }
  const add = (
    decl: PyDecl | undefined,
    file: PyFile,
    at: Node,
    read: ReadKind,
    name: string | undefined,
  ) => {
    if (!decl) return
    const citation = { file: file.path, line: line(at) }
    push({
      node: decl.ref,
      kind: 'read',
      value: name === undefined ? read : `${read}.${name}`,
      citation,
      source,
    })
  }

  for (const file of program.files) {
    for (const start of present(
      file.tree.rootNode.descendantsOfType(['identifier', 'attribute', 'call']),
    )) {
      const parent = start.parent
      const followed =
        (parent?.type === 'attribute' && parent.childForFieldName('object')?.id === start.id) ||
        (parent?.type === 'subscript' && parent.childForFieldName('value')?.id === start.id) ||
        (parent?.type === 'call' && parent.childForFieldName('function')?.id === start.id)
      if (!followed) continue
      const decl = program.declOf(file, start)
      if (!decl) continue
      const symbols = program.symbolsOf(program.typeOf(start, file)).filter((s) => ons.has(s))
      if (symbols.length === 0) continue
      const observed = chainFrom(start)
      if (observed.length === 0) continue
      for (const symbol of symbols) {
        let hit = false
        for (const { rule, items, on } of chains) {
          if (on !== symbol || !fits(items, observed)) continue
          const outer = observed[items.length - 1]?.node
          if (outer && assignedTo(outer)) {
            hit = true
            break
          }
          const at = outer ?? start
          const property = items.findIndex((item) => item.property)
          if (property >= 0) {
            const seen = observed[property]
            const name = seen?.key
              ? program.stringValueOf(seen.key, file)
              : seen?.field || undefined
            if (name !== undefined && rule.except?.includes(name)) {
              hit = true
              break
            }
            const kind = name !== undefined ? rule.by?.[name] : undefined
            if (rule.by) add(decl, file, at, kind ?? rule.read, kind ? undefined : name)
            else add(decl, file, at, rule.read, name)
            hit = true
            break
          }
          const named = items.findIndex((item) => item.call?.name)
          if (named < 0) {
            add(decl, file, at, rule.read, undefined)
            hit = true
            break
          }
          const value = program.stringValueOf(observed[named]?.args?.[0], file)
          if (value !== undefined && rule.except?.includes(value)) {
            hit = true
            break
          }
          const kind = value !== undefined ? rule.by?.[value] : undefined
          if (rule.by) add(decl, file, at, kind ?? rule.read, kind ? undefined : value)
          else add(decl, file, at, rule.read, value)
          hit = true
          break
        }
        if (hit) break
      }
    }
    // Reads through a function given the request.
    for (const call of present(file.tree.rootNode.descendantsOfType('call'))) {
      const fn = call.childForFieldName('function')
      if (!fn || (fn.type !== 'identifier' && fn.type !== 'attribute')) continue
      const rule = (program.callees(fn, file) ?? [])
        .map((t) => calls.get(t.ref) ?? calls.get(`ext:${program.symbolOf(t)}`))
        .find((r) => r)
      if (!rule) continue
      if (typeof rule.request === 'string' && !argumentsOf(call).keywords.has(rule.request))
        continue
      const args = argumentsOf(call).positional
      add(
        program.declOf(file, call),
        file,
        call,
        rule.read,
        rule.name === undefined ? undefined : program.stringValueOf(args[rule.name], file),
      )
    }
    // Reads a function's parameters declare.
    if (profile.parameters) {
      for (const decl of file.decls)
        parameterReads(program, profile, file, decl, parameterized, add)
    }
  }
  return facts
}

// What a function's parameters read: a marker's (`Query()`, `Header(alias="x-key")`), a model's
// (the body), an upload's (a form field), and for a handler or a dependency of a route, a plain
// parameter's: a path parameter when the route's path names it, a query parameter otherwise.
function parameterReads(
  program: PyProgram,
  profile: ResolvedProfile,
  file: PyFile,
  decl: PyDecl,
  parameterized: Map<string, Set<string>>,
  add: (
    decl: PyDecl | undefined,
    file: PyFile,
    at: Node,
    read: ReadKind,
    name: string | undefined,
  ) => void,
) {
  const spec = profile.parameters
  if (!spec || decl.kind === 'class') return
  const markers = new Map(spec.markers.map((m) => [`ext:${m.call}`, m]))
  const depends = new Set(spec.depends.map((d) => `ext:${d}`))
  const given = new Set(spec.given ?? [])
  const models = new Set(spec.models ?? [])
  const uploads = new Set(spec.files ?? [])
  const paths = parameterized.get(decl.ref)
  const params = parametersOf(decl.node)
  for (const [index, param] of params.entries()) {
    if (index === 0 && decl.kind === 'method') continue
    if (param.star) continue
    // The marker: the default, or `Annotated` metadata.
    const candidates: { node: Node; file: PyFile }[] = [
      ...(param.value ? [{ node: param.value, file }] : []),
      ...program.annotated(param.type, file),
    ]
    let marked = false
    for (const { node, file: f } of candidates) {
      if (node.type !== 'call') continue
      const fn = node.childForFieldName('function')
      const targets = fn ? (program.callees(fn, f) ?? []) : []
      if (targets.some((t) => depends.has(`ext:${program.symbolOf(t)}`))) {
        marked = true
        break
      }
      const marker = targets.map((t) => markers.get(`ext:${program.symbolOf(t)}`)).find((m) => m)
      if (!marker) continue
      const alias = spec.alias ? argumentsOf(node).keywords.get(spec.alias) : undefined
      const named = alias ? stringValue(alias) : undefined
      const converted =
        marker.hyphens &&
        !alias &&
        argumentsOf(node).keywords.get('convert_underscores')?.text !== 'False'
      add(
        decl,
        file,
        param.node,
        marker.read,
        named ?? (converted ? hyphenated(param.name) : param.name),
      )
      marked = true
      break
    }
    if (marked) continue
    const type = program.typeOfAnnotation(param.type, file)
    const symbols = program.symbolsOf(type)
    if (symbols.some((s) => given.has(s))) continue
    if (symbols.some((s) => uploads.has(s))) {
      add(decl, file, param.node, 'form', param.name)
      continue
    }
    if (symbols.some((s) => models.has(s))) {
      add(decl, file, param.node, 'body', undefined)
      continue
    }
    if (!paths) continue
    const inPath = [...paths].some(
      (p) => p.includes(`{${param.name}}`) || p.includes(`{${param.name}...}`),
    )
    add(decl, file, param.node, inPath ? 'path' : 'query', param.name)
  }
}

const literal = (node: Node | undefined) =>
  !!node &&
  (['integer', 'float', 'true', 'false', 'none'].includes(node.type) ||
    ((node.type === 'string' || node.type === 'concatenated_string') &&
      stringValue(node) !== undefined))

const mutating =
  /^(append|extend|insert|remove|pop|popitem|clear|update|setdefault|add|discard|set|put|delete|__setitem__|__delitem__|appendleft|incr|decr|inc|dec)$/

// The variable at the root of `a.b[c].d`.
function rootOf(node: Node): Node | undefined {
  let current: Node | null = node
  while (current) {
    if (current.type === 'identifier') return current
    if (current.type === 'attribute') current = current.childForFieldName('object')
    else if (current.type === 'subscript') current = current.childForFieldName('value')
    else if (current.type === 'call') current = current.childForFieldName('function')
    else if (current.type === 'parenthesized_expression' || current.type === 'await')
      current = current.namedChildren[0] ?? null
    else return undefined
  }
  return undefined
}

const uses = (node: Node) =>
  new Set(
    present(node.descendantsOfType('identifier'))
      .map((n) => n.text)
      .concat(node.type === 'identifier' ? [node.text] : []),
  )

// `if x is None: x = …` or `global x` set once: a singleton every request then only reads.
function lazilySet(assignment: Node, name: string): boolean {
  const unset = new RegExp(
    `(^|[^\\w.])(not\\s+${name}\\b|${name}\\s+is\\s+None\\b|${name}\\s*==\\s*None\\b)`,
  )
  for (let n = assignment.parent; n; n = n.parent) {
    if (n.type === 'if_statement' && unset.test(n.childForFieldName('condition')?.text ?? ''))
      return true
    if (n.type === 'function_definition') return false
  }
  return false
}

// A status a refusal states, as the profile's `exceptions` say it is written:
// `HTTPException(status_code=401)`, `status.HTTP_403_FORBIDDEN`, an integer among the arguments.
function statusOf(
  raised: Node,
  program: PyProgram,
  file: PyFile,
  handled: Map<string, number>,
  exceptions: ResolvedProfile['exceptions'],
): number | undefined {
  const value = raised.type === 'call' ? raised : undefined
  if (value) {
    const { positional, keywords } = argumentsOf(value)
    const named = exceptions.named ? new RegExp(exceptions.named) : undefined
    for (const arg of [...exceptions.status.map((k) => keywords.get(k)), ...positional]) {
      if (!arg) continue
      if (arg.type === 'integer') return Number(arg.text)
      const status = named?.exec(arg.text)?.[1]
      if (status) return Number(status)
    }
  }
  // An exception of the application's own, answered by a handler with a status.
  const callee = value ? value.childForFieldName('function') : raised
  const targets = callee ? (program.callees(callee, file) ?? []) : []
  for (const t of targets) {
    const decl = t.decl?.kind === 'class' ? t.decl : t.decl?.owner
    const status = decl ? handled.get(decl.ref) : handled.get(t.ref)
    if (status) return status
  }
  return undefined
}

export function declFacts(
  program: PyProgram,
  profile: ResolvedProfile,
  library: Library,
  reads: Fact[],
  dependencies: Set<string>,
): Fact[] {
  const facts: Fact[] = []
  const source = `tree-sitter:${profile.name}`
  const sinks = new Map<string, Sink>(library.sinks)
  for (const [kind, symbols] of Object.entries(profile.sinks)) {
    for (const entry of symbols ?? []) {
      const { symbol, argument } = parseSink(entry)
      sinks.set(`ext:${symbol}`, { kind: kind as Sink['kind'], argument })
    }
  }
  const requestTypes = new Set(
    [profile.request, profile.context, ...profile.handlerTypes].filter((t): t is string => !!t),
  )
  const isRequest = (node: Node | undefined, file: PyFile) =>
    !!node && program.symbolsOf(program.typeOf(node, file)).some((s) => requestTypes.has(s))
  const mutations = profile.mutations.map((m) => ({
    items: parseChain(m.chain),
    on: m.on ?? profile.request,
  }))
  const readLines = new Set(
    reads
      .filter((r) => !/^(body|form)(\.|$)/.test(r.value))
      .map((r) => `${r.node}\0${r.citation.line}`),
  )
  const bodyLines = new Set(
    reads
      .filter((r) => r.value === 'body' || r.value.startsWith('body.'))
      .map((r) => `${r.node}\0${r.citation.line}`),
  )
  const models = new Set(profile.parameters?.models ?? [])
  const statusGuards = profile.guards.filter(
    (g): g is { status: number; kind: never } => 'status' in g,
  )
  const handled = exceptionStatuses(program, profile)

  for (const file of program.files) {
    const add = (at: Node, kind: Fact['kind'], value: string, data?: Record<string, unknown>) => {
      const decl = program.declOf(file, at)
      if (!decl) return
      facts.push({
        node: decl.ref,
        kind,
        value,
        citation: { file: file.path, line: line(at) },
        source,
        ...(data ? { data } : {}),
      })
    }
    // A module's own variables: state that outlives a request.
    const isModuleVar = (node: Node | undefined): boolean => {
      if (node?.type !== 'identifier') return false
      const binding = program.lookup(node.text, node, file)
      if (binding?.kind !== 'value') return false
      const statement = binding.node.parent
      return statement?.type === 'expression_statement' && statement.parent?.type === 'module'
    }

    for (const call of present(file.tree.rootNode.descendantsOfType('call'))) {
      const fn = call.childForFieldName('function')
      if (
        !fn ||
        (fn.type !== 'identifier' && fn.type !== 'attribute') ||
        !program.declOf(file, call)
      )
        continue
      const { positional, keywords } = argumentsOf(call)
      const targets = program.callees(fn, file) ?? []
      for (const target of targets) {
        const sink = sinks.get(target.ref)
        if (sink) {
          const interpreted =
            sink.argument === '*'
              ? [...positional, ...keywords.values()]
              : [positional[sink.argument]]
          if (interpreted.some((a) => a && !literal(a)))
            add(call, 'sink', sink.kind, { callee: target.ref })
        }
        if (library.writes.has(target.ref))
          add(call, 'signal', 'data-write', { callee: target.ref })
        if (library.reads.has(target.ref)) add(call, 'signal', 'data-read', { callee: target.ref })
      }
      // A function the caller supplied, given the request.
      const root = fn.type === 'attribute' ? rootOf(fn) : fn
      const binding =
        root?.type === 'identifier' ? program.lookup(root.text, root, file) : undefined
      if (
        binding?.kind === 'param' &&
        targets.length === 0 &&
        positional.some((a) => isRequest(a, file))
      )
        add(call, 'signal', 'callback-passed', { callee: fn.text })
      // Request state changed for what reads it later.
      if (fn.type === 'attribute') {
        for (
          let start: Node | null = fn;
          start?.type === 'attribute';
          start = start.childForFieldName('object')
        ) {
          const object = start.childForFieldName('object')
          if (!object) break
          const symbols = program.symbolsOf(program.typeOf(object, file))
          if (symbols.length === 0) continue
          const observed = chainFrom(object)
          const hit = mutations.find(
            (m) =>
              symbols.includes(m.on ?? '') &&
              fits(m.items, observed) &&
              observed[m.items.length - 1]?.node.id === call.id,
          )
          if (hit) {
            add(call, 'signal', 'retained-mutation', { target: fn.text })
            break
          }
        }
        const property = fn.childForFieldName('attribute')?.text
        if (property && mutating.test(property)) {
          const owner = rootOf(fn.childForFieldName('object') as Node)
          if (isModuleVar(owner)) add(call, 'signal', 'live-state', { variable: owner?.text })
        }
      }
    }

    for (const assignment of present(
      file.tree.rootNode.descendantsOfType(['assignment', 'augmented_assignment']),
    )) {
      if (!program.declOf(file, assignment)) continue
      const target = assignment.childForFieldName('left')
      if (!target) continue
      const root = rootOf(target)
      // A module variable assigned in a function that declares it `global`, or changed in place.
      const global =
        target.type === 'identifier'
          ? present(
              program.declOf(file, assignment)?.node.descendantsOfType('global_statement') ?? [],
            ).some((g) => g.namedChildren.some((n) => n?.text === target.text))
          : isModuleVar(root)
      if (root && global && !lazilySet(assignment, root.text))
        add(assignment, 'signal', 'live-state', { variable: root.text })
      if (root && target.id !== root.id && isRequest(root, file))
        add(assignment, 'signal', 'retained-mutation', { target: target.text })
    }

    for (const decl of file.decls) {
      if (decl.kind === 'class') continue
      const body = decl.node.childForFieldName('body')
      if (!body) continue
      const own = (n: Node) => program.declOf(file, n)?.ref === decl.ref
      const fromRequest = new Set<string>()
      const bodies = new Set<string>()
      // Parameters read as plain values, and those that hold a model.
      for (const r of reads) {
        if (r.node !== decl.ref) continue
        for (const p of parametersOf(decl.node)) {
          if (line(p.node) !== r.citation.line) continue
          if (r.value === 'body' || r.value.startsWith('body.')) bodies.add(p.name)
          else if (!/^form/.test(r.value)) fromRequest.add(p.name)
        }
      }
      for (const p of parametersOf(decl.node)) {
        if (program.symbolsOf(program.typeOfAnnotation(p.type, file)).some((s) => models.has(s)))
          bodies.add(p.name)
      }
      // A call of a method that dumps a model to a mapping: `body.model_dump()`.
      const dumps = (n: Node) =>
        present(
          n.type === 'call' ? [n, ...n.descendantsOfType('call')] : n.descendantsOfType('call'),
        ).some((c) => {
          const f = c.childForFieldName('function')
          return (
            f?.type === 'attribute' &&
            library.dumps.has(f.childForFieldName('attribute')?.text ?? '')
          )
        })
      for (const assignment of present(body.descendantsOfType('assignment'))) {
        if (!own(assignment)) continue
        const left = assignment.childForFieldName('left')
        const right = assignment.childForFieldName('right')
        if (left?.type !== 'identifier' || !right) continue
        const at = `${decl.ref}\0${line(assignment)}`
        if (readLines.has(at)) fromRequest.add(left.text)
        if (bodyLines.has(at)) bodies.add(left.text)
        // `data = body.model_dump()`, `data = await request.json()`.
        if ([...bodies].some((b) => uses(right).has(b)) && dumps(right)) bodies.add(left.text)
        if (right.type === 'call') {
          const rfn = right.childForFieldName('function')
          if (rfn && (program.callees(rfn, file) ?? []).some((t) => library.decoders.has(t.ref)))
            bodies.add(left.text)
        }
      }
      if (fromRequest.size === 0 && bodies.size === 0) continue
      const writes = present(body.descendantsOfType('call')).some((c) => {
        const cfn = c.childForFieldName('function')
        return (
          own(c) &&
          !!cfn &&
          (program.callees(cfn, file) ?? []).some((t) => library.writes.has(t.ref))
        )
      })
      for (const call of present(body.descendantsOfType('call'))) {
        if (!own(call)) continue
        const cfn = call.childForFieldName('function')
        const refs =
          cfn && (cfn.type === 'identifier' || cfn.type === 'attribute')
            ? (program.callees(cfn, file) ?? []).map((t) => t.ref)
            : []
        const access = refs.some((r) => library.writes.has(r) || library.reads.has(r))
        const used = new Set<string>()
        for (const a of present(call.childForFieldName('arguments')?.namedChildren ?? []))
          for (const u of uses(a)) used.add(u)
        if (access) {
          const key = [...fromRequest].find((n) => used.has(n))
          if (key) add(call, 'signal', 'request-key', { variable: key })
        }
        // A model spread into another, or validated into one, in a function that writes:
        // `Item(**body.model_dump())`, `Item.model_validate(body)`, `item.sqlmodel_update(data)`.
        if (!writes) continue
        const args = present(call.childForFieldName('arguments')?.namedChildren ?? [])
        const spread = args.find(
          (a) => a.type === 'dictionary_splat' && [...bodies].some((b) => uses(a).has(b)),
        )
        const bound =
          library.binds.has(
            cfn?.type === 'attribute' ? (cfn.childForFieldName('attribute')?.text ?? '') : '',
          ) &&
          args.find((a) => a.type !== 'keyword_argument' && [...bodies].some((b) => uses(a).has(b)))
        const stored = spread ?? bound
        if (stored) {
          const name = [...bodies].find((b) => uses(stored).has(b))
          add(call, 'signal', 'mass-assignment', { variable: name })
        }
      }
    }

    // A middleware that can answer without calling the next one, and a dependency that refuses.
    for (const decl of file.decls) {
      if (decl.kind === 'class') continue
      shortCircuit(
        program,
        file,
        decl,
        add,
        isRequest,
        dependencies.has(decl.ref),
        profile.middleware,
      )
      if (dependencies.has(decl.ref) && statusGuards.length > 0) {
        const body = decl.node.childForFieldName('body')
        const own = (n: Node) => program.declOf(file, n)?.ref === decl.ref
        const found = new Set<string>()
        for (const raise of present(body?.descendantsOfType('raise_statement') ?? [])) {
          if (!own(raise) || !conditional(raise, body as Node)) continue
          const raised = raise.namedChildren[0]
          if (!raised) continue
          const status = statusOf(raised, program, file, handled, profile.exceptions)
          const rule = statusGuards.find((g) => g.status === status)
          if (!rule || found.has(rule.kind)) continue
          found.add(rule.kind)
          add(raise, 'guard', rule.kind, { status })
        }
      }
    }
  }
  return facts
}

// Whether a statement runs only in a condition of a function's body: an `if`, an `except`, a
// `match` case, a loop.
function conditional(node: Node, body: Node): boolean {
  for (let n = node.parent; n && n.id !== body.id; n = n.parent) {
    if (
      [
        'if_statement',
        'elif_clause',
        'else_clause',
        'except_clause',
        'case_clause',
        'for_statement',
        'while_statement',
      ].includes(n.type)
    )
      return true
  }
  return false
}

// The statuses the application's exception handlers answer each of its exceptions with:
// `@app.exception_handler(Unauthenticated)` returning `JSONResponse(…, 401)`.
function exceptionStatuses(program: PyProgram, profile: ResolvedProfile): Map<string, number> {
  const handled = new Map<string, number>()
  if (profile.exceptions.handlers.length === 0) return handled
  for (const file of program.files) {
    for (const call of present(file.tree.rootNode.descendantsOfType('call'))) {
      const fn = call.childForFieldName('function')
      const name = fn?.type === 'attribute' ? fn.childForFieldName('attribute')?.text : undefined
      if (!name || !profile.exceptions.handlers.includes(name)) continue
      const { positional } = argumentsOf(call)
      const exception = positional[0]
      // A decorator takes the function it decorates; a call, its second argument.
      const handlerNode =
        call.parent?.type === 'decorator'
          ? call.parent.parent?.childForFieldName('definition')
          : positional[1]
      if (!exception || !handlerNode) continue
      const ref = program.resolve(exception, file)
      if (ref?.kind !== 'decl') continue
      const handler =
        handlerNode.type === 'function_definition'
          ? file.declsById.get(handlerNode.id)
          : (() => {
              const r = program.resolve(handlerNode, file)
              return r?.kind === 'decl' ? r.decl : undefined
            })()
      if (!handler) continue
      // One status, however many times the handler writes it.
      const statuses = new Set(
        present(handler.node.descendantsOfType('integer'))
          .map((n) => Number(n.text))
          .filter((n) => n >= 400 && n < 600),
      )
      if (statuses.size === 1) handled.set(ref.decl.ref, [...statuses][0] as number)
    }
  }
  return handled
}

// A function that can answer on its own: a middleware given the request and a next handler
// (`call_next`, `app`) that returns or raises in a condition before calling it; or a dependency
// that raises in a condition, which ends the request before the handler.
function shortCircuit(
  program: PyProgram,
  file: PyFile,
  decl: PyDecl,
  add: (at: Node, kind: Fact['kind'], value: string) => void,
  isRequest: (node: Node | undefined, file: PyFile) => boolean,
  dependency: boolean,
  middleware: ResolvedProfile['middleware'],
) {
  const body = decl.node.childForFieldName('body')
  if (body?.type !== 'block') return
  const own = (n: Node) => program.declOf(file, n)?.ref === decl.ref
  if (dependency) {
    for (const raise of present(body.descendantsOfType('raise_statement'))) {
      if (own(raise) && raise.namedChildren.length > 0 && conditional(raise, body)) {
        add(raise, 'signal', 'short-circuit')
        return
      }
    }
  }
  const params = parametersOf(decl.node).filter((_p, i) => !(i === 0 && decl.kind === 'method'))
  const first = params[0]
  if (!first || !isRequest(first.node, file)) {
    // A middleware class's method, `__call__(self, scope, receive, send)`, that calls the next
    // application through one of its attributes the profile names: `self.app(…)`.
    const method = decl.kind === 'method' ? decl.name.split('.').at(-1) : undefined
    if (method && method in middleware.classes && middleware.forwards.length > 0) {
      const through = new RegExp(`\\bself\\.(${middleware.forwards.join('|')})\\s*\\(`)
      stops(body, own, (n: Node) => through.test(n.text), add)
    }
    return
  }
  const next = params.slice(1).map((p) => p.name)
  if (next.length === 0) return
  const forwards = (node: Node) =>
    present(
      node.type === 'call'
        ? [node, ...node.descendantsOfType('call')]
        : node.descendantsOfType('call'),
    ).some((c) => {
      const f = c.childForFieldName('function')
      return f?.type === 'identifier' && next.includes(f.text) && own(c)
    })
  stops(body, own, forwards, add)
}

function stops(
  body: Node,
  own: (n: Node) => boolean,
  forwards: (n: Node) => boolean,
  add: (at: Node, kind: Fact['kind'], value: string) => void,
) {
  if (!present(body.descendantsOfType('call')).filter(own).some(forwards)) return
  for (const stop of present(body.descendantsOfType(['return_statement', 'raise_statement']))) {
    if (!own(stop) || forwards(stop)) continue
    if (!conditional(stop, body)) continue
    const before = present(stop.parent?.namedChildren ?? []).filter(
      (s) => s.endIndex <= stop.startIndex,
    )
    if (before.some(forwards)) continue
    add(stop, 'signal', 'short-circuit')
    return
  }
}
