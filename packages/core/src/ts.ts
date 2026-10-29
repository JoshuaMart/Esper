import { posix } from 'node:path'
import type { Node, Tree } from 'web-tree-sitter'
import { type Analysis, type Place, placeKey } from './analyzer.ts'
import type { Callee } from './entries.ts'
import type { Graph, GraphEdge, GraphNode } from './graph.ts'
import type { CallStats } from './language.ts'
import { defineGrammar, loadQuery, parse } from './parser.ts'
import { declRef, externalRef, fingerprint, hashText, Names } from './refs.ts'
import type { TargetFile } from './target.ts'
import { type Docs, readDocs } from './ts-docs.ts'
import { type Package, type Resolved, Resolver } from './ts-modules.ts'

// The TypeScript and JavaScript call graph: declarations, imports and calls, resolved across the
// target's modules where the syntax states what a name is, guessed with a reason where it does not
// (D6). Imports are resolved through the target's own `tsconfig` paths and packages.

defineGrammar('typescript', 'tree-sitter-typescript/tree-sitter-typescript.wasm')
defineGrammar('tsx', 'tree-sitter-typescript/tree-sitter-tsx.wasm')
defineGrammar('javascript', 'tree-sitter-javascript/tree-sitter-javascript.wasm')

const grammarOf = (path: string): { grammar: string; queries: string } | undefined => {
  if (path.endsWith('.d.ts') || /\.d\.[mc]ts$/.test(path)) return undefined
  if (/\.(ts|mts|cts)$/.test(path)) return { grammar: 'typescript', queries: 'typescript' }
  if (path.endsWith('.tsx')) return { grammar: 'tsx', queries: 'typescript' }
  if (/\.(js|jsx|mjs|cjs)$/.test(path)) return { grammar: 'javascript', queries: 'javascript' }
  return undefined
}

export const isTsSource = (path: string) => grammarOf(path) !== undefined

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

const functionTypes = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'arrow_function',
  'method_definition',
])
const literalTypes = new Set(['function_expression', 'generator_function', 'arrow_function'])
const classTypes = new Set(['class_declaration', 'abstract_class_declaration', 'class'])
const wrapperTypes = new Set([
  'parenthesized_expression',
  'as_expression',
  'satisfies_expression',
  'non_null_expression',
])

export interface Decl {
  ref: string
  // Its name within the file: `createApp`, `Hono.fetch`, `createApp/fn3`, `actions.create`.
  name: string
  file: string
  // The function, method or class.
  node: Node
  kind: 'function' | 'method' | 'class' | 'literal'
  // The identifier that names it, left out of its fingerprint (D21), and where an analyzer finds
  // its definition.
  named?: Node
  exported: boolean
  getter?: boolean
}

// What a name is bound to where it is used, as the syntax states it.
export type Binding =
  | { kind: 'decl'; decl: Decl }
  | { kind: 'class'; node: Node; file: TsFile }
  | {
      kind: 'value'
      file: TsFile
      // The declarator, or the assignment, that gives the value.
      node: Node
      value?: Node
      type?: Node
      // For a destructured name, the properties it is taken through: `{ a: { b } } = x` is `a.b`.
      path?: string[]
    }
  | { kind: 'param'; file: TsFile; fn: Node; index: number; type?: Node; path?: string[] }
  | { kind: 'import'; file: TsFile; specifier: string; name: string }
  | { kind: 'unknown' }

interface Export {
  local?: string
  from?: string
  name?: string
  // `export default <expression>`.
  value?: Node
}

export interface TsFile {
  path: string
  dir: string
  hash: string
  tree: Tree
  decls: Decl[]
  declsById: Map<number, Decl>
  // Top-level names: imports, functions, classes, variables.
  bindings: Map<string, Binding>
  // Top-level types: classes, interfaces, type aliases and enums, by name.
  types: Map<string, Node>
  exports: Map<string, Export>
  stars: string[]
  // Each import and re-export, by specifier, with where it is.
  imports: { specifier: string; node: Node }[]
  package?: Package
  // What its documentation comments state, in JavaScript.
  docs?: Docs
}

// A type, as far as the syntax states it.
export type TsType =
  | { kind: 'class'; file: TsFile; node: Node; name: string }
  | { kind: 'interface'; file: TsFile; node: Node; name: string }
  | { kind: 'function'; file: TsFile; node: Node }
  | { kind: 'external'; module: string; name: string }
  | { kind: 'object'; file: TsFile; node: Node }
  // A value whose type is known not to be one of the target's: a string, an array, a value from
  // a module outside the target.
  | { kind: 'outside' }

const outside: TsType = { kind: 'outside' }

// A callee, with the declaration of the target it names.
export interface Target extends Callee {
  decl?: Decl
}

// The names a pattern declares, each with the properties it is taken through.
export function patternNames(pattern: Node, path: string[] = []): { name: Node; path: string[] }[] {
  switch (pattern.type) {
    case 'identifier':
    case 'shorthand_property_identifier_pattern':
      return [{ name: pattern, path }]
    case 'object_pattern':
      return present(pattern.namedChildren).flatMap((child) => {
        if (child.type === 'shorthand_property_identifier_pattern')
          return [{ name: child, path: [...path, child.text] }]
        if (child.type === 'pair_pattern') {
          const key = child.childForFieldName('key')
          const value = child.childForFieldName('value')
          return value && key
            ? patternNames(value, [...path, key.text.replace(/^['"]|['"]$/g, '')])
            : []
        }
        if (child.type === 'object_assignment_pattern') {
          const left = child.childForFieldName('left')
          return left
            ? patternNames(
                left,
                left.type === 'shorthand_property_identifier_pattern' ? [...path, left.text] : path,
              )
            : []
        }
        if (child.type === 'rest_pattern') return patternNames(child.namedChildren[0] as Node, path)
        return []
      })
    case 'array_pattern':
      return present(pattern.namedChildren).flatMap((child, i) =>
        patternNames(child, [...path, String(i)]),
      )
    case 'assignment_pattern': {
      const left = pattern.childForFieldName('left')
      return left ? patternNames(left, path) : []
    }
    case 'rest_pattern':
      return present(pattern.namedChildren).flatMap((child) => patternNames(child, path))
    default:
      return []
  }
}

// What JavaScript files state in their documentation comments, by the tree of each file: the
// type each node is stated to have, and the result types of its functions.
const documented = new WeakMap<Tree, Docs>()

// The type a declarator, a parameter, a field or a cast states, in its syntax or its documentation.
export const typeField = (node: Node): Node | undefined =>
  node.childForFieldName('type') ?? documented.get(node.tree)?.types.get(node.id)

// The result type a function states.
export const returnField = (fn: Node): Node | undefined =>
  fn.childForFieldName('return_type') ?? documented.get(fn.tree)?.returns.get(fn.id)

// The parameters of a function, by position: the pattern and the type each states.
export function parametersOf(fn: Node): { pattern: Node; type?: Node }[] {
  const list = fn.childForFieldName('parameters') ?? fn.childForFieldName('parameter')
  if (!list) return []
  if (list.type === 'identifier') {
    const type = typeField(list)
    return [type ? { pattern: list, type } : { pattern: list }]
  }
  return present(list.namedChildren)
    .filter((p) => p.type !== 'comment')
    .map((p) => {
      if (p.type === 'required_parameter' || p.type === 'optional_parameter') {
        const pattern = p.childForFieldName('pattern') ?? p
        const type = p.childForFieldName('type')
        return type ? { pattern, type } : { pattern }
      }
      const pattern = p.type === 'assignment_pattern' ? (p.childForFieldName('left') ?? p) : p
      const type = documented.get(pattern.tree)?.types.get(pattern.id)
      return type ? { pattern, type } : { pattern }
    })
}

const stringValueOf = (node: Node | null | undefined): string | undefined => {
  if (!node) return undefined
  if (node.type === 'string') return node.text.slice(1, -1)
  if (
    node.type === 'template_string' &&
    !node.namedChildren.some((n) => n?.type === 'template_substitution')
  )
    return node.text.slice(1, -1)
  return undefined
}

// The name of a property key as written: `m`, `'m'`, `[ 'm' ]`.
export function keyName(key: Node | null | undefined): string | undefined {
  if (!key) return undefined
  if (['property_identifier', 'identifier', 'private_property_identifier'].includes(key.type))
    return key.text
  if (key.type === 'string') return key.text.slice(1, -1)
  if (key.type === 'number') return key.text
  if (key.type === 'computed_property_name') return stringValueOf(key.namedChildren[0])
  return undefined
}

async function parseFile(file: TargetFile, resolver: Resolver): Promise<TsFile> {
  const kind = grammarOf(file.path) as { grammar: string; queries: string }
  const tree = await parse(kind.grammar, file.source)
  const root = tree.rootNode
  const [declarations, imports] = await Promise.all([
    loadQuery(kind.grammar, 'declarations', kind.queries),
    loadQuery(kind.grammar, 'imports', kind.queries),
  ])
  const pkg = resolver.packageOf(file.path)
  const parsed: TsFile = {
    path: file.path,
    dir: posix.dirname(file.path),
    hash: hashText(file.source),
    tree,
    decls: [],
    declsById: new Map(),
    bindings: new Map(),
    types: new Map(),
    exports: new Map(),
    stars: [],
    imports: [],
    ...(pkg ? { package: pkg } : {}),
  }
  if (kind.grammar === 'javascript') {
    parsed.docs = await readDocs(root)
    documented.set(tree, parsed.docs)
  }
  for (const match of imports.matches(root)) {
    const spec = match.captures.find((c) => c.name === 'source')?.node.text
    const node = match.captures.find((c) => c.name === 'import' || c.name === 'export')?.node
    if (spec !== undefined && node) parsed.imports.push({ specifier: spec, node })
  }
  // `require('x')` and `import('x')` name modules too.
  for (const call of present(root.descendantsOfType('call_expression'))) {
    const fn = call.childForFieldName('function')
    const [arg] = present(call.childForFieldName('arguments')?.namedChildren ?? [])
    const spec = stringValueOf(arg)
    if (
      spec !== undefined &&
      (fn?.type === 'import' || (fn?.type === 'identifier' && fn.text === 'require'))
    ) {
      parsed.imports.push({ specifier: spec, node: call })
    }
  }

  // Declarations, in source order, so that a parent is named before what it holds.
  const found: { node: Node; capture: string; named?: Node }[] = []
  for (const match of declarations.matches(root)) {
    const capture = match.captures.find((c) =>
      ['function', 'class', 'method', 'literal'].includes(c.name),
    )
    if (!capture) continue
    const named = match.captures.find((c) => c.name === 'name')?.node
    found.push({ node: capture.node, capture: capture.name, ...(named ? { named } : {}) })
  }
  found.sort((a, b) => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex)
  const taken = new Names()
  const ranks = new Map<string, number>()
  const enclosingDecl = (node: Node): Decl | undefined => {
    for (let n = node.parent; n; n = n.parent) {
      const decl = parsed.declsById.get(n.id)
      if (decl) return decl
    }
    return undefined
  }
  // What holds an object literal: `o` for `const o = {…}`, `actions.create` for a nested one,
  // `default` for `export default {…}`; nothing for an object passed or returned.
  const holder = (object: Node): string | undefined => {
    const parent = object.parent
    if (!parent) return undefined
    if (
      parent.type === 'variable_declarator' &&
      parent.childForFieldName('name')?.type === 'identifier'
    )
      return parent.childForFieldName('name')?.text
    if (parent.type === 'pair') {
      const outer = parent.parent
      const key = keyName(parent.childForFieldName('key'))
      const above = outer ? holder(outer) : undefined
      return above && key ? `${above}.${key}` : undefined
    }
    if (parent.type === 'export_statement') return 'default'
    if (['as_expression', 'satisfies_expression', 'parenthesized_expression'].includes(parent.type))
      return holder(parent)
    return undefined
  }
  const local = (decl: Decl | undefined) =>
    decl ? decl.ref.slice(file.path.length + 1) : undefined
  const within = (parent: Decl | undefined, name: string) => {
    const prefix = local(parent)
    return prefix ? `${prefix}/${name}` : name
  }
  // The name a function literal or a method takes from where it sits.
  const nameFor = (
    node: Node,
    named: Node | undefined,
  ): { name: string; named?: Node; anonymous?: boolean; member?: boolean } => {
    const parent = enclosingDecl(node)
    const container = node.parent
    // A member of a class: `Class.member`.
    const classBody =
      container?.type === 'class_body'
        ? container
        : container?.parent?.type === 'class_body'
          ? container.parent
          : undefined
    if (classBody) {
      const cls = parsed.declsById.get(classBody.parent?.id ?? -1)
      const member =
        node.type === 'method_definition'
          ? keyName(node.childForFieldName('name'))
          : keyName(container?.childForFieldName('name'))
      const memberNode =
        node.type === 'method_definition'
          ? node.childForFieldName('name')
          : container?.childForFieldName('name')
      if (cls && member)
        return {
          name: `${local(cls)}.${member}`,
          member: true,
          ...(memberNode ? { named: memberNode } : {}),
        }
    }
    // A property of an object literal: `holder.key`, or `parent/key` for an object no name holds.
    const object =
      node.type === 'method_definition' && container?.type === 'object'
        ? container
        : container?.type === 'pair' && container.parent?.type === 'object'
          ? container.parent
          : undefined
    if (object) {
      const keyNode =
        node.type === 'method_definition'
          ? node.childForFieldName('name')
          : container?.childForFieldName('key')
      const key = keyName(keyNode)
      if (key) {
        const held = holder(object)
        const objectParent = enclosingDecl(object)
        const name = held ? within(objectParent, `${held}.${key}`) : within(objectParent, key)
        return { name, member: true, ...(keyNode ? { named: keyNode } : {}) }
      }
    }
    if (named) return { name: within(parent, named.text), named }
    if (
      container?.type === 'variable_declarator' &&
      container.childForFieldName('name')?.type === 'identifier'
    ) {
      const id = container.childForFieldName('name') as Node
      return { name: within(parent, id.text), named: id }
    }
    if (container?.type === 'export_statement') return { name: 'default' }
    if (
      container?.type === 'assignment_expression' &&
      container.childForFieldName('right')?.id === node.id
    ) {
      const left = container.childForFieldName('left')
      if (left && /^[\w$.]+$/.test(left.text)) {
        const name = left.type === 'member_expression' ? left.childForFieldName('property') : left
        return { name: within(parent, left.text), ...(name ? { named: name } : {}) }
      }
    }
    // At the top of a module, a literal inside what a name holds is named after it:
    // `const auth = createMiddleware(async (c, next) => …)` holds `auth/fn1`.
    let held: string | undefined
    if (!parent) {
      for (let n = node.parent; n; n = n.parent) {
        if (
          n.type === 'variable_declarator' &&
          n.childForFieldName('name')?.type === 'identifier'
        ) {
          held = n.childForFieldName('name')?.text
          break
        }
      }
    }
    const key = local(parent) ?? held ?? ''
    const rank = (ranks.get(key) ?? 0) + 1
    ranks.set(key, rank)
    return held
      ? { name: `${held}/fn${rank}` }
      : { name: within(parent, `fn${rank}`), anonymous: true }
  }
  for (const { node, capture, named } of found) {
    let name: string
    let nameNode = named
    let kind: Decl['kind'] =
      capture === 'literal'
        ? 'literal'
        : capture === 'class'
          ? 'class'
          : capture === 'method'
            ? 'method'
            : 'function'
    if (capture === 'function' || capture === 'class') {
      name = within(enclosingDecl(node), named?.text ?? '_')
    } else if (capture === 'method') {
      // A method of an object literal is a function the object holds.
      const given = nameFor(node, undefined)
      name = given.name
      nameNode = given.named
      if (node.parent?.type === 'object') kind = 'method'
    } else {
      const own =
        node.type === 'function_expression' || node.type === 'generator_function'
          ? node.childForFieldName('name')
          : null
      const given = nameFor(node, own ?? undefined)
      name = given.name
      nameNode = given.named
      // A literal a name holds is a function in its own right; only an anonymous one is a literal.
      kind = given.anonymous ? 'literal' : given.member ? 'method' : 'function'
    }
    const ref = declRef(file.path, taken.take(name))
    const getter = node.type === 'method_definition' && node.children.some((c) => c?.type === 'get')
    const decl: Decl = {
      ref,
      name: ref.slice(file.path.length + 1),
      file: file.path,
      node,
      kind,
      ...(nameNode ? { named: nameNode } : {}),
      exported: false,
      ...(getter ? { getter } : {}),
    }
    parsed.decls.push(decl)
    parsed.declsById.set(node.id, decl)
  }

  // Top-level bindings, types and exports.
  const bind = (name: string, binding: Binding) => {
    if (!parsed.bindings.has(name)) parsed.bindings.set(name, binding)
  }
  const declare = (statement: Node, exported: boolean) => {
    switch (statement.type) {
      case 'import_statement': {
        const spec = statement.childForFieldName('source')?.namedChildren[0]?.text ?? ''
        const clause = statement.namedChildren.find((n) => n?.type === 'import_clause')
        for (const part of present(clause?.namedChildren ?? [])) {
          if (part.type === 'identifier')
            bind(part.text, { kind: 'import', file: parsed, specifier: spec, name: 'default' })
          else if (part.type === 'namespace_import') {
            const id = part.namedChildren[0]
            if (id) bind(id.text, { kind: 'import', file: parsed, specifier: spec, name: '*' })
          } else if (part.type === 'named_imports') {
            for (const s of present(part.namedChildren)) {
              if (s.type !== 'import_specifier') continue
              const name = s.childForFieldName('name')
              const alias = s.childForFieldName('alias') ?? name
              if (name && alias)
                bind(alias.text, {
                  kind: 'import',
                  file: parsed,
                  specifier: spec,
                  name: keyName(name) ?? name.text,
                })
            }
          }
        }
        return
      }
      case 'function_declaration':
      case 'generator_function_declaration': {
        const decl = parsed.declsById.get(statement.id)
        const name = statement.childForFieldName('name')?.text
        if (decl && name) {
          bind(name, { kind: 'decl', decl })
          if (exported) {
            decl.exported = true
            parsed.exports.set(name, { local: name })
          }
        }
        return
      }
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const name = statement.childForFieldName('name')?.text
        if (!name) return
        bind(name, { kind: 'class', node: statement, file: parsed })
        parsed.types.set(name, statement)
        if (exported) {
          parsed.exports.set(name, { local: name })
          const cls = parsed.declsById.get(statement.id)
          if (cls) cls.exported = true
        }
        return
      }
      case 'interface_declaration':
      case 'type_alias_declaration':
      case 'enum_declaration': {
        const name = statement.childForFieldName('name')?.text
        if (name) parsed.types.set(name, statement)
        if (name && statement.type === 'enum_declaration') {
          bind(name, { kind: 'value', file: parsed, node: statement })
        }
        if (name && exported) parsed.exports.set(name, { local: name })
        return
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const declarator of present(statement.namedChildren)) {
          if (declarator.type !== 'variable_declarator') continue
          for (const binding of declaratorBindings(declarator, parsed)) {
            bind(binding.name, binding.binding)
            if (exported) parsed.exports.set(binding.name, { local: binding.name })
          }
        }
        return
      }
      case 'export_statement': {
        const declaration = statement.childForFieldName('declaration')
        const from = statement.childForFieldName('source')?.namedChildren[0]?.text
        const value = statement.childForFieldName('value')
        const clause = statement.namedChildren.find((n) => n?.type === 'export_clause')
        const isDefault = statement.children.some((c) => c?.type === 'default')
        if (declaration) {
          declare(declaration, true)
          if (isDefault) {
            const name = declaration.childForFieldName('name')?.text
            if (name) parsed.exports.set('default', { local: name })
            else parsed.exports.set('default', { value: declaration })
          }
        } else if (value) {
          if (value.type === 'identifier') parsed.exports.set('default', { local: value.text })
          else parsed.exports.set('default', { value })
        } else if (clause) {
          for (const s of present(clause.namedChildren)) {
            if (s.type !== 'export_specifier') continue
            const name = keyName(s.childForFieldName('name'))
            const alias = keyName(s.childForFieldName('alias')) ?? name
            if (!name || !alias) continue
            parsed.exports.set(alias, from !== undefined ? { from, name } : { local: name })
          }
        } else if (from !== undefined) {
          const namespace = statement.namedChildren.find((n) => n?.type === 'namespace_export')
          const alias = namespace?.namedChildren[0]
          if (alias) parsed.exports.set(keyName(alias) ?? alias.text, { from, name: '*' })
          else parsed.stars.push(from)
        }
        return
      }
      case 'expression_statement': {
        // CommonJS: `module.exports = …` and `exports.name = …`.
        const expr = statement.namedChildren[0]
        if (expr?.type !== 'assignment_expression') return
        const left = expr.childForFieldName('left')?.text
        const right = expr.childForFieldName('right')
        if (!right) return
        if (left === 'module.exports')
          parsed.exports.set(
            'default',
            right.type === 'identifier' ? { local: right.text } : { value: right },
          )
        const named = /^(?:module\.)?exports\.([\w$]+)$/.exec(left ?? '')?.[1]
        if (named)
          parsed.exports.set(
            named,
            right.type === 'identifier' ? { local: right.text } : { value: right },
          )
        return
      }
      default:
        return
    }
  }
  for (const statement of present(root.namedChildren)) declare(statement, false)
  // `@import { A } from 'm'` and `@typedef {T} Name`, as an import and a type alias would.
  for (const { name, specifier, imported } of parsed.docs?.imports ?? [])
    bind(name, { kind: 'import', file: parsed, specifier, name: imported })
  for (const [name, node] of parsed.docs?.typedefs ?? [])
    if (!parsed.types.has(name)) parsed.types.set(name, node)
  // What an export names is exported: a function, a class and its public methods, the functions an
  // exported object holds.
  for (const [, exp] of parsed.exports) {
    const binding = exp.local ? parsed.bindings.get(exp.local) : undefined
    const nodes = present([
      binding?.kind === 'decl' ? binding.decl.node : undefined,
      binding?.kind === 'class' ? binding.node : undefined,
      binding?.kind === 'value' ? binding.value : undefined,
      exp.value,
    ])
    for (const node of nodes) markExported(parsed, node)
    // The functions given to the call whose result an exported name holds:
    // `export const upgradeWebSocket = defineWebSocketHelper(async (c) => …)`.
    if (binding?.kind === 'value' && binding.value && exp.local) {
      for (const decl of parsed.decls) {
        if (
          decl.name.startsWith(`${exp.local}/fn`) &&
          !decl.name.slice(exp.local.length + 1).includes('/')
        )
          decl.exported = true
      }
    }
  }
  return parsed
}

// Marks a declaration exported, with what it holds that callers reach through it: the public
// methods of a class, the functions of an object literal.
function markExported(file: TsFile, node: Node) {
  const decl = file.declsById.get(node.id)
  if (decl) decl.exported = true
  const inner = ['as_expression', 'satisfies_expression', 'parenthesized_expression'].includes(
    node.type,
  )
    ? node.namedChildren[0]
    : undefined
  if (inner) markExported(file, inner)
  if (classTypes.has(node.type)) {
    for (const member of present(node.childForFieldName('body')?.namedChildren ?? [])) {
      const privateMember =
        member.childForFieldName('name')?.type === 'private_property_identifier' ||
        member.children.some((c) => c?.type === 'accessibility_modifier' && c.text !== 'public')
      if (privateMember) continue
      const fn = member.type === 'method_definition' ? member : member.childForFieldName('value')
      const memberDecl = fn ? file.declsById.get(fn.id) : undefined
      if (memberDecl) memberDecl.exported = true
    }
  }
  if (node.type === 'object') {
    for (const property of present(node.namedChildren)) {
      const fn =
        property.type === 'method_definition' ? property : property.childForFieldName('value')
      if (fn) markExported(file, fn)
    }
  }
}

// The names a variable declarator binds, with what the syntax states of each.
function declaratorBindings(declarator: Node, file: TsFile): { name: string; binding: Binding }[] {
  const pattern = declarator.childForFieldName('name')
  const value = declarator.childForFieldName('value')
  const type = typeField(declarator)
  if (!pattern) return []
  // `const x = require('m')`, `const { a } = require('m')`.
  const required =
    value?.type === 'call_expression' &&
    value.childForFieldName('function')?.text === 'require' &&
    stringValueOf(value.childForFieldName('arguments')?.namedChildren[0])
  if (required !== undefined && required !== false) {
    return patternNames(pattern).map(({ name, path }) => ({
      name: name.text,
      binding: { kind: 'import', file, specifier: required, name: path[0] ?? '*' },
    }))
  }
  if (pattern.type === 'identifier') {
    const decl = value ? file.declsById.get(value.id) : undefined
    if (decl) return [{ name: pattern.text, binding: { kind: 'decl', decl } }]
    return [
      {
        name: pattern.text,
        binding: {
          kind: 'value',
          file,
          node: declarator,
          ...(value ? { value } : {}),
          ...(type ? { type } : {}),
        },
      },
    ]
  }
  return patternNames(pattern).map(({ name, path }) => ({
    name: name.text,
    binding: { kind: 'value', file, node: declarator, ...(value ? { value } : {}), path },
  }))
}

// The names a block declares directly, hoisted: its variables, functions and classes.
function blockBindings(block: Node, file: TsFile): Map<string, Binding> {
  const found = new Map<string, Binding>()
  for (const statement of present(block.namedChildren)) {
    const inner =
      statement.type === 'export_statement' ? statement.childForFieldName('declaration') : statement
    if (!inner) continue
    if (inner.type === 'lexical_declaration' || inner.type === 'variable_declaration') {
      for (const declarator of present(inner.namedChildren)) {
        if (declarator.type !== 'variable_declarator') continue
        for (const { name, binding } of declaratorBindings(declarator, file))
          if (!found.has(name)) found.set(name, binding)
      }
    } else if (
      inner.type === 'function_declaration' ||
      inner.type === 'generator_function_declaration'
    ) {
      const decl = file.declsById.get(inner.id)
      const name = inner.childForFieldName('name')?.text
      if (decl && name && !found.has(name)) found.set(name, { kind: 'decl', decl })
    } else if (classTypes.has(inner.type)) {
      const name = inner.childForFieldName('name')?.text
      if (name && !found.has(name)) found.set(name, { kind: 'class', node: inner, file })
    }
  }
  return found
}

export type Ref =
  | { kind: 'binding'; binding: Binding; file: TsFile }
  | { kind: 'external'; module: string; name: string }
  | { kind: 'namespace'; file: TsFile }

// Groups declarations under a key, each group sorted by reference.
const byRef = (a: Decl, b: Decl) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)

export interface TsLibrary {
  fluent: Set<string>
  returns: Map<string, string>
  globals: Set<string>
  builtins: Set<string>
}

// The parsed files of a target and what the syntax states about them: the call graph, the types
// of expressions, and the declarations an expression names. Profiles read the program through
// it; `dispose` frees the syntax trees.
export class TsProgram {
  readonly files: TsFile[]
  readonly resolver: Resolver
  private readonly byPath: Map<string, TsFile>
  private readonly library: TsLibrary
  private readonly analysis: Analysis | undefined
  private readonly declsByPlace = new Map<string, Decl>()
  private readonly membersByName = new Map<string, Decl[]>()
  private readonly scopes = new Map<number, Map<string, Binding>>()
  private readonly types = new Map<number, TsType | undefined>()
  // Parameter types given from outside the syntax: a profile says what a handler receives.
  private readonly given = new Map<number, Map<number, TsType>>()
  readonly getters = new Set<string>()

  static async load(
    files: TargetFile[],
    options: {
      library?: Partial<TsLibrary>
      analysis?: Analysis
      aliases?: Record<string, string>
    } = {},
  ): Promise<TsProgram> {
    const sources = files.filter((f) => isTsSource(f.path))
    const resolver = new Resolver(
      files,
      sources.map((f) => f.path),
      options.aliases ? { aliases: options.aliases } : {},
    )
    const parsed = await Promise.all(sources.map((f) => parseFile(f, resolver)))
    return new TsProgram(
      parsed,
      resolver,
      {
        fluent: options.library?.fluent ?? new Set(),
        returns: options.library?.returns ?? new Map(),
        globals: options.library?.globals ?? new Set(),
        builtins: options.library?.builtins ?? new Set(),
      },
      options.analysis,
    )
  }

  private constructor(
    parsed: TsFile[],
    resolver: Resolver,
    library: TsLibrary,
    analysis?: Analysis,
  ) {
    this.files = parsed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    this.byPath = new Map(this.files.map((f) => [f.path, f]))
    this.resolver = resolver
    this.library = library
    this.analysis = analysis
    for (const file of this.files) {
      for (const decl of file.decls) {
        if (decl.named) this.declsByPlace.set(placeKey(at(file, decl.named)), decl)
        if (decl.getter) this.getters.add(decl.name.split('.').at(-1) ?? '')
        if (decl.kind === 'method' || decl.name.includes('.')) {
          const member = decl.name.split(/[./]/).at(-1) ?? ''
          this.membersByName.set(member, [...(this.membersByName.get(member) ?? []), decl])
        }
      }
    }
    for (const list of this.membersByName.values()) list.sort(byRef)
  }

  dispose() {
    for (const file of this.files) {
      file.docs?.tree?.delete()
      file.tree.delete()
    }
  }

  file(path: string): TsFile | undefined {
    return this.byPath.get(path)
  }

  // The innermost declaration that encloses `node`, or the declaration `node` is.
  declOf(file: TsFile, node: Node): Decl | undefined {
    for (let n: Node | null = node; n; n = n.parent) {
      const decl = file.declsById.get(n.id)
      if (decl) return decl
    }
    return undefined
  }

  enclosing(file: TsFile, node: Node): Decl | undefined {
    return node.parent ? this.declOf(file, node.parent) : undefined
  }

  // Gives a function's parameter a type the syntax does not state: what a profile's handlers
  // receive.
  giveParameter(fn: Node, index: number, type: TsType) {
    const params = this.given.get(fn.id) ?? new Map()
    if (params.has(index)) return
    params.set(index, type)
    this.given.set(fn.id, params)
    // Types already computed depend on this parameter only if it was looked up before: the cache
    // is cleared then, and only then.
    if (this.asked.has(fn.id)) {
      this.types.clear()
      this.destructured.clear()
      this.assignedFields.clear()
      this.asked.clear()
    }
  }

  // The functions whose parameters' types were looked up while no profile had given one.
  private readonly asked = new Set<number>()

  // Types of functions that are handlers, from outside the target (`hono#MiddlewareHandler`): a
  // function typed so receives the context first.
  handlerTypes = new Set<string>()
  contextType: TsType | undefined
  // The members of types outside the target, by type and property, as a profile states them:
  // `@sveltejs/kit#RequestEvent` has a `request` that is a `globalThis#Request`.
  members = new Map<string, Record<string, string>>()

  // The string an expression always is: a literal, a template whose parts are, or a constant
  // initialised with one, of the file or one it imports.
  stringValueOf(node: Node | null | undefined, file: TsFile, depth = 0): string | undefined {
    if (!node || this.tooDeep(depth)) return undefined
    if (node.type === 'string') return node.text.slice(1, -1)
    if (node.type === 'template_string') {
      let text = ''
      for (const part of node.children) {
        if (!part) continue
        if (part.type === 'string_fragment' || part.type === 'escape_sequence') text += part.text
        else if (part.type === 'template_substitution') {
          const value = this.stringValueOf(part.namedChildren[0], file, depth + 1)
          if (value === undefined) return undefined
          text += value
        }
      }
      return text
    }
    if (wrapperTypes.has(node.type))
      return this.stringValueOf(node.namedChildren[0], file, depth + 1)
    if (node.type === 'binary_expression' && node.childForFieldName('operator')?.text === '+') {
      const left = this.stringValueOf(node.childForFieldName('left'), file, depth + 1)
      const right = this.stringValueOf(node.childForFieldName('right'), file, depth + 1)
      return left !== undefined && right !== undefined ? left + right : undefined
    }
    if (node.type === 'identifier' || node.type === 'shorthand_property_identifier') {
      const binding = this.lookup(node.text, node, file)
      const ref = binding ? this.follow(binding, file) : undefined
      if (ref?.kind !== 'binding' || ref.binding.kind !== 'value' || ref.binding.path)
        return undefined
      const declaration = ref.binding.node.parent
      if (declaration?.type !== 'lexical_declaration' || !declaration.text.startsWith('const'))
        return undefined
      return this.stringValueOf(ref.binding.value, ref.file, depth + 1)
    }
    if (node.type === 'member_expression') {
      // A property of a constant object: `ROUTES.users`.
      const object = node.childForFieldName('object')
      const property = keyName(node.childForFieldName('property'))
      const type = object ? this.typeOf(object, file) : undefined
      if (type?.kind !== 'object' || !property) return undefined
      for (const p of present(type.node.namedChildren)) {
        if (p.type === 'pair' && keyName(p.childForFieldName('key')) === property)
          return this.stringValueOf(p.childForFieldName('value'), type.file, depth + 1)
      }
    }
    return undefined
  }

  // What a module specifier of a file refers to.
  resolve(file: TsFile, specifier: string): Resolved {
    return this.resolver.resolve(file.path, specifier)
  }

  // What a module exports under a name: a binding of one of the target's files, a symbol outside
  // the target, or a namespace.
  exported(file: TsFile, name: string, seen = new Set<string>()): Ref | undefined {
    const key = `${file.path}\0${name}`
    if (seen.has(key)) return undefined
    seen.add(key)
    if (name === '*') return { kind: 'namespace', file }
    const exp = file.exports.get(name)
    if (exp) {
      if (exp.local !== undefined) {
        const binding = file.bindings.get(exp.local)
        return binding ? this.follow(binding, file, seen) : undefined
      }
      if (exp.from !== undefined) return this.imported(file, exp.from, exp.name ?? name, seen)
      if (exp.value) {
        const decl = file.declsById.get(exp.value.id)
        if (decl) return { kind: 'binding', binding: { kind: 'decl', decl }, file }
        if (classTypes.has(exp.value.type))
          return { kind: 'binding', binding: { kind: 'class', node: exp.value, file }, file }
        return {
          kind: 'binding',
          binding: { kind: 'value', file, node: exp.value, value: exp.value },
          file,
        }
      }
    }
    for (const star of file.stars) {
      const found = this.imported(file, star, name, seen)
      if (found && found.kind !== 'external') return found
    }
    return undefined
  }

  private imported(
    file: TsFile,
    specifier: string,
    name: string,
    seen: Set<string>,
  ): Ref | undefined {
    const resolved = this.resolve(file, specifier)
    if ('external' in resolved) return { kind: 'external', module: resolved.external, name }
    if ('missing' in resolved) return undefined
    const target = this.byPath.get(resolved.file)
    return target ? this.exported(target, name, seen) : undefined
  }

  // A binding, with an import followed to what it names.
  follow(binding: Binding, file: TsFile, seen = new Set<string>()): Ref | undefined {
    if (binding.kind === 'import')
      return this.imported(binding.file, binding.specifier, binding.name, seen)
    return { kind: 'binding', binding, file }
  }

  // What a name is bound to where `at` uses it: the nearest declaration, through blocks, functions
  // and their parameters, up to the file's own names.
  lookup(name: string, at: Node, file: TsFile): Binding | undefined {
    for (let scope = at.parent; scope; scope = scope.parent) {
      if (scope.type === 'program') return file.bindings.get(name)
      if (
        scope.type === 'statement_block' ||
        scope.type === 'class_static_block' ||
        scope.type === 'switch_body'
      ) {
        let names = this.scopes.get(scope.id)
        if (!names) {
          names = blockBindings(scope, file)
          this.scopes.set(scope.id, names)
        }
        const found = names.get(name)
        if (found) return found
      } else if (functionTypes.has(scope.type)) {
        // A parameter's default value sees the parameters before it; the body sees them all.
        const params = parametersOf(scope)
        for (let i = 0; i < params.length; i++) {
          const param = params[i] as { pattern: Node; type?: Node }
          for (const { name: id, path } of patternNames(param.pattern)) {
            if (id.text === name)
              return {
                kind: 'param',
                file,
                fn: scope,
                index: i,
                ...(param.type ? { type: param.type } : {}),
                ...(path.length > 0 ? { path } : {}),
              }
          }
        }
        const own =
          scope.type === 'function_expression' || scope.type === 'generator_function'
            ? scope.childForFieldName('name')
            : null
        if (own?.text === name) {
          const decl = file.declsById.get(scope.id)
          if (decl) return { kind: 'decl', decl }
        }
      } else if (scope.type === 'for_in_statement' || scope.type === 'for_statement') {
        const left = scope.childForFieldName('left') ?? scope.childForFieldName('initializer')
        const declared = left
          ? patternNames(
              left.type === 'lexical_declaration'
                ? (left.namedChildren[0]?.childForFieldName('name') ?? left)
                : left,
            )
          : []
        if (declared.some((d) => d.name.text === name)) return { kind: 'unknown' }
        if (left?.type === 'lexical_declaration' || left?.type === 'variable_declaration') {
          for (const declarator of present(left.namedChildren)) {
            if (declarator.type !== 'variable_declarator') continue
            for (const b of declaratorBindings(declarator, file))
              if (b.name === name) return b.binding
          }
        }
      } else if (scope.type === 'catch_clause') {
        const param = scope.childForFieldName('parameter')
        if (param && patternNames(param).some((d) => d.name.text === name))
          return { kind: 'unknown' }
      } else if (classTypes.has(scope.type) && scope.type === 'class') {
        if (scope.childForFieldName('name')?.text === name)
          return { kind: 'class', node: scope, file }
      }
    }
    return file.bindings.get(name)
  }

  // A type name used at a node: a class, interface or type of the target, or a symbol outside it.
  typeNamed(name: string, at: Node, file: TsFile, depth = 0): TsType | undefined {
    if (this.tooDeep(depth)) return undefined
    const local = file.types.get(name)
    if (local) return this.typeOfDeclaration(local, file, depth)
    const binding = this.lookup(name, at, file)
    if (binding?.kind === 'class')
      return { kind: 'class', file: binding.file, node: binding.node, name }
    if (binding?.kind === 'import') {
      const ref = this.follow(binding, file)
      if (ref?.kind === 'external') return { kind: 'external', module: ref.module, name: ref.name }
      if (ref?.kind === 'binding') {
        if (ref.binding.kind === 'class') {
          const own = ref.binding.node.childForFieldName('name')?.text ?? name
          return { kind: 'class', file: ref.binding.file, node: ref.binding.node, name: own }
        }
        // A type exported under a name: its declaration in its file.
        const declared =
          binding.name === 'default' ? undefined : this.exportedType(ref.file, binding.name)
        if (declared) return declared
      }
      const target = this.resolve(file, binding.specifier)
      if ('file' in target) {
        const other = this.byPath.get(target.file)
        const found = other ? this.exportedType(other, binding.name, depth + 1) : undefined
        if (found) return found
      }
      return this.undeclared(file, target, binding.name)
    }
    if (!binding && this.library.globals.has(name))
      return { kind: 'external', module: 'globalThis', name }
    return undefined
  }

  // A type of the target the index does not read, such as one a declaration file declares, named
  // by the package it belongs to (`@sveltejs/kit#RequestEvent`), as a type outside it would be.
  private undeclared(file: TsFile, target: Resolved, name: string): TsType | undefined {
    if ('external' in target || name === 'default' || name === '*') return undefined
    const pkg = 'file' in target ? this.byPath.get(target.file)?.package : file.package
    return pkg?.name ? { kind: 'external', module: pkg.name, name } : undefined
  }

  // A type a module exports, from a specifier: `import('m').T` in a type.
  private importedType(file: TsFile, specifier: string, name: string, depth: number) {
    const target = this.resolve(file, specifier)
    if ('external' in target) return { kind: 'external' as const, module: target.external, name }
    const other = 'file' in target ? this.byPath.get(target.file) : undefined
    return (
      (other ? this.exportedType(other, name, depth + 1) : undefined) ??
      this.undeclared(file, target, name)
    )
  }

  // A type a file exports under a name, following re-exports.
  private exportedType(
    file: TsFile,
    name: string,
    depth = 0,
    seen = new Set<string>(),
  ): TsType | undefined {
    const key = `${file.path}\0${name}`
    if (seen.has(key) || this.tooDeep(depth)) return undefined
    seen.add(key)
    const exp = file.exports.get(name)
    if (exp?.local !== undefined) {
      const local = file.types.get(exp.local)
      if (local) return this.typeOfDeclaration(local, file, depth + 1)
      const binding = file.bindings.get(exp.local)
      if (binding?.kind === 'import') {
        const target = this.resolve(file, binding.specifier)
        if ('external' in target)
          return { kind: 'external', module: target.external, name: binding.name }
        const other = 'file' in target ? this.byPath.get(target.file) : undefined
        return other ? this.exportedType(other, binding.name, depth + 1, seen) : undefined
      }
    }
    const froms =
      exp?.from !== undefined ? [[exp.from, exp.name ?? name]] : file.stars.map((s) => [s, name])
    for (const [spec, inner] of froms as [string, string][]) {
      const target = this.resolve(file, spec)
      if ('external' in target) {
        if (exp?.from !== undefined)
          return { kind: 'external', module: target.external, name: inner }
        continue
      }
      const other = 'file' in target ? this.byPath.get(target.file) : undefined
      const found = other ? this.exportedType(other, inner, depth + 1, seen) : undefined
      if (found) return found
    }
    return undefined
  }

  private typeOfDeclaration(node: Node, file: TsFile, depth: number): TsType | undefined {
    const name = node.childForFieldName('name')?.text ?? ''
    if (classTypes.has(node.type)) return { kind: 'class', file, node, name }
    if (node.type === 'interface_declaration') return { kind: 'interface', file, node, name }
    if (node.type === 'type_alias_declaration') {
      const value = node.childForFieldName('value')
      if (value?.type === 'object_type') return { kind: 'interface', file, node, name }
      return value ? this.typeOfAnnotation(value, file, depth + 1) : undefined
    }
    return outside
  }

  // A type as written: a name, a generic, a union with `null` or `undefined`, a function type.
  typeOfAnnotation(node: Node, file: TsFile, depth = 0): TsType | undefined {
    if (this.tooDeep(depth)) return undefined
    switch (node.type) {
      case 'type_annotation':
      case 'parenthesized_type':
      case 'readonly_type': {
        const inner = node.namedChildren.at(-1)
        return inner ? this.typeOfAnnotation(inner, file, depth + 1) : undefined
      }
      case 'type_identifier':
        return this.typeNamed(node.text, node, file, depth + 1)
      case 'generic_type': {
        const name = node.childForFieldName('name')
        // `Promise<T>` is what awaiting it gives.
        if (name?.text === 'Promise') {
          const [inner] = present(node.childForFieldName('type_arguments')?.namedChildren ?? [])
          return inner ? this.typeOfAnnotation(inner, file, depth + 1) : undefined
        }
        // `ReturnType<typeof f>` is what `f` returns.
        if (name?.text === 'ReturnType') {
          const [query] = present(node.childForFieldName('type_arguments')?.namedChildren ?? [])
          const named = query?.type === 'type_query' ? query.namedChildren[0] : undefined
          const callee = named?.type === 'instantiation_expression' ? named.namedChildren[0] : named
          if (callee && (callee.type === 'identifier' || callee.type === 'member_expression')) {
            const [target] = this.targets(callee, file) ?? []
            if (target?.decl) {
              const declFile = this.byPath.get(target.decl.file)
              const result = returnField(target.decl.node)
              return declFile && result
                ? this.typeOfAnnotation(result, declFile, depth + 1)
                : undefined
            }
            const known = target ? this.library.returns.get(target.ref.slice(4)) : undefined
            if (known && !/^@\d+$/.test(known)) {
              const [module, type] = known.split('#') as [string, string]
              return { kind: 'external', module, name: type }
            }
          }
          return undefined
        }
        // `Pick<T, …>`, `Partial<T>` and the like have the members of `T` they keep.
        if (name && /^(Pick|Omit|Partial|Required|Readonly|NonNullable)$/.test(name.text)) {
          const [inner] = present(node.childForFieldName('type_arguments')?.namedChildren ?? [])
          return inner ? this.typeOfAnnotation(inner, file, depth + 1) : undefined
        }
        return name ? this.typeOfAnnotation(name, file, depth + 1) : undefined
      }
      case 'nested_type_identifier': {
        const module = node.childForFieldName('module')
        const name = node.childForFieldName('name')?.text
        const binding = module ? this.lookup(module.text, node, file) : undefined
        if (binding?.kind === 'import' && binding.name === '*' && name) {
          const target = this.resolve(file, binding.specifier)
          if ('external' in target) return { kind: 'external', module: target.external, name }
          const other = 'file' in target ? this.byPath.get(target.file) : undefined
          return other ? this.exportedType(other, name, depth + 1) : undefined
        }
        return undefined
      }
      case 'union_type': {
        const parts = present(node.namedChildren).filter(
          (p) =>
            !(p.type === 'literal_type' && /^(null|undefined)$/.test(p.text)) &&
            !/^(null|undefined|void)$/.test(p.text),
        )
        const [only] = parts
        return parts.length === 1 && only ? this.typeOfAnnotation(only, file, depth + 1) : undefined
      }
      // `import('m').T`, as JavaScript's documentation writes a type of another module.
      case 'member_expression': {
        const object = node.childForFieldName('object')
        const name = keyName(node.childForFieldName('property'))
        const [spec] = present(object?.childForFieldName('arguments')?.namedChildren ?? [])
        if (
          object?.type !== 'call_expression' ||
          object.childForFieldName('function')?.type !== 'import' ||
          spec?.type !== 'string' ||
          !name
        )
          return undefined
        return this.importedType(file, spec.text.slice(1, -1), name, depth)
      }
      case 'function_type':
        return { kind: 'function', file, node }
      case 'object_type':
        return { kind: 'interface', file, node, name: '' }
      case 'predefined_type':
      case 'literal_type':
      case 'array_type':
      case 'tuple_type':
      case 'template_literal_type':
        return outside
      default:
        return undefined
    }
  }

  // The type of a parameter: as written, as given by a profile, or from the type of the function
  // that holds it when that is stated (`const h: Handler = (c) => …`, a function returned by a
  // function whose result type is a function type, or passed where a function type is declared).
  private parameterType(
    binding: Extract<Binding, { kind: 'param' }>,
    depth: number,
  ): TsType | undefined {
    // A name destructured from a parameter has the type of the property it is taken through:
    // `({ request }) => …` given an event whose `request` is a `Request`.
    if (binding.path) {
      const { path, ...whole } = binding
      let type = this.parameterType(whole, depth + 1)
      for (const property of path) {
        if (!type) return undefined
        type = /^\d+$/.test(property) ? undefined : this.memberType(type, property, depth + 1)
      }
      return type
    }
    const stated = binding.type
      ? this.typeOfAnnotation(binding.type, binding.file, depth + 1)
      : undefined
    if (stated) return stated
    const given = this.given.get(binding.fn.id)?.get(binding.index)
    if (!given) this.asked.add(binding.fn.id)
    if (given) return given
    const fnType = this.contextualType(binding.fn, binding.file, depth + 1)
    if (
      fnType?.kind === 'external' &&
      binding.index === 0 &&
      this.handlerTypes.has(`${fnType.module}#${fnType.name}`)
    )
      return this.contextType
    const signature = this.signatureOf(fnType)
    const param = signature ? parametersOf(signature.node)[binding.index] : undefined
    return signature && param?.type
      ? this.typeOfAnnotation(param.type, signature.file, depth + 1)
      : undefined
  }

  // The signature a function type gives: the type itself, or the first call signature of an
  // interface (`interface GetCookie { (c: Context): … }`).
  private signatureOf(type: TsType | undefined): { node: Node; file: TsFile } | undefined {
    if (type?.kind === 'function') return { node: type.node, file: type.file }
    if (type?.kind !== 'interface') return undefined
    const body =
      type.node.childForFieldName('body') ?? type.node.childForFieldName('value') ?? type.node
    const call = present(body.namedChildren).find((m) => m.type === 'call_signature')
    return call ? { node: call, file: type.file } : undefined
  }

  // The symbols an expression's type may be, for rules that name types: one, or each member of a
  // union its declaration states (`request: HonoRequest | Request`).
  typeSymbols(node: Node, file: TsFile): string[] {
    const one = typeSymbol(this.typeOf(node, file))
    if (one) return [one]
    if (node.type !== 'identifier') return []
    const binding = this.lookup(node.text, node, file)
    const annotation =
      binding?.kind === 'param' || binding?.kind === 'value' ? binding.type : undefined
    const union =
      annotation?.namedChildren.find((n) => n?.type === 'union_type') ??
      (annotation?.type === 'union_type' ? annotation : undefined)
    if (
      !union ||
      !binding ||
      binding.kind === 'unknown' ||
      binding.kind === 'decl' ||
      binding.kind === 'class' ||
      binding.kind === 'import'
    )
      return []
    return present(union.namedChildren)
      .map((member) => typeSymbol(this.typeOfAnnotation(member, binding.file)))
      .filter((s): s is string => !!s)
  }

  // For a name destructured from a parameter or a value, the symbols of what it is taken from and
  // the properties it is taken through: `request` in `({ request }) => …` is `request` of the
  // parameter's type.
  destructuredFrom(node: Node, file: TsFile): { symbols: string[]; path: string[] } | undefined {
    const binding = this.lookup(node.text, node, file)
    if ((binding?.kind !== 'param' && binding?.kind !== 'value') || !binding.path?.length)
      return undefined
    const { path, ...whole } = binding
    // The symbol of what the names of one pattern are taken from, worked out once.
    const key = whole.kind === 'param' ? `${whole.fn.id}:${whole.index}` : `${whole.node.id}`
    if (!this.destructured.has(key)) {
      const type =
        whole.kind === 'param'
          ? this.parameterType(whole, 0)
          : whole.value
            ? this.typeOf(whole.value, whole.file)
            : undefined
      this.destructured.set(key, typeSymbol(type))
    }
    const symbol = this.destructured.get(key)
    return symbol ? { symbols: [symbol], path } : undefined
  }
  private readonly destructured = new Map<string, string | undefined>()

  // The type a function literal takes from where it sits.
  private contextualType(fn: Node, file: TsFile, depth: number): TsType | undefined {
    if (this.tooDeep(depth)) return undefined
    let node = fn
    while (
      node.parent &&
      ['parenthesized_expression', 'as_expression', 'satisfies_expression'].includes(
        node.parent.type,
      )
    )
      node = node.parent
    const parent = node.parent
    if (!parent) return undefined
    if (parent.type === 'variable_declarator') {
      const type = typeField(parent)
      return type ? this.typeOfAnnotation(type, file, depth + 1) : undefined
    }
    // Returned: by a `return`, or as the body of an arrow.
    let returner: Node | undefined
    if (parent.type === 'return_statement') {
      for (let n = parent.parent; n; n = n.parent) {
        if (functionTypes.has(n.type)) {
          returner = n
          break
        }
      }
    } else if (
      parent.type === 'arrow_function' &&
      parent.childForFieldName('body')?.id === node.id
    ) {
      returner = parent
    }
    if (returner) {
      const result = returnField(returner)
      if (result) return this.typeOfAnnotation(result, file, depth + 1)
      // A function that states no result type returns what its own type says it does:
      // `const m: Middleware = (params) => async (c, next) => …`.
      const outer = this.contextualType(returner, file, depth + 1)
      const signature = this.signatureOf(outer)
      const returns = signature?.node.childForFieldName('return_type')
      return signature && returns
        ? this.typeOfAnnotation(returns, signature.file, depth + 1)
        : undefined
    }
    // Passed where the callee declares a function type.
    if (parent.type === 'arguments') {
      const call = parent.parent
      const index = present(parent.namedChildren).findIndex((n) => n.id === node.id)
      const callee = call?.childForFieldName('function')
      const targets = callee ? (this.targets(callee, file) ?? []) : []
      for (const target of targets) {
        if (!target.decl) continue
        const param = parametersOf(target.decl.node)[index]
        const declFile = this.byPath.get(target.decl.file)
        if (param?.type && declFile) return this.typeOfAnnotation(param.type, declFile, depth + 1)
      }
    }
    return undefined
  }

  // The type of the class a `this` is in.
  private thisType(node: Node, file: TsFile): TsType | undefined {
    for (let n = node.parent; n; n = n.parent) {
      if (n.type === 'function_expression' || n.type === 'function_declaration') return undefined
      if (classTypes.has(n.type)) {
        return { kind: 'class', file, node: n, name: n.childForFieldName('name')?.text ?? '' }
      }
    }
    return undefined
  }

  // The type of an expression, from what the syntax states.
  typeOf(node: Node, file: TsFile, depth = 0): TsType | undefined {
    if (this.tooDeep(depth)) return undefined
    if (this.types.has(node.id)) return this.types.get(node.id)
    const cut = this.cut
    const found = this.computeType(node, file, depth)
    // A type cut short by the depth is not known, and is looked for again from a shallower place.
    if (this.cut === cut) this.types.set(node.id, found)
    return found
  }

  // How many lookups were cut short by their depth: a type found while one was is not cached, since
  // it may be found from a shallower place.
  private cut = 0

  private tooDeep(depth: number): boolean {
    if (depth <= 24) return false
    this.cut++
    return true
  }

  private computeType(node: Node, file: TsFile, depth: number): TsType | undefined {
    switch (node.type) {
      case 'identifier':
      case 'shorthand_property_identifier':
      case 'shorthand_property_identifier_pattern': {
        const binding = this.lookup(node.text, node, file)
        if (!binding) return this.library.globals.has(node.text) ? outside : undefined
        return this.typeOfBinding(binding, file, depth + 1)
      }
      case 'this':
        return this.thisType(node, file)
      case 'parenthesized_expression':
      case 'non_null_expression':
      case 'await_expression': {
        // A cast its documentation states: `/** @type {T} */ (value)`.
        const cast = node.type === 'parenthesized_expression' ? typeField(node) : undefined
        const stated = cast ? this.typeOfAnnotation(cast, file, depth + 1) : undefined
        if (stated) return stated
        const inner = node.namedChildren[0]
        return inner ? this.typeOf(inner, file, depth + 1) : undefined
      }
      case 'as_expression':
      case 'satisfies_expression': {
        const type = node.namedChildren[1]
        if (node.type === 'as_expression' && type) {
          const stated = this.typeOfAnnotation(type, file, depth + 1)
          if (stated) return stated
        }
        const inner = node.namedChildren[0]
        return inner ? this.typeOf(inner, file, depth + 1) : undefined
      }
      case 'new_expression': {
        const ctor = node.childForFieldName('constructor')
        if (!ctor) return undefined
        if (ctor.type === 'identifier') {
          const binding = this.lookup(ctor.text, ctor, file)
          if (binding?.kind === 'class')
            return { kind: 'class', file: binding.file, node: binding.node, name: ctor.text }
          if (binding?.kind === 'import') {
            const ref = this.follow(binding, file)
            if (ref?.kind === 'external')
              return { kind: 'external', module: ref.module, name: ref.name }
            if (ref?.kind === 'binding' && ref.binding.kind === 'class')
              return {
                kind: 'class',
                file: ref.binding.file,
                node: ref.binding.node,
                name: ref.binding.node.childForFieldName('name')?.text ?? ctor.text,
              }
          }
          if (!binding && this.library.globals.has(ctor.text)) {
            const symbol = `globalThis#${ctor.text}`
            return this.library.returns.has(symbol)
              ? this.externalResult(symbol, node, file, depth)
              : { kind: 'external', module: 'globalThis', name: ctor.text }
          }
          return undefined
        }
        const external = this.qualified(ctor, file)
        return external
          ? { kind: 'external', module: external.module, name: external.name }
          : undefined
      }
      case 'object':
        return { kind: 'object', file, node }
      case 'string':
      case 'template_string':
      case 'number':
      case 'array':
      case 'true':
      case 'false':
      case 'null':
      case 'undefined':
      case 'binary_expression': {
        // `a ?? b` and `a || b` are `a` when it is set: the type of `a`, as far as it is known.
        const operator = node.childForFieldName('operator')?.text
        const left = node.childForFieldName('left')
        if ((operator === '??' || operator === '||') && left) {
          const type = this.typeOf(left, file, depth + 1)
          if (type && type.kind !== 'outside') return type
          const right = node.childForFieldName('right')
          return right ? this.typeOf(right, file, depth + 1) : outside
        }
        return outside
      }
      case 'regex':
      case 'unary_expression':
      case 'arrow_function':
      case 'function_expression':
        return outside
      case 'member_expression': {
        const object = node.childForFieldName('object')
        const property = keyName(node.childForFieldName('property'))
        if (!object || !property) return undefined
        const owner = this.typeOf(object, file, depth + 1)
        if (!owner) {
          return this.qualified(object, file) ? outside : undefined
        }
        return this.memberType(owner, property, depth + 1)
      }
      case 'call_expression': {
        const fn = node.childForFieldName('function')
        if (!fn) return undefined
        const targets = this.callees(fn, file) ?? []
        const types = targets.map((t) => this.resultType(t, fn, file, depth + 1))
        const [first] = types
        if (
          types.length > 0 &&
          first &&
          types.every((t) => JSON.stringify(t && typeKey(t)) === JSON.stringify(typeKey(first)))
        )
          return first
        if (fn.type === 'member_expression') {
          const object = fn.childForFieldName('object')
          const owner = object ? this.typeOf(object, file, depth + 1) : undefined
          if (
            owner?.kind === 'external' &&
            this.library.fluent.has(`${owner.module}#${owner.name}`)
          )
            return owner
          if (owner?.kind === 'external' || owner?.kind === 'outside') return outside
        }
        return targets.some((t) => !t.decl) ? outside : undefined
      }
      default:
        return undefined
    }
  }

  // What a callee returns, as its declaration states, or as the library says for a function
  // outside the target.
  private resultType(target: Target, fn: Node, file: TsFile, depth: number): TsType | undefined {
    if (target.decl) {
      const declFile = this.byPath.get(target.decl.file)
      if (!declFile) return undefined
      if (target.decl.kind === 'class')
        return { kind: 'class', file: declFile, node: target.decl.node, name: target.decl.name }
      const result = returnField(target.decl.node)
      if (result) return this.typeOfAnnotation(result, declFile, depth + 1)
      // A function without a result type that returns one expression: the type of that.
      const body = target.decl.node.childForFieldName('body')
      const returned =
        body && body.type !== 'statement_block'
          ? body
          : present(body?.namedChildren ?? []).find((s) => s.type === 'return_statement')
              ?.namedChildren[0]
      return returned ? this.typeOf(returned, declFile, depth + 1) : undefined
    }
    const symbol = target.ref.startsWith('ext:') ? target.ref.slice(4) : undefined
    const call = fn.parent
    return symbol && call ? this.externalResult(symbol, call, file, depth) : outside
  }

  // What a function or class outside the target gives, as the library states it: a type, or the
  // type of one of its arguments.
  private externalResult(
    symbol: string,
    call: Node,
    file: TsFile,
    depth: number,
  ): TsType | undefined {
    const known = this.library.returns.get(symbol)
    // `@n` is the type of the call's n-th argument; `@scope/pkg#Type` is a type.
    if (known && /^@\d+$/.test(known)) {
      const arg = present(call.childForFieldName('arguments')?.namedChildren ?? [])[
        Number(known.slice(1))
      ]
      return arg ? this.typeOf(arg, file, depth + 1) : undefined
    }
    if (known) {
      const [module, name] = known.split('#') as [string, string]
      return { kind: 'external', module, name }
    }
    return outside
  }

  // The type of a member of a type: a field, a getter's result, a property of an object literal.
  memberType(owner: TsType, property: string, depth: number): TsType | undefined {
    if (this.tooDeep(depth)) return undefined
    // A member of a type outside the target, as the profile states it.
    const stated =
      owner.kind === 'external' ? this.members.get(`${owner.module}#${owner.name}`) : undefined
    const symbol = stated?.[property]
    if (symbol) {
      const at = symbol.indexOf('#')
      return { kind: 'external', module: symbol.slice(0, at), name: symbol.slice(at + 1) }
    }
    if (owner.kind === 'external' || owner.kind === 'outside' || owner.kind === 'function')
      return outside
    if (owner.kind === 'object') {
      for (const p of present(owner.node.namedChildren)) {
        if (p.type === 'pair' && keyName(p.childForFieldName('key')) === property) {
          const value = p.childForFieldName('value')
          return value ? this.typeOf(value, owner.file, depth + 1) : undefined
        }
        if (p.type === 'shorthand_property_identifier' && p.text === property)
          return this.typeOf(p, owner.file, depth + 1)
      }
      return undefined
    }
    const member = this.member(owner, property)
    if (!member) return undefined
    if (member.type) return this.typeOfAnnotation(member.type, member.file, depth + 1)
    if (member.value) return this.typeOf(member.value, member.file, depth + 1)
    return undefined
  }

  // A member of a class or an interface of the target, through what it extends.
  member(
    owner: Extract<TsType, { kind: 'class' | 'interface' }>,
    name: string,
    depth = 0,
  ): { file: TsFile; node: Node; type?: Node; value?: Node; decl?: Decl } | undefined {
    if (this.tooDeep(depth)) return undefined
    const body =
      owner.node.type === 'object_type'
        ? owner.node
        : (owner.node.childForFieldName('body') ?? owner.node.childForFieldName('value'))
    for (const m of present(body?.namedChildren ?? [])) {
      const key = keyName(m.childForFieldName('name'))
      if (m.type === 'method_definition' && key === name) {
        const decl = owner.file.declsById.get(m.id)
        const getter = m.children.some((c) => c?.type === 'get')
        const result = returnField(m)
        return {
          file: owner.file,
          node: m,
          ...(getter && result ? { type: result } : {}),
          ...(decl ? { decl } : {}),
        }
      }
      if (
        [
          'public_field_definition',
          'property_signature',
          'method_signature',
          'abstract_method_signature',
        ].includes(m.type) &&
        key === name
      ) {
        const value = m.childForFieldName('value')
        const type = m.type === 'method_signature' ? undefined : typeField(m)
        const decl = value ? owner.file.declsById.get(value.id) : undefined
        return {
          file: owner.file,
          node: m,
          ...(type ? { type } : {}),
          ...(value ? { value } : {}),
          ...(decl ? { decl } : {}),
        }
      }
    }
    // A constructor's parameter property: `constructor(private db: DB)`.
    if (owner.kind === 'class') {
      for (const m of present(body?.namedChildren ?? [])) {
        if (m.type !== 'method_definition' || m.childForFieldName('name')?.text !== 'constructor')
          continue
        for (const param of present(m.childForFieldName('parameters')?.namedChildren ?? [])) {
          const modified = param.children.some(
            (c) => c?.type === 'accessibility_modifier' || c?.type === 'readonly',
          )
          const pattern = param.childForFieldName('pattern')
          const type = param.childForFieldName('type')
          if (modified && pattern?.text === name)
            return { file: owner.file, node: param, ...(type ? { type } : {}) }
        }
      }
    }
    // What the class extends, or the interface extends.
    for (const parent of this.parents(owner)) {
      const found = this.member(parent, name, depth + 1)
      if (found) return found
    }
    return undefined
  }

  private parents(
    owner: Extract<TsType, { kind: 'class' | 'interface' }>,
  ): Extract<TsType, { kind: 'class' | 'interface' }>[] {
    const heritage = owner.node.namedChildren.find(
      (n) => n?.type === 'class_heritage' || n?.type === 'extends_type_clause',
    )
    if (!heritage) return []
    const clauses =
      heritage.type === 'class_heritage'
        ? present(heritage.namedChildren).filter(
            (n) => n.type === 'extends_clause' || n.type === 'identifier',
          )
        : [heritage]
    const found: Extract<TsType, { kind: 'class' | 'interface' }>[] = []
    for (const clause of clauses) {
      const names =
        clause.type === 'identifier'
          ? [clause]
          : present(clause.namedChildren).filter((n) =>
              ['identifier', 'type_identifier', 'generic_type', 'member_expression'].includes(
                n.type,
              ),
            )
      for (const name of names) {
        const text =
          name.type === 'generic_type' ? (name.childForFieldName('name')?.text ?? '') : name.text
        const type = this.typeNamed(text, name, owner.file)
        if (type?.kind === 'class' || type?.kind === 'interface') found.push(type)
      }
    }
    return found
  }

  private typeOfBinding(binding: Binding, file: TsFile, depth: number): TsType | undefined {
    switch (binding.kind) {
      case 'param':
        return this.parameterType(binding, depth)
      case 'value': {
        if (binding.path && binding.path.length > 0) {
          if (!binding.value) return undefined
          let type = this.typeOf(binding.value, binding.file, depth + 1)
          for (const property of binding.path) {
            if (!type) return undefined
            type = /^\d+$/.test(property) ? undefined : this.memberType(type, property, depth + 1)
          }
          return type
        }
        if (binding.type) return this.typeOfAnnotation(binding.type, binding.file, depth + 1)
        if (binding.node.type === 'enum_declaration') return outside
        return binding.value ? this.typeOf(binding.value, binding.file, depth + 1) : undefined
      }
      case 'import': {
        const ref = this.follow(binding, file)
        if (!ref) return undefined
        if (ref.kind === 'external' || ref.kind === 'namespace') return outside
        return ref.binding.kind === 'import'
          ? undefined
          : this.typeOfBinding(ref.binding, ref.file, depth + 1)
      }
      case 'decl':
      case 'class':
        return outside
      default:
        return undefined
    }
  }

  // An expression that names a symbol outside the target: `z`, `z.object`, `Sentry.metrics`,
  // through the imports of the file.
  qualified(node: Node, file: TsFile): { module: string; name: string } | undefined {
    if (node.type === 'identifier') {
      const binding = this.lookup(node.text, node, file)
      if (binding?.kind !== 'import') return undefined
      const ref = this.follow(binding, file)
      return ref?.kind === 'external' ? { module: ref.module, name: ref.name } : undefined
    }
    if (node.type === 'member_expression') {
      const object = node.childForFieldName('object')
      const property = keyName(node.childForFieldName('property'))
      if (!object || !property) return undefined
      const base = this.qualified(object, file)
      if (!base) return undefined
      return {
        module: base.module,
        name: base.name === '*' ? property : `${base.name}.${property}`,
      }
    }
    return undefined
  }

  // What a binding names when it is called: a declaration of the target, or a symbol outside it.
  private bindingTargets(binding: Binding, file: TsFile, depth = 0): Target[] | undefined {
    if (this.tooDeep(depth)) return undefined
    switch (binding.kind) {
      case 'decl':
        return [{ ref: binding.decl.ref, decl: binding.decl, resolution: 'resolved' }]
      case 'class': {
        const ctor = this.classMember(binding.node, binding.file, 'constructor')
        const decl = ctor ?? binding.file.declsById.get(binding.node.id)
        return decl ? [{ ref: decl.ref, decl, resolution: 'resolved' }] : undefined
      }
      case 'import': {
        const ref = this.follow(binding, file)
        if (!ref) return undefined
        if (ref.kind === 'external') {
          const external =
            ref.name === '*' || ref.name === 'default' ? binding.specifier : `${ref.name}`
          return [
            {
              ref: externalRef(ref.module, ref.name === '*' ? undefined : ref.name),
              external,
              resolution: 'resolved',
            },
          ]
        }
        if (ref.kind === 'namespace') return undefined
        return this.bindingTargets(ref.binding, ref.file, depth + 1)
      }
      case 'value': {
        if (binding.path || !binding.value) return undefined
        const decl = binding.file.declsById.get(binding.value.id)
        if (decl) return [{ ref: decl.ref, decl, resolution: 'resolved' }]
        // A name that holds another: `const handler = getProject`.
        if (binding.value.type === 'identifier') {
          const inner = this.lookup(binding.value.text, binding.value, binding.file)
          return inner ? this.bindingTargets(inner, binding.file, depth + 1) : undefined
        }
        if (
          binding.value.type === 'member_expression' ||
          binding.value.type === 'subscript_expression'
        )
          return this.targets(binding.value, binding.file)
        return undefined
      }
      default:
        return undefined
    }
  }

  private classMember(cls: Node, file: TsFile, name: string): Decl | undefined {
    for (const m of present(cls.childForFieldName('body')?.namedChildren ?? [])) {
      if (keyName(m.childForFieldName('name')) !== name) continue
      const fn = m.type === 'method_definition' ? m : m.childForFieldName('value')
      const decl = fn ? file.declsById.get(fn.id) : undefined
      if (decl) return decl
    }
    return undefined
  }

  // What a callee expression names, as the call graph sees it: `f`, `obj.m`, `ns.f`, `new C`.
  // Each target is a declaration of the target or an external reference, resolved or guessed with
  // a reason. `undefined` means the index cannot name it.
  targets(fn: Node, file: TsFile): Target[] | undefined {
    if (literalTypes.has(fn.type)) {
      const decl = file.declsById.get(fn.id)
      return decl ? [{ ref: decl.ref, decl, resolution: 'resolved' }] : undefined
    }
    if (fn.type === 'parenthesized_expression' || fn.type === 'non_null_expression') {
      const inner = fn.namedChildren.at(-1)
      return inner ? this.targets(inner, file) : undefined
    }
    if (fn.type === 'identifier' || fn.type === 'shorthand_property_identifier') {
      const binding = this.lookup(fn.text, fn, file)
      if (binding) return this.bindingTargets(binding, file)
      if (this.library.globals.has(fn.text))
        return [
          { ref: externalRef('globalThis', fn.text), external: fn.text, resolution: 'resolved' },
        ]
      return undefined
    }
    // A function picked from an object by a computed key, `detectors[name]`: each function the
    // object holds may be the one, as guesses.
    if (fn.type === 'subscript_expression') {
      const object = fn.childForFieldName('object')
      const type = object ? this.typeOf(object, file) : undefined
      if (type?.kind !== 'object' || !object) return undefined
      const found: Target[] = []
      for (const p of present(type.node.namedChildren)) {
        const value =
          p.type === 'method_definition'
            ? p
            : p.type === 'pair'
              ? p.childForFieldName('value')
              : p.type === 'shorthand_property_identifier'
                ? p
                : null
        for (const target of (value ? this.targets(value, type.file) : undefined) ?? []) {
          if (target.decl && !found.some((f) => f.ref === target.ref))
            found.push({
              ref: target.ref,
              decl: target.decl,
              resolution: 'guessed',
              reason: `${fn.text} is one of the functions ${object.text} holds`,
            })
        }
      }
      return found.length > 0 ? found : undefined
    }
    if (fn.type !== 'member_expression') return undefined
    const object = fn.childForFieldName('object')
    const name = keyName(fn.childForFieldName('property'))
    if (!object || !name) return undefined
    // A function of a module: `ns.f()` for a namespace import of the target, `z.object()` outside.
    if (object.type === 'identifier') {
      const binding = this.lookup(object.text, object, file)
      if (binding?.kind === 'import') {
        const ref = this.follow(binding, file)
        if (ref?.kind === 'namespace') {
          const exported = this.exported(ref.file, name)
          if (exported?.kind === 'binding')
            return this.bindingTargets(exported.binding, exported.file)
          if (exported?.kind === 'external')
            return this.bindingTargets(
              { kind: 'import', file, specifier: binding.specifier, name },
              file,
            )
          return undefined
        }
      }
      if (binding?.kind === 'class') {
        const decl = this.classMember(binding.node, binding.file, name)
        return decl ? [{ ref: decl.ref, decl, resolution: 'resolved' }] : undefined
      }
      if (!binding && this.library.globals.has(object.text)) {
        const symbol = `${object.text}.${name}`
        return [
          { ref: externalRef('globalThis', symbol), external: symbol, resolution: 'resolved' },
        ]
      }
    }
    const external = this.qualified(fn, file)
    if (external) {
      return [
        {
          ref: externalRef(external.module, external.name),
          external: external.name,
          resolution: 'resolved',
        },
      ]
    }
    if (object.type === 'super') {
      const cls = this.thisType(fn, file)
      const parent = cls?.kind === 'class' ? this.parents(cls)[0] : undefined
      const found = parent ? this.member(parent, name) : undefined
      return found?.decl
        ? [{ ref: found.decl.ref, decl: found.decl, resolution: 'resolved' }]
        : undefined
    }
    const type = this.typeOf(object, file)
    if (type?.kind === 'outside' || type?.kind === 'function') return undefined
    if (type?.kind === 'external') {
      const symbol = `${type.name}.${name}`
      return [{ ref: externalRef(type.module, symbol), external: symbol, resolution: 'resolved' }]
    }
    if (type?.kind === 'object') {
      for (const p of present(type.node.namedChildren)) {
        const key =
          keyName(p.childForFieldName('name') ?? p.childForFieldName('key')) ??
          (p.type === 'shorthand_property_identifier' ? p.text : undefined)
        if (key !== name) continue
        const value =
          p.type === 'method_definition' ? p : p.type === 'pair' ? p.childForFieldName('value') : p
        if (!value) return undefined
        const decl = type.file.declsById.get(value.id)
        if (decl) return [{ ref: decl.ref, decl, resolution: 'resolved' }]
        return value.type === 'identifier' || value.type === 'shorthand_property_identifier'
          ? this.targets(value.type === 'shorthand_property_identifier' ? value : value, type.file)
          : undefined
      }
      return undefined
    }
    if (type?.kind === 'class' || type?.kind === 'interface') {
      const found = this.member(type, name)
      if (found?.decl) return [{ ref: found.decl.ref, decl: found.decl, resolution: 'resolved' }]
      if (found?.value) return this.targets(found.value, found.file)
      // A field of a class assigned a function elsewhere: `this.getPath = strict ? getPath : …`.
      if (type.kind === 'class' && found?.node.type === 'public_field_definition') {
        const assigned = this.fieldAssigned(type, name)
        if (assigned) return assigned
      }
      if (
        type.kind === 'interface' ||
        found?.node.type === 'abstract_method_signature' ||
        found?.node.type === 'method_signature' ||
        found?.node.type === 'property_signature'
      ) {
        const implementations = this.implementations(type, name)
        if (implementations) return implementations
      }
      if (found) return undefined
    }
    // A value of unknown type: the only method of the target with that name is a guess, unless the
    // name is one of the language's own (`map`, `then`), which values of any type have.
    if (this.library.builtins.has(name)) return undefined
    const candidates = this.membersByName.get(name) ?? []
    if (candidates.length !== 1 || !candidates[0]) return undefined
    const why = type
      ? `${type.name || 'the type'} declares no member ${name}`
      : 'receiver type unknown'
    const reason = `${why}; ${candidates[0].name} is the only member named ${name}`
    return [{ ref: candidates[0].ref, decl: candidates[0], resolution: 'guessed', reason }]
  }

  // What a class's own code assigns to one of its fields, as guesses: each function the assigned
  // value may be, through `?:`, `??` and `||`.
  private readonly assignedFields = new Map<string, Target[] | undefined>()

  private fieldAssigned(
    type: Extract<TsType, { kind: 'class' }>,
    name: string,
  ): Target[] | undefined {
    const key = `${type.node.id}\0${name}`
    if (!this.assignedFields.has(key)) this.assignedFields.set(key, this.assignedTo(type, name))
    return this.assignedFields.get(key)
  }

  private assignedTo(type: Extract<TsType, { kind: 'class' }>, name: string): Target[] | undefined {
    const found: Target[] = []
    for (const assignment of present(type.node.descendantsOfType('assignment_expression'))) {
      const left = assignment.childForFieldName('left')
      if (left?.type !== 'member_expression' || left.childForFieldName('object')?.type !== 'this')
        continue
      if (keyName(left.childForFieldName('property')) !== name) continue
      const value = assignment.childForFieldName('right')
      const reason = `${name} is assigned ${value?.text.replace(/\s+/g, ' ').slice(0, 80)}`
      const values: Node[] = []
      const collect = (n: Node | null) => {
        if (!n) return
        if (n.type === 'ternary_expression') {
          collect(n.childForFieldName('consequence'))
          collect(n.childForFieldName('alternative'))
        } else if (
          n.type === 'binary_expression' &&
          /^(\?\?|\|\|)$/.test(n.childForFieldName('operator')?.text ?? '')
        ) {
          collect(n.childForFieldName('left'))
          collect(n.childForFieldName('right'))
        } else if (wrapperTypes.has(n.type)) collect(n.namedChildren[0] ?? null)
        else values.push(n)
      }
      collect(value)
      for (const v of values) {
        if (v.type !== 'identifier' && v.type !== 'member_expression' && !literalTypes.has(v.type))
          continue
        if (
          v.type === 'member_expression' &&
          v.childForFieldName('object')?.type !== 'this' &&
          this.typeOf(v.childForFieldName('object') as Node, type.file)?.kind !== 'class'
        ) {
          // `options.getPath`: a function the caller gives, not one of the target's.
          continue
        }
        for (const target of this.targets(v, type.file) ?? []) {
          if (target.decl && !found.some((f) => f.ref === target.ref))
            found.push({ ref: target.ref, decl: target.decl, resolution: 'guessed', reason })
        }
      }
    }
    return found.length > 0 ? found.sort((a, b) => (a.ref < b.ref ? -1 : 1)) : undefined
  }

  // The methods named `method` of the classes of the target that implement an interface or extend
  // an abstract class, as guesses: which one runs depends on the value.
  // The classes of the target by each name their heritage clause names, built once.
  private heritageIndex?: Map<string, { node: Node; file: TsFile }[]>

  private heritage(): Map<string, { node: Node; file: TsFile }[]> {
    if (this.heritageIndex) return this.heritageIndex
    const index = new Map<string, { node: Node; file: TsFile }[]>()
    for (const file of this.files) {
      for (const node of file.types.values()) {
        if (!classTypes.has(node.type)) continue
        const heritage = node.namedChildren.find((n) => n?.type === 'class_heritage')
        const names = new Set(
          present(heritage?.descendantsOfType(['type_identifier', 'identifier']) ?? []).map(
            (n) => n.text,
          ),
        )
        for (const name of names) index.set(name, [...(index.get(name) ?? []), { node, file }])
      }
    }
    this.heritageIndex = index
    return index
  }

  private implementations(
    type: Extract<TsType, { kind: 'class' | 'interface' }>,
    method: string,
  ): Target[] | undefined {
    const found: Target[] = []
    for (const { node, file } of this.heritage().get(type.name) ?? []) {
      const decl = this.classMember(node, file, method)
      if (decl) {
        const reason = `${node.childForFieldName('name')?.text} implements ${type.name}`
        found.push({ ref: decl.ref, decl, resolution: 'guessed', reason })
      }
    }
    return found.length > 0 ? found.sort((a, b) => (a.ref < b.ref ? -1 : 1)) : undefined
  }

  // What a callee expression calls: the analyzer's answer where it names it, the syntax's
  // otherwise (D22).
  callees(fn: Node, file: TsFile): Target[] | undefined {
    const cited =
      fn.type === 'member_expression'
        ? fn.childForFieldName('property')
        : fn.type === 'identifier'
          ? fn
          : null
    const named = cited ? this.analyzed(cited, file) : undefined
    if (!named) return this.targets(fn, file)
    // A symbol outside the target is named by the module the code imports it from (`hono/cors`),
    // as profiles and the library name it; an analyzer names the package that declares it. Where
    // both name one outside the target, the import's name is kept.
    if (named.every((t) => !t.decl)) {
      const own = this.targets(fn, file)
      if (own && own.length > 0 && own.every((t) => !t.decl)) return own
    }
    return named
  }

  // What an analyzer says a name refers to: a declaration of the target, or a symbol outside it,
  // or each method that implements the interface method it names.
  analyzed(name: Node, file: TsFile): Target[] | undefined {
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
    if (decl) return [{ ref: decl.ref, decl, resolution: 'resolved', source: analyzer }]
    const implementations = (this.analysis.implementations.get(placeKey(target)) ?? [])
      .map((impl) => this.declsByPlace.get(placeKey(impl.at)))
      .filter((d): d is Decl => d !== undefined)
      .sort(byRef)
    if (implementations.length === 0) return undefined
    const iface = this.interfaceMethod(target, found.name)
    return implementations.map((d) => ({
      ref: d.ref,
      decl: d,
      resolution: 'resolved' as const,
      source: analyzer,
      ...(iface ? { interface: iface } : {}),
    }))
  }

  private interfaceMethod(place: Place, name: string): string | undefined {
    const file = this.byPath.get(place.file)
    let node: Node | null | undefined = file?.tree.rootNode.descendantForPosition({
      row: place.line - 1,
      column: place.column - 1,
    })
    for (; node; node = node.parent) {
      if (node.type === 'interface_declaration' || classTypes.has(node.type))
        return `${node.childForFieldName('name')?.text}.${name}`
    }
    return undefined
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
      graph.files.push({ path: file.path, hash: file.hash, language: 'typescript' })
      const root = file.tree.rootNode
      graph.nodes.push({
        ref: file.path,
        kind: 'file',
        name: posix.basename(file.path),
        file: file.path,
        startLine: 1,
        endLine: root.endPosition.row + 1,
        fingerprint: fingerprint(root, isComment),
        ...(file.package?.name ? { data: { package: file.package.name } } : {}),
      })

      const seenImports = new Set<string>()
      for (const imp of file.imports) {
        const citation = { file: file.path, line: line(imp.node) }
        const data = { path: imp.specifier }
        const resolved = this.resolve(file, imp.specifier)
        const to =
          'file' in resolved
            ? resolved.file
            : 'external' in resolved
              ? externalRef(resolved.external)
              : undefined
        if (!to) continue
        const key = `${to}\0${citation.line}`
        if (seenImports.has(key)) continue
        seenImports.add(key)
        if ('external' in resolved && !externals.has(to))
          externals.set(to, { ref: to, kind: 'external', name: resolved.external })
        edge({ kind: 'imports', from: file.path, to, citation, data })
      }

      for (const decl of file.decls) {
        const node: GraphNode = {
          ref: decl.ref,
          kind: 'decl',
          name: decl.name,
          file: file.path,
          startLine: line(decl.node),
          endLine: decl.node.endPosition.row + 1,
          // Its own name is left out, so that a function renamed without other change is found
          // again by its code, and the notes on it follow it (D7, D21).
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
        // A literal is reached through the function that defines it, as Go's are; so is a method
        // of an object literal it defines: `{ getClientAddress() { … } }` is
        // `{ getClientAddress: () => … }`.
        const parent =
          literalTypes.has(decl.node.type) ||
          (decl.node.type === 'method_definition' && decl.node.parent?.type === 'object')
            ? this.enclosing(file, decl.node)
            : undefined
        if (parent && parent.kind !== 'class') {
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
              : {
                  resolution: 'resolved',
                  ...(target.interface ? { interface: target.interface } : {}),
                }
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

      for (const call of present(root.descendantsOfType(['call_expression', 'new_expression']))) {
        const fn = call.childForFieldName(
          call.type === 'new_expression' ? 'constructor' : 'function',
        )
        const caller = this.enclosing(file, call)
        if (!fn || !caller) continue
        if (
          literalTypes.has(fn.type) ||
          fn.type === 'import' ||
          (fn.type === 'identifier' && fn.text === 'require')
        )
          continue
        if (fn.type !== 'identifier' && fn.type !== 'member_expression') continue
        record(caller.ref, call, this.callees(fn, file))
      }

      // A getter of the target's own classes runs when its property is read: `c.req` calls the
      // getter `Context.req`.
      if (this.getters.size > 0) {
        for (const access of present(root.descendantsOfType('member_expression'))) {
          const property = keyName(access.childForFieldName('property'))
          if (!property || !this.getters.has(property)) continue
          const parent = access.parent
          if (
            parent?.type === 'call_expression' &&
            parent.childForFieldName('function')?.id === access.id
          )
            continue
          if (
            parent?.type === 'assignment_expression' &&
            parent.childForFieldName('left')?.id === access.id
          )
            continue
          const caller = this.enclosing(file, access)
          const object = access.childForFieldName('object')
          const owner = object ? this.typeOf(object, file) : undefined
          if (!caller || (owner?.kind !== 'class' && owner?.kind !== 'interface')) continue
          const found = this.member(owner, property)
          if (!found?.decl?.getter) continue
          const target: Target = { ref: found.decl.ref, decl: found.decl, resolution: 'resolved' }
          edge({
            kind: 'calls',
            from: caller.ref,
            to: target.ref,
            citation: { file: file.path, line: line(access) },
            data: { resolution: 'resolved', getter: true },
          })
        }
      }

      // A function returned as a value (`return handler`) runs when the caller calls what it got.
      for (const node of present(root.descendantsOfType(['identifier', 'member_expression']))) {
        if (!returned(node)) continue
        const caller = this.enclosing(file, node)
        const targets = caller ? this.callees(node, file) : undefined
        if (!caller || !targets) continue
        const citation = { file: file.path, line: line(node) }
        for (const target of targets) {
          if (
            !target.decl ||
            target.resolution !== 'resolved' ||
            target.ref === caller.ref ||
            target.decl.kind === 'class'
          )
            continue
          edge(
            {
              kind: 'calls',
              from: caller.ref,
              to: target.ref,
              citation,
              data: { resolution: 'resolved', reference: true },
            },
            target.source,
          )
        }
      }
    }
    graph.nodes.push(...externals.values())
    return { graph, stats }
  }
}

// Whether a name is a value its function returns: `return h`, `return wrap(h)`, `=> h`.
const throughValues = new Set([
  'arguments',
  'parenthesized_expression',
  'as_expression',
  'satisfies_expression',
  'array',
  'pair',
  'object',
  'await_expression',
])
function returned(node: Node): boolean {
  const parent = node.parent
  if (!parent) return false
  if (parent.type === 'call_expression' || parent.type === 'new_expression') {
    const fn = parent.childForFieldName(
      parent.type === 'call_expression' ? 'function' : 'constructor',
    )
    if (fn?.id === node.id) return false
    return returned(parent)
  }
  if (parent.type === 'member_expression') return false
  if (parent.type === 'return_statement') return true
  if (parent.type === 'arrow_function') return parent.childForFieldName('body')?.id === node.id
  if (parent.type === 'pair' && parent.childForFieldName('key')?.id === node.id) return false
  return throughValues.has(parent.type) && returned(parent)
}

const typeKey = (t: TsType): string =>
  t.kind === 'external'
    ? `${t.module}#${t.name}`
    : t.kind === 'outside'
      ? 'outside'
      : `${t.kind}:${t.file.path}:${t.node.startIndex}`

// The symbol a type is known by in profiles: `hono#Context` for one outside the target, and for a
// class or an interface of the target, the name of its package and its own: a framework's own
// `Context`, declared in `src/context.ts` of the package `hono`, is `hono#Context` too.
export function typeSymbol(type: TsType | undefined): string | undefined {
  if (!type) return undefined
  if (type.kind === 'external') return `${type.module}#${type.name}`
  if (type.kind === 'class' || type.kind === 'interface')
    return type.name ? `${type.file.package?.name ?? '.'}#${type.name}` : undefined
  return undefined
}
