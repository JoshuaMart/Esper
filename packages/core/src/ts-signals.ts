import type { Node } from 'web-tree-sitter'
import type { Fact } from './graph.ts'
import { type Library, parseSink, type Sink } from './library.ts'
import type { ReadKind, ReadRule, ResolvedProfile } from './profile.ts'
import {
  type Binding,
  type Decl,
  keyName,
  line,
  parametersOf,
  patternNames,
  present,
  type TsFile,
  type TsProgram,
  typeSymbol,
} from './ts.ts'

// Facts on declarations, computed by rules from the syntax (D6): what each reads from the
// request, the sinks it calls, the persisted data it reads and writes, and what it does with the
// request and with state that outlives it. Entry points get their signals from what they reach.

interface ChainItem {
  field?: string
  call?: { name: boolean }
  // A property whose name is what is read: `params[name]`.
  property?: true
}

// `req.param(name)` is the field `req`, the field `param`, and a call whose argument names what is
// read; `params[name]` the field `params` and the property read from it.
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
  // For a property read by a computed key: the key, when it is not a string the index can read.
  key?: Node
  args?: Node[]
  node: Node
}

// The fields and calls applied to a value, outward from it: `c.req.header('X')` from `c`.
function chainFrom(node: Node): Observed[] {
  const items: Observed[] = []
  let current = node
  for (let parent = current.parent; parent; current = parent, parent = parent.parent) {
    if (parent.type === 'non_null_expression') continue
    if (
      parent.type === 'member_expression' &&
      parent.childForFieldName('object')?.id === current.id
    ) {
      items.push({ field: keyName(parent.childForFieldName('property')) ?? '', node: parent })
    } else if (
      parent.type === 'subscript_expression' &&
      parent.childForFieldName('object')?.id === current.id
    ) {
      const index = parent.childForFieldName('index') ?? undefined
      items.push({ field: '', ...(index ? { key: index } : {}), node: parent })
    } else if (
      parent.type === 'call_expression' &&
      parent.childForFieldName('function')?.id === current.id
    ) {
      items.push({
        args: present(parent.childForFieldName('arguments')?.namedChildren ?? []),
        node: parent,
      })
    } else break
  }
  return items
}

const fits = (items: ChainItem[], observed: Observed[]) =>
  items.length <= observed.length &&
  items.every((item, i) => {
    const seen = observed[i]
    if (item.property) return seen?.field !== undefined
    return item.field !== undefined
      ? seen?.field === item.field && !seen.key
      : seen?.args !== undefined
  })

const assignedTo = (node: Node) => {
  const parent = node.parent
  return (
    (parent?.type === 'assignment_expression' ||
      parent?.type === 'augmented_assignment_expression') &&
    parent.childForFieldName('left')?.id === node.id
  )
}

// The value an expression gives once awaited and unwrapped: what a declarator takes.
function outermost(node: Node): Node {
  let current = node
  while (
    current.parent &&
    [
      'await_expression',
      'parenthesized_expression',
      'as_expression',
      'non_null_expression',
    ].includes(current.parent.type)
  )
    current = current.parent
  return current
}

// Where a value is stored: the names a declarator binds with it.
function declaredWith(node: Node): Node | undefined {
  const value = outermost(node)
  const parent = value.parent
  return parent?.type === 'variable_declarator' &&
    parent.childForFieldName('value')?.id === value.id
    ? (parent.childForFieldName('name') ?? undefined)
    : undefined
}

export function extractReads(program: TsProgram, profile: ResolvedProfile): Fact[] {
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
  // A read is stated once per declaration, value and line, however many rules see it.
  const stated = new Set<string>()
  const push = (fact: Fact) => {
    const key = `${fact.node}\0${fact.value}\0${fact.citation.line}`
    if (stated.has(key)) return
    stated.add(key)
    facts.push(fact)
  }
  const add = (file: TsFile, at: Node, read: ReadKind, name: string | undefined) => {
    const decl = program.declOf(file, at)
    if (!decl) return
    const citation = { file: file.path, line: line(at) }
    // A read whose name the call does not say, destructured: `const { id } = c.req.param()`.
    const names =
      name === undefined
        ? (() => {
            const pattern = declaredWith(at)
            return pattern?.type === 'object_pattern'
              ? patternNames(pattern)
                  .map((n) => n.path[0])
                  .filter((n): n is string => !!n)
              : []
          })()
        : [name]
    if (names.length === 0) push({ node: decl.ref, kind: 'read', value: read, citation, source })
    for (const n of new Set(names))
      push({ node: decl.ref, kind: 'read', value: `${read}.${n}`, citation, source })
  }

  // What the names of a pattern read, each through the properties it is taken by.
  const destructured = (file: TsFile, pattern: Node, observed: Observed[], symbol: string) => {
    for (const { name, path } of patternNames(pattern)) {
      const extended = [...observed, ...path.map((field) => ({ field, node: name }))]
      const hit = chains.find(
        ({ items, on }) =>
          on === symbol && items.length === extended.length && fits(items, extended),
      )
      // `const { id } = params` reads `path.id` when the rule's last item is a property.
      if (hit) add(file, name, hit.rule.read, hit.items.at(-1)?.property ? path.at(-1) : undefined)
    }
  }

  for (const file of program.files) {
    for (const start of present(
      file.tree.rootNode.descendantsOfType(['identifier', 'this', 'member_expression']),
    )) {
      const parent = start.parent
      const followed =
        (parent?.type === 'member_expression' ||
          parent?.type === 'subscript_expression' ||
          parent?.type === 'call_expression') &&
        parent.childForFieldName(parent.type === 'call_expression' ? 'function' : 'object')?.id ===
          start.id
      // A value destructured as it is: `const { id } = params`.
      const whole = declaredWith(start)?.type === 'object_pattern'
      // A name destructured from a value starts the chain at the properties it is taken by:
      // `({ locals }) => locals.user` reads what `event.locals.user` does.
      const from = start.type === 'identifier' ? program.destructuredFrom(start, file) : undefined
      if (!followed && !whole && !from) continue
      const starts = [
        ...program.typeSymbols(start, file).map((symbol) => ({ symbol, prefix: [] as Observed[] })),
        ...(from?.symbols ?? []).map((symbol) => ({
          symbol,
          prefix: from?.path.map((field): Observed => ({ field, node: start })) ?? [],
        })),
      ]
      for (const { symbol, prefix } of starts) {
        if (!ons.has(symbol)) continue
        const observed = [...prefix, ...(followed ? chainFrom(start) : [])]
        if (observed.length === 0 && !whole) continue
        // A value destructured from the chain reads what each of its properties would:
        // `const { method, url } = c.req`.
        const end = observed.at(-1)?.node ?? start
        const pattern = declaredWith(end)
        if (pattern?.type === 'object_pattern') destructured(file, pattern, observed, symbol)
        for (const { rule, items, on } of chains) {
          if (on !== symbol || !fits(items, observed)) continue
          // `c.req.raw.headers = h` writes the request; it reads nothing.
          const outer = observed[items.length - 1]?.node
          if (outer && assignedTo(outer)) break
          const at = outer ?? start
          // A property names what it reads: `params.id`, `headers[key]`.
          const property = items.findIndex((item) => item.property)
          if (property >= 0) {
            const seen = observed[property]
            const name = seen?.key
              ? program.stringValueOf(seen.key, file)
              : seen?.field || undefined
            add(file, at, rule.read, name)
            break
          }
          const named = items.findIndex((item) => item.call?.name)
          if (named < 0) {
            add(file, at, rule.read, undefined)
            break
          }
          const value = program.stringValueOf(observed[named]?.args?.[0], file)
          const kind = value !== undefined ? rule.by?.[value] : undefined
          if (rule.by && value !== undefined)
            add(file, at, kind ?? rule.read, kind ? undefined : value)
          else if (rule.by) add(file, at, rule.read, undefined)
          else add(file, at, rule.read, value)
          break
        }
      }
    }
    // Reads through a function given the request or the context.
    for (const call of present(file.tree.rootNode.descendantsOfType('call_expression'))) {
      const fn = call.childForFieldName('function')
      if (!fn || (fn.type !== 'identifier' && fn.type !== 'member_expression')) continue
      const rule = (program.callees(fn, file) ?? []).map((t) => calls.get(t.ref)).find((r) => r)
      if (!rule) continue
      const args = present(call.childForFieldName('arguments')?.namedChildren ?? [])
      add(
        file,
        call,
        rule.read,
        rule.name === undefined ? undefined : program.stringValueOf(args[rule.name], file),
      )
    }
  }
  return facts
}

const literal = (node: Node | undefined) =>
  !!node &&
  (node.type === 'number' ||
    node.type === 'true' ||
    node.type === 'false' ||
    node.type === 'null' ||
    node.type === 'string' ||
    (node.type === 'template_string' &&
      !node.namedChildren.some((n) => n?.type === 'template_substitution')))

const mutating =
  /^(set|add|delete|clear|push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|append|assign|setItem|removeItem|store|put|insert|remove|reset|inc|dec|incr|decr)$/

const argumentsOf = (call: Node) =>
  present(call.childForFieldName('arguments')?.namedChildren ?? [])

// The variable at the root of `a.b[c].d`, the target of an assignment or a call.
function rootOf(node: Node): Node | undefined {
  let current: Node | null = node
  while (current) {
    if (current.type === 'identifier' || current.type === 'this') return current
    if (current.type === 'member_expression' || current.type === 'subscript_expression') {
      current = current.childForFieldName('object')
    } else if (current.type === 'call_expression') current = current.childForFieldName('function')
    else if (
      [
        'parenthesized_expression',
        'non_null_expression',
        'as_expression',
        'await_expression',
      ].includes(current.type)
    ) {
      current = current.namedChildren[0] ?? null
    } else return undefined
  }
  return undefined
}

const uses = (node: Node) =>
  new Set(
    present(node.descendantsOfType(['identifier', 'shorthand_property_identifier']))
      .map((n) => n.text)
      .concat(node.type === 'identifier' ? [node.text] : []),
  )

// `if (!pool) pool = …`, `pool ??= …`, or `if (pool) return pool` before it, sets a singleton
// once, which every request then only reads.
function lazilySet(assignment: Node, name: string): boolean {
  if (
    assignment.type === 'augmented_assignment_expression' &&
    /^(\?\?=|\|\|=)$/.test(assignment.childForFieldName('operator')?.text ?? '')
  )
    return true
  const escaped = name.replace(/[$]/g, '\\$')
  const unset = new RegExp(
    `(^|[^\\w$.])(!\\s*${escaped}\\b|${escaped}\\s*(===?|==)\\s*(null|undefined)\\b)`,
  )
  const set = new RegExp(
    `^\\(?\\s*${escaped}\\s*\\)?$|\\b${escaped}\\s*!==?\\s*(null|undefined)\\b`,
  )
  const condition = (n: Node) => n.childForFieldName('condition')?.text ?? ''
  for (let n = assignment.parent; n; n = n.parent) {
    if (n.type === 'if_statement' && unset.test(condition(n))) return true
    if (
      [
        'function_declaration',
        'arrow_function',
        'function_expression',
        'method_definition',
      ].includes(n.type)
    ) {
      const body = n.childForFieldName('body')
      const before = present(body?.namedChildren ?? []).filter(
        (s) => s.endIndex <= assignment.startIndex,
      )
      return before.some(
        (s) =>
          s.type === 'if_statement' &&
          set.test(
            condition(s)
              .replace(/^\(|\)$/g, '')
              .trim(),
          ) &&
          present(s.childForFieldName('consequence')?.descendantsOfType('return_statement') ?? [])
            .length > 0,
      )
    }
  }
  return false
}

export function declFacts(
  program: TsProgram,
  profile: ResolvedProfile,
  library: Library,
  reads: Fact[],
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
  const requestTypes = new Set([profile.request, profile.context].filter((t): t is string => !!t))
  const isRequest = (node: Node | undefined, file: TsFile) =>
    !!node && program.typeSymbols(node, file).some((s) => requestTypes.has(s))
  const mutations = profile.mutations.map((m) => ({
    items: parseChain(m.chain),
    on: m.on ?? profile.request,
  }))
  // A body is stored rather than used as a key: only the other reads select a record.
  const readLines = new Set(
    reads
      .filter((r) => !/^(body|form)(\.|$)/.test(r.value))
      .map((r) => `${r.node}\0${r.citation.line}`),
  )
  const readsOf = new Map<string, Fact[]>()
  for (const r of reads) readsOf.set(r.node, [...(readsOf.get(r.node) ?? []), r])
  const bodyLines = new Set(
    reads
      .filter((r) => r.value === 'body' || r.value.startsWith('body.'))
      .map((r) => `${r.node}\0${r.citation.line}`),
  )

  for (const file of program.files) {
    const add = (at: Node, kind: Fact['kind'], value: string, data?: Record<string, unknown>) => {
      const decl = program.declOf(file, at)
      if (!decl) return
      const citation = { file: file.path, line: line(at) }
      facts.push({ node: decl.ref, kind, value, citation, source, ...(data ? { data } : {}) })
    }
    // Variables of the module: state that outlives a request.
    const isModuleVar = (node: Node | undefined): boolean => {
      if (node?.type !== 'identifier') return false
      const binding: Binding | undefined = program.lookup(node.text, node, file)
      if (binding?.kind !== 'value') return false
      let top: Node | null = binding.node.parent
      while (top && top.type !== 'program' && top.type !== 'statement_block') top = top.parent
      return top?.type === 'program' && binding.node.type === 'variable_declarator'
    }

    // Calls: sinks, data access, callbacks, request mutations, module state.
    for (const call of present(
      file.tree.rootNode.descendantsOfType(['call_expression', 'new_expression']),
    )) {
      const fn = call.childForFieldName(call.type === 'new_expression' ? 'constructor' : 'function')
      if (
        !fn ||
        (fn.type !== 'identifier' && fn.type !== 'member_expression') ||
        !program.declOf(file, call)
      )
        continue
      const args = argumentsOf(call)
      const targets = program.callees(fn, file) ?? []
      for (const target of targets) {
        const sink = sinks.get(target.ref)
        if (sink) {
          // A template tag interprets its substitutions.
          const interpreted =
            call.childForFieldName('arguments')?.type === 'template_string'
              ? present(call.childForFieldName('arguments')?.namedChildren ?? []).filter(
                  (n) => n.type === 'template_substitution',
                )
              : sink.argument === '*'
                ? args
                : [args[sink.argument]]
          if (interpreted.some((a) => a && !literal(a)))
            add(call, 'sink', sink.kind, { callee: target.ref })
        }
        if (library.writes.has(target.ref))
          add(call, 'signal', 'data-write', { callee: target.ref })
        if (library.reads.has(target.ref)) add(call, 'signal', 'data-read', { callee: target.ref })
      }
      // A function the caller supplied (a parameter, or one of its properties) given the request.
      const root = fn.type === 'member_expression' ? rootOf(fn) : fn
      const binding =
        root?.type === 'identifier' ? program.lookup(root.text, root, file) : undefined
      if (
        binding?.kind === 'param' &&
        targets.length === 0 &&
        args.some((a) => isRequest(a, file))
      ) {
        add(call, 'signal', 'callback-passed', { callee: fn.text })
      }
      // Request state changed for what reads it later: `c.set(…)`, `headers.set(…)`.
      if (fn.type === 'member_expression') {
        for (
          let start: Node | null = fn;
          start;
          start = start.type === 'member_expression' ? start.childForFieldName('object') : null
        ) {
          const object =
            start.type === 'member_expression' ? start.childForFieldName('object') : null
          if (!object) break
          const symbol = typeSymbol(program.typeOf(object, file))
          if (!symbol) continue
          const observed = chainFrom(object)
          const hit = mutations.find(
            (m) =>
              m.on === symbol &&
              fits(m.items, observed) &&
              observed[m.items.length - 1]?.node.id === call.id,
          )
          if (hit) {
            add(call, 'signal', 'retained-mutation', { target: fn.text })
            break
          }
        }
      }
      // Module state changed by a call: `cache.set(k, v)`, `connections.push(c)`.
      const property =
        fn.type === 'member_expression' ? keyName(fn.childForFieldName('property')) : undefined
      if (property && mutating.test(property)) {
        const owner = rootOf(fn.childForFieldName('object') as Node)
        if (isModuleVar(owner)) add(call, 'signal', 'live-state', { variable: owner?.text })
      }
    }

    // Assignments: to module state, and to the request.
    for (const assignment of present(
      file.tree.rootNode.descendantsOfType([
        'assignment_expression',
        'augmented_assignment_expression',
        'update_expression',
      ]),
    )) {
      if (!program.declOf(file, assignment)) continue
      const target =
        assignment.type === 'update_expression'
          ? assignment.childForFieldName('argument')
          : assignment.childForFieldName('left')
      if (!target) continue
      const root = rootOf(target)
      if (isModuleVar(root) && root && !lazilySet(assignment, root.text)) {
        add(assignment, 'signal', 'live-state', { variable: root.text })
      }
      if (root && target.id !== root.id && isRequest(root, file)) {
        add(assignment, 'signal', 'retained-mutation', { target: target.text })
      }
    }

    // A value read from the request that selects a record, and a decoded body that is stored.
    for (const decl of file.decls) {
      const body = decl.node.childForFieldName('body')
      if (!body) continue
      const own = (n: Node) => program.declOf(file, n)?.ref === decl.ref
      const fromRequest = new Set<string>()
      const bodies = new Set<string>()
      for (const declarator of present(body.descendantsOfType('variable_declarator'))) {
        if (!own(declarator)) continue
        const at = `${decl.ref}\0${line(declarator)}`
        const value = declarator.childForFieldName('value')
        const valueAt = value ? `${decl.ref}\0${line(value)}` : at
        const names = patternNames(declarator.childForFieldName('name') as Node).map(
          (n) => n.name.text,
        )
        if (readLines.has(at) || readLines.has(valueAt)) for (const n of names) fromRequest.add(n)
        if (bodyLines.has(at) || bodyLines.has(valueAt)) for (const n of names) bodies.add(n)
        // `JSON.parse(text)` decodes too.
        const decoded =
          value?.type === 'call_expression' &&
          (program.callees(value.childForFieldName('function') as Node, file) ?? []).some((t) =>
            library.decoders.has(t.ref),
          )
        if (decoded) for (const n of names) bodies.add(n)
      }
      if (fromRequest.size === 0 && bodies.size === 0) continue
      for (const call of present(body.descendantsOfType('call_expression'))) {
        if (!own(call)) continue
        const fn = call.childForFieldName('function')
        const refs =
          fn && (fn.type === 'identifier' || fn.type === 'member_expression')
            ? (program.callees(fn, file) ?? []).map((t) => t.ref)
            : []
        const writes = refs.some((r) => library.writes.has(r))
        const access = writes || refs.some((r) => library.reads.has(r))
        if (!access) continue
        // The arguments of the whole chain of a query builder: `db.update(t).set(body).where(…)`.
        const used = new Set<string>()
        for (let n: Node | null = call; n; ) {
          for (const a of argumentsOf(n)) for (const u of uses(a)) used.add(u)
          const parent: Node | null = n.parent
          const grand: Node | null = parent?.parent ?? null
          n =
            parent?.type === 'member_expression' &&
            grand?.type === 'call_expression' &&
            grand.childForFieldName('function')?.id === parent.id
              ? grand
              : outermost(n).parent?.type === 'member_expression' &&
                  outermost(n).parent?.parent?.type === 'call_expression'
                ? (outermost(n).parent?.parent ?? null)
                : null
        }
        const key = [...fromRequest].find((name) => used.has(name))
        if (key) add(call, 'signal', 'request-key', { variable: key })
        const stored = [...bodies].find((name) => used.has(name))
        if (writes && stored) add(call, 'signal', 'mass-assignment', { variable: stored })
      }
    }

    // A middleware that can answer without calling the next handler: a function that passes the
    // request on, calling a function it was given after the request or the context (`next()`), and
    // that returns or throws, inside a
    // condition, from a block that does not.
    const refusals = new Set(profile.refusals.map((r) => `ext:${r}`))
    // The request, the context, or a name destructured from either: `({ cookies }) => …`.
    const ofRequest = (node: Node | undefined, f: TsFile) =>
      isRequest(node, f) ||
      (!!node &&
        (program.destructuredFrom(node, f)?.symbols ?? []).some((s) => requestTypes.has(s)))
    for (const decl of file.decls) {
      shortCircuit(program, file, decl, add, isRequest, ofRequest, refusals)
    }
    // A check: a function that refuses the request when a value read from it is missing.
    for (const decl of file.decls) refusesWithout(program, file, decl, profile, readsOf, add)
  }
  return facts
}

// A function given the request that answers it on its own, without a next handler to skip: in a
// condition, it calls one of the profile's refusals, which end the request with an error or a
// redirect (`if (!user) redirect(303, '/login')` in a layout's `load`). Returns that call.
function refuses(
  program: TsProgram,
  file: TsFile,
  decl: Decl,
  body: Node,
  isRequest: (node: Node | undefined, file: TsFile) => boolean,
  refusals: Set<string>,
): Node | undefined {
  if (refusals.size === 0) return undefined
  const [first] = parametersOf(decl.node)
  if (!first) return undefined
  const names =
    first.pattern.type === 'object_pattern'
      ? patternNames(first.pattern).map((n) => n.name)
      : [first.pattern]
  if (!names.some((n) => isRequest(n, file))) return undefined
  const own = (n: Node) => program.declOf(file, n)?.ref === decl.ref
  for (const call of present(body.descendantsOfType('call_expression'))) {
    if (!own(call)) continue
    const fn = call.childForFieldName('function')
    if (!fn || !(program.callees(fn, file) ?? []).some((t) => refusals.has(t.ref))) continue
    for (let n = call.parent; n && n.id !== body.id; n = n.parent)
      if (n.type === 'if_statement' || n.type === 'switch_case' || n.type === 'catch_clause')
        return call
  }
  return undefined
}

// `if (!locals.user) error(401)`: a condition on a value read from the request, the value itself
// or a name that holds it, then a refusal the profile names, makes the function a guard of the
// kind its check rule gives.
function refusesWithout(
  program: TsProgram,
  file: TsFile,
  decl: Decl,
  profile: ResolvedProfile,
  readsOf: Map<string, Fact[]>,
  add: (at: Node, kind: Fact['kind'], value: string, data?: Record<string, unknown>) => void,
) {
  const checks = profile.guards.filter((g) => 'check' in g)
  if (checks.length === 0) return
  const body = decl.node.childForFieldName('body')
  if (!body) return
  const refusals = new Set(profile.refusals.map((r) => `ext:${r}`))
  const reads = readsOf.get(decl.ref) ?? []
  const own = (n: Node) => program.declOf(file, n)?.ref === decl.ref
  const readAt = (from: number, to: number) =>
    reads.filter((r) => r.citation.line >= from && r.citation.line <= to).map((r) => r.value)
  const found = new Set<string>()
  for (const branch of present(body.descendantsOfType('if_statement'))) {
    if (!own(branch)) continue
    const condition = branch.childForFieldName('condition')
    const consequence = branch.childForFieldName('consequence')
    if (!condition || !consequence) continue
    // What the condition finds missing: `!locals.user`, `locals.user == null`, each with the name
    // it tests, the read's own last name or a name that holds it.
    const missing = (name: string) =>
      new RegExp(
        `!\\s*\\(?\\s*[\\w$.?\\]\\['"]*\\b${name.replace(/[$]/g, '\\$')}\\b(?!\\s*[.(\\[])|\\b${name.replace(/[$]/g, '\\$')}\\s*===?\\s*(null|undefined)\\b`,
      ).test(condition.text)
    const values = readAt(line(condition), condition.endPosition.row + 1).filter((v) =>
      missing(v.split('.').at(-1) ?? v),
    )
    // A name the condition tests that holds a read: `const user = locals.user; if (!user) …`.
    for (const name of present(condition.descendantsOfType('identifier'))) {
      const binding = program.lookup(name.text, name, file)
      if (
        binding?.kind === 'value' &&
        binding.node.type === 'variable_declarator' &&
        missing(name.text)
      )
        values.push(...readAt(line(binding.node), binding.node.endPosition.row + 1))
    }
    const refuses = present(
      consequence.type === 'call_expression'
        ? [consequence, ...consequence.descendantsOfType('call_expression')]
        : consequence.descendantsOfType('call_expression'),
    ).some((call) => {
      const fn = call.childForFieldName('function')
      return !!fn && own(call) && (program.callees(fn, file) ?? []).some((t) => refusals.has(t.ref))
    })
    if (!refuses) continue
    for (const rule of checks) {
      if (!('check' in rule) || found.has(rule.check)) continue
      if (!values.some((v) => v === rule.check || v.startsWith(`${rule.check}.`))) continue
      found.add(rule.check)
      add(branch, 'guard', rule.kind, { check: rule.check })
    }
  }
}

function shortCircuit(
  program: TsProgram,
  file: TsFile,
  decl: Decl,
  add: (at: Node, kind: Fact['kind'], value: string) => void,
  isRequest: (node: Node | undefined, file: TsFile) => boolean,
  ofRequest: (node: Node | undefined, file: TsFile) => boolean,
  refusals: Set<string>,
) {
  const body = decl.node.childForFieldName('body')
  if (body?.type !== 'statement_block') return
  const refusal = refuses(program, file, decl, body, ofRequest, refusals)
  if (refusal) {
    add(refusal, 'signal', 'short-circuit')
    return
  }
  // A middleware: its first parameter is the request or the context, as stated or as the profile
  // gives it. Any other function that calls a function it was given is not one.
  // Or its first parameter is destructured, the request or the context among its names, and the
  // others are what it was given: `({ event, resolve }) => …`.
  const [first, ...others] = parametersOf(decl.node)
  if (!first) return
  const given = others.map((p) => (p.pattern.type === 'identifier' ? p.pattern.text : undefined))
  if (first.pattern.type === 'object_pattern') {
    const names = patternNames(first.pattern).map((n) => n.name)
    if (!names.some((n) => isRequest(n, file))) return
    given.push(...names.filter((n) => !isRequest(n, file)).map((n) => n.text))
  } else if (first.pattern.type !== 'identifier' || !isRequest(first.pattern, file)) return
  const params = given
  if (params.length === 0) return
  const own = (n: Node) => program.declOf(file, n)?.ref === decl.ref
  const forwards = (node: Node) =>
    present(
      node.type === 'call_expression'
        ? [node, ...node.descendantsOfType('call_expression')]
        : node.descendantsOfType('call_expression'),
    ).some((call) => {
      const fn = call.childForFieldName('function')
      return fn?.type === 'identifier' && params.includes(fn.text) && own(call)
    })
  const calls = present(body.descendantsOfType('call_expression')).filter(own)
  if (!calls.some((c) => forwards(c))) return
  for (const stop of present(body.descendantsOfType(['return_statement', 'throw_statement']))) {
    if (!own(stop) || forwards(stop)) continue
    let conditional = false
    for (let n = stop.parent; n && n.id !== body.id; n = n.parent) {
      if (n.type === 'if_statement' || n.type === 'switch_case') conditional = true
    }
    const before = present(stop.parent?.namedChildren ?? []).filter(
      (s) => s.endIndex <= stop.startIndex,
    )
    const passed = before.some((s) => forwards(s))
    if (conditional && !passed) {
      add(stop, 'signal', 'short-circuit')
      return
    }
  }
}
