import { posix } from 'node:path'
import type { Node } from 'web-tree-sitter'
import type { Analysis } from './analyzer.ts'
import { addEntries, type Route } from './entries.ts'
import {
  declaredAt,
  type GoFile,
  type GoModuleRoot,
  GoProgram,
  type Located,
  line,
  type ParsedFile,
  present,
} from './go.ts'
import { RouteInterpreter } from './go-routes.ts'
import { declFacts } from './go-signals.ts'
import type { Fact, Graph } from './graph.ts'
import type { IndexStats, Language, Module } from './language.ts'
import { loadLibrary } from './library.ts'
import type { ReadKind, ReadRule, ResolvedProfile } from './profile.ts'

// A Go target indexed with a profile: the call graph, the entry points with their chains and
// handlers, and what each declaration and entry point reads from the request (D6).

interface ChainItem {
  field?: string
  call?: { name: boolean }
}

// `URL.Query().Get(name)` is the field `URL`, the field `Query`, a call, the field `Get`, and a
// call whose argument names what is read.
function parseChain(chain: string): ChainItem[] {
  return chain.split('.').flatMap((part) => {
    const match = /^([A-Za-z_]\w*)(\((name)?\))?$/.exec(part)
    if (!match?.[1]) return []
    const items: ChainItem[] = [{ field: match[1] }]
    if (match[2]) items.push({ call: { name: match[3] === 'name' } })
    return items
  })
}

// The fields and calls applied to a value, outward from it: `r.Header.Get("X")` from `r`.
function chainFrom(node: Node): { field?: string; args?: Node[]; node: Node }[] {
  const items: { field?: string; args?: Node[]; node: Node }[] = []
  let current = node
  for (let parent = current.parent; parent; current = parent, parent = parent.parent) {
    if (
      parent.type === 'selector_expression' &&
      parent.childForFieldName('operand')?.id === current.id
    ) {
      items.push({ field: parent.childForFieldName('field')?.text ?? '', node: parent })
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

function extractReads(program: GoProgram, profile: ResolvedProfile): Fact[] {
  const facts: Fact[] = []
  const source = `tree-sitter:${profile.name}`
  const chains = profile.reads
    .filter((r): r is Extract<ReadRule, { chain: string }> => 'chain' in r)
    .map((rule) => ({ rule, items: parseChain(rule.chain) }))
    .sort((a, b) => b.items.length - a.items.length)
  const calls = new Map(
    profile.reads
      .filter((r): r is Extract<ReadRule, { call: string }> => 'call' in r)
      .map((rule) => [`ext:${rule.call}`, rule]),
  )
  const add = (file: ParsedFile, at: Node, read: ReadKind, name: string | undefined) => {
    const decl = program.declOf(file, at)
    if (!decl) return
    const citation = { file: file.path, line: line(at) }
    facts.push({
      node: decl.ref,
      kind: 'read',
      value: name ? `${read}.${name}` : read,
      citation,
      source,
    })
  }

  for (const file of program.files) {
    // Reads on the request, or on a value that carries it: the longest chain rule that the
    // value's fields and calls follow.
    for (const id of present(file.tree.rootNode.descendantsOfType('identifier'))) {
      const parent = id.parent
      if (
        parent?.type !== 'selector_expression' ||
        parent.childForFieldName('operand')?.id !== id.id
      ) {
        continue
      }
      if (!declaredAt(id.text, id)) continue
      const type = program.typeOf(id, file)
      if (!type || !('importPath' in type)) continue
      const typeName = `${type.importPath}#${type.name}`
      const observed = chainFrom(id)
      for (const { rule, items } of chains) {
        if ((rule.on ?? profile.request) !== typeName || items.length > observed.length) continue
        const fits = items.every((item, i) => {
          const seen = observed[i]
          return item.field !== undefined ? seen?.field === item.field : seen?.args !== undefined
        })
        if (!fits) continue
        // `r.RemoteAddr = ip` writes the request; it reads nothing.
        const outer = observed[items.length - 1]?.node
        const list = outer?.parent
        const assigned =
          list?.type === 'expression_list' &&
          list.parent?.type === 'assignment_statement' &&
          list.parent.childForFieldName('left')?.id === list.id
        if (assigned) break
        const named = items.findIndex((item) => item.call?.name)
        const name = named < 0 ? undefined : program.stringValue(observed[named]?.args?.[0], file)
        add(file, id, rule.read, name)
        break
      }
    }
    // Reads through a function that takes the request, or a value derived from it.
    for (const call of present(file.tree.rootNode.descendantsOfType('call_expression'))) {
      const fn = call.childForFieldName('function')
      if (!fn || fn.type === 'func_literal') continue
      const rule = (program.callees(fn, file) ?? []).map((t) => calls.get(t.ref)).find((r) => r)
      if (!rule) continue
      const args = present(call.childForFieldName('arguments')?.namedChildren ?? [])
      add(
        file,
        call,
        rule.read,
        rule.name === undefined ? undefined : program.stringValue(args[rule.name], file),
      )
    }
  }
  return facts
}

// The functions and methods that take a response writer and the request: a framework's handlers.
function handlerDecls(program: GoProgram, profile: ResolvedProfile): Set<string> {
  const found = new Set<string>()
  const is = (symbol: string | undefined, type: Located | undefined) => {
    const [path, name] = (symbol ?? '').split('#')
    return !!type && 'importPath' in type && type.importPath === path && type.name === name
  }
  for (const file of program.files) {
    for (const decl of file.decls) {
      if (decl.node.type === 'func_literal') continue
      const params = present(decl.node.childForFieldName('parameters')?.namedChildren ?? [])
      const types = params.map((p) => {
        const text = p.childForFieldName('type')?.text
        return text ? program.locate(text, file) : undefined
      })
      if (types.some((t) => is(profile.request, t)) && types.some((t) => is(profile.response, t))) {
        found.add(decl.ref)
      }
    }
  }
  return found
}

export async function indexGo(
  files: GoFile[],
  options: {
    module?: string
    modules?: GoModuleRoot[]
    profile: ResolvedProfile
    // What an analyzer resolved, imported before the entry points follow the calls (D12).
    analysis?: Analysis
  },
): Promise<{ graph: Graph; stats: IndexStats; routes: Route[] }> {
  const library = await loadLibrary('go')
  const program = await GoProgram.load(files, {
    ...options,
    fluent: library.fluent,
    returns: library.returns,
    keeps: library.keeps,
    constants: library.constants,
  })
  try {
    const { graph, stats } = program.callGraph()
    const profile = options.profile
    // A framework has no routes of its own: its entry points are its request surface (D5).
    const routes =
      profile.kind === 'application' ? new RouteInterpreter(program, profile).routes() : []
    const reads = extractReads(program, profile)
    const signals = declFacts(program, profile, library, reads)
    graph.facts.push(...reads, ...signals)

    const exported = (name: string) => name.split('.').every((part) => /^[A-Z]/.test(part))
    const handlers =
      profile.kind === 'framework' ? handlerDecls(program, profile) : new Set<string>()
    const added = addEntries(graph, {
      profile,
      routes,
      facts: [...reads, ...signals],
      // Each exported function, and each exported method of an exported type; and each function
      // and method that takes a response writer and the request, exported or not.
      surfaced: (node) =>
        (profile.surface.exported && exported(node.name)) ||
        (profile.surface.handlers && handlers.has(node.ref)),
    })
    return {
      graph,
      stats: {
        ...stats,
        files: program.files.length,
        entries: added.entries,
        reads: reads.length,
        signals: added.signals,
      },
      routes: added.routes,
    }
  } finally {
    program.dispose()
  }
}

// The module path and the direct requirements of a `go.mod`: an `// indirect` one is not something
// the code uses.
export function parseGoMod(text: string): { path?: string; requires: string[] } {
  const path = /^module\s+(\S+)/m.exec(text)?.[1]
  const requires: string[] = []
  const requirement = (line: string) => {
    if (/\/\/\s*indirect\b/.test(line)) return
    const dep = /^\s*(\S+)\s+v\S+/.exec(line)?.[1]
    if (dep) requires.push(dep)
  }
  for (const block of text.matchAll(/^require\s*\(([^)]*)\)/gm)) {
    for (const line of (block[1] ?? '').split('\n')) requirement(line)
  }
  for (const single of text.matchAll(/^require\s+(\S+\s+v\S+.*)$/gm)) requirement(single[1] ?? '')
  return { ...(path ? { path } : {}), requires }
}

// The import paths a Go file declares, read from its import declarations only: a path in a
// comment or a string is not an import.
export function goImports(source: string): string[] {
  const found: string[] = []
  const spec = /^\s*(?:[\w.]+\s+)?"([^"]+)"/
  for (const block of source.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) {
    for (const line of (block[1] ?? '').split('\n')) {
      const path = spec.exec(line.replace(/\/\/.*$/, ''))?.[1]
      if (path) found.push(path)
    }
  }
  for (const single of source.matchAll(/^import\s+((?:[\w.]+\s+)?"[^"]+")/gm)) {
    const path = spec.exec(single[1] ?? '')?.[1]
    if (path) found.push(path)
  }
  return found
}

const isGo = (path: string) => path.endsWith('.go')

// Go, as the shared machinery reads it: `.go` files and every `go.mod`, a module per `go.mod`.
export const go: Language = {
  name: 'go',
  label: 'Go',
  ecosystem: 'Go',
  reads: (path) => isGo(path) || posix.basename(path) === 'go.mod',
  source: isGo,
  test: (path) => path.endsWith('_test.go'),
  modules: (files) =>
    files
      .filter((f) => posix.basename(f.path) === 'go.mod')
      .flatMap((f): Module[] => {
        const mod = parseGoMod(f.source)
        return mod.path
          ? [{ path: mod.path, dir: posix.dirname(f.path), requires: mod.requires }]
          : []
      }),
  imports: (files) => files.filter((f) => isGo(f.path)).flatMap((f) => goImports(f.source)),
  index: (files, options) =>
    indexGo(
      files.filter((f) => isGo(f.path)),
      {
        modules: options.modules,
        profile: options.profile,
        ...(options.analysis ? { analysis: options.analysis } : {}),
      },
    ),
}
