import { posix } from 'node:path'
import type { Node, Tree } from 'web-tree-sitter'
import { type Analysis, type Place, placeKey } from './analyzer.ts'
import type { Callee } from './entries.ts'
import type { Graph, GraphEdge, GraphNode } from './graph.ts'
import type { CallStats } from './language.ts'
import { defineGrammar, loadQuery, parse } from './parser.ts'
import { externalRef, fingerprint, hashText, Names } from './refs.ts'
import type { TargetFile } from './target.ts'

// The Python call graph: declarations, imports and calls, resolved across the target's modules
// where the syntax states what a name is (an import, an annotation, `x = C()`, a field `self.x`
// assigned, a function's return annotation), guessed with a reason where it does not (D6).

defineGrammar('python', 'tree-sitter-python/tree-sitter-python.wasm')

export const isPySource = (path: string) => path.endsWith('.py')

const source = 'tree-sitter'
const isComment = (node: Node) => node.type === 'comment'
export const line = (node: Node) => node.startPosition.row + 1
const at = (file: { path: string }, node: Node): Place => ({
  file: file.path,
  line: line(node),
  column: node.startPosition.column + 1,
})
export const present = (nodes: (Node | null | undefined)[]) =>
  nodes.filter((n): n is Node => n !== null && n !== undefined)

const scopeTypes = new Set(['function_definition', 'lambda'])

export interface PyDecl {
  ref: string
  // Its name within the file: `create_app`, `Request.json`, `create_routes/authenticated`,
  // `create_routes/lambda2`.
  name: string
  file: string
  // The function, the class or the lambda; a decorated one without its decorators.
  node: Node
  kind: 'function' | 'method' | 'class' | 'literal'
  // The identifier that names it, left out of its fingerprint (D21).
  named?: Node
  exported: boolean
  // For a method, the class that holds it.
  owner?: PyDecl
  // A property: run when its attribute is read.
  getter?: boolean
}

// What a name is bound to where it is used, as the syntax states it.
export type Binding =
  | { kind: 'decl'; decl: PyDecl; file: PyFile }
  | {
      kind: 'value'
      file: PyFile
      // The statement or clause that binds it: an assignment, a `with` item, a `for`.
      node: Node
      value?: Node
      type?: Node
      // The value is what entering it gives: `with C() as x`.
      entered?: boolean
      // The value is one of what it iterates: `for x in xs`.
      iterated?: boolean
    }
  | {
      kind: 'param'
      file: PyFile
      fn: Node
      index: number
      node: Node
      name: string
      type?: Node
      value?: Node
    }
  | { kind: 'import'; file: PyFile; module: string; name?: string; node: Node }

export interface PyFile {
  path: string
  // Its dotted module name: `space.api.rest`; a package's `__init__.py` is the package.
  module: string
  // The package relative imports start from.
  package: string
  hash: string
  tree: Tree
  decls: PyDecl[]
  declsById: Map<number, PyDecl>
  bindings: Map<string, Binding[]>
  // `from m import *`, by absolute module.
  stars: string[]
  imports: { module: string; node: Node }[]
  // `__all__`, when the module states it as a list of strings.
  all?: Set<string>
}

// A type, as far as the syntax states it: an instance of a class of the target, a value named by
// a symbol outside the target (or a type alias of it), a module, or a value known not to be one of
// the target's (a string, a list).
export type PyType =
  | { kind: 'class'; decl: PyDecl; file: PyFile }
  | { kind: 'external'; module: string; name: string }
  | { kind: 'module'; module: string; file?: PyFile }
  | { kind: 'outside' }

const outside: PyType = { kind: 'outside' }

// A callee, with the declaration of the target it names.
export interface Target extends Callee {
  decl?: PyDecl
}

// What a name refers to once imports are followed.
export type Ref =
  | { kind: 'decl'; decl: PyDecl; file: PyFile }
  | { kind: 'module'; module: string; file?: PyFile }
  | { kind: 'external'; module: string; name: string }
  | { kind: 'binding'; binding: Binding }

// The text of a string literal without interpolation, or nothing.
export function stringValue(node: Node | null | undefined): string | undefined {
  if (!node) return undefined
  if (node.type === 'concatenated_string') {
    const parts = present(node.namedChildren).map(stringValue)
    return parts.every((p) => p !== undefined) ? parts.join('') : undefined
  }
  if (node.type !== 'string') return undefined
  if (node.namedChildren.some((n) => n?.type === 'interpolation')) return undefined
  const start = node.namedChildren.find((n) => n?.type === 'string_start')?.text ?? ''
  if (/[bB]/.test(start)) return undefined
  return present(node.namedChildren)
    .filter((n) => n.type === 'string_content' || n.type === 'escape_sequence')
    .map((n) =>
      n.type === 'escape_sequence' && !/[rR]/.test(start) ? unescapeOne(n.text) : n.text,
    )
    .join('')
}

function unescapeOne(text: string): string {
  const simple: Record<string, string> = {
    n: '\n',
    t: '\t',
    r: '\r',
    '\\': '\\',
    "'": "'",
    '"': '"',
  }
  const c = text.slice(1)
  if (c in simple) return simple[c] as string
  if (/^x[0-9a-fA-F]{2}$|^u[0-9a-fA-F]{4}$/.test(c))
    return String.fromCharCode(Number.parseInt(c.slice(1), 16))
  return text
}

// The arguments of a call: positional, and keywords by name.
export function argumentsOf(call: Node): { positional: Node[]; keywords: Map<string, Node> } {
  const positional: Node[] = []
  const keywords = new Map<string, Node>()
  const args = call.childForFieldName('arguments')
  for (const arg of present(args?.namedChildren ?? [])) {
    if (arg.type === 'comment') continue
    if (arg.type === 'keyword_argument') {
      const name = arg.childForFieldName('name')?.text
      const value = arg.childForFieldName('value')
      if (name && value) keywords.set(name, value)
    } else positional.push(arg)
  }
  if (args?.type === 'generator_expression') positional.push(args)
  return { positional, keywords }
}

// An argument by its position or its keyword.
export function argument(call: Node, index: number, keyword?: string): Node | undefined {
  const { positional, keywords } = argumentsOf(call)
  return (keyword ? keywords.get(keyword) : undefined) ?? positional[index]
}

// The parameters of a function or a lambda, each with its name, annotation and default.
export function parametersOf(
  fn: Node,
): { node: Node; name: string; type?: Node; value?: Node; star?: '*' | '**' }[] {
  const params = fn.childForFieldName('parameters')
  const found: { node: Node; name: string; type?: Node; value?: Node; star?: '*' | '**' }[] = []
  for (const p of present(params?.namedChildren ?? [])) {
    let name: Node | undefined
    let star: '*' | '**' | undefined
    if (p.type === 'identifier') name = p
    else if (p.type === 'typed_parameter') {
      const inner = p.namedChildren[0]
      if (inner?.type === 'identifier') name = inner
      else if (inner?.type === 'list_splat_pattern' || inner?.type === 'dictionary_splat_pattern') {
        name = inner.namedChildren[0] ?? undefined
        star = inner.type === 'list_splat_pattern' ? '*' : '**'
      }
    } else if (p.type === 'default_parameter' || p.type === 'typed_default_parameter')
      name = p.childForFieldName('name') ?? undefined
    else if (p.type === 'list_splat_pattern' || p.type === 'dictionary_splat_pattern') {
      name = p.namedChildren[0] ?? undefined
      star = p.type === 'list_splat_pattern' ? '*' : '**'
    }
    if (name?.type !== 'identifier') continue
    const type = p.childForFieldName('type') ?? undefined
    const value = p.childForFieldName('value') ?? undefined
    found.push({
      node: name,
      name: name.text,
      ...(type ? { type } : {}),
      ...(value ? { value } : {}),
      ...(star ? { star } : {}),
    })
  }
  return found
}

// The decorators of a function or a class.
export function decoratorsOf(node: Node): Node[] {
  const parent = node.parent
  if (parent?.type !== 'decorated_definition') return []
  return present(parent.namedChildren)
    .filter((n) => n.type === 'decorator')
    .map((d) => d.namedChildren.find((c) => c?.type !== 'comment') ?? d)
    .filter((n): n is Node => !!n)
}

// The names an assignment's target binds: `a`, `a, b`, `[a, *b]`.
function targetNames(target: Node): Node[] {
  if (target.type === 'identifier') return [target]
  if (['pattern_list', 'tuple_pattern', 'list_pattern', 'list_splat_pattern'].includes(target.type))
    return present(target.namedChildren).flatMap(targetNames)
  if (target.type === 'parenthesized_expression' || target.type === 'tuple')
    return present(target.namedChildren).flatMap(targetNames)
  return []
}

// The dotted module a file is, from the nearest folder above it that is not a package: a target
// in the `src` layout is `space.api.rest` for `src/space/api/rest.py`.
function moduleNames(paths: string[]): Map<string, { module: string; package: string }> {
  const packages = new Set(
    paths.filter((p) => posix.basename(p) === '__init__.py').map((p) => posix.dirname(p)),
  )
  const names = new Map<string, { module: string; package: string }>()
  for (const path of paths) {
    let dir = posix.dirname(path)
    const parts: string[] = []
    while (dir !== '.' && dir !== '/' && packages.has(dir)) {
      parts.unshift(posix.basename(dir))
      dir = posix.dirname(dir)
    }
    const base = posix.basename(path, '.py')
    const init = base === '__init__'
    const module = init ? parts.join('.') : [...parts, base].join('.')
    names.set(path, { module: module || base, package: init ? module : parts.join('.') })
  }
  return names
}

async function parseFile(
  file: TargetFile,
  names: { module: string; package: string },
): Promise<PyFile> {
  const tree = await parse('python', file.source)
  const root = tree.rootNode
  const [declarations, imports] = await Promise.all([
    loadQuery('python', 'declarations'),
    loadQuery('python', 'imports'),
  ])
  const parsed: PyFile = {
    path: file.path,
    module: names.module,
    package: names.package,
    hash: hashText(file.source),
    tree,
    decls: [],
    declsById: new Map(),
    bindings: new Map(),
    stars: [],
    imports: [],
  }
  for (const match of imports.matches(root)) {
    const node = match.captures.find((c) => c.name === 'import')?.node
    if (!node) continue
    for (const module of importedModules(node, parsed)) parsed.imports.push({ module, node })
  }

  const found: { node: Node; capture: string; named?: Node }[] = []
  for (const match of declarations.matches(root)) {
    const capture = match.captures.find((c) => ['function', 'class', 'literal'].includes(c.name))
    if (!capture) continue
    const named = match.captures.find((c) => c.name === 'name')?.node
    found.push({ node: capture.node, capture: capture.name, ...(named ? { named } : {}) })
  }
  found.sort((a, b) => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex)
  const taken = new Names()
  const ranks = new Map<string, number>()
  const enclosing = (node: Node): PyDecl | undefined => {
    for (let n = node.parent; n; n = n.parent) {
      const decl = parsed.declsById.get(n.id)
      if (decl) return decl
    }
    return undefined
  }
  const privateModule = parsed.module
    .split('.')
    .some((part) => part.startsWith('_') && !/^__\w+__$/.test(part))
  const isPublic = (name: string) => !name.startsWith('_') || /^__\w+__$/.test(name)
  for (const { node, capture, named } of found) {
    const parent = enclosing(node)
    // A method, decorated or not, sits in the body of its class.
    const holder = node.parent?.type === 'decorated_definition' ? node.parent : node
    const inClass = parent?.kind === 'class' && holder.parent?.parent?.id === parent.node.id
    let name: string
    let kind: PyDecl['kind']
    if (capture === 'literal') {
      // A lambda a name holds is named after it: `key = lambda r: …`.
      const holder = node.parent?.type === 'assignment' ? node.parent : undefined
      const left = holder?.childForFieldName('left')
      if (holder?.childForFieldName('right')?.id === node.id && left?.type === 'identifier') {
        name = left.text
        kind = 'function'
      } else {
        const key = parent?.name ?? ''
        const rank = (ranks.get(key) ?? 0) + 1
        ranks.set(key, rank)
        name = `lambda${rank}`
        kind = 'literal'
      }
    } else {
      name = named?.text ?? '?'
      kind = capture === 'class' ? 'class' : inClass ? 'method' : 'function'
    }
    const qualified = parent
      ? `${parent.name}${parent.kind === 'class' && (inClass || kind === 'class') ? '.' : '/'}${name}`
      : name
    const full = taken.take(qualified)
    const exported =
      !privateModule &&
      kind !== 'literal' &&
      isPublic(name) &&
      (!parent || (parent.kind === 'class' && parent.exported && (inClass || kind === 'class')))
    const decorators = decoratorsOf(node).map((d) => d.text)
    const decl: PyDecl = {
      ref: `${file.path}#${full}`,
      name: full,
      file: file.path,
      node,
      kind,
      exported,
      ...(named && kind !== 'literal' ? { named } : {}),
      ...(parent && inClass ? { owner: parent } : {}),
      ...(inClass && decorators.some((d) => /(^|\.)(cached_)?property$/.test(d))
        ? { getter: true }
        : {}),
    }
    parsed.decls.push(decl)
    parsed.declsById.set(node.id, decl)
  }

  for (const [name, binding] of scopeBindings(root, parsed)) parsed.bindings.set(name, binding)
  // `__all__ = ["a", "b"]` says what `from m import *` takes.
  for (const binding of parsed.bindings.get('__all__') ?? []) {
    if (binding.kind !== 'value' || binding.value?.type !== 'list') continue
    parsed.all = new Set(
      present(binding.value.namedChildren)
        .map(stringValue)
        .filter((s): s is string => s !== undefined),
    )
  }
  return parsed
}

// The absolute module of `from .x import y` in a file.
function absoluteModule(node: Node, file: Pick<PyFile, 'package'>): string | undefined {
  if (node.type === 'dotted_name') return node.text
  if (node.type !== 'relative_import') return undefined
  const prefix = node.namedChildren.find((n) => n?.type === 'import_prefix')?.text.length ?? 0
  const rest = node.namedChildren.find((n) => n?.type === 'dotted_name')?.text
  const base = file.package ? file.package.split('.') : []
  const up = base.slice(0, Math.max(0, base.length - (prefix - 1)))
  if (prefix - 1 > base.length) return undefined
  return [...up, ...(rest ? [rest] : [])].join('.')
}

function importedModules(node: Node, file: Pick<PyFile, 'package'>): string[] {
  if (node.type === 'import_statement') {
    return present(node.childrenForFieldName('name')).map((n) =>
      n.type === 'aliased_import' ? (n.childForFieldName('name')?.text ?? '') : n.text,
    )
  }
  const module = node.childForFieldName('module_name')
  const base = module ? absoluteModule(module, file) : undefined
  if (base === undefined) return []
  const names = present(node.childrenForFieldName('name')).map((n) =>
    n.type === 'aliased_import' ? (n.childForFieldName('name')?.text ?? '') : n.text,
  )
  // `from . import x` may import the module `x` of the package.
  return [base, ...names.map((n) => (base ? `${base}.${n}` : n))]
}

// The names a scope binds: a module, or a function's body, without what nested functions and
// classes bind for themselves (their own names are bound here).
function scopeBindings(scope: Node, file: PyFile): Map<string, Binding[]> {
  const bindings = new Map<string, Binding[]>()
  const bind = (name: string, binding: Binding) =>
    bindings.set(name, [...(bindings.get(name) ?? []), binding])
  if (scopeTypes.has(scope.type)) {
    parametersOf(scope).forEach((p, index) => {
      bind(p.name, {
        kind: 'param',
        file,
        fn: scope,
        index,
        node: p.node,
        name: p.name,
        ...(p.type ? { type: p.type } : {}),
        ...(p.value ? { value: p.value } : {}),
      })
    })
  }
  const body = scope.type === 'module' ? scope : scope.childForFieldName('body')
  if (!body) return bindings
  const visit = (node: Node) => {
    switch (node.type) {
      case 'function_definition':
      case 'class_definition': {
        const decl = file.declsById.get(node.id)
        if (decl) bind(decl.name.split(/[./]/).at(-1) as string, { kind: 'decl', decl, file })
        // Default values and decorators run in this scope.
        for (const d of decoratorsOf(node)) visit(d)
        const params = node.childForFieldName('parameters')
        if (params) for (const p of present(params.namedChildren)) visit(p)
        if (node.type === 'class_definition') {
          const supers = node.childForFieldName('superclasses')
          if (supers) visit(supers)
        }
        return
      }
      case 'lambda':
        return
      case 'assignment': {
        const left = node.childForFieldName('left')
        const right = node.childForFieldName('right') ?? undefined
        const type = node.childForFieldName('type') ?? undefined
        // `a, b = x, y` binds each name to its own value.
        const pairs =
          left &&
          right &&
          left.type === 'pattern_list' &&
          ['expression_list', 'tuple'].includes(right.type)
            ? present(right.namedChildren)
            : undefined
        if (left && pairs && pairs.length === left.namedChildren.length) {
          left.namedChildren.forEach((n, i) => {
            const value = pairs[i]
            if (n?.type === 'identifier')
              bind(n.text, { kind: 'value', file, node, ...(value ? { value } : {}) })
          })
        } else if (left) {
          const names = targetNames(left)
          for (const n of names) {
            bind(n.text, {
              kind: 'value',
              file,
              node,
              ...(right && names.length === 1 && left.type === 'identifier'
                ? { value: right }
                : {}),
              ...(type && left.type === 'identifier' ? { type } : {}),
            })
          }
        }
        if (right) visit(right)
        return
      }
      case 'named_expression': {
        const name = node.childForFieldName('name')
        const value = node.childForFieldName('value') ?? undefined
        if (name) bind(name.text, { kind: 'value', file, node, ...(value ? { value } : {}) })
        if (value) visit(value)
        return
      }
      case 'for_statement':
      case 'for_in_clause': {
        const left = node.childForFieldName('left')
        const right = node.childForFieldName('right') ?? undefined
        for (const n of left ? targetNames(left) : [])
          bind(n.text, {
            kind: 'value',
            file,
            node,
            ...(right ? { value: right } : {}),
            iterated: true,
          })
        break
      }
      case 'as_pattern': {
        const alias = node.childForFieldName('alias')
        const value = node.namedChildren[0] ?? undefined
        const entered = node.parent?.type === 'with_item'
        for (const n of alias ? targetNames(alias.namedChildren[0] ?? alias) : [])
          bind(n.text, {
            kind: 'value',
            file,
            node,
            ...(value && entered ? { value, entered: true } : {}),
          })
        break
      }
      case 'except_clause': {
        // `except E as e`.
        const alias = node.childForFieldName('alias')
        if (alias?.type === 'identifier') bind(alias.text, { kind: 'value', file, node })
        break
      }
      case 'import_statement': {
        for (const n of present(node.childrenForFieldName('name'))) {
          if (n.type === 'aliased_import') {
            const alias = n.childForFieldName('alias')?.text
            const module = n.childForFieldName('name')?.text
            if (alias && module) bind(alias, { kind: 'import', file, module, node })
          } else {
            // `import a.b` binds `a`.
            const first = n.text.split('.')[0] as string
            bind(first, { kind: 'import', file, module: first, node })
          }
        }
        return
      }
      case 'import_from_statement': {
        const moduleNode = node.childForFieldName('module_name')
        const module = moduleNode ? absoluteModule(moduleNode, file) : undefined
        if (module === undefined) return
        if (present(node.namedChildren).some((n) => n.type === 'wildcard_import')) {
          if (scope.type === 'module') file.stars.push(module)
          return
        }
        for (const n of present(node.childrenForFieldName('name'))) {
          const name =
            n.type === 'aliased_import' ? n.childForFieldName('name')?.text : (n.text as string)
          const alias = n.type === 'aliased_import' ? n.childForFieldName('alias')?.text : name
          if (name && alias) bind(alias, { kind: 'import', file, module, name, node })
        }
        return
      }
      case 'type_alias_statement': {
        const left = node.childForFieldName('left')
        const right = node.childForFieldName('right') ?? undefined
        const name = left?.descendantsOfType('identifier')[0]
        if (name) bind(name.text, { kind: 'value', file, node, ...(right ? { type: right } : {}) })
        return
      }
    }
    for (const child of present(node.namedChildren)) visit(child)
  }
  for (const child of present(body.namedChildren)) visit(child)
  return bindings
}

// The scope that holds a node: the innermost function or lambda, skipping a class body, whose
// names a method does not see; the module otherwise.
function scopesOf(node: Node): Node[] {
  const scopes: Node[] = []
  for (let n = node.parent; n; n = n.parent) {
    if (scopeTypes.has(n.type)) {
      // A default value or an annotation belongs to the scope around the function.
      const params = n.childForFieldName('parameters')
      const ret = n.childForFieldName('return_type')
      if (
        params &&
        node.startIndex >= params.startIndex &&
        node.endIndex <= params.endIndex &&
        !(n.type === 'lambda')
      ) {
        const inside = parametersOf(n).some((p) => p.node.id === node.id)
        if (!inside) continue
      }
      if (ret && node.startIndex >= ret.startIndex && node.endIndex <= ret.endIndex) continue
      scopes.push(n)
    }
  }
  return scopes
}

// Names bound by a function's `global` statements.
function globalsOf(fn: Node): Set<string> {
  const names = new Set<string>()
  const body = fn.childForFieldName('body')
  for (const statement of present(body?.descendantsOfType('global_statement') ?? []))
    for (const n of present(statement.namedChildren)) names.add(n.text)
  return names
}

export interface PyLibrary {
  returns: Map<string, string>
  globals: Set<string>
  builtins: Set<string>
  members: Map<string, Record<string, string>>
}

const byRef = (a: PyDecl, b: PyDecl) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)

// The parsed files of a target and what the syntax states about them: the call graph, the types of
// expressions, and the declarations an expression names. Profiles read the program through it;
// `dispose` frees the syntax trees.
export class PyProgram {
  readonly files: PyFile[]
  private readonly byPath: Map<string, PyFile>
  private readonly byModule: Map<string, PyFile>
  private readonly library: PyLibrary
  private readonly analysis: Analysis | undefined
  private readonly declsByPlace = new Map<string, PyDecl>()
  private readonly methodsByName = new Map<string, PyDecl[]>()
  private readonly scopes = new Map<number, Map<string, Binding[]>>()
  private readonly types = new Map<number, PyType | undefined>()
  private subclasses?: Map<string, PyDecl[]>
  // What a profile says of names outside the target that are another's: `fastapi#Request` is
  // `starlette.requests#Request`.
  reexports = new Map<string, string>()
  // The bases a profile states for types outside the target.
  externalBases = new Map<string, string[]>()
  // The members of types outside the target, by type and attribute.
  members = new Map<string, Record<string, string>>()

  static async load(
    files: TargetFile[],
    options: { library?: Partial<PyLibrary>; analysis?: Analysis } = {},
  ): Promise<PyProgram> {
    const sources = files.filter((f) => isPySource(f.path))
    const names = moduleNames(sources.map((f) => f.path))
    const parsed = await Promise.all(
      sources.map((f) => parseFile(f, names.get(f.path) as { module: string; package: string })),
    )
    return new PyProgram(
      parsed,
      {
        returns: options.library?.returns ?? new Map(),
        globals: options.library?.globals ?? new Set(),
        builtins: options.library?.builtins ?? new Set(),
        members: options.library?.members ?? new Map(),
      },
      options.analysis,
    )
  }

  private constructor(parsed: PyFile[], library: PyLibrary, analysis?: Analysis) {
    this.files = parsed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    this.byPath = new Map(this.files.map((f) => [f.path, f]))
    this.byModule = new Map()
    for (const file of this.files)
      if (!this.byModule.has(file.module)) this.byModule.set(file.module, file)
    this.library = library
    this.analysis = analysis
    this.members = new Map(library.members)
    for (const file of this.files) {
      for (const decl of file.decls) {
        if (decl.named) this.declsByPlace.set(placeKey(at(file, decl.named)), decl)
        if (decl.kind === 'method') {
          const name = decl.name.split('.').at(-1) as string
          this.methodsByName.set(name, [...(this.methodsByName.get(name) ?? []), decl])
        }
      }
    }
    for (const list of this.methodsByName.values()) list.sort(byRef)
  }

  dispose() {
    for (const file of this.files) file.tree.delete()
  }

  file(path: string): PyFile | undefined {
    return this.byPath.get(path)
  }

  // The symbol a callee is known by in profiles: its own outside the target, and for a declaration
  // of the target, its module and its name, a class's `__init__` by its class
  // (`fastapi.param_functions#Form`), so that a framework's rules name its own code.
  symbolOf(target: Target): string {
    const decl = target.decl ?? this.decl(target.ref)
    if (!decl) return target.ref.startsWith('ext:') ? target.ref.slice(4) : target.ref
    const file = this.byPath.get(decl.file) as PyFile
    const name = decl.owner && decl.name.endsWith('.__init__') ? decl.owner.name : decl.name
    return `${file.module}#${name}`
  }

  // A declaration by its reference.
  decl(ref: string): PyDecl | undefined {
    const file = this.byPath.get(ref.slice(0, ref.indexOf('#')))
    return file?.decls.find((d) => d.ref === ref)
  }

  moduleFile(module: string): PyFile | undefined {
    return this.byModule.get(module)
  }

  // The innermost declaration that encloses `node`, or the declaration `node` is; a class body's
  // own statements belong to none.
  declOf(file: PyFile, node: Node): PyDecl | undefined {
    for (let n: Node | null = node; n; n = n.parent) {
      const decl = file.declsById.get(n.id)
      if (decl) return decl.kind === 'class' ? undefined : decl
    }
    return undefined
  }

  // The innermost function, method or lambda that holds a node.
  enclosing(file: PyFile, node: Node): PyDecl | undefined {
    for (let n = node.parent; n; n = n.parent) {
      const decl = file.declsById.get(n.id)
      if (decl) return decl.kind === 'class' ? undefined : decl
    }
    return undefined
  }

  // The class a method's `self` is an instance of.
  classOf(fn: Node, file: PyFile): PyDecl | undefined {
    const decl = file.declsById.get(fn.id)
    return decl?.owner
  }

  private scope(node: Node, file: PyFile): Map<string, Binding[]> {
    let found = this.scopes.get(node.id)
    if (!found) {
      found = scopeBindings(node, file)
      this.scopes.set(node.id, found)
    }
    return found
  }

  // What a name is bound to where it is used: the innermost function that binds it, then the
  // module. Of several bindings, the last one before the use, or the first.
  lookup(name: string, at: Node, file: PyFile): Binding | undefined {
    for (const scope of scopesOf(at)) {
      if (globalsOf(scope).has(name)) break
      const bound = this.scope(scope, file).get(name)
      if (bound) return pick(bound, at)
    }
    const bound = file.bindings.get(name)
    return bound ? pick(bound, at) : undefined
  }

  // The bindings a module exports by a name: its own, or what it imports, by `*` too.
  exported(module: string, name: string, seen = new Set<string>()): Ref | undefined {
    const key = `${module}\0${name}`
    if (seen.has(key)) return undefined
    seen.add(key)
    const sub = this.byModule.get(module ? `${module}.${name}` : name)
    const file = this.byModule.get(module)
    if (!file) return sub ? { kind: 'module', module: sub.module, file: sub } : undefined
    const bound = file.bindings.get(name)
    if (bound) {
      const last = bound.at(-1) as Binding
      return this.follow(last, seen)
    }
    if (sub) return { kind: 'module', module: sub.module, file: sub }
    for (const star of file.stars) {
      const starred = this.byModule.get(star)
      if (starred?.all && !starred.all.has(name)) continue
      if (!starred && name.startsWith('_')) continue
      const found = starred
        ? this.exported(star, name, seen)
        : ({ kind: 'external', module: star, name } as Ref)
      if (found) return found
    }
    return undefined
  }

  // Follows a binding through imports.
  follow(binding: Binding, seen = new Set<string>()): Ref | undefined {
    if (binding.kind === 'decl') return { kind: 'decl', decl: binding.decl, file: binding.file }
    if (binding.kind !== 'import') return { kind: 'binding', binding }
    if (binding.name === undefined) {
      const file = this.byModule.get(binding.module)
      return { kind: 'module', module: binding.module, ...(file ? { file } : {}) }
    }
    const inside =
      this.byModule.has(binding.module) || this.byModule.has(`${binding.module}.${binding.name}`)
    if (inside) return this.exported(binding.module, binding.name, seen)
    return this.externalName(binding.module, binding.name)
  }

  // A name outside the target, as a profile names it once its re-exports are followed.
  externalName(module: string, name: string): Ref {
    const symbol = this.reexports.get(`${module}#${name}`)
    if (symbol) {
      const at = symbol.indexOf('#')
      return { kind: 'external', module: symbol.slice(0, at), name: symbol.slice(at + 1) }
    }
    return { kind: 'external', module, name }
  }

  // What an expression names: a declaration, a module, a symbol outside the target, or a binding
  // whose value is not a declaration.
  resolve(node: Node, file: PyFile, depth = 0): Ref | undefined {
    if (depth > 12) return undefined
    if (node.type === 'identifier') {
      const binding = this.lookup(node.text, node, file)
      if (!binding) {
        if (this.library.globals.has(node.text))
          return { kind: 'external', module: 'builtins', name: node.text }
        return undefined
      }
      const ref = this.follow(binding)
      // A name that holds another name: `handler = other_handler`.
      if (
        ref?.kind === 'binding' &&
        ref.binding.kind === 'value' &&
        !ref.binding.entered &&
        !ref.binding.iterated &&
        ref.binding.value &&
        (ref.binding.value.type === 'identifier' || ref.binding.value.type === 'attribute')
      ) {
        const inner = this.resolve(ref.binding.value, ref.binding.file, depth + 1)
        if (inner && inner.kind !== 'binding') return inner
      }
      return ref
    }
    if (node.type === 'attribute') {
      const object = node.childForFieldName('object')
      const name = node.childForFieldName('attribute')?.text
      if (!object || !name) return undefined
      const owner = this.resolve(object, file, depth + 1)
      if (owner?.kind === 'module') {
        if (owner.file || this.byModule.has(`${owner.module}.${name}`)) {
          const found = this.exported(owner.module, name)
          if (found) return found
          return undefined
        }
        return this.externalName(owner.module, name)
      }
      if (owner?.kind === 'external') {
        // `os.path`, `sqlalchemy.orm`: a module's attribute, named in full.
        const module = `${owner.module}.${owner.name}`
        return /^[a-z_]/.test(owner.name)
          ? this.externalName(module, name)
          : { kind: 'external', module: owner.module, name: `${owner.name}.${name}` }
      }
      if (owner?.kind === 'decl' && owner.decl.kind === 'class') {
        const member = this.classMember(owner.decl, name)
        if (member)
          return { kind: 'decl', decl: member, file: this.byPath.get(member.file) as PyFile }
      }
      return undefined
    }
    return undefined
  }

  // A method of a class of the target, its bases' included, in the order Python looks them up.
  classMember(cls: PyDecl, name: string, seen = new Set<string>()): PyDecl | undefined {
    if (seen.has(cls.ref)) return undefined
    seen.add(cls.ref)
    const own = this.ownMember(cls, name)
    if (own) return own
    for (const base of this.bases(cls)) {
      if (base.kind !== 'class') continue
      const found = this.classMember(base.decl, name, seen)
      if (found) return found
    }
    return undefined
  }

  private ownMember(cls: PyDecl, name: string): PyDecl | undefined {
    const file = this.byPath.get(cls.file) as PyFile
    const body = cls.node.childForFieldName('body')
    let found: PyDecl | undefined
    for (const child of present(body?.namedChildren ?? [])) {
      const def =
        child.type === 'decorated_definition' ? child.childForFieldName('definition') : child
      if (def?.type !== 'function_definition') continue
      if (def.childForFieldName('name')?.text !== name) continue
      const decl = file.declsById.get(def.id)
      // The getter of a property, not its setter.
      if (decl && !found) found = decl
    }
    return found
  }

  // The bases a class states, each a class of the target or a symbol outside it.
  bases(cls: PyDecl): PyType[] {
    const file = this.byPath.get(cls.file) as PyFile
    const supers = cls.node.childForFieldName('superclasses')
    const found: PyType[] = []
    for (const base of present(supers?.namedChildren ?? [])) {
      if (base.type === 'keyword_argument') continue
      const expr = base.type === 'subscript' ? base.childForFieldName('value') : base
      const ref = expr ? this.resolve(expr, file) : undefined
      if (ref?.kind === 'decl' && ref.decl.kind === 'class')
        found.push({ kind: 'class', decl: ref.decl, file: ref.file })
      else if (ref?.kind === 'external')
        found.push({ kind: 'external', module: ref.module, name: ref.name })
    }
    return found
  }

  // Every symbol a type is known by: its own, then each of its bases'.
  symbolsOf(type: PyType | undefined, seen = new Set<string>()): string[] {
    if (!type) return []
    const own = typeSymbol(type)
    if (!own || seen.has(own)) return []
    seen.add(own)
    if (type.kind === 'external')
      return [
        own,
        ...(this.externalBases.get(own) ?? []).flatMap((b) => this.symbolsOf(symbolType(b), seen)),
      ]
    if (type.kind !== 'class') return [own]
    return [own, ...this.bases(type.decl).flatMap((b) => this.symbolsOf(b, seen))]
  }

  // The type an annotation states: `Session`, `Annotated[Session, Depends(get_db)]`,
  // `User | None`, `Optional[User]`, `"User"`, a type alias.
  typeOfAnnotation(node: Node | undefined, file: PyFile, depth = 0): PyType | undefined {
    if (!node || depth > 8) return undefined
    switch (node.type) {
      case 'type':
        return this.typeOfAnnotation(node.namedChildren[0] ?? undefined, file, depth + 1)
      case 'identifier':
      case 'attribute': {
        const ref = this.resolve(node, file)
        if (!ref) return undefined
        if (ref.kind === 'decl' && ref.decl.kind === 'class')
          return { kind: 'class', decl: ref.decl, file: ref.file }
        if (ref.kind === 'external') {
          if (ref.module === 'builtins' || ref.module === 'typing') return outside
          return { kind: 'external', module: ref.module, name: ref.name }
        }
        if (ref.kind === 'binding' && ref.binding.kind === 'value') {
          // A type alias: `SessionDep = Annotated[Session, Depends(get_db)]`, `type X = …`.
          const value = ref.binding.type ?? ref.binding.value
          const scope = ref.binding.file
          if (value && atModuleLevel(ref.binding.node)) {
            if (isTypeExpression(value)) {
              // `Annotated[T, …]`, `Optional[T]` and `T | None` stand for `T`; any other type
              // expression is a type of its own, named by the alias: `Scope`.
              const head = genericParts(
                value.type === 'type' ? (value.namedChildren[0] ?? value) : value,
              ).head
              const unwraps =
                /^(Annotated|Optional|Union)$/.test(head?.text.split('.').at(-1) ?? '') ||
                (value.type === 'binary_operator' && value.text.includes('None'))
              const inner = unwraps ? this.typeOfAnnotation(value, scope, depth + 1) : undefined
              if (inner && inner.kind !== 'outside') return inner
              const name =
                node.type === 'identifier' ? node.text : node.childForFieldName('attribute')?.text
              return name ? { kind: 'external', module: scope.module, name } : undefined
            }
          }
        }
        return undefined
      }
      case 'string': {
        const text = stringValue(node)
        if (!text || !/^[A-Za-z_][\w.]*$/.test(text)) return undefined
        const parts = text.split('.')
        const first = parts[0] as string
        const binding = this.lookup(first, node, file)
        const ref = binding ? this.follow(binding) : undefined
        if (parts.length === 1 && ref?.kind === 'decl' && ref.decl.kind === 'class')
          return { kind: 'class', decl: ref.decl, file: ref.file }
        if (parts.length === 1 && ref?.kind === 'external')
          return { kind: 'external', module: ref.module, name: ref.name }
        return undefined
      }
      case 'binary_operator': {
        // `User | None`.
        const sides = [node.childForFieldName('left'), node.childForFieldName('right')].filter(
          (s): s is Node => !!s && s.type !== 'none',
        )
        return sides.length === 1 ? this.typeOfAnnotation(sides[0], file, depth + 1) : undefined
      }
      case 'generic_type':
      case 'subscript': {
        const { head, args } = genericParts(node)
        const name = head?.text.split('.').at(-1)
        if (
          name === 'Annotated' ||
          name === 'Optional' ||
          name === 'Required' ||
          name === 'NotRequired'
        )
          return this.typeOfAnnotation(args[0], file, depth + 1)
        if (name === 'Union') {
          const real = args.filter((a) => a.text !== 'None')
          return real.length === 1 ? this.typeOfAnnotation(real[0], file, depth + 1) : undefined
        }
        if (name === 'Type' || name === 'type') return undefined
        // A generic class of the target: `Repository[User]` is a `Repository`.
        const base = head ? this.typeOfAnnotation(head, file, depth + 1) : undefined
        return base && base.kind !== 'outside' ? base : outside
      }
      case 'none':
        return undefined
      default:
        return undefined
    }
  }

  // The metadata an annotation carries through `Annotated[T, …]`, type aliases followed:
  // `Annotated[Session, Depends(get_db)]` carries `Depends(get_db)`.
  annotated(node: Node | undefined, file: PyFile, depth = 0): { node: Node; file: PyFile }[] {
    if (!node || depth > 8) return []
    if (node.type === 'type')
      return this.annotated(node.namedChildren[0] ?? undefined, file, depth + 1)
    if (node.type === 'generic_type' || node.type === 'subscript') {
      const { head, args } = genericParts(node)
      const name = head?.text.split('.').at(-1)
      if (name === 'Annotated')
        return [
          ...this.annotated(args[0], file, depth + 1),
          ...args
            .slice(1)
            .map((a) => ({ node: a.type === 'type' ? (a.namedChildren[0] ?? a) : a, file })),
        ]
      if (name === 'Optional') return this.annotated(args[0], file, depth + 1)
      return []
    }
    if (node.type === 'binary_operator') {
      return [node.childForFieldName('left'), node.childForFieldName('right')].flatMap((s) =>
        s && s.type !== 'none' ? this.annotated(s, file, depth + 1) : [],
      )
    }
    if (node.type === 'identifier' || node.type === 'attribute') {
      const ref = this.resolve(node, file)
      if (ref?.kind === 'binding' && ref.binding.kind === 'value') {
        const value = ref.binding.type ?? ref.binding.value
        if (value && isTypeExpression(value))
          return this.annotated(value, ref.binding.file, depth + 1)
      }
    }
    return []
  }

  // The type an expression has, as far as the syntax states it.
  typeOf(node: Node | undefined, file: PyFile, depth = 0): PyType | undefined {
    if (!node || depth > 10) return undefined
    if (this.types.has(node.id)) return this.types.get(node.id)
    this.types.set(node.id, undefined)
    const type = this.computeType(node, file, depth)
    this.types.set(node.id, type)
    return type
  }

  private computeType(node: Node, file: PyFile, depth: number): PyType | undefined {
    switch (node.type) {
      case 'parenthesized_expression':
      case 'await':
        return this.typeOf(node.namedChildren[0] ?? undefined, file, depth + 1)
      case 'string':
      case 'concatenated_string':
      case 'integer':
      case 'float':
      case 'list':
      case 'dictionary':
      case 'set':
      case 'tuple':
      case 'list_comprehension':
      case 'dictionary_comprehension':
      case 'set_comprehension':
      case 'true':
      case 'false':
        return outside
      case 'identifier': {
        if (node.text === 'self' || node.text === 'cls') {
          const binding = this.lookup(node.text, node, file)
          if (binding?.kind === 'param' && binding.index === 0) {
            const cls = this.classOf(binding.fn, file)
            if (cls) return { kind: 'class', decl: cls, file: this.byPath.get(cls.file) as PyFile }
          }
        }
        const binding = this.lookup(node.text, node, file)
        if (!binding) return undefined
        return this.typeOfBinding(binding, depth)
      }
      case 'attribute': {
        const object = node.childForFieldName('object')
        const name = node.childForFieldName('attribute')?.text
        if (!object || !name) return undefined
        const ref = this.resolve(node, file)
        if (ref?.kind === 'module')
          return { kind: 'module', module: ref.module, ...(ref.file ? { file: ref.file } : {}) }
        if (ref?.kind === 'binding') return this.typeOfBinding(ref.binding, depth)
        const owner = this.typeOf(object, file, depth + 1)
        return owner ? this.memberType(owner, name, depth + 1) : undefined
      }
      case 'call': {
        const fn = node.childForFieldName('function')
        if (!fn) return undefined
        // `super()` is the instance, seen as its bases.
        if (fn.type === 'identifier' && fn.text === 'super') return undefined
        const targets = this.targets(fn, file)
        for (const target of targets ?? []) {
          if (target.decl?.kind === 'class')
            return {
              kind: 'class',
              decl: target.decl,
              file: this.byPath.get(target.decl.file) as PyFile,
            }
          if (target.decl?.name.endsWith('.__init__') && target.decl.owner)
            return {
              kind: 'class',
              decl: target.decl.owner,
              file: this.byPath.get(target.decl.owner.file) as PyFile,
            }
          if (target.decl) return this.resultType(target.decl, depth)
          if (target.external) {
            const symbol = target.ref.slice('ext:'.length)
            const returned = this.library.returns.get(symbol)
            if (returned) return symbolType(returned)
            const name = symbol.split('#')[1] ?? ''
            // A class outside the target, by its name: `Session(engine)`.
            const last = name.split('.').at(-1) ?? ''
            if (/^[A-Z]/.test(last) && !name.includes('.')) return symbolType(symbol)
            if (symbol.startsWith('builtins#')) return outside
          }
        }
        return undefined
      }
      case 'subscript':
        return undefined
      case 'conditional_expression':
        return this.typeOf(node.namedChildren[0] ?? undefined, file, depth + 1)
      case 'boolean_operator':
        return this.typeOf(node.childForFieldName('left') ?? undefined, file, depth + 1)
      default:
        return undefined
    }
  }

  // What a function returns: its annotation, or the one expression it returns.
  resultType(decl: PyDecl, depth = 0): PyType | undefined {
    if (depth > 10 || decl.kind === 'class') return undefined
    const file = this.byPath.get(decl.file) as PyFile
    const annotation = decl.node.childForFieldName('return_type') ?? undefined
    if (annotation) {
      const type = this.typeOfAnnotation(annotation, file)
      // `-> Generator[Session]` and `-> Iterator[T]` give what they yield, for a dependency.
      const { head, args } = genericParts(annotation.namedChildren[0] ?? annotation)
      if (
        head &&
        /^(Generator|AsyncGenerator|Iterator|AsyncIterator|Iterable|AsyncIterable|Awaitable|Coroutine)$/.test(
          head.text.split('.').at(-1) ?? '',
        )
      )
        return this.typeOfAnnotation(
          /Coroutine/.test(head.text) ? args.at(-1) : args[0],
          file,
          depth + 1,
        )
      if (type) return type
    }
    if (decl.kind === 'literal')
      return this.typeOf(decl.node.childForFieldName('body') ?? undefined, file, depth + 1)
    const body = decl.node.childForFieldName('body')
    const returns = present(body?.descendantsOfType(['return_statement', 'yield']) ?? []).filter(
      (r) => this.enclosing(file, r)?.ref === decl.ref,
    )
    const values = returns.map((r) => r.namedChildren[0]).filter((v): v is Node => !!v)
    if (values.length !== 1) return undefined
    return this.typeOf(values[0], file, depth + 1)
  }

  private typeOfBinding(binding: Binding, depth: number): PyType | undefined {
    const file = binding.file
    switch (binding.kind) {
      case 'decl':
        return undefined
      case 'import': {
        const ref = this.follow(binding)
        if (ref?.kind === 'module')
          return { kind: 'module', module: ref.module, ...(ref.file ? { file: ref.file } : {}) }
        if (ref?.kind === 'binding') return this.typeOfBinding(ref.binding, depth + 1)
        return undefined
      }
      case 'param': {
        if (binding.type) {
          const type = this.typeOfAnnotation(binding.type, file)
          if (type) return type
        }
        if (binding.index === 0 && (binding.name === 'self' || binding.name === 'cls')) {
          const cls = this.classOf(binding.fn, file)
          if (cls) return { kind: 'class', decl: cls, file: this.byPath.get(cls.file) as PyFile }
        }
        return this.given.get(binding.fn.id)?.get(binding.index)
      }
      case 'value': {
        if (binding.type) {
          const type = this.typeOfAnnotation(binding.type, file)
          if (type) return type
        }
        if (binding.iterated) return undefined
        if (binding.value) return this.typeOf(binding.value, file, depth + 1)
        return undefined
      }
    }
  }

  // Parameter types given from outside the syntax: what a handler or a dependency receives.
  private readonly given = new Map<number, Map<number, PyType>>()
  giveParameter(fn: Node, index: number, type: PyType) {
    const map = this.given.get(fn.id) ?? new Map<number, PyType>()
    if (map.has(index)) return
    map.set(index, type)
    this.given.set(fn.id, map)
    // Types already computed may rest on this parameter: they are computed again, once per
    // parameter given, not each time a route names the same handler.
    this.types.clear()
  }

  // The type of an attribute of a value of a type.
  memberType(owner: PyType, name: string, depth = 0): PyType | undefined {
    if (depth > 10) return undefined
    if (owner.kind === 'module') {
      if (!owner.file) return undefined
      const ref = this.exported(owner.module, name)
      if (ref?.kind === 'binding') return this.typeOfBinding(ref.binding, depth + 1)
      if (ref?.kind === 'module')
        return { kind: 'module', module: ref.module, ...(ref.file ? { file: ref.file } : {}) }
      return undefined
    }
    if (owner.kind === 'external') {
      const members = this.members.get(`${owner.module}#${owner.name}`)
      const type = members?.[name]
      return type ? symbolType(type) : undefined
    }
    if (owner.kind !== 'class') return undefined
    const field = this.fieldOf(owner.decl, name, depth)
    if (field) return field
    // A member a base outside the target states.
    for (const base of this.bases(owner.decl)) {
      if (base.kind === 'external') {
        const type = this.memberType(base, name, depth + 1)
        if (type) return type
      }
    }
    return undefined
  }

  // A field of a class: a class-level annotation or assignment, a property's result, or what its
  // methods assign to `self.<name>`.
  private fieldOf(
    cls: PyDecl,
    name: string,
    depth: number,
    seen = new Set<string>(),
  ): PyType | undefined {
    if (seen.has(cls.ref)) return undefined
    seen.add(cls.ref)
    const file = this.byPath.get(cls.file) as PyFile
    const body = cls.node.childForFieldName('body')
    for (const statement of present(body?.namedChildren ?? [])) {
      const assignment =
        statement.type === 'expression_statement' ? statement.namedChildren[0] : undefined
      if (assignment?.type !== 'assignment') continue
      if (assignment.childForFieldName('left')?.text !== name) continue
      const annotation = assignment.childForFieldName('type') ?? undefined
      const type = annotation
        ? this.typeOfAnnotation(annotation, file)
        : this.typeOf(assignment.childForFieldName('right') ?? undefined, file, depth + 1)
      if (type) return type
    }
    const member = this.ownMember(cls, name)
    if (member?.getter) return this.resultType(member, depth + 1)
    // `self.name = …` in a method of the class.
    for (const method of file.decls.filter((d) => d.owner?.ref === cls.ref)) {
      const methodBody = method.node.childForFieldName('body')
      for (const assignment of present(methodBody?.descendantsOfType('assignment') ?? [])) {
        const left = assignment.childForFieldName('left')
        if (
          left?.type !== 'attribute' ||
          left.childForFieldName('object')?.text !== 'self' ||
          left.childForFieldName('attribute')?.text !== name
        )
          continue
        const annotation = assignment.childForFieldName('type') ?? undefined
        const type = annotation
          ? this.typeOfAnnotation(annotation, file)
          : this.typeOf(assignment.childForFieldName('right') ?? undefined, file, depth + 1)
        if (type) return type
      }
    }
    for (const base of this.bases(cls)) {
      if (base.kind !== 'class') continue
      const type = this.fieldOf(base.decl, name, depth + 1, seen)
      if (type) return type
    }
    return undefined
  }

  // The targets of the callee of a call, an analyzer's first.
  callees(fn: Node, file: PyFile): Target[] | undefined {
    const cited = fn.type === 'attribute' ? fn.childForFieldName('attribute') : fn
    const named = cited ? this.analyzed(cited, file) : undefined
    if (!named) return this.targets(fn, file)
    if (named.every((t) => !t.decl)) {
      const own = this.targets(fn, file)
      if (own && own.length > 0 && own.every((t) => !t.decl)) return own
    }
    return named
  }

  analyzed(name: Node, file: PyFile): Target[] | undefined {
    const found = this.analysis?.references.get(placeKey(at(file, name)))
    if (!this.analysis || !found) return undefined
    const analyzer = this.analysis.source
    const target = found.target
    if ('external' in target) {
      const [module, symbol] = target.external.split('#') as [string, string]
      return [
        {
          ref: externalRef(module, symbol),
          external: symbol,
          resolution: 'resolved',
          source: analyzer,
        },
      ]
    }
    const decl = this.declsByPlace.get(placeKey(target))
    // A class called runs its `__init__`, as the syntax reads it.
    if (decl) return [{ ...this.declTarget(decl), source: analyzer }]
    const implementations = (this.analysis.implementations.get(placeKey(target)) ?? [])
      .map((impl) => this.declsByPlace.get(placeKey(impl.at)))
      .filter((d): d is PyDecl => d !== undefined)
      .sort(byRef)
    if (implementations.length === 0) return undefined
    return implementations.map((d) => ({
      ref: d.ref,
      decl: d,
      resolution: 'resolved' as const,
      source: analyzer,
    }))
  }

  private declTarget(decl: PyDecl): Target {
    // Calling a class runs its `__init__`, its own or a base's of the target.
    if (decl.kind === 'class') {
      const init = this.classMember(decl, '__init__')
      if (init) return { ref: init.ref, decl: init, resolution: 'resolved' }
    }
    return { ref: decl.ref, decl, resolution: 'resolved' }
  }

  private externalTarget(
    module: string,
    name: string,
    resolution: 'resolved' | 'guessed' = 'resolved',
    reason?: string,
  ): Target {
    return {
      ref: externalRef(module, name),
      external: name,
      resolution,
      ...(reason ? { reason } : {}),
    }
  }

  // What a callee expression calls, as the syntax states it: a function, a class, a method of a
  // value whose type is known, a symbol outside the target; guessed, with the reason, through an
  // abstract method or a method no type names that the target defines once.
  targets(fn: Node, file: PyFile): Target[] | undefined {
    const ref = this.resolve(fn, file)
    if (ref?.kind === 'decl') {
      // A class used for its type is not called: `Depends()` given nothing calls the annotation.
      return [this.declTarget(ref.decl)]
    }
    if (ref?.kind === 'external') return [this.externalTarget(ref.module, ref.name)]
    if (ref?.kind === 'binding') {
      const binding = ref.binding
      if (binding.kind === 'value' && binding.value?.type === 'lambda') {
        const decl = binding.file.declsById.get(binding.value.id)
        if (decl) return [{ ref: decl.ref, decl, resolution: 'resolved' }]
      }
      // A value called is its type's `__call__`.
      const type = this.typeOfBinding(binding, 0)
      if (type?.kind === 'class') {
        const call = this.classMember(type.decl, '__call__')
        if (call) return [{ ref: call.ref, decl: call, resolution: 'resolved' }]
      }
      if (type?.kind === 'external')
        return [this.externalTarget(type.module, `${type.name}.__call__`)]
      return undefined
    }
    if (fn.type !== 'attribute') return undefined
    const object = fn.childForFieldName('object')
    const name = fn.childForFieldName('attribute')?.text
    if (!object || !name) return undefined
    // `super().method()`: the method of a base.
    if (object.type === 'call' && object.childForFieldName('function')?.text === 'super') {
      const enclosing = this.enclosing(file, fn)
      const cls = enclosing?.owner
      if (!cls) return undefined
      for (const base of this.bases(cls)) {
        if (base.kind === 'class') {
          const found = this.classMember(base.decl, name)
          if (found) return [{ ref: found.ref, decl: found, resolution: 'resolved' }]
        } else if (base.kind === 'external')
          return [this.externalTarget(base.module, `${base.name}.${name}`)]
      }
      return undefined
    }
    const owner = this.typeOf(object, file)
    if (owner?.kind === 'class') return this.methodTargets(owner.decl, name)
    if (owner?.kind === 'external')
      return [this.externalTarget(owner.module, `${owner.name}.${name}`)]
    if (owner?.kind === 'module') {
      if (owner.file) return undefined
      return [this.externalTarget(owner.module, name)]
    }
    if (owner?.kind === 'outside') return undefined
    // A method no type names: the one the target defines by that name, unless values of the
    // language's own types have it too.
    if (this.library.builtins.has(name)) return undefined
    const candidates = this.methodsByName.get(name) ?? []
    if (candidates.length === 1) {
      const decl = candidates[0] as PyDecl
      return [
        { ref: decl.ref, decl, resolution: 'guessed', reason: `the only method named ${name}` },
      ]
    }
    return undefined
  }

  // A method of a value of a class: the one Python finds, and where it is abstract, each override
  // in the target's subclasses, guessed.
  private methodTargets(cls: PyDecl, name: string): Target[] | undefined {
    const found = this.classMember(cls, name)
    if (!found) {
      for (const base of this.allBases(cls)) {
        if (base.kind === 'external')
          return [this.externalTarget(base.module, `${base.name}.${name}`)]
      }
      const overrides = this.overrides(cls, name)
      return overrides.length > 0
        ? overrides.map((d) => ({
            ref: d.ref,
            decl: d,
            resolution: 'guessed' as const,
            reason: `an override of ${cls.name}.${name}`,
          }))
        : undefined
    }
    const targets: Target[] = [{ ref: found.ref, decl: found, resolution: 'resolved' }]
    if (abstract(found)) {
      for (const d of this.overrides(cls, name))
        if (d.ref !== found.ref)
          targets.push({
            ref: d.ref,
            decl: d,
            resolution: 'guessed',
            reason: `an override of ${found.name}`,
          })
    }
    return targets
  }

  private allBases(cls: PyDecl, seen = new Set<string>()): PyType[] {
    if (seen.has(cls.ref)) return []
    seen.add(cls.ref)
    return this.bases(cls).flatMap((b) => [
      b,
      ...(b.kind === 'class' ? this.allBases(b.decl, seen) : []),
    ])
  }

  // The methods of that name of the target's subclasses of a class.
  private overrides(cls: PyDecl, name: string): PyDecl[] {
    if (!this.subclasses) {
      this.subclasses = new Map()
      for (const file of this.files)
        for (const decl of file.decls)
          if (decl.kind === 'class')
            for (const base of this.bases(decl))
              if (base.kind === 'class')
                this.subclasses.set(base.decl.ref, [
                  ...(this.subclasses.get(base.decl.ref) ?? []),
                  decl,
                ])
    }
    const found: PyDecl[] = []
    const visit = (c: PyDecl, seen: Set<string>) => {
      for (const sub of this.subclasses?.get(c.ref) ?? []) {
        if (seen.has(sub.ref)) continue
        seen.add(sub.ref)
        const own = this.ownMember(sub, name)
        if (own) found.push(own)
        visit(sub, seen)
      }
    }
    visit(cls, new Set())
    return found.sort(byRef)
  }

  // The string an expression holds: a literal, or a module-level constant that holds one.
  stringValueOf(node: Node | null | undefined, file: PyFile, depth = 0): string | undefined {
    if (!node || depth > 8) return undefined
    const literal = stringValue(node)
    if (literal !== undefined) return literal
    if (node.type === 'parenthesized_expression')
      return this.stringValueOf(node.namedChildren[0], file, depth + 1)
    if (node.type === 'binary_operator' && node.childForFieldName('operator')?.text === '+') {
      const left = this.stringValueOf(node.childForFieldName('left'), file, depth + 1)
      const right = this.stringValueOf(node.childForFieldName('right'), file, depth + 1)
      return left !== undefined && right !== undefined ? left + right : undefined
    }
    if (node.type === 'identifier' || node.type === 'attribute') {
      const ref = this.resolve(node, file)
      if (
        ref?.kind === 'binding' &&
        ref.binding.kind === 'value' &&
        ref.binding.value &&
        !ref.binding.iterated &&
        !ref.binding.entered
      ) {
        // A name assigned once: a constant.
        const all =
          node.type === 'identifier'
            ? scopesOf(node).length === 0 || atModuleLevel(ref.binding.node)
              ? (ref.binding.file.bindings.get(node.text) ?? [])
              : []
            : []
        if (all.length > 1) return undefined
        return this.stringValueOf(ref.binding.value, ref.binding.file, depth + 1)
      }
      // A setting's default: `settings.API_V1_STR` with `API_V1_STR: str = "/api/v1"`.
      if (node.type === 'attribute') {
        const object = node.childForFieldName('object')
        const name = node.childForFieldName('attribute')?.text
        const owner = object ? this.typeOf(object, file) : undefined
        if (owner?.kind === 'class' && name) return this.classConstant(owner.decl, name, depth)
        const ref2 = object ? this.resolve(object, file) : undefined
        if (ref2?.kind === 'decl' && ref2.decl.kind === 'class' && name)
          return this.classConstant(ref2.decl, name, depth)
      }
    }
    return undefined
  }

  private classConstant(cls: PyDecl, name: string, depth: number): string | undefined {
    const file = this.byPath.get(cls.file) as PyFile
    for (const statement of present(cls.node.childForFieldName('body')?.namedChildren ?? [])) {
      const assignment =
        statement.type === 'expression_statement' ? statement.namedChildren[0] : undefined
      if (assignment?.type !== 'assignment' || assignment.childForFieldName('left')?.text !== name)
        continue
      return this.stringValueOf(assignment.childForFieldName('right'), file, depth + 1)
    }
    for (const base of this.bases(cls))
      if (base.kind === 'class') {
        const found = this.classConstant(base.decl, name, depth + 1)
        if (found !== undefined) return found
      }
    return undefined
  }

  // The strings an expression holds: a list, a tuple or a set of them, or a name that holds one.
  stringsOf(node: Node | null | undefined, file: PyFile, depth = 0): string[] | undefined {
    if (!node || depth > 8) return undefined
    if (['list', 'tuple', 'set'].includes(node.type)) {
      const values = present(node.namedChildren).map((n) => this.stringValueOf(n, file, depth + 1))
      return values.every((v) => v !== undefined) ? (values as string[]) : undefined
    }
    if (node.type === 'identifier') {
      const ref = this.resolve(node, file)
      if (ref?.kind === 'binding' && ref.binding.kind === 'value' && ref.binding.value)
        return this.stringsOf(ref.binding.value, ref.binding.file, depth + 1)
    }
    const one = this.stringValueOf(node, file, depth + 1)
    return one !== undefined ? [one] : undefined
  }

  // The file, declaration and call-graph nodes and edges of the program (D6).
  callGraph(): { graph: Graph; stats: CallStats } {
    const graph: Graph = { files: [], nodes: [], edges: [], facts: [], skips: [] }
    const stats: CallStats = { calls: 0, resolved: 0, guessed: 0, unresolved: 0, analyzed: 0 }
    const externals = new Map<string, GraphNode>()
    const edge = (e: Omit<GraphEdge, 'source'>, from = source) =>
      graph.edges.push({ ...e, source: from })
    const external = (target: Target) => {
      if (target.external && !externals.has(target.ref))
        externals.set(target.ref, { ref: target.ref, kind: 'external', name: target.external })
    }
    for (const file of this.files) {
      graph.files.push({ path: file.path, hash: file.hash, language: 'python' })
      const root = file.tree.rootNode
      graph.nodes.push({
        ref: file.path,
        kind: 'file',
        name: posix.basename(file.path),
        file: file.path,
        startLine: 1,
        endLine: root.endPosition.row + 1,
        fingerprint: fingerprint(root, isComment),
        data: { module: file.module },
      })

      const seenImports = new Set<string>()
      for (const imp of file.imports) {
        const citation = { file: file.path, line: line(imp.node) }
        const inside = this.byModule.get(imp.module)
        // `from a import b` names the module `a.b` only when there is one.
        if (!inside && imp.node.type === 'import_from_statement') {
          const base = imp.node.childForFieldName('module_name')
          const module = base ? absoluteModule(base, file) : undefined
          if (module !== imp.module) continue
        }
        const to = inside ? inside.path : externalRef(imp.module)
        const key = `${to}\0${citation.line}`
        if (seenImports.has(key) || !imp.module) continue
        seenImports.add(key)
        if (!inside && !externals.has(to))
          externals.set(to, { ref: to, kind: 'external', name: imp.module })
        edge({ kind: 'imports', from: file.path, to, citation, data: { path: imp.module } })
      }

      for (const decl of file.decls) {
        const node: GraphNode = {
          ref: decl.ref,
          kind: 'decl',
          name: decl.name,
          file: file.path,
          startLine: line(decl.node),
          endLine: decl.node.endPosition.row + 1,
          // Its own name is left out (D7, D21).
          fingerprint: fingerprint(decl.node, (n) => isComment(n) || n.id === decl.named?.id),
        }
        const data: Record<string, unknown> = {}
        if (decl.kind === 'literal') data.literal = true
        if (decl.kind === 'class') data.class = true
        if (decl.exported) data.exported = true
        if (Object.keys(data).length > 0) node.data = data
        graph.nodes.push(node)
        const citation = { file: file.path, line: line(decl.node) }
        edge({ kind: 'contains', from: file.path, to: decl.ref, citation })
        // A lambda or a nested function is reached through the function that defines it.
        const parent =
          decl.kind !== 'method' && decl.kind !== 'class'
            ? this.enclosing(file, decl.node)
            : undefined
        if (parent) {
          edge({
            kind: 'calls',
            from: parent.ref,
            to: decl.ref,
            citation,
            data: { resolution: 'resolved', literal: true },
          })
        }
      }

      const record = (
        callerRef: string,
        call: Node,
        targets: Target[] | undefined,
        data: Record<string, unknown> = {},
      ) => {
        stats.calls++
        if (!targets || targets.length === 0) {
          stats.unresolved++
          return
        }
        if (targets.some((t) => t.source !== undefined)) stats.analyzed++
        const citation = { file: file.path, line: line(call) }
        for (const target of targets) {
          if (target.resolution === 'resolved') stats.resolved++
          else stats.guessed++
          external(target)
          const resolution =
            target.resolution === 'guessed'
              ? { resolution: 'guessed', reason: target.reason }
              : { resolution: 'resolved' }
          edge(
            {
              kind: 'calls',
              from: callerRef,
              to: target.ref,
              citation,
              data: { ...resolution, ...data },
            },
            target.source,
          )
        }
      }

      for (const call of present(root.descendantsOfType('call'))) {
        const fn = call.childForFieldName('function')
        const caller = this.enclosing(file, call)
        if (!fn || !caller) continue
        if (fn.type !== 'identifier' && fn.type !== 'attribute') continue
        record(caller.ref, call, this.callees(fn, file))
      }

      // A property of the target's own classes runs when its attribute is read.
      for (const access of present(root.descendantsOfType('attribute'))) {
        const parent = access.parent
        if (parent?.type === 'call' && parent.childForFieldName('function')?.id === access.id)
          continue
        if (parent?.type === 'assignment' && parent.childForFieldName('left')?.id === access.id)
          continue
        const name = access.childForFieldName('attribute')?.text
        const object = access.childForFieldName('object')
        if (!name || !object) continue
        const caller = this.enclosing(file, access)
        if (!caller) continue
        const owner = this.typeOf(object, file)
        if (owner?.kind !== 'class') continue
        const found = this.classMember(owner.decl, name)
        if (!found?.getter) continue
        edge({
          kind: 'calls',
          from: caller.ref,
          to: found.ref,
          citation: { file: file.path, line: line(access) },
          data: { resolution: 'resolved', getter: true },
        })
      }

      // A function given to a call runs when what it is given to calls it:
      // `run_in_threadpool(self.debug_response, request, exc)`, `asyncio.to_thread(f)`.
      for (const call of present(root.descendantsOfType('call'))) {
        const caller = this.enclosing(file, call)
        if (!caller) continue
        const args = call.childForFieldName('arguments')
        for (const arg of present(args?.namedChildren ?? [])) {
          const value = arg.type === 'keyword_argument' ? arg.childForFieldName('value') : arg
          if (!value || (value.type !== 'identifier' && value.type !== 'attribute')) continue
          const ref = this.resolve(value, file)
          let decl = ref?.kind === 'decl' ? ref.decl : undefined
          if (!decl && value.type === 'attribute') {
            const object = value.childForFieldName('object')
            const owner = object ? this.typeOf(object, file) : undefined
            const name = value.childForFieldName('attribute')?.text
            if (owner?.kind === 'class' && name) decl = this.classMember(owner.decl, name)
          }
          if (!decl || decl.kind === 'class' || decl.getter || decl.ref === caller.ref) continue
          edge({
            kind: 'calls',
            from: caller.ref,
            to: decl.ref,
            citation: { file: file.path, line: line(value) },
            data: { resolution: 'resolved', reference: true },
          })
        }
      }

      // A function returned as a value (`return handler`) runs when the caller calls what it got.
      for (const statement of present(root.descendantsOfType('return_statement'))) {
        const value = statement.namedChildren[0]
        if (!value || (value.type !== 'identifier' && value.type !== 'attribute')) continue
        const caller = this.enclosing(file, statement)
        const ref = caller ? this.resolve(value, file) : undefined
        if (
          !caller ||
          ref?.kind !== 'decl' ||
          ref.decl.kind === 'class' ||
          ref.decl.ref === caller.ref
        )
          continue
        edge({
          kind: 'calls',
          from: caller.ref,
          to: ref.decl.ref,
          citation: { file: file.path, line: line(value) },
          data: { resolution: 'resolved', reference: true },
        })
      }
    }
    graph.nodes.push(...externals.values())
    return { graph, stats }
  }
}

// The binding of a name in effect at a node: the last one bound before it, or the first.
function pick(bindings: Binding[], at: Node): Binding {
  let found: Binding | undefined
  for (const b of bindings) {
    const node = b.kind === 'decl' ? b.decl.node : b.node
    if (node.startIndex <= at.startIndex) found = b
  }
  return found ?? (bindings[0] as Binding)
}

// Whether a statement is at the top of its module.
const atModuleLevel = (node: Node) =>
  node.parent?.type === 'module' ||
  (node.parent?.type === 'expression_statement' && node.parent.parent?.type === 'module')

// The head and the arguments of `X[a, b]`, as a type or as an expression.
export function genericParts(node: Node): { head?: Node; args: Node[] } {
  if (node.type === 'generic_type') {
    const head = node.namedChildren[0] ?? undefined
    const params = node.namedChildren.find((n) => n?.type === 'type_parameter')
    return { ...(head ? { head } : {}), args: present(params?.namedChildren ?? []) }
  }
  if (node.type === 'subscript') {
    const head = node.childForFieldName('value') ?? undefined
    const args = present(node.childrenForFieldName('subscript'))
    const flat =
      args.length === 1 && args[0]?.type === 'tuple' ? present(args[0].namedChildren) : args
    return { ...(head ? { head } : {}), args: flat }
  }
  return { args: [] }
}

// Whether a module-level value is a type: `Annotated[…]`, `A | B`, `list[int]`.
function isTypeExpression(node: Node): boolean {
  if (node.type === 'type') return true
  if (node.type === 'subscript' || node.type === 'generic_type') return true
  if (node.type === 'binary_operator' && node.childForFieldName('operator')?.text === '|')
    return true
  return false
}

// Whether a method only states itself, for subclasses to define: `...`, `pass`, or
// `raise NotImplementedError`, or `@abstractmethod`.
function abstract(decl: PyDecl): boolean {
  if (decoratorsOf(decl.node).some((d) => /abstractmethod$/.test(d.text))) return true
  const body = present(decl.node.childForFieldName('body')?.namedChildren ?? []).filter(
    (s) =>
      !(s.type === 'expression_statement' && s.namedChildren[0]?.type === 'string') &&
      s.type !== 'comment',
  )
  if (body.length !== 1) return false
  const only = body[0] as Node
  return (
    only.type === 'pass_statement' ||
    (only.type === 'expression_statement' && only.text === '...') ||
    (only.type === 'raise_statement' && /NotImplementedError/.test(only.text))
  )
}

export function symbolType(symbol: string): PyType {
  const at = symbol.indexOf('#')
  return { kind: 'external', module: symbol.slice(0, at), name: symbol.slice(at + 1) }
}

// The symbol a type is known by in profiles: `starlette.requests#Request`, a class of the target
// by its module and its name.
export function typeSymbol(type: PyType | undefined): string | undefined {
  if (!type) return undefined
  if (type.kind === 'external') return `${type.module}#${type.name}`
  if (type.kind === 'class') return `${type.file.module}#${type.decl.name}`
  return undefined
}
