import { createHash } from 'node:crypto'
import type { Citation, Fact, Graph, GraphEdge, GraphNode } from './graph.ts'
import type { ResolvedProfile } from './profile.ts'
import { callsOf, reach } from './reach.ts'
import { Names } from './refs.ts'

// Entry points, from what a language module found (D5, D6): an application's routes with their
// chains and handlers, or a framework's request surface, each with the reads and signals of what
// it reaches through calls, its guards, and the routes whose guards diverge from their siblings'.
// Nothing here depends on the language: routes, reads and signals come in as data.

// What a callee, a handler or a chain member names: a declaration of the target, or an external
// reference, resolved or guessed with a reason.
export interface Callee {
  ref: string
  // For an external, its name as written (`chi.NewRouter`).
  external?: string
  resolution: 'resolved' | 'guessed'
  reason?: string
  // The analyzer that named it, as `<name>@<version>`; tree-sitter otherwise.
  source?: string
  // For a call through an interface of the target, the interface method: `Routes.Match`.
  interface?: string
  // Built with an argument its guard rule's `unless` names, so that it refuses nothing
  // (`HTTPBearer(auto_error=False)`).
  passes?: boolean
}

export interface Member {
  text: string
  citation: Citation
  targets: Callee[]
}

export interface Route {
  method: string
  path: string
  pattern: string
  handler: Member
  chain: Member[]
  citation: Citation
  // The router the route is declared on, seen through what derives a router from another: routes
  // of one group are siblings, whose guards can be compared.
  group: number
}

// A route pattern, normalised (D7): parameters as `{name}`, catch-alls as `{name...}`, no trailing
// slash but on the root. `servemux` patterns may carry a method and end in `/` for a subtree;
// `colon` patterns write parameters `:name`, optionally with a pattern (`:id{[0-9]+}`) or a `?`;
// `brackets` patterns are the folders of a route tree, `[id]`, `[[optional]]`, `[...rest]`,
// `[id=matcher]`, a character escaped `[x+2f]` or `[u+00e9]`, and `(group)`, no part of the path.
export function normalisePattern(
  pattern: string,
  syntax: 'braces' | 'servemux' | 'colon' | 'brackets',
): { method?: string; path: string } {
  if (syntax === 'brackets') {
    const segments = pattern
      .split('/')
      .filter((s) => s !== '' && !/^\(.*\)$/.test(s))
      .map((s) =>
        s
          .replace(/\[([xu])\+([0-9a-fA-F]+)\]/g, (_, __, code: string) =>
            String.fromCodePoint(Number.parseInt(code, 16)),
          )
          .replace(/\[\[([\w$]+)(=[\w$]+)?\]\]/g, '{$1}')
          .replace(/\[\.\.\.([\w$]+)(=[\w$]+)?\]/g, '{$1...}')
          .replace(/\[([\w$]+)(=[\w$]+)?\]/g, '{$1}'),
      )
    return { path: `/${segments.join('/')}` }
  }
  let text = pattern.trim()
  let method: string | undefined
  const withMethod = /^([A-Z]+)\s+(\S.*)$/.exec(text)
  if (withMethod?.[1] && withMethod[2]) {
    method = withMethod[1]
    text = withMethod[2]
  }
  let path = text
  if (syntax === 'braces') {
    path = path
      .replace(/\{([A-Za-z_][\w-]*)(:[^{}]*(?:\{[^{}]*\}[^{}]*)*)?\}/g, '{$1}')
      .replace(/\*$/, '{rest...}')
  } else if (syntax === 'colon') {
    path = path
      .replace(/:([A-Za-z_][\w-]*)(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})?\??/g, '{$1}')
      .replace(/(^|\/)\*$/, '$1{rest...}')
  } else if (path.endsWith('/{$}')) {
    // `/{$}` matches the path exactly.
    path = path.slice(0, -3)
  } else if (path.endsWith('/')) {
    // A trailing slash, the root included, matches the whole subtree.
    path += '{rest...}'
  }
  return { ...(method ? { method } : {}), path }
}

export function joinPath(prefix: string, path: string): string {
  const clean = `${prefix}/${path}`.replace(/\/{2,}/g, '/')
  return clean.length > 1 ? clean.replace(/\/$/, '') : '/'
}

// A glob of paths: `**` any folders, `*` any characters of a name.
export function glob(pattern: string): RegExp {
  let source = ''
  for (const part of pattern.split('/')) {
    if (part === '**') source += '(?:[^/]+/)*'
    else
      source += `${part
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*')}/`
  }
  return new RegExp(`^${source.replace(/\/$/, '').replace(/\(\?:\[\^\/\]\+\/\)\*$/, '.*')}$`)
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

// Adds the entry points to a graph that holds the call graph and the facts on declarations, and
// returns how many there are and how many signals they carry.
export function addEntries(
  graph: Graph,
  options: {
    profile: ResolvedProfile
    routes: Route[]
    // The reads and signals of declarations, already in the graph.
    facts: Fact[]
    // For a framework: whether a declaration is part of its surface, before it is checked to
    // reach a read of the request.
    surfaced?: (node: GraphNode) => boolean
  },
): { entries: number; signals: number; routes: Route[] } {
  const { profile, routes } = options
  const source = `tree-sitter:${profile.name}`
  const nodes = new Map(graph.nodes.map((n) => [n.ref, n]))
  const calls = callsOf(graph.edges)
  const factsOf = new Map<string, Fact[]>()
  for (const fact of options.facts) {
    factsOf.set(fact.node, [...(factsOf.get(fact.node) ?? []), fact])
  }
  // Everything reachable through calls, each with whether the only paths to it go through a
  // guessed edge: a signal reached that way says so.
  const reachFrom = (start: string[]) => reach(calls, start)
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
        // A handler or chain member an analyzer named has it as its source.
        source: target.source ?? source,
        data: { ...data, ...resolution },
      })
    }
  }
  const guardRules = new Map(
    profile.guards.flatMap((g): [string, string][] =>
      'call' in g ? [[`ext:${g.call}`, g.kind]] : [],
    ),
  )
  // Gives an entry the reads and signals of what some of its members reach.
  const take = (
    ref: string,
    seen: Set<string>,
    part: 'handler' | 'chain',
    members: Member[],
    accept: (f: Fact) => boolean,
  ) => {
    const reached = reachFrom(members.flatMap((m) => m.targets.map((t) => t.ref)))
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
  const fromTheHandler = (f: Fact) =>
    f.kind === 'read' || f.kind === 'sink' || fromHandler.has(f.value)

  const ordered = [...routes].sort((a, b) => {
    const ka = `${a.method} ${a.path}\0${a.citation.file}\0${String(a.citation.line).padStart(9, '0')}`
    const kb = `${b.method} ${b.path}\0${b.citation.file}\0${String(b.citation.line).padStart(9, '0')}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  const taken = new Names()
  // What guards each entry: the guard kinds of its chain, and the chain members that can answer
  // without calling the next handler.
  const guarding = new Map<string, Map<string, { citation: Citation; text: string }>>()
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
      fingerprint: sha256([route.method, route.path, print(route.handler), route.chain.map(print)]),
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

    const guards = new Map<string, { citation: Citation; text: string }>()
    for (const member of route.chain) {
      for (const target of member.targets) {
        const kind = target.passes ? undefined : guardRules.get(target.ref)
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

    // A check that refuses the request, in the handler, a chain member, or what they call: the
    // function that makes it guards the route, by the kind its profile gives the check.
    const checked = new Set<string>()
    for (const member of [...route.chain, route.handler]) {
      for (const decl of reachFrom(member.targets.map((t) => t.ref)).keys()) {
        for (const fact of factsOf.get(decl) ?? []) {
          const key = `${fact.value}\0${fact.citation.file}:${fact.citation.line}`
          if (fact.kind !== 'guard' || checked.has(key)) continue
          checked.add(key)
          graph.facts.push({ ...fact, node: ref, data: { ...fact.data, via: decl } })
          if (!guards.has(fact.value))
            guards.set(fact.value, { citation: fact.citation, text: member.text })
        }
      }
    }

    // Reads and signals, from what the handler and the chain reach.
    const seen = new Set<string>()
    take(ref, seen, 'handler', [route.handler], fromTheHandler)
    take(
      ref,
      seen,
      'chain',
      route.chain,
      (f) => f.kind === 'read' || (f.kind === 'signal' && fromChain.has(f.value)),
    )
    // A chain member that can answer on its own guards the routes behind it, whatever its kind.
    // It is known by the code that answers, not by how it is written or built: `auth` and
    // `(auth)` are one guard, and so are two factories that build the same middleware.
    for (const member of route.chain) {
      const reached = reachFrom(member.targets.map((t) => t.ref))
      const stops = [...reached.keys()]
        .filter((decl) => (factsOf.get(decl) ?? []).some((f) => f.value === 'short-circuit'))
        .sort()
      if (stops.length > 0)
        guards.set(`member:${stops.join(',')}`, { citation: member.citation, text: member.text })
    }
    guarding.set(ref, guards)
  }

  // An entry that lacks a guard most of its siblings have: routes declared on the same router,
  // seen through what derives a router from another, of which there are at least three.
  const groups = new Map<number, Route[]>()
  for (const route of ordered) groups.set(route.group, [...(groups.get(route.group) ?? []), route])
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

  // A framework's request surface: each declaration the language puts on it that reads the
  // request through what it reaches.
  let surface = 0
  const entries: GraphNode[] = []
  if (profile.kind === 'framework' && options.surfaced) {
    const excepted = profile.surface.except.map(glob)
    for (const node of graph.nodes) {
      if (node.kind !== 'decl' || node.data?.literal || !node.file) continue
      const file = node.file
      if (excepted.some((pattern) => pattern.test(file))) continue
      if (!options.surfaced(node)) continue
      const reached = reachFrom([node.ref])
      const reads = [...reached.keys()].some((decl) =>
        (factsOf.get(decl) ?? []).some((f) => f.kind === 'read'),
      )
      if (!reads) continue
      const ref = `entry:${node.ref}`
      const citation = { file: node.file, line: node.startLine ?? 1 }
      entries.push({
        ref,
        kind: 'entry',
        name: node.name,
        file: node.file,
        ...(node.startLine ? { startLine: node.startLine } : {}),
        ...(node.endLine ? { endLine: node.endLine } : {}),
        ...(node.fingerprint ? { fingerprint: node.fingerprint } : {}),
        data: { symbol: node.ref },
      })
      const member: Member = {
        text: node.name,
        citation,
        targets: [{ ref: node.ref, resolution: 'resolved' }],
      }
      link('handles', ref, member, {})
      take(ref, new Set(), 'handler', [member], fromTheHandler)
      surface++
    }
    graph.nodes.push(...entries)
  }

  const isEntry = (ref: string) => ref.startsWith('route:') || ref.startsWith('entry:')
  return {
    entries: ordered.length + surface,
    signals: graph.facts.filter((f) => f.kind === 'signal' && isEntry(f.node)).length,
    routes: ordered,
  }
}
