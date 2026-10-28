import type { Node } from 'web-tree-sitter'
import { declaredAt, type GoProgram, line, type ParsedFile, present } from './go.ts'
import type { Fact } from './graph.ts'
import type { Library } from './library.ts'
import type { ResolvedProfile } from './profile.ts'

// Facts on declarations, computed by rules from the syntax (D6): the sinks a declaration calls,
// the persisted data it reads and writes, and what it does with the request and with state that
// outlives it. Entry points get their signals from what they reach (`go-index.ts`).

const literal = (node: Node | undefined) =>
  node?.type === 'interpreted_string_literal' || node?.type === 'raw_string_literal'

const mutating =
  /^(Store|LoadOrStore|LoadAndDelete|CompareAndSwap|Swap|Set|Add|Delete|Put|Inc|Dec|Append|Push|Insert|Remove|Reset|Clear)$/

// `if cfg == nil { cfg = load() }`, or `if cfg != nil { return cfg }` before it, sets a singleton
// once, which every request then only reads.
function lazilySet(assignment: Node, name: string): boolean {
  const unset = new RegExp(`\\b${name}\\s*==\\s*nil\\b`)
  const set = new RegExp(`\\b${name}\\s*!=\\s*nil\\b`)
  const condition = (n: Node) => n.childForFieldName('condition')?.text ?? ''
  for (let n = assignment.parent; n; n = n.parent) {
    if (n.type === 'if_statement' && unset.test(condition(n))) return true
  }
  const before = present(assignment.parent?.namedChildren ?? []).filter(
    (s) => s.endIndex <= assignment.startIndex,
  )
  return before.some(
    (s) =>
      s.type === 'if_statement' &&
      set.test(condition(s)) &&
      present(s.childForFieldName('consequence')?.descendantsOfType('return_statement') ?? [])
        .length > 0,
  )
}

const argumentsOf = (call: Node) =>
  present(call.childForFieldName('arguments')?.namedChildren ?? [])

// The identifiers an expression uses, by name.
function uses(node: Node): Set<string> {
  return new Set(present(node.descendantsOfType('identifier')).map((n) => n.text))
}

// The variable at the root of `a.b[c].d`, the target of an assignment or a call.
function rootOf(node: Node): Node | undefined {
  let current: Node | null = node
  while (current) {
    if (current.type === 'identifier') return current
    if (current.type === 'selector_expression' || current.type === 'call_expression') {
      current = current.childForFieldName(
        current.type === 'selector_expression' ? 'operand' : 'function',
      )
    } else if (current.type === 'index_expression') current = current.childForFieldName('operand')
    else if (current.type === 'parenthesized_expression' || current.type === 'unary_expression') {
      current = current.childForFieldName('operand') ?? current.namedChildren[0] ?? null
    } else return undefined
  }
  return undefined
}

export function declFacts(
  program: GoProgram,
  profile: ResolvedProfile,
  library: Library,
  reads: Fact[],
): Fact[] {
  const facts: Fact[] = []
  const source = `tree-sitter:${profile.name}`
  const [requestPath, requestType] = (profile.request ?? '').split('#')
  const isRequest = (node: Node, file: ParsedFile) => {
    if (node.type !== 'identifier' || !declaredAt(node.text, node)) return false
    const type = program.typeOf(node, file)
    return (
      !!type && 'importPath' in type && type.importPath === requestPath && type.name === requestType
    )
  }
  const readLines = new Set(reads.map((r) => `${r.node}\0${r.citation.line}`))

  for (const file of program.files) {
    const add = (at: Node, kind: Fact['kind'], value: string, data?: Record<string, unknown>) => {
      const decl = program.declOf(file, at)
      if (!decl) return
      const citation = { file: file.path, line: line(at) }
      facts.push({ node: decl.ref, kind, value, citation, source, ...(data ? { data } : {}) })
    }

    // Variables of the package: state that outlives a request.
    const packageVars = new Set<string>()
    for (const other of program.filesIn(file.dir)) {
      for (const decl of present(other.tree.rootNode.namedChildren)) {
        if (decl.type !== 'var_declaration') continue
        for (const spec of present(decl.descendantsOfType('var_spec'))) {
          for (const name of spec.childrenForFieldName('name')) packageVars.add(name.text)
        }
      }
    }
    const isPackageVar = (node: Node | undefined) =>
      !!node &&
      node.type === 'identifier' &&
      packageVars.has(node.text) &&
      !declaredAt(node.text, node)

    // Calls: sinks, data access, decoders, callbacks, request mutations, package state.
    const decoded = new Map<string, string[]>()
    for (const call of present(file.tree.rootNode.descendantsOfType('call_expression'))) {
      const fn = call.childForFieldName('function')
      if (!fn || fn.type === 'func_literal' || !program.declOf(file, call)) continue
      const args = argumentsOf(call)
      const refs = (program.targets(fn, file) ?? []).map((t) => t.ref)
      for (const ref of refs) {
        const sink = library.sinks.get(ref)
        if (sink) {
          const interpreted = sink.argument === '*' ? args : [args[sink.argument]]
          if (interpreted.some((a) => a && !literal(a)))
            add(call, 'sink', sink.kind, { callee: ref })
        }
        if (library.writes.has(ref)) add(call, 'signal', 'data-write', { callee: ref })
        if (library.reads.has(ref)) add(call, 'signal', 'data-read', { callee: ref })
        if (library.decoders.has(ref)) {
          const into = rootOf(args.at(-1) ?? call)
          const decl = program.declOf(file, call)
          if (into && decl) decoded.set(decl.ref, [...(decoded.get(decl.ref) ?? []), into.text])
        }
      }
      // A function the caller supplied (a parameter, or a field holding one) given the request.
      const declared = fn.type === 'identifier' ? declaredAt(fn.text, fn) : undefined
      const suppliedType =
        declared && 'type' in declared ? declared.type : program.fieldType(fn, file)
      if (suppliedType?.startsWith('func') && args.some((a) => isRequest(a, file))) {
        add(call, 'signal', 'callback-passed', { callee: fn.text })
      }
      // `r.Header.Set(…)` and the like change the request that later code reads.
      if (
        fn.type === 'selector_expression' &&
        /^(Set|Add|Del)$/.test(fn.childForFieldName('field')?.text ?? '')
      ) {
        const owner = fn.childForFieldName('operand')
        const root = owner ? rootOf(owner) : undefined
        if (root && owner?.text.endsWith('.Header') && isRequest(root, file)) {
          add(call, 'signal', 'retained-mutation', { target: owner.text })
        }
      }
      // Package state changed by a call: `delete(cache, k)`, or a method that writes, such as
      // `sessions.Store(…)`.
      const changed =
        fn.type === 'identifier' && fn.text === 'delete'
          ? args[0]
          : fn.type === 'selector_expression' &&
              mutating.test(fn.childForFieldName('field')?.text ?? '')
            ? fn.childForFieldName('operand')
            : undefined
      const root = changed ? rootOf(changed) : undefined
      if (isPackageVar(root)) add(call, 'signal', 'live-state', { variable: root?.text })
    }

    // Assignments: to package state, and to the request.
    for (const assignment of present(
      file.tree.rootNode.descendantsOfType([
        'assignment_statement',
        'inc_statement',
        'dec_statement',
      ]),
    )) {
      const left =
        assignment.type === 'assignment_statement'
          ? present(assignment.childForFieldName('left')?.namedChildren ?? [])
          : present(assignment.namedChildren.slice(0, 1))
      for (const target of left) {
        const root = rootOf(target)
        if (isPackageVar(root) && root && !lazilySet(assignment, root.text)) {
          add(assignment, 'signal', 'live-state', { variable: root.text })
        }
        if (root && target.id !== root.id && isRequest(root, file)) {
          add(assignment, 'signal', 'retained-mutation', { target: target.text })
        }
      }
    }

    // A value read from the request that selects a record, and a decoded body that is stored.
    for (const decl of file.decls) {
      const body = decl.node.childForFieldName('body')
      if (!body) continue
      const fromRequest = new Set<string>()
      for (const assign of present(body.descendantsOfType('short_var_declaration'))) {
        if (!readLines.has(`${decl.ref}\0${line(assign)}`)) continue
        for (const name of present(assign.childForFieldName('left')?.namedChildren ?? []))
          fromRequest.add(name.text)
      }
      const bodies = new Set(decoded.get(decl.ref) ?? [])
      for (const call of present(body.descendantsOfType('call_expression'))) {
        if (program.declOf(file, call)?.ref !== decl.ref) continue
        const fn = call.childForFieldName('function')
        const refs =
          fn && fn.type !== 'func_literal'
            ? (program.targets(fn, file) ?? []).map((t) => t.ref)
            : []
        const writes = refs.some((r) => library.writes.has(r))
        const access = writes || refs.some((r) => library.reads.has(r))
        if (!access) continue
        const used = new Set(argumentsOf(call).flatMap((a) => [...uses(a)]))
        const key = [...fromRequest].find((name) => used.has(name))
        if (key) add(call, 'signal', 'request-key', { variable: key })
        const stored = [...bodies].find((name) => used.has(name))
        if (writes && stored) add(call, 'signal', 'mass-assignment', { variable: stored })
      }
    }

    // A middleware that can answer without calling the next handler: a function that passes the
    // request on (`next.ServeHTTP(w, r)`, or `next(w, r)` for a handler function it was given),
    // and returns, inside a condition, from a block that does not.
    for (const decl of file.decls) {
      const body = decl.node.childForFieldName('body')
      if (!body) continue
      const own = (n: Node) => program.declOf(file, n)?.ref === decl.ref
      const forwards = (call: Node) => {
        const fn = call.childForFieldName('function')
        if (fn?.childForFieldName('field')?.text === 'ServeHTTP') return true
        const declared = fn?.type === 'identifier' ? declaredAt(fn.text, fn) : undefined
        const type = declared && 'type' in declared ? declared.type : ''
        return /^(http\.HandlerFunc|func\s*\(\s*\w*\s*http\.ResponseWriter)/.test(type)
      }
      const calls = present(body.descendantsOfType('call_expression')).filter(own)
      if (!calls.some(forwards)) continue
      for (const ret of present(body.descendantsOfType('return_statement'))) {
        if (!own(ret)) continue
        let conditional = false
        for (let n = ret.parent; n && n.id !== body.id; n = n.parent) {
          if (n.type === 'if_statement') conditional = true
        }
        const before = present(ret.parent?.namedChildren ?? []).filter(
          (s) => s.endIndex <= ret.startIndex,
        )
        const passed = before.some((s) => {
          const call = s.type === 'expression_statement' ? s.namedChildren[0] : undefined
          return call?.type === 'call_expression' && forwards(call)
        })
        if (conditional && !passed) {
          add(ret, 'signal', 'short-circuit')
          break
        }
      }
    }
  }
  return facts
}
