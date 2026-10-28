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
export const line = (node: Node) => node.startPosition.row + 1

export interface Decl {
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

export interface ParsedFile {
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
  // The method names of each interface type of a file.
  interfaces: Map<string, string[]>
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
export type Declared = { type: string } | { value: Node; index: number } | { untyped: true }

function fromValues(declared: string[], index: number, values: Node[]): Declared {
  if (values.length === declared.length && values[index]) return { value: values[index], index: 0 }
  if (values.length === 1 && values[0]) return { value: values[0], index }
  return { untyped: true }
}

export const present = (nodes: (Node | null)[]) => nodes.filter((n): n is Node => n !== null)

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
export function declaredAt(name: string, at: Node): Declared | undefined {
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

// The methods each interface type declares by name; embedded interfaces are not followed.
function interfaceMethods(root: Node): Map<string, string[]> {
  const interfaces = new Map<string, string[]>()
  for (const spec of present(root.descendantsOfType('type_spec'))) {
    const name = spec.childForFieldName('name')?.text
    const type = spec.childForFieldName('type')
    if (!name || type?.type !== 'interface_type') continue
    const methods = present(type.namedChildren)
      .filter((n) => n.type === 'method_elem')
      .map((n) => n.childForFieldName('name')?.text ?? '')
    interfaces.set(name, methods.filter(Boolean))
  }
  return interfaces
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
    interfaces: interfaceMethods(root),
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

export type Located = { dir: string; name: string } | { importPath: string; name: string }
export type Outside = { outside: true }
const outside: Outside = { outside: true }

// One type when every candidate agrees on it, none otherwise.
function agreed(types: (Located | undefined)[]): Located | undefined {
  const first = JSON.stringify(types[0])
  return types.length > 0 && types.every((t) => JSON.stringify(t) === first) ? types[0] : undefined
}

// The parsed files of a Go module, and what the syntax states about them: the call graph, the
// types of expressions, and the declarations an expression names. Profiles read the program
// through it; `dispose` frees the syntax trees.
export class GoProgram {
  readonly files: ParsedFile[]
  // The modules of the target, by the folder their `go.mod` is in; the longest path wins.
  readonly modules: GoModuleRoot[]
  // Types whose methods return the type itself: `db.Where(…).First(…)` keeps `*gorm.DB`.
  private readonly fluent: Set<string>
  // What functions outside the module return first: `encoding/json#NewDecoder` gives
  // `encoding/json#Decoder`.
  private readonly returns: Map<string, string>
  // Functions outside the module that return their string argument normalised.
  private readonly keeps: Set<string>
  // String constants of packages outside the module: `net/http#MethodGet` is `GET`.
  private readonly constants: Map<string, string>
  private readonly functions: Map<string, Decl[]>
  private readonly methods: Map<string, Decl[]>
  private readonly methodsByName: Map<string, Decl[]>
  private readonly filesByDir = new Map<string, ParsedFile[]>()
  private readonly fields = new Map<string, { type: string; file: ParsedFile }[]>()
  private readonly aliasesOf = new Map<string, Map<string, string>>()
  private readonly byPath: Map<string, ParsedFile>

  static async load(
    files: GoFile[],
    options: {
      // One module at the target's root, or every module with its folder.
      module?: string
      modules?: GoModuleRoot[]
      fluent?: Iterable<string>
      returns?: Iterable<[string, string]>
      keeps?: Iterable<string>
      constants?: Iterable<[string, string]>
    } = {},
  ): Promise<GoProgram> {
    const parsed = await Promise.all(files.map(parseFile))
    const modules = options.modules ?? (options.module ? [{ path: options.module, dir: '.' }] : [])
    return new GoProgram(parsed, modules, {
      fluent: new Set(options.fluent ?? []),
      returns: new Map(options.returns ?? []),
      keeps: new Set(options.keeps ?? []),
      constants: new Map(options.constants ?? []),
    })
  }

  private constructor(
    parsed: ParsedFile[],
    modules: GoModuleRoot[],
    library: {
      fluent: Set<string>
      returns: Map<string, string>
      keeps: Set<string>
      constants: Map<string, string>
    },
  ) {
    this.fluent = library.fluent
    this.returns = library.returns
    this.keeps = library.keeps
    this.constants = library.constants
    this.files = parsed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    this.modules = [...modules].sort((a, b) => b.path.length - a.path.length)
    this.byPath = new Map(this.files.map((file) => [file.path, file]))

    // Several declarations under one key are build variants (`sock_unix.go`, `sock_windows.go`):
    // a call to that name is not resolved to one of them.
    const all = this.files.flatMap((file) => file.decls.map((decl) => ({ file, decl })))
    const key = ({ file, decl }: { file: ParsedFile; decl: Decl }): [string, Decl] => [
      `${file.dir}\0${decl.name}`,
      decl,
    ]
    this.functions = group(
      all.filter(({ decl }) => decl.node.type === 'function_declaration').map(key),
    )
    const withReceiver = all.filter(({ decl }) => decl.receiver)
    this.methods = group(withReceiver.map(key))
    this.methodsByName = group(
      withReceiver.map(({ decl }): [string, Decl] => [
        decl.name.slice((decl.receiver?.length ?? 0) + 1),
        decl,
      ]),
    )
    for (const file of this.files) {
      this.filesByDir.set(file.dir, [...(this.filesByDir.get(file.dir) ?? []), file])
      for (const [type, typeFields] of file.structs) {
        for (const [field, fieldType] of typeFields) {
          const k = `${file.dir}\0${type}\0${field}`
          this.fields.set(k, [...(this.fields.get(k) ?? []), { type: fieldType, file }])
        }
      }
    }
    // The names a file's imports are known by, and the import path behind each.
    for (const file of this.files) {
      const aliases = new Map<string, string>()
      for (const imp of file.imports) {
        const dir = this.internalDir(imp.path)
        const declared = dir === undefined ? undefined : this.filesByDir.get(dir)?.[0]?.packageName
        const alias = imp.alias ?? declared ?? defaultPackageName(imp.path)
        if (alias !== '_' && alias !== '.') aliases.set(alias, imp.path)
      }
      this.aliasesOf.set(file.path, aliases)
    }
  }

  dispose() {
    for (const file of this.files) file.tree.delete()
  }

  file(path: string): ParsedFile | undefined {
    return this.byPath.get(path)
  }

  filesIn(dir: string): ParsedFile[] {
    return this.filesByDir.get(dir) ?? []
  }

  internalDir(importPath: string): string | undefined {
    for (const module of this.modules) {
      if (importPath === module.path) return module.dir
      if (importPath.startsWith(`${module.path}/`)) {
        return posix.join(module.dir, importPath.slice(module.path.length + 1))
      }
    }
    return undefined
  }

  // The innermost declaration that encloses `node`, or the declaration `node` is.
  declOf(file: ParsedFile, node: Node): Decl | undefined {
    return file.declsById.get(node.id) ?? enclosing(file, node)
  }

  // An identifier names an imported package only when no local declaration shadows it.
  packageOf(node: Node, file: ParsedFile): string | undefined {
    if (node.type !== 'identifier') return undefined
    const importPath = this.aliasesOf.get(file.path)?.get(node.text)
    return importPath && !declaredAt(node.text, node) ? importPath : undefined
  }

  // A type as written, located: in a package of the module by its directory, or outside it by
  // import path.
  locate(text: string, file: ParsedFile): Located | undefined {
    const type = namedType(text)
    if (!type) return undefined
    if (!type.qualifier) return { dir: file.dir, name: type.name }
    const importPath = this.aliasesOf.get(file.path)?.get(type.qualifier)
    if (!importPath) return undefined
    const dir = this.internalDir(importPath)
    return dir === undefined ? { importPath, name: type.name } : { dir, name: type.name }
  }

  // The methods named `method` of the types that implement the interface `name` of `dir`, as
  // guesses: which one runs depends on the value, which the syntax does not state.
  private implementations(dir: string, name: string, method: string): Target[] | undefined {
    const required = this.filesIn(dir)
      .map((f) => f.interfaces.get(name))
      .find((m) => m)
    if (!required?.includes(method)) return undefined
    this.methodSets ??= this.buildMethodSets()
    const found: Target[] = []
    for (const [type, set] of this.methodSets) {
      if (!required.every((m) => set.methods.has(m))) continue
      const decl = set.methods.get(method)
      if (decl) {
        const reason = `${type.split('\0')[1]} implements ${name}`
        found.push({ ref: decl.ref, decl, resolution: 'guessed', reason })
      }
    }
    return found.length > 0 ? found.sort((a, b) => (a.ref < b.ref ? -1 : 1)) : undefined
  }

  private methodSets?: Map<string, { methods: Map<string, Decl> }>

  private buildMethodSets(): Map<string, { methods: Map<string, Decl> }> {
    const sets = new Map<string, { methods: Map<string, Decl> }>()
    for (const file of this.files) {
      for (const decl of file.decls) {
        if (!decl.receiver) continue
        const key = `${file.dir}\0${decl.receiver}`
        const set = sets.get(key) ?? { methods: new Map() }
        set.methods.set(decl.name.slice(decl.receiver.length + 1), decl)
        sets.set(key, set)
      }
    }
    return new Map([...sets].sort(([a], [b]) => (a < b ? -1 : 1)))
  }

  // The string an expression always is: a literal, or a constant or package variable initialised
  // with one, in this package (`trueClientIP`) or another of the module (`conf.Path`).
  stringValue(node: Node | undefined, file: ParsedFile): string | undefined {
    if (!node) return undefined
    if (node.type === 'interpreted_string_literal' || node.type === 'raw_string_literal') {
      return node.text.slice(1, -1)
    }
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function')
      const operand =
        fn?.type === 'selector_expression' ? fn.childForFieldName('operand') : undefined
      const importPath = operand ? this.packageOf(operand, file) : undefined
      const symbol = `${importPath}#${fn?.childForFieldName('field')?.text}`
      const [first] = present(node.childForFieldName('arguments')?.namedChildren ?? [])
      return importPath && this.keeps.has(symbol) ? this.stringValue(first, file) : undefined
    }
    let name: string | undefined
    let dir: string | undefined
    if (node.type === 'identifier' && !declaredAt(node.text, node)) {
      name = node.text
      dir = file.dir
    } else if (node.type === 'selector_expression') {
      const operand = node.childForFieldName('operand')
      const importPath = operand ? this.packageOf(operand, file) : undefined
      dir = importPath ? this.internalDir(importPath) : undefined
      name = node.childForFieldName('field')?.text
      const known = this.constants.get(`${importPath}#${name}`)
      if (importPath && dir === undefined && known !== undefined) return known
    }
    if (!name || dir === undefined) return undefined
    const [declared] = this.packageValues(dir).declared.get(name) ?? []
    return declared ? this.stringValue(declared.value, declared.file) : undefined
  }

  // The values a package's own constants and variables get: where they are declared, and, for
  // variables, where they are assigned. Built once per package.
  private readonly values = new Map<string, PackageValues>()

  private packageValues(dir: string): PackageValues {
    let found = this.values.get(dir)
    if (found) return found
    found = { declared: new Map(), assigned: new Map() }
    const add = (map: Map<string, PackageValue[]>, name: string, entry: PackageValue) =>
      map.set(name, [...(map.get(name) ?? []), entry])
    for (const file of this.filesIn(dir)) {
      for (const top of present(file.tree.rootNode.namedChildren)) {
        if (top.type !== 'const_declaration' && top.type !== 'var_declaration') continue
        for (const spec of present(top.descendantsOfType(['const_spec', 'var_spec']))) {
          const values = spec.childForFieldName('value')?.namedChildren ?? []
          names(spec).forEach((name, i) => {
            const value = values[i]
            if (value)
              add(found.declared, name, { value, file, variable: spec.type === 'var_spec' })
          })
        }
      }
      for (const assignment of present(
        file.tree.rootNode.descendantsOfType('assignment_statement'),
      )) {
        const left = present(assignment.childForFieldName('left')?.namedChildren ?? [])
        const right = assignment.childForFieldName('right')?.namedChildren ?? []
        left.forEach((target, i) => {
          const value = right[i]
          if (target.type === 'identifier' && value && !declaredAt(target.text, target)) {
            add(found.assigned, target.text, { value, file, variable: true })
          }
        })
      }
    }
    this.values.set(dir, found)
    return found
  }

  // What a package variable holding a function is assigned: `DefaultLogger = RequestLogger(…)`
  // makes a call to `DefaultLogger` a guess to `RequestLogger`, whose result it holds.
  assigned(fn: Node, file: ParsedFile): Target[] | undefined {
    if (fn.type !== 'identifier' || declaredAt(fn.text, fn)) return undefined
    const { declared, assigned } = this.packageValues(file.dir)
    const values = [
      ...(declared.get(fn.text) ?? []).filter((v) => v.variable),
      ...(assigned.get(fn.text) ?? []),
    ]
    const found: Target[] = []
    for (const { value, file: other } of values) {
      const named = value.type === 'call_expression' ? value.childForFieldName('function') : value
      for (const target of (named ? this.targets(named, other) : undefined) ?? []) {
        const reason = `${fn.text} is assigned ${value.text.replace(/\s+/g, ' ').slice(0, 80)}`
        found.push({ ...target, resolution: 'guessed', reason })
      }
    }
    return found.length > 0 ? found : undefined
  }

  // The declared type of a field `x.f`, as written, when `x` is a struct of the module.
  fieldType(node: Node, file: ParsedFile): string | undefined {
    if (node.type !== 'selector_expression') return undefined
    const inner = node.childForFieldName('operand')
    const field = node.childForFieldName('field')?.text
    const owner =
      inner && field && !this.packageOf(inner, file) ? this.typeOf(inner, file) : undefined
    if (!owner || !('dir' in owner)) return undefined
    const declared = this.fields.get(`${owner.dir}\0${owner.name}\0${field}`) ?? []
    const texts = new Set(declared.map((d) => d.type))
    return texts.size === 1 ? [...texts][0] : undefined
  }

  // The `index`-th type a function declares it returns, located from the function's own file.
  private resultOf(decls: Decl[] | undefined, index: number): Located | undefined {
    return agreed(
      (decls ?? []).map((decl) => {
        const result = decl.node.childForFieldName('result')
        const file = this.byPath.get(decl.file)
        if (!result || !file) return undefined
        const types =
          result.type === 'parameter_list'
            ? present(result.namedChildren).flatMap((param) => {
                const type = param.childForFieldName('type')?.text ?? ''
                return Array<string>(Math.max(1, names(param).length)).fill(type)
              })
            : [result.text]
        const text = types[index]
        return text ? this.locate(text, file) : undefined
      }),
    )
  }

  // The type of an expression, from what the syntax states: a typed variable, a field of a struct
  // of the module, a composite literal, or the result of a call. A value that comes from a package
  // outside the module is `outside`: its methods are not the module's, even when its type is not
  // known.
  typeOf(node: Node, file: ParsedFile, index = 0, depth = 0): Located | Outside | undefined {
    if (depth > 8) return undefined
    if (index > 0 && node.type !== 'call_expression') return undefined
    switch (node.type) {
      case 'identifier': {
        const declared = declaredAt(node.text, node)
        if (!declared || 'untyped' in declared) return undefined
        return 'type' in declared
          ? this.locate(declared.type, file)
          : this.typeOf(declared.value, file, declared.index, depth + 1)
      }
      case 'parenthesized_expression':
      case 'unary_expression': {
        const operator = node.childForFieldName('operator')?.text
        if (operator && operator !== '&') return undefined
        const inner = node.childForFieldName('operand') ?? node.namedChildren[0]
        return inner ? this.typeOf(inner, file, 0, depth + 1) : undefined
      }
      case 'composite_literal': {
        const type = node.childForFieldName('type')?.text
        return type ? this.locate(type, file) : undefined
      }
      case 'selector_expression': {
        const inner = node.childForFieldName('operand')
        const field = node.childForFieldName('field')?.text
        if (!inner || !field || this.packageOf(inner, file)) return undefined
        const owner = this.typeOf(inner, file, 0, depth + 1)
        if (!owner || !('dir' in owner)) return owner ? outside : undefined
        const declared = this.fields.get(`${owner.dir}\0${owner.name}\0${field}`) ?? []
        return agreed(declared.map((d) => this.locate(d.type, d.file)))
      }
      case 'call_expression': {
        const fn = node.childForFieldName('function')
        if (fn?.type === 'identifier') {
          return declaredAt(fn.text, fn)
            ? undefined
            : this.resultOf(this.functions.get(`${file.dir}\0${fn.text}`), index)
        }
        if (fn?.type !== 'selector_expression') return undefined
        const operand = fn.childForFieldName('operand')
        const name = fn.childForFieldName('field')?.text
        if (!operand || !name) return undefined
        const importPath = this.packageOf(operand, file)
        if (importPath) {
          const dir = this.internalDir(importPath)
          const known = this.returns.get(`${importPath}#${name}`)
          if (dir === undefined && known && index === 0) {
            const [path, type] = known.split('#')
            if (path && type) return { importPath: path, name: type }
          }
          return dir === undefined
            ? outside
            : this.resultOf(this.functions.get(`${dir}\0${name}`), index)
        }
        const receiver = this.typeOf(operand, file, 0, depth + 1)
        if (receiver && 'importPath' in receiver && index === 0) {
          if (this.fluent.has(`${receiver.importPath}#${receiver.name}`)) return receiver
        }
        if (!receiver || !('dir' in receiver)) return receiver ? outside : undefined
        return this.resultOf(this.methods.get(`${receiver.dir}\0${receiver.name}.${name}`), index)
      }
      default:
        return undefined
    }
  }

  // What a callee expression names, as the call graph sees it: `f`, `pkg.F` or `x.m`. Each target
  // is a declaration of the module or an external reference, resolved or guessed with a reason.
  // `undefined` means the index cannot name it.
  targets(fn: Node, file: ParsedFile): Target[] | undefined {
    const variants = (decls: Decl[] | undefined): Target[] | undefined => {
      const [first] = decls ?? []
      if (!decls || !first) return undefined
      if (decls.length === 1) return [{ ref: first.ref, decl: first, resolution: 'resolved' }]
      const reason = `${decls.length} declarations of ${first.name}, one per build variant`
      return decls.map((decl) => ({ ref: decl.ref, decl, resolution: 'guessed', reason }))
    }
    if (fn.type === 'func_literal') {
      const decl = file.declsById.get(fn.id)
      return decl ? [{ ref: decl.ref, decl, resolution: 'resolved' }] : undefined
    }
    if (fn.type === 'identifier') {
      const declared = declaredAt(fn.text, fn)
      if (declared && 'value' in declared && declared.value.type === 'func_literal') {
        return this.targets(declared.value, file)
      }
      if (declared) return undefined
      return variants(this.functions.get(`${file.dir}\0${fn.text}`))
    }
    if (fn.type !== 'selector_expression') return undefined
    const operand = fn.childForFieldName('operand')
    const name = fn.childForFieldName('field')?.text
    if (!operand || !name) return undefined
    const importPath = this.packageOf(operand, file)
    if (importPath) {
      const dir = this.internalDir(importPath)
      if (dir !== undefined) return variants(this.functions.get(`${dir}\0${name}`))
      return [
        {
          ref: externalRef(importPath, name),
          external: `${operand.text}.${name}`,
          resolution: 'resolved',
        },
      ]
    }
    // A method of a value whose type the syntax states, of the module or of a package outside it.
    const type = this.typeOf(operand, file)
    if (type && 'outside' in type) return undefined
    if (type && 'importPath' in type) {
      const symbol = `${type.name}.${name}`
      return [
        { ref: externalRef(type.importPath, symbol), external: symbol, resolution: 'resolved' },
      ]
    }
    const own = type ? variants(this.methods.get(`${type.dir}\0${type.name}.${name}`)) : undefined
    if (own) return own
    // A method of an interface of the module: each type of the module that has every method of
    // the interface may be the one called.
    const implementations = type ? this.implementations(type.dir, type.name, name) : undefined
    if (implementations) return implementations
    // Otherwise, an interface, an embedded method or a value of unknown type: the only method of
    // the module with that name is a guess.
    const candidates = this.methodsByName.get(name) ?? []
    if (candidates.length !== 1 || !candidates[0]) return undefined
    const why = type ? `${type.name} declares no method ${name}` : 'receiver type unknown'
    const reason = `${why}; ${candidates[0].name} is the only method named ${name}`
    return [{ ref: candidates[0].ref, decl: candidates[0], resolution: 'guessed', reason }]
  }

  // The file, declaration and call-graph nodes and edges of the program (D6).
  callGraph(): { graph: Graph; stats: CallStats } {
    const graph: Graph = { files: [], nodes: [], edges: [], facts: [], skips: [] }
    const stats: CallStats = { calls: 0, resolved: 0, guessed: 0, unresolved: 0 }
    const externals = new Map<string, GraphNode>()
    const edge = (e: Omit<GraphEdge, 'source'>) => graph.edges.push({ ...e, source })

    for (const file of this.files) {
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
        const dir = this.internalDir(imp.path)
        if (dir === undefined) {
          const ref = externalRef(imp.path)
          if (!externals.has(ref)) externals.set(ref, { ref, kind: 'external', name: imp.path })
          edge({ kind: 'imports', from: file.path, to: ref, citation, data })
          continue
        }
        for (const target of this.filesIn(dir)) {
          edge({ kind: 'imports', from: file.path, to: target.path, citation, data })
        }
      }

      for (const decl of file.decls) {
        const named = decl.node.childForFieldName('name')
        const node: GraphNode = {
          ref: decl.ref,
          kind: 'decl',
          name: decl.name,
          file: file.path,
          startLine: line(decl.node),
          endLine: decl.node.endPosition.row + 1,
          // Its own name is left out, so that a function renamed without other change is found
          // again by its code, and the notes on it follow it (D7).
          fingerprint: fingerprint(decl.node, (n) => isComment(n) || n.id === named?.id),
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

      for (const call of present(file.tree.rootNode.descendantsOfType('call_expression'))) {
        const fn = call.childForFieldName('function')
        const caller = enclosing(file, call)
        if (!fn || !caller || fn.type === 'func_literal') continue
        if (fn.type !== 'identifier' && fn.type !== 'selector_expression') continue
        if (fn.type === 'identifier' && builtins.has(fn.text) && !declaredAt(fn.text, fn)) continue
        stats.calls++
        const targets = this.targets(fn, file) ?? this.assigned(fn, file)
        if (!targets) {
          stats.unresolved++
          continue
        }
        const citation = { file: file.path, line: line(call) }
        for (const target of targets) {
          if (target.resolution === 'resolved') stats.resolved++
          else stats.guessed++
          if (target.external && !externals.has(target.ref)) {
            externals.set(target.ref, { ref: target.ref, kind: 'external', name: target.external })
          }
          const data =
            target.resolution === 'guessed'
              ? { resolution: 'guessed', reason: target.reason }
              : { resolution: 'resolved' }
          edge({ kind: 'calls', from: caller.ref, to: target.ref, citation, data })
        }
      }

      // A function or method returned as a value (`return compressor.Handler`) runs when the
      // caller calls what it got: the function that returns it reaches it, as a middleware
      // factory reaches the handler it builds. A function stored or registered for later, as a
      // router does with its handlers, is not reached this way.
      for (const node of present(root.descendantsOfType(['identifier', 'selector_expression']))) {
        if (!returned(node)) continue
        if (node.type === 'selector_expression' && this.fieldType(node, file)) continue
        const caller = enclosing(file, node)
        const targets = caller ? this.targets(node, file) : undefined
        if (!caller || !targets) continue
        const citation = { file: file.path, line: line(node) }
        for (const target of targets) {
          if (!target.decl || target.resolution !== 'resolved' || target.ref === caller.ref)
            continue
          const data = { resolution: 'resolved', reference: true }
          edge({ kind: 'calls', from: caller.ref, to: target.ref, citation, data })
        }
      }
    }

    graph.nodes.push(...externals.values())
    return { graph, stats }
  }
}

// Whether a name is a value that its function returns: `return h`, `return http.HandlerFunc(h)`.
const throughValues = new Set([
  'argument_list',
  'expression_list',
  'parenthesized_expression',
  'unary_expression',
  'composite_literal',
  'literal_value',
  'keyed_element',
  'literal_element',
])
function returned(node: Node): boolean {
  const parent = node.parent
  if (!parent) return false
  if (parent.type === 'call_expression') {
    // As the function called, the name is a call, not a value.
    if (parent.childForFieldName('function')?.id === node.id) return false
    return returned(parent)
  }
  if (parent.type === 'return_statement') return true
  return throughValues.has(parent.type) && returned(parent)
}

interface PackageValue {
  value: Node
  file: ParsedFile
  variable: boolean
}

interface PackageValues {
  declared: Map<string, PackageValue[]>
  assigned: Map<string, PackageValue[]>
}

export interface GoModuleRoot {
  path: string
  // The folder of its `go.mod`, relative to the target's root: `.` at the root.
  dir: string
}

export interface Target {
  ref: string
  // The declaration of the module, or the external symbol's name as written (`chi.NewRouter`).
  decl?: Decl
  external?: string
  resolution: 'resolved' | 'guessed'
  reason?: string
}

export async function extractGo(
  files: GoFile[],
  options: { module?: string; modules?: GoModuleRoot[] } = {},
): Promise<{ graph: Graph; stats: CallStats }> {
  const program = await GoProgram.load(files, options)
  try {
    return program.callGraph()
  } finally {
    program.dispose()
  }
}
