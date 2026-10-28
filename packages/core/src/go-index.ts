import { createHash } from 'node:crypto'
import type { Node } from 'web-tree-sitter'
import {
  type CallStats,
  declaredAt,
  type GoFile,
  GoProgram,
  line,
  type ParsedFile,
  present,
} from './go.ts'
import { type Member, type Route, RouteInterpreter } from './go-routes.ts'
import type { Fact, Graph, GraphEdge } from './graph.ts'
import type { ReadKind, ReadRule, ResolvedProfile } from './profile.ts'
import { Names } from './refs.ts'

// A Go target indexed with a profile: the call graph, the entry points with their chains and
// handlers, and what each declaration and entry point reads from the request (D6).

export interface IndexStats extends CallStats {
  entries: number
  reads: number
}

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

function literal(node: Node | undefined): string | undefined {
  if (node?.type === 'interpreted_string_literal' || node?.type === 'raw_string_literal') {
    return node.text.slice(1, -1)
  }
  return undefined
}

function extractReads(program: GoProgram, profile: ResolvedProfile): Fact[] {
  const facts: Fact[] = []
  const source = `tree-sitter:${profile.name}`
  const [requestPath, requestType] = (profile.request ?? '').split('#')
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
    // Reads on the request: the longest chain rule that its fields and calls follow.
    if (requestPath && requestType) {
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
        if (
          !type ||
          !('importPath' in type) ||
          type.importPath !== requestPath ||
          type.name !== requestType
        ) {
          continue
        }
        const observed = chainFrom(id)
        for (const { rule, items } of chains) {
          if (items.length > observed.length) continue
          const fits = items.every((item, i) => {
            const seen = observed[i]
            return item.field !== undefined ? seen?.field === item.field : seen?.args !== undefined
          })
          if (!fits) continue
          const named = items.findIndex((item) => item.call?.name)
          const name = named < 0 ? undefined : literal(observed[named]?.args?.[0])
          add(file, id, rule.read, name)
          break
        }
      }
    }
    // Reads through a function that takes the request, or a value derived from it.
    for (const call of present(file.tree.rootNode.descendantsOfType('call_expression'))) {
      const fn = call.childForFieldName('function')
      if (!fn || fn.type === 'func_literal') continue
      const rule = (program.targets(fn, file) ?? []).map((t) => calls.get(t.ref)).find((r) => r)
      if (!rule) continue
      const args = present(call.childForFieldName('arguments')?.namedChildren ?? [])
      add(file, call, rule.read, rule.name === undefined ? undefined : literal(args[rule.name]))
    }
  }
  return facts
}

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export async function indexGo(
  files: GoFile[],
  options: { module?: string; profile: ResolvedProfile },
): Promise<{ graph: Graph; stats: IndexStats; routes: Route[] }> {
  const program = await GoProgram.load(files, options)
  try {
    const { graph, stats } = program.callGraph()
    const profile = options.profile
    const source = `tree-sitter:${profile.name}`
    const routes = new RouteInterpreter(program, profile).routes()
    const reads = extractReads(program, profile)
    graph.facts.push(...reads)

    const nodes = new Map(graph.nodes.map((n) => [n.ref, n]))
    const calls = new Map<string, string[]>()
    for (const e of graph.edges) {
      if (e.kind === 'calls' && e.data?.resolution === 'resolved') {
        calls.set(e.from, [...(calls.get(e.from) ?? []), e.to])
      }
    }
    const readsOf = new Map<string, Fact[]>()
    for (const fact of reads) readsOf.set(fact.node, [...(readsOf.get(fact.node) ?? []), fact])
    // The reads of everything a member reaches through resolved calls.
    const reached = (start: string[]): Fact[] => {
      const seen = new Set<string>()
      const queue = [...start]
      const found: Fact[] = []
      while (queue.length > 0) {
        const ref = queue.shift() as string
        if (seen.has(ref)) continue
        seen.add(ref)
        found.push(...(readsOf.get(ref) ?? []))
        queue.push(...(calls.get(ref) ?? []))
      }
      return found
    }
    const ensure = (ref: string, name: string) => {
      if (!nodes.has(ref)) {
        const node = { ref, kind: 'external' as const, name }
        nodes.set(ref, node)
        graph.nodes.push(node)
      }
    }
    const link = (
      kind: GraphEdge['kind'],
      from: string,
      member: Member,
      data: Record<string, unknown>,
    ) => {
      for (const target of member.targets) {
        if (target.external) ensure(target.ref, target.external)
        const resolution =
          target.resolution === 'guessed'
            ? { resolution: 'guessed', reason: target.reason }
            : { resolution: 'resolved' }
        graph.edges.push({
          kind,
          from,
          to: target.ref,
          citation: member.citation,
          source,
          data: { ...data, ...resolution },
        })
      }
    }

    const ordered = [...routes].sort((a, b) => {
      const ka = `${a.method} ${a.path}\0${a.citation.file}\0${String(a.citation.line).padStart(9, '0')}`
      const kb = `${b.method} ${b.path}\0${b.citation.file}\0${String(b.citation.line).padStart(9, '0')}`
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
    const taken = new Names()
    for (const route of ordered) {
      const ref = `route:${taken.take(`${route.method} ${route.path}`)}`
      const unresolved = [route.handler, ...route.chain]
        .map((m, i) => ({
          text: m.text,
          citation: m.citation,
          position: i === 0 ? 'handler' : i - 1,
        }))
        .filter((_, i) => ([route.handler, ...route.chain][i]?.targets.length ?? 0) === 0)
      const print = (m: Member) =>
        m.targets.map((t) => [t.ref, nodes.get(t.ref)?.fingerprint ?? null])
      graph.nodes.push({
        ref,
        kind: 'entry',
        name: `${route.method} ${route.path}`,
        file: route.citation.file,
        startLine: route.citation.line,
        endLine: route.citation.line,
        fingerprint: sha256([
          route.method,
          route.path,
          print(route.handler),
          route.chain.map(print),
        ]),
        data: {
          method: route.method,
          path: route.path,
          pattern: route.pattern,
          handler: route.handler.text,
          ...(unresolved.length > 0 ? { unresolved } : {}),
        },
      })
      graph.facts.push(
        { node: ref, kind: 'method', value: route.method, citation: route.citation, source },
        { node: ref, kind: 'path', value: route.path, citation: route.citation, source },
      )
      link('handles', ref, route.handler, {})
      route.chain.forEach((member, position) => {
        link('chain', ref, member, { position })
      })

      // An entry reads what its handler and its chain read, wherever in what they reach.
      const seen = new Set<string>()
      const from = (part: 'handler' | 'chain', members: Member[]) => {
        for (const fact of reached(members.flatMap((m) => m.targets.map((t) => t.ref)))) {
          const key = `${fact.value}\0${fact.citation.file}:${fact.citation.line}`
          if (seen.has(key)) continue
          seen.add(key)
          graph.facts.push({ ...fact, node: ref, data: { via: fact.node, from: part } })
        }
      }
      from('handler', [route.handler])
      from('chain', route.chain)
    }

    return {
      graph,
      stats: { ...stats, entries: ordered.length, reads: reads.length },
      routes: ordered,
    }
  } finally {
    program.dispose()
  }
}
