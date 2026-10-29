import type { Node, Tree } from 'web-tree-sitter'
import { parse } from './parser.ts'

// The types a JavaScript file states in its documentation comments (D24): `@param {T} name`,
// `@type {T}` on a declaration, a parameter or a cast `/** @type {T} */ (x)`, `@returns {T}`,
// `@typedef {T} Name` and `@import { A } from 'm'`. TypeScript reads them as it reads a type
// annotation, and so does the index: each type is parsed as TypeScript and stands where an
// annotation would.

export interface Docs {
  // The type each node is stated to have: a parameter's pattern, a variable declarator, a
  // parenthesized expression cast.
  types: Map<number, Node>
  // The result type of each function.
  returns: Map<number, Node>
  // `@typedef`, by name: the type alias it declares.
  typedefs: Map<string, Node>
  // `@import`, as an import statement would bind them.
  imports: { name: string; specifier: string; imported: string }[]
  // The tree the types were parsed in, freed with the file's own.
  tree?: Tree
}

const functions = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'arrow_function',
  'method_definition',
])

// The text between the braces of a tag, braces inside it balanced: `{{ a: X }}` is `{ a: X }`.
function braced(text: string, from: number): { type: string; end: number } | undefined {
  const open = text.indexOf('{', from)
  if (open < 0) return undefined
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return { type: text.slice(open + 1, i), end: i + 1 }
  }
  return undefined
}

// A type as TypeScript would write it: JSDoc's `*` is `any`, `?T` and `T=` drop their marks, and
// the type arguments of `import('m').T<…>`, which the grammar does not read there, are dropped.
function clean(type: string): string {
  let text = type
    .replace(/\n\s*\*/g, ' ')
    .trim()
    .replace(/^\?/, '')
    .replace(/=$/, '')
  if (text === '*') text = 'any'
  // Each `import('m').A.B` once, and the type arguments right after it skipped.
  let out = ''
  let from = 0
  for (const match of text.matchAll(/import\(\s*['"][^'"]+['"]\s*\)(\.[\w$]+)+/g)) {
    const end = (match.index ?? 0) + match[0].length
    if (end < from) continue
    out += text.slice(from, end)
    from = end
    if (text[end] !== '<') continue
    let depth = 0
    for (let i = end; i < text.length; i++) {
      if (text[i] === '<') depth++
      else if (text[i] === '>' && --depth === 0) {
        from = i + 1
        break
      }
    }
  }
  out += text.slice(from)
  return out
}

interface Tag {
  tag: string
  type?: string
  name?: string
  rest: string
}

function tagsOf(comment: string): Tag[] {
  const body = comment.replace(/^\/\*\*/, '').replace(/\*\/$/, '')
  const tags: Tag[] = []
  const at = /(^|\n)\s*\*?\s*@(\w+)/g
  const starts = [...body.matchAll(at)]
  starts.forEach((match, i) => {
    const start = (match.index ?? 0) + match[0].length
    const end = starts[i + 1]?.index ?? body.length
    const text = body.slice(start, end)
    const tag = match[2] as string
    const type = text.trimStart().startsWith('{') ? braced(text, 0) : undefined
    const after = type ? text.slice(type.end) : text
    const name = /^\s*\[?\s*([\w$.]+)/.exec(after)?.[1]
    tags.push({
      tag,
      ...(type ? { type: clean(type.type) } : {}),
      ...(name ? { name } : {}),
      rest: text,
    })
  })
  return tags
}

// What a documentation comment documents: the next statement, member or parameter.
function documented(comment: Node): Node | undefined {
  let next = comment.nextNamedSibling
  while (next?.type === 'comment') next = next.nextNamedSibling
  return next ?? undefined
}

// The functions and declarators a documented node holds.
function targetsOf(node: Node): { fn?: Node; declarator?: Node } {
  let inner = node
  if (inner.type === 'export_statement') {
    const declaration = inner.childForFieldName('declaration') ?? inner.childForFieldName('value')
    if (declaration) inner = declaration
  }
  if (functions.has(inner.type)) return { fn: inner }
  if (inner.type === 'lexical_declaration' || inner.type === 'variable_declaration') {
    const declarator = inner.namedChildren.find((n) => n?.type === 'variable_declarator')
    const value = declarator ? unwrap(declarator.childForFieldName('value')) : undefined
    return {
      ...(declarator ? { declarator } : {}),
      ...(value && functions.has(value.type) ? { fn: value } : {}),
    }
  }
  if (inner.type === 'pair' || inner.type === 'public_field_definition') {
    const value = unwrap(inner.childForFieldName('value'))
    return value && functions.has(value.type) ? { fn: value } : {}
  }
  if (inner.type === 'expression_statement') {
    const expr = inner.namedChildren[0]
    if (expr?.type === 'assignment_expression') {
      const value = unwrap(expr.childForFieldName('right'))
      return value && functions.has(value.type) ? { fn: value } : {}
    }
  }
  return {}
}

const unwrap = (node: Node | null | undefined): Node | undefined => {
  let n = node ?? undefined
  while (n && n.type === 'parenthesized_expression') n = n.namedChildren[0] ?? undefined
  return n
}

const parameterPatterns = (fn: Node): Node[] => {
  const list = fn.childForFieldName('parameters') ?? fn.childForFieldName('parameter')
  if (!list) return []
  if (list.type === 'identifier') return [list]
  return list.namedChildren
    .filter((p): p is Node => !!p && p.type !== 'comment')
    .map((p) => (p.type === 'assignment_pattern' ? (p.childForFieldName('left') ?? p) : p))
}

// Reads the documentation comments of a JavaScript file's tree.
export async function readDocs(root: Node): Promise<Docs> {
  const docs: Docs = { types: new Map(), returns: new Map(), typedefs: new Map(), imports: [] }
  // Each type to parse, with where it goes once parsed.
  const pending: { type: string; put: (node: Node) => void }[] = []
  const want = (type: string | undefined, put: (node: Node) => void) => {
    if (type) pending.push({ type, put })
  }
  for (const comment of root.descendantsOfType('comment')) {
    if (!comment?.text.startsWith('/**')) continue
    const tags = tagsOf(comment.text)
    if (tags.length === 0) continue
    for (const tag of tags) {
      if (tag.tag === 'import') {
        const match = /^\s*(\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)\s+from\s+['"]([^'"]+)['"]/.exec(
          tag.rest,
        )
        if (!match?.[1] || !match[2]) continue
        const what = match[1]
        if (what.startsWith('{')) {
          for (const part of what.slice(1, -1).split(',')) {
            const [imported, alias] = part.split(/\s+as\s+/).map((s) => s.trim())
            if (imported)
              docs.imports.push({ name: alias || imported, specifier: match[2], imported })
          }
        } else if (what.startsWith('*')) {
          const name = what.split(/\s+/).at(-1) as string
          docs.imports.push({ name, specifier: match[2], imported: '*' })
        } else docs.imports.push({ name: what, specifier: match[2], imported: 'default' })
      } else if (tag.tag === 'typedef' && tag.type && tag.name) {
        const name = tag.name
        want(tag.type, (node) => {
          if (!docs.typedefs.has(name) && node.parent) docs.typedefs.set(name, node.parent)
        })
      }
    }
    // A cast: `/** @type {T} */ (value)`.
    const typeTag = tags.find((t) => t.tag === 'type' || t.tag === 'satisfies')
    const next = comment.nextSibling
    if (
      typeTag &&
      next?.type === 'parenthesized_expression' &&
      next.startIndex >= comment.endIndex
    ) {
      if (typeTag.tag === 'type') want(typeTag.type, (node) => docs.types.set(next.id, node))
      continue
    }
    // A parameter documented in place: `(/** @type {T} */ value)`.
    if (typeTag && comment.parent?.type === 'formal_parameters') {
      let param = documented(comment)
      if (param?.type === 'assignment_pattern') param = param.childForFieldName('left') ?? param
      if (param) want(typeTag.type, (node) => docs.types.set((param as Node).id, node))
      continue
    }
    const target = documented(comment)
    if (!target) continue
    const { fn, declarator } = targetsOf(target)
    if (typeTag && declarator) want(typeTag.type, (node) => docs.types.set(declarator.id, node))
    if (typeTag && !declarator && target.type === 'public_field_definition')
      want(typeTag.type, (node) => docs.types.set(target.id, node))
    if (!fn) continue
    const params = parameterPatterns(fn)
    const documentedParams = tags.filter(
      (t) => t.tag === 'param' && t.name && !t.name.includes('.'),
    )
    documentedParams.forEach((tag, i) => {
      // A parameter by its name, or by its position when it is destructured.
      const param =
        params.find((p) => p.type === 'identifier' && p.text === tag.name) ??
        (params[i] && params[i]?.type !== 'identifier' ? params[i] : undefined)
      if (param) want(tag.type, (node) => docs.types.set(param.id, node))
    })
    const returns = tags.find((t) => t.tag === 'returns' || t.tag === 'return')
    want(returns?.type, (node) => docs.returns.set(fn.id, node))
  }
  if (pending.length === 0) return docs
  // Every type of the file, parsed at once: `type __0 = T0;` on a line of its own.
  const source = pending.map((p, i) => `type __${i} = ${p.type};`).join('\n')
  const tree = await parse('typescript', source)
  docs.tree = tree
  for (const alias of tree.rootNode.namedChildren) {
    if (alias?.type !== 'type_alias_declaration') continue
    const index = Number(alias.childForFieldName('name')?.text.slice(2))
    const value = alias.childForFieldName('value')
    const entry = pending[index]
    if (entry && value && !alias.hasError) entry.put(value)
  }
  return docs
}
