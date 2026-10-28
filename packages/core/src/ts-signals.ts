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
}

// `req.param(name)` is the field `req`, the field `param`, and a call whose argument names what is
// read.
function parseChain(chain: string): ChainItem[] {
  return chain.split('.').flatMap((part) => {
    const match = /^([A-Za-z_$][\w$]*)(\((name)?\))?$/.exec(part)
    if (!match?.[1]) return []
    const items: ChainItem[] = [{ field: match[1] }]
    if (match[2]) items.push({ call: { name: match[3] === 'name' } })
    return items
  })
}

interface Observed {
  field?: string
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
    return item.field !== undefined ? seen?.field === item.field : seen?.args !== undefined
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
    if (names.length === 0)
      facts.push({ node: decl.ref, kind: 'read', value: read, citation, source })
    for (const n of new Set(names))
      facts.push({ node: decl.ref, kind: 'read', value: `${read}.${n}`, citation, source })
  }

  for (const file of program.files) {
    for (const start of present(
      file.tree.rootNode.descendantsOfType(['identifier', 'this', 'member_expression']),
    )) {
      const parent = start.parent
      if (
        parent?.type !== 'member_expression' ||
        parent.childForFieldName('object')?.id !== start.id
      )
        continue
      for (const symbol of program.typeSymbols(start, file)) {
        if (!ons.has(symbol)) continue
        const observed = chainFrom(start)
        // A value destructured from the chain reads what each of its properties would:
        // `const { method, url } = c.req`.
        const end = observed.at(-1)?.node ?? start
        const pattern = declaredWith(end)
        if (pattern?.type === 'object_pattern') {
          for (const { name, path } of patternNames(pattern)) {
            const extended = [...observed, ...path.map((field) => ({ field, node: name }))]
            const hit = chains.find(
              ({ items, on }) =>
                on === symbol && items.length === extended.length && fits(items, extended),
            )
            if (hit) add(file, name, hit.rule.read, undefined)
          }
        }
        for (const { rule, items, on } of chains) {
          if (on !== symbol || !fits(items, observed)) continue
          // `c.req.raw.headers = h` writes the request; it reads nothing.
          const outer = observed[items.length - 1]?.node
          if (outer && assignedTo(outer)) break
          const named = items.findIndex((item) => item.call?.name)
          const at = outer ?? start
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
    for (const decl of file.decls) {
      shortCircuit(program, file, decl, add, isRequest)
    }
  }
  return facts
}

function shortCircuit(
  program: TsProgram,
  file: TsFile,
  decl: Decl,
  add: (at: Node, kind: Fact['kind'], value: string) => void,
  isRequest: (node: Node | undefined, file: TsFile) => boolean,
) {
  const body = decl.node.childForFieldName('body')
  if (body?.type !== 'statement_block') return
  // A middleware: its first parameter is the request or the context, as stated or as the profile
  // gives it. Any other function that calls a function it was given is not one.
  const [first] = parametersOf(decl.node)
  if (first?.pattern.type !== 'identifier' || !isRequest(first.pattern, file)) return
  const params = parametersOf(decl.node)
    .slice(1)
    .map((p) => (p.pattern.type === 'identifier' ? p.pattern.text : undefined))
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
