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
import { declFacts } from './go-signals.ts'
import type { Fact, Graph, GraphEdge } from './graph.ts'
import { loadLibrary } from './library.ts'
import type { ReadKind, ReadRule, ResolvedProfile } from './profile.ts'
import { Names } from './refs.ts'

// A Go target indexed with a profile: the call graph, the entry points with their chains and
// handlers, and what each declaration and entry point reads from the request (D6).

export interface IndexStats extends CallStats {
  entries: number
  reads: number
  signals: number
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

// Signals an entry takes from what its handler reaches, and from what its chain reaches.
const fromHandler = new Set([
  'data-write',
  'data-read',
  'request-key',
  'mass-assignment',
  'live-state',
  'callback-passed',
  'retained-mutation',
])
const fromChain = new Set(['short-circuit', 'live-state', 'callback-passed', 'retained-mutation'])

export async function indexGo(
  files: GoFile[],
  options: { module?: string; profile: ResolvedProfile },
): Promise<{ graph: Graph; stats: IndexStats; routes: Route[] }> {
  const library = await loadLibrary('go')
  const program = await GoProgram.load(files, {
    ...options,
    fluent: library.fluent,
    returns: library.returns,
  })
  try {
    const { graph, stats } = program.callGraph()
    const profile = options.profile
    const source = `tree-sitter:${profile.name}`
    const routes = new RouteInterpreter(program, profile).routes()
    const reads = extractReads(program, profile)
    const signals = declFacts(program, profile, library, reads)
    graph.facts.push(...reads, ...signals)

    const nodes = new Map(graph.nodes.map((n) => [n.ref, n]))
    const calls = new Map<string, { to: string; guessed: boolean }[]>()
    for (const e of graph.edges) {
      if (e.kind !== 'calls') continue
      const list = calls.get(e.from) ?? []
      list.push({ to: e.to, guessed: e.data?.resolution === 'guessed' })
      calls.set(e.from, list)
    }
    const factsOf = new Map<string, Fact[]>()
    for (const fact of [...reads, ...signals]) {
      factsOf.set(fact.node, [...(factsOf.get(fact.node) ?? []), fact])
    }
    // Everything reachable through calls, each with whether the only paths to it go through a
    // guessed edge: a signal reached that way says so.
    const reach = (start: string[]): Map<string, boolean> => {
      const best = new Map<string, boolean>()
      const queue = start.map((ref) => ({ ref, guessed: false }))
      while (queue.length > 0) {
        const { ref, guessed } = queue.shift() as { ref: string; guessed: boolean }
        const known = best.get(ref)
        if (known === false || (known === true && guessed)) continue
        best.set(ref, guessed)
        for (const next of calls.get(ref) ?? [])
          queue.push({ ref: next.to, guessed: guessed || next.guessed })
      }
      return best
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
    const guardRules = new Map(profile.guards.map((g) => [`ext:${g.call}`, g.kind]))

    const ordered = [...routes].sort((a, b) => {
      const ka = `${a.method} ${a.path}\0${a.citation.file}\0${String(a.citation.line).padStart(9, '0')}`
      const kb = `${b.method} ${b.path}\0${b.citation.file}\0${String(b.citation.line).padStart(9, '0')}`
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
    const taken = new Names()
    // What guards each entry: the guard kinds of its chain, and the chain members that can answer
    // without calling the next handler.
    const guarding = new Map<string, Map<string, { citation: Fact['citation']; text: string }>>()
    const entryOf = new Map<Route, string>()
    for (const route of ordered) {
      const ref = `route:${taken.take(`${route.method} ${route.path}`)}`
      entryOf.set(route, ref)
      const members = [route.handler, ...route.chain]
      const unresolved = members
        .map((m, i) => ({
          text: m.text,
          citation: m.citation,
          position: i === 0 ? 'handler' : i - 1,
        }))
        .filter((_, i) => (members[i]?.targets.length ?? 0) === 0)
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

      const guards = new Map<string, { citation: Fact['citation']; text: string }>()
      for (const member of route.chain) {
        for (const target of member.targets) {
          const kind = guardRules.get(target.ref)
          if (kind) {
            graph.facts.push({
              node: ref,
              kind: 'guard',
              value: kind,
              citation: member.citation,
              source,
              data: { via: target.ref },
            })
            guards.set(kind, { citation: member.citation, text: member.text })
          }
        }
      }

      // Reads and signals, from what the handler and the chain reach.
      const seen = new Set<string>()
      const take = (part: 'handler' | 'chain', members: Member[], accept: (f: Fact) => boolean) => {
        const reached = reach(members.flatMap((m) => m.targets.map((t) => t.ref)))
        for (const [decl, guessed] of reached) {
          for (const fact of factsOf.get(decl) ?? []) {
            if (!accept(fact)) continue
            const key = `${fact.kind}\0${fact.value}\0${fact.citation.file}:${fact.citation.line}`
            if (seen.has(key)) continue
            seen.add(key)
            const data = { via: fact.node, from: part, ...(guessed ? { guessed: true } : {}) }
            const value = fact.kind === 'sink' ? 'sink-reachable' : fact.value
            const kind = fact.kind === 'sink' ? 'signal' : fact.kind
            graph.facts.push({
              ...fact,
              node: ref,
              kind,
              value,
              data: { ...data, ...(fact.kind === 'sink' ? { sink: fact.value } : {}) },
            })
          }
        }
      }
      take(
        'handler',
        [route.handler],
        (f) => f.kind === 'read' || f.kind === 'sink' || fromHandler.has(f.value),
      )
      take(
        'chain',
        route.chain,
        (f) => f.kind === 'read' || (f.kind === 'signal' && fromChain.has(f.value)),
      )
      // A chain member that can answer on its own guards the routes behind it, whatever its kind.
      for (const member of route.chain) {
        const reached = reach(member.targets.map((t) => t.ref))
        const stops = [...reached.keys()].some((decl) =>
          (factsOf.get(decl) ?? []).some((f) => f.value === 'short-circuit'),
        )
        if (stops)
          guards.set(`member:${member.text}`, { citation: member.citation, text: member.text })
      }
      guarding.set(ref, guards)
    }

    // An entry that lacks a guard most of its siblings have: routes declared on the same router,
    // seen through `With` and `Group`, of which there are at least three.
    const groups = new Map<number, Route[]>()
    for (const route of ordered)
      groups.set(route.group, [...(groups.get(route.group) ?? []), route])
    for (const siblings of groups.values()) {
      if (siblings.length < 3) continue
      for (const route of siblings) {
        const ref = entryOf.get(route) as string
        const own = guarding.get(ref) ?? new Map()
        const others = siblings
          .filter((s) => s !== route)
          .map((s) => guarding.get(entryOf.get(s) as string) ?? new Map())
        const counts = new Map<string, { n: number; text: string }>()
        for (const guards of others) {
          for (const [key, guard] of guards)
            counts.set(key, { n: (counts.get(key)?.n ?? 0) + 1, text: guard.text })
        }
        const missing = [...counts]
          .filter(([key, { n }]) => !own.has(key) && n * 2 > others.length)
          .map(([key, { text }]) => (key.startsWith('member:') ? text : key))
          .sort()
        if (missing.length === 0) continue
        graph.facts.push({
          node: ref,
          kind: 'signal',
          value: 'divergent-guard',
          citation: route.citation,
          source,
          data: { missing, siblings: others.length },
        })
      }
    }

    return {
      graph,
      stats: {
        ...stats,
        entries: ordered.length,
        reads: reads.length,
        signals: graph.facts.filter((f) => f.kind === 'signal' && f.node.startsWith('route:'))
          .length,
      },
      routes: ordered,
    }
  } finally {
    program.dispose()
  }
}
