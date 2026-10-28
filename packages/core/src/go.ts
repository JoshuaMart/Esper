import { posix } from 'node:path'
import type { Node, Tree } from 'web-tree-sitter'
import type { Graph, GraphEdge, GraphNode } from './graph.ts'
import { loadQuery, parse } from './parser.ts'
import { declRef, externalRef, fingerprint, hashText, Names } from './refs.ts'

// The Go call graph: declarations, imports and calls, resolved within the module where Go's
// syntax allows it, guessed with a reason where it does not (D6).

export interface GoFile {
  path: string
  source: string
}

export interface CallStats {
  calls: number
  resolved: number
  guessed: number
  unresolved: number
}

const builtins = new Set([
  'append',
  'cap',
  'clear',
  'close',
  'complex',
  'copy',
  'delete',
  'imag',
  'len',
  'make',
  'max',
  'min',
  'new',
  'panic',
  'print',
  'println',
  'real',
  'recover',
])

const source = 'tree-sitter'
const isComment = (node: Node) => node.type === 'comment'
const line = (node: Node) => node.startPosition.row + 1

interface Decl {
  ref: string
  name: string
  file: string
  node: Node
  // For a method, the name of its receiver's type.
  receiver?: string
}

const byRef = (a: Decl, b: Decl) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)

interface Import {
  path: string
  // Only when the source names one: `import chi "…"`, `import . "…"`.
  alias?: string
  node: Node
}

interface ParsedFile {
  path: string
  dir: string
  hash: string
  tree: Tree
  packageName: string
  imports: Import[]
  decls: Decl[]
  // Each declaration by the id of its syntax node, to find the one that encloses a node.
  declsById: Map<number, Decl>
  structs: Map<string, Map<string, string>>
}

// The module path that `go.mod` declares, so that an import can be told internal or external.
export function modulePath(goMod: string): string | undefined {
  return /^module\s+(\S+)/m.exec(goMod)?.[1]
}

// The name a package outside the module is imported under by default: the last path element
// that is not a major version (`github.com/go-chi/chi/v5` is `chi`, `gopkg.in/yaml.v3` is
// `yaml`). A package of the module is imported under the name its `package` clause declares.
export function defaultPackageName(importPath: string): string {
  const parts = importPath.split('/')
  let last = parts.at(-1) ?? importPath
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts.at(-2) ?? last
  return last
    .replace(/\.v\d+$/, '')
    .replace(/^go-/, '')
    .replaceAll('-', '_')
}

const names = (node: Node | null | undefined) =>
  node?.childrenForFieldName('name').map((n) => n.text) ?? []

function receiverOf(receiver: Node): string | undefined {
  const param = receiver.namedChildren.find((child) => child?.type === 'parameter_declaration')
  const type = param?.childForFieldName('type')?.text ?? ''
  return /([A-Za-z_]\w*)\s*(?:\[.*\])?\s*$/.exec(type)?.[1]
}

// The innermost declaration that encloses `node`, not counting `node` itself.
function enclosing(file: ParsedFile, node: Node): Decl | undefined {
  for (let n = node.parent; n; n = n.parent) {
    const decl = file.declsById.get(n.id)
    if (decl) return decl
  }
  return undefined
}

// A Go type as written, reduced to the named type it refers to: `*store.DB` is `store`, `DB`;
// slices, maps, channels, functions and interfaces name no type whose methods can be looked up.
function namedType(text: string): { qualifier?: string; name: string } | undefined {
  const match = /^[*&]*\s*(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)\s*(?:\[.*\])?$/s.exec(text.trim())
  if (!match?.[2]) return undefined
  return match[1] ? { qualifier: match[1], name: match[2] } : { name: match[2] }
}

// What the syntax states about a variable: its type, the value it was assigned (the `index`-th
// result when several names take the results of one call), or only that it is declared.
type Declared = { type: string } | { value: Node; index: number } | { untyped: true }

function fromValues(declared: string[], index: number, values: Node[]): Declared {
  if (values.length === declared.length && values[index]) return { value: values[index], index: 0 }
  if (values.length === 1 && values[0]) return { value: values[0], index }
  return { untyped: true }
}

const present = (nodes: (Node | null)[]) => nodes.filter((n): n is Node => n !== null)

// Whether `statement` declares `name`, and what it states about it.
function declares(statement: Node, name: string): Declared | undefined {
  switch (statement.type) {
    case 'parameter_list':
      for (const param of present(statement.namedChildren)) {
        if (!names(param).includes(name)) continue
        const type = param.childForFieldName('type')?.text
        return type ? { type } : { untyped: true }
      }
      return undefined
    case 'short_var_declaration': {
      const left = present(statement.childForFieldName('left')?.namedChildren ?? []).map(
        (n) => n.text,
      )
      const index = left.indexOf(name)
      if (index < 0) return undefined
      const right = present(statement.childForFieldName('right')?.namedChildren ?? [])
      return fromValues(left, index, right)
    }
    case 'var_declaration':
      for (const spec of present(statement.descendantsOfType('var_spec'))) {
        const declared = names(spec)
        const index = declared.indexOf(name)
        if (index < 0) continue
        const type = spec.childForFieldName('type')?.text
        if (type) return { type }
        return fromValues(
          declared,
          index,
          present(spec.childForFieldName('value')?.namedChildren ?? []),
        )
      }
      return undefined
    case 'range_clause':
    case 'type_switch_statement': {
      const field = statement.type === 'range_clause' ? 'left' : 'alias'
      const declared = present(statement.childForFieldName(field)?.namedChildren ?? [])
      return declared.some((n) => n.text === name) ? { untyped: true } : undefined
    }
    case 'for_clause': {
      const initializer = statement.childForFieldName('initializer')
      return initializer ? declares(initializer, name) : undefined
    }
    default:
      return undefined
  }
}

const withInitializer = new Set([
  'if_statement',
  'for_statement',
  'expression_switch_statement',
  'type_switch_statement',
])
const functionLike = new Set(['function_declaration', 'method_declaration', 'func_literal'])

// What the syntax states about the variable `name` where `at` reads it, following Go's scopes
// outward: the statements before it in each block, the initializers of `if`, `for` and
// `switch`, then the parameters, results and receiver of each enclosing function. The nearest
// declaration wins, so a shadowing variable hides the outer one even when its type is unknown.
function declaredAt(name: string, at: Node): Declared | undefined {
  let child: Node = at
  for (let scope = at.parent; scope; child = scope, scope = scope.parent) {
    let candidates: Node[] = []
    if (scope.type === 'statement_list') {
      candidates = present(scope.namedChildren)
        .filter((s) => s.endIndex <= child.startIndex)
        .reverse()
    } else if (withInitializer.has(scope.type)) {
      const parts = [
        scope.childForFieldName('initializer'),
        ...scope.namedChildren.filter(
          (n) => n?.type === 'range_clause' || n?.type === 'for_clause',
        ),
        scope.type === 'type_switch_statement' ? scope : null,
      ]
      candidates = present(parts).filter((part) => part.id !== child.id)
    } else if (functionLike.has(scope.type)) {
      candidates = present(
        ['receiver', 'parameters', 'result'].map((f) => scope.childForFieldName(f)),
      )
    }
    for (const candidate of candidates) {
      const found = declares(candidate, name)
      if (found) return found
    }
  }
  return undefined
}

// The fields of each struct type of a file, by type name: `type Server struct { db *store.DB }`.
// Fields of a struct nested in a field's type belong to that type, not to the outer one.
function structFields(root: Node): Map<string, Map<string, string>> {
  const types = new Map<string, Map<string, string>>()
  for (const spec of present(root.descendantsOfType('type_spec'))) {
    const name = spec.childForFieldName('name')?.text
    const struct = spec.childForFieldName('type')
    if (!name || struct?.type !== 'struct_type') continue
    const fields = new Map<string, string>()
    const list = struct.namedChildren.find((n) => n?.type === 'field_declaration_list')
    for (const field of present(list?.namedChildren ?? [])) {
      const type =
        field.type === 'field_declaration' ? field.childForFieldName('type')?.text : undefined
      if (!type) continue
      for (const fieldName of names(field)) fields.set(fieldName, type)
    }
    types.set(name, fields)
  }
  return types
}

async function parseFile(file: GoFile): Promise<ParsedFile> {
  const tree = await parse('go', file.source)
  const root = tree.rootNode
  const [pkg, imports, declarations] = await Promise.all([
    loadQuery('go', 'package'),
    loadQuery('go', 'imports'),
    loadQuery('go', 'declarations'),
  ])

  const fileImports: Import[] = imports.matches(root).flatMap((match) => {
    const path = match.captures.find((c) => c.name === 'path')?.node
    const spec = match.captures.find((c) => c.name === 'import')?.node
    if (!path || !spec) return []
    const alias = match.captures.find((c) => c.name === 'alias')?.node.text
    return [{ path: path.text.slice(1, -1), node: spec, ...(alias ? { alias } : {}) }]
  })

  const parsed: ParsedFile = {
    path: file.path,
    dir: posix.dirname(file.path),
    hash: hashText(file.source),
    tree,
    packageName: pkg.captures(root)[0]?.node.text ?? 'main',
    imports: fileImports,
    decls: [],
    declsById: new Map(),
    structs: structFields(root),
  }
  const add = (decl: Decl) => {
    parsed.decls.push(decl)
    parsed.declsById.set(decl.node.id, decl)
  }

  // Named declarations first, in source order, then literals, which are named after them.
  const taken = new Names()
  const literals: Node[] = []
  for (const match of declarations.matches(root)) {
    const capture = match.captures.find((c) => ['function', 'method', 'literal'].includes(c.name))
    if (!capture) continue
    if (capture.name === 'literal') {
      literals.push(capture.node)
      continue
    }
    let name = match.captures.find((c) => c.name === 'name')?.node.text ?? '_'
    const receiver = match.captures.find((c) => c.name === 'receiver')?.node
    const type = capture.name === 'method' && receiver ? receiverOf(receiver) : undefined
    if (type) name = `${type}.${name}`
    add({
      ref: declRef(file.path, taken.take(name)),
      name,
      file: file.path,
      node: capture.node,
      ...(type ? { receiver: type } : {}),
    })
  }

  // A literal is named by its parent and its rank (`#Routes/fn1`), or by the variable that holds
  // it at the top of the file (`var handler = func…` is `#handler`). Literals are named in
  // source order, so that a literal's parent literal is named before it.
  literals.sort((a, b) => a.startIndex - b.startIndex)
  const ranks = new Map<string, number>()
  for (const literal of literals) {
    const parent = enclosing(parsed, literal)
    const key = parent?.ref ?? ''
    const rank = (ranks.get(key) ?? 0) + 1
    ranks.set(key, rank)
    let name = `fn${rank}`
    if (parent) name = `${parent.ref.slice(file.path.length + 1)}/fn${rank}`
    else if (literal.parent?.parent?.type === 'var_spec') {
      const index = literal.parent.namedChildren.findIndex((n) => n?.id === literal.id)
      name = names(literal.parent.parent)[index] ?? name
    }
    add({ ref: declRef(file.path, taken.take(name)), name, file: file.path, node: literal })
  }
  return parsed
}

// Groups declarations under a key, each group sorted by reference, so that what is looked up
// does not depend on the order the files were read in.
function group(entries: [string, Decl][]): Map<string, Decl[]> {
  const groups = new Map<string, Decl[]>()
  for (const [key, decl] of entries) groups.set(key, [...(groups.get(key) ?? []), decl])
  for (const list of groups.values()) list.sort(byRef)
  return groups
}

export async function extractGo(
  files: GoFile[],
  options: { module?: string } = {},
): Promise<{ graph: Graph; stats: CallStats }> {
  const parsed = (await Promise.all(files.map(parseFile))).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )
  const calls = await loadQuery('go', 'calls')
  const graph: Graph = { files: [], nodes: [], edges: [], facts: [], skips: [] }
  const stats: CallStats = { calls: 0, resolved: 0, guessed: 0, unresolved: 0 }
  const externals = new Map<string, GraphNode>()
  const external = (ref: string, name: string) => {
    if (!externals.has(ref)) externals.set(ref, { ref, kind: 'external', name })
    return ref
  }

  const internalDir = (importPath: string): string | undefined => {
    const module = options.module
    if (!module) return undefined
    if (importPath === module) return '.'
    return importPath.startsWith(`${module}/`) ? importPath.slice(module.length + 1) : undefined
  }

  // Lookups. Several declarations under one key are build variants (`sock_unix.go`,
  // `sock_windows.go`): a call to that name is not resolved to one of them.
  const all = parsed.flatMap((file) => file.decls.map((decl) => ({ file, decl })))
  const functions = group(
    all
      .filter(({ decl }) => decl.node.type === 'function_declaration')
      .map(({ file, decl }): [string, Decl] => [`${file.dir}\0${decl.name}`, decl]),
  )
  const methods = group(
    all
      .filter(({ decl }) => decl.receiver)
      .map(({ file, decl }): [string, Decl] => [`${file.dir}\0${decl.name}`, decl]),
  )
  const methodsByName = group(
    all
      .filter(({ decl }) => decl.receiver)
      .map(({ decl }): [string, Decl] => [decl.name.slice((decl.receiver?.length ?? 0) + 1), decl]),
  )
  const filesByDir = new Map<string, ParsedFile[]>()
  const fields = new Map<string, { type: string; file: ParsedFile }[]>()
  for (const file of parsed) {
    filesByDir.set(file.dir, [...(filesByDir.get(file.dir) ?? []), file])
    for (const [type, typeFields] of file.structs) {
      for (const [field, fieldType] of typeFields) {
        const key = `${file.dir}\0${type}\0${field}`
        fields.set(key, [...(fields.get(key) ?? []), { type: fieldType, file }])
      }
    }
  }
  // The names a file's imports are known by, and the import path behind each.
  const aliasesOf = new Map<string, Map<string, string>>()
  for (const file of parsed) {
    const aliases = new Map<string, string>()
    for (const imp of file.imports) {
      const dir = internalDir(imp.path)
      const declared = dir === undefined ? undefined : filesByDir.get(dir)?.[0]?.packageName
      const alias = imp.alias ?? declared ?? defaultPackageName(imp.path)
      if (alias !== '_' && alias !== '.') aliases.set(alias, imp.path)
    }
    aliasesOf.set(file.path, aliases)
  }
  // An identifier names an imported package only when no local declaration shadows it.
  const packageOf = (node: Node, file: ParsedFile): string | undefined => {
    if (node.type !== 'identifier') return undefined
    const importPath = aliasesOf.get(file.path)?.get(node.text)
    return importPath && !declaredAt(node.text, node) ? importPath : undefined
  }

  // A named type, located: in a package of the module by its directory, or outside by import path.
  type Located = { dir: string; name: string } | { importPath: string; name: string }
  type Outside = { outside: true }
  const outside: Outside = { outside: true }
  const parsedByPath = new Map(parsed.map((file) => [file.path, file]))
  const locate = (text: string, file: ParsedFile): Located | undefined => {
    const type = namedType(text)
    if (!type) return undefined
    if (!type.qualifier) return { dir: file.dir, name: type.name }
    const importPath = aliasesOf.get(file.path)?.get(type.qualifier)
    if (!importPath) return undefined
    const dir = internalDir(importPath)
    return dir === undefined ? { importPath, name: type.name } : { dir, name: type.name }
  }
  // One type when every candidate agrees on it, none otherwise.
  const agreed = (types: (Located | undefined)[]) => {
    const first = JSON.stringify(types[0])
    return types.length > 0 && types.every((t) => JSON.stringify(t) === first)
      ? types[0]
      : undefined
  }
  // The `index`-th type a function declares it returns, located from the function's own file.
  const resultOf = (decls: Decl[] | undefined, index: number): Located | undefined =>
    agreed(
      (decls ?? []).map((decl) => {
        const result = decl.node.childForFieldName('result')
        const file = parsedByPath.get(decl.file)
        if (!result || !file) return undefined
        const types =
          result.type === 'parameter_list'
            ? present(result.namedChildren).flatMap((param) => {
                const type = param.childForFieldName('type')?.text ?? ''
                return Array<string>(Math.max(1, names(param).length)).fill(type)
              })
            : [result.text]
        const text = types[index]
        return text ? locate(text, file) : undefined
      }),
    )
  // The type of an expression, from what the syntax states: a typed variable, a field of a struct
  // of the module, a composite literal, or the result of a call. A value that comes from a package
  // outside the module is `outside`: its methods are not the module's, even when its type is not
  // known.
  const typeOf = (
    node: Node,
    file: ParsedFile,
    index = 0,
    depth = 0,
  ): Located | Outside | undefined => {
    if (depth > 8) return undefined
    if (index > 0 && node.type !== 'call_expression') return undefined
    switch (node.type) {
      case 'identifier': {
        const declared = declaredAt(node.text, node)
        if (!declared || 'untyped' in declared) return undefined
        return 'type' in declared
          ? locate(declared.type, file)
          : typeOf(declared.value, file, declared.index, depth + 1)
      }
      case 'parenthesized_expression':
      case 'unary_expression': {
        const operator = node.childForFieldName('operator')?.text
        if (operator && operator !== '&') return undefined
        const inner = node.childForFieldName('operand') ?? node.namedChildren[0]
        return inner ? typeOf(inner, file, 0, depth + 1) : undefined
      }
      case 'composite_literal': {
        const type = node.childForFieldName('type')?.text
        return type ? locate(type, file) : undefined
      }
      case 'selector_expression': {
        const inner = node.childForFieldName('operand')
        const field = node.childForFieldName('field')?.text
        if (!inner || !field || packageOf(inner, file)) return undefined
        const owner = typeOf(inner, file, 0, depth + 1)
        if (!owner || !('dir' in owner)) return owner ? outside : undefined
        const declared = fields.get(`${owner.dir}\0${owner.name}\0${field}`) ?? []
        return agreed(declared.map((d) => locate(d.type, d.file)))
      }
      case 'call_expression': {
        const fn = node.childForFieldName('function')
        if (fn?.type === 'identifier') {
          return declaredAt(fn.text, fn)
            ? undefined
            : resultOf(functions.get(`${file.dir}\0${fn.text}`), index)
        }
        if (fn?.type !== 'selector_expression') return undefined
        const operand = fn.childForFieldName('operand')
        const name = fn.childForFieldName('field')?.text
        if (!operand || !name) return undefined
        const importPath = packageOf(operand, file)
        if (importPath) {
          const dir = internalDir(importPath)
          return dir === undefined ? outside : resultOf(functions.get(`${dir}\0${name}`), index)
        }
        const receiver = typeOf(operand, file, 0, depth + 1)
        if (!receiver || !('dir' in receiver)) return receiver ? outside : undefined
        return resultOf(methods.get(`${receiver.dir}\0${receiver.name}.${name}`), index)
      }
      default:
        return undefined
    }
  }

  const edge = (e: Omit<GraphEdge, 'source'>) => graph.edges.push({ ...e, source })

  for (const file of parsed) {
    graph.files.push({ path: file.path, hash: file.hash, language: 'go' })
    const root = file.tree.rootNode
    graph.nodes.push({
      ref: file.path,
      kind: 'file',
      name: posix.basename(file.path),
      file: file.path,
      startLine: 1,
      endLine: root.endPosition.row + 1,
      fingerprint: fingerprint(root, isComment),
      data: { package: file.packageName },
    })

    for (const imp of file.imports) {
      const citation = { file: file.path, line: line(imp.node) }
      const data = { path: imp.path }
      const dir = internalDir(imp.path)
      if (dir === undefined) {
        const to = external(externalRef(imp.path), imp.path)
        edge({ kind: 'imports', from: file.path, to, citation, data })
        continue
      }
      for (const target of filesByDir.get(dir) ?? []) {
        edge({ kind: 'imports', from: file.path, to: target.path, citation, data })
      }
    }

    for (const decl of file.decls) {
      const node: GraphNode = {
        ref: decl.ref,
        kind: 'decl',
        name: decl.name,
        file: file.path,
        startLine: line(decl.node),
        endLine: decl.node.endPosition.row + 1,
        fingerprint: fingerprint(decl.node, isComment),
      }
      if (decl.node.type === 'func_literal') node.data = { literal: true }
      graph.nodes.push(node)
      const citation = { file: file.path, line: line(decl.node) }
      edge({ kind: 'contains', from: file.path, to: decl.ref, citation })
      // A literal is reached through the function that defines it: a handler built inside a
      // middleware runs when the middleware's result is called.
      const parent = decl.node.type === 'func_literal' ? enclosing(file, decl.node) : undefined
      if (parent) {
        const data = { resolution: 'resolved', literal: true }
        edge({ kind: 'calls', from: parent.ref, to: decl.ref, citation, data })
      }
    }

    for (const match of calls.matches(root)) {
      const call = match.captures.find((c) => c.name === 'call')?.node
      const callee = match.captures.find((c) => c.name === 'callee')?.node.text
      if (!call || !callee) continue
      const caller = enclosing(file, call)
      if (!caller) continue
      const operand = match.captures.find((c) => c.name === 'operand')?.node
      const citation = { file: file.path, line: line(call) }
      const resolved = (to: string) => {
        stats.resolved++
        edge({ kind: 'calls', from: caller.ref, to, citation, data: { resolution: 'resolved' } })
      }
      const guessed = (to: string, reason: string) => {
        stats.guessed++
        const data = { resolution: 'guessed', reason }
        edge({ kind: 'calls', from: caller.ref, to, citation, data })
      }
      // One declaration is the callee; several are build variants, each a guess.
      const declared = (decls: Decl[] | undefined): boolean => {
        const [first] = decls ?? []
        if (!decls || !first) return false
        if (decls.length === 1) resolved(first.ref)
        else {
          const reason = `${decls.length} declarations of ${first.name}, one per build variant`
          for (const decl of decls) guessed(decl.ref, reason)
        }
        return true
      }

      if (!operand) {
        // A local variable holding a function is not the package-level function of that name.
        const local = declaredAt(callee, call)
        if (builtins.has(callee) && !local) continue
        stats.calls++
        if (local || !declared(functions.get(`${file.dir}\0${callee}`))) stats.unresolved++
        continue
      }

      stats.calls++
      const importPath = packageOf(operand, file)
      if (importPath) {
        const dir = internalDir(importPath)
        if (dir === undefined) {
          resolved(external(externalRef(importPath, callee), `${operand.text}.${callee}`))
        } else if (!declared(functions.get(`${dir}\0${callee}`))) stats.unresolved++
        continue
      }
      // A call on a value whose type the syntax states: a method of the module, or of a package
      // outside it, named by its import path.
      const type = typeOf(operand, file)
      if (type && 'outside' in type) {
        stats.unresolved++
        continue
      }
      if (type && 'importPath' in type) {
        const name = `${type.name}.${callee}`
        resolved(external(externalRef(type.importPath, name), name))
        continue
      }
      if (type && declared(methods.get(`${type.dir}\0${type.name}.${callee}`))) continue
      // Otherwise, an interface, an embedded method or a value of unknown type: the only method
      // of the module with that name is a guess.
      const candidates = methodsByName.get(callee) ?? []
      if (candidates.length === 1 && candidates[0]) {
        const why = type ? `${type.name} declares no method ${callee}` : 'receiver type unknown'
        guessed(
          candidates[0].ref,
          `${why}; ${candidates[0].name} is the only method named ${callee}`,
        )
      } else stats.unresolved++
    }
  }

  graph.nodes.push(...externals.values())
  for (const file of parsed) file.tree.delete()
  return { graph, stats }
}
