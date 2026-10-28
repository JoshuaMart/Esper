import { posix } from 'node:path'
import type { StatementSync } from 'node:sqlite'
import { EsperError } from './errors.ts'
import type { Fact, Graph, GraphEdge, GraphNode } from './graph.ts'
import type { Language, Module } from './language.ts'
import type { ResolvedProfile } from './profile.ts'
import { callsOf, reach } from './reach.ts'
import type { Store } from './store.ts'
import {
  changedLines,
  classify,
  commitOf,
  commitsNaming,
  isAncestor,
  parentOf,
  readRef,
  remoteRepositories,
  repositoryOf,
  tagsAt,
} from './target.ts'
import { cvss3Score, parseVersion, type Range, type Semver, versionState } from './versions.ts'

// Past vulnerabilities (D19, D30): the target's advisories, imported from OSV, kept when rated
// medium or more, and linked to the code their fix touched. Advisories and their links belong to
// the project, like notes, not to a snapshot: each snapshot, when it is read, gets an `advisory`
// node for each, an `affects` edge for each link placed on its code by reference and fingerprint,
// and the `fix-downstream` signal on the entry points that reach one. Advisory text comes from a
// third party and is data.

// A package of the target, as OSV names it: its name and its ecosystem.
export interface Package {
  name: string
  ecosystem: string
}

// What OSV returns, as far as Esper reads it (https://ossf.github.io/osv-schema/).
export interface OsvEntry {
  id: string
  aliases?: string[]
  summary?: string
  details?: string
  published?: string
  modified?: string
  withdrawn?: string
  severity?: { type: string; score: string }[]
  database_specific?: { severity?: string } & Record<string, unknown>
  affected?: {
    package?: { name: string; ecosystem: string }
    ranges?: Range[]
    ecosystem_specific?: { imports?: { path: string; symbols?: string[] }[] } & Record<
      string,
      unknown
    >
  }[]
  references?: { type: string; url: string }[]
}

// Where advisories come from: OSV's API, or a recording of it in tests.
export interface AdvisorySource {
  // Every entry that affects a package, across OSV's databases.
  query(pkg: Package): Promise<OsvEntry[]>
  // One entry, or undefined when OSV has none of that id.
  get(id: string): Promise<OsvEntry | undefined>
}

// OSV's API: the one network call Esper itself makes. `ESPER_OSV_URL` points it elsewhere.
export function osvSource(
  base = process.env.ESPER_OSV_URL ?? 'https://api.osv.dev',
): AdvisorySource {
  const call = async (path: string, body?: unknown): Promise<Response> => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    })
    return response
  }
  return {
    async query(pkg) {
      const entries: OsvEntry[] = []
      let token: string | undefined
      // OSV pages a long answer; a bound keeps a broken page token from looping.
      for (let page = 0; page < 50; page++) {
        const response = await call('/v1/query', {
          package: { name: pkg.name, ecosystem: pkg.ecosystem },
          ...(token ? { page_token: token } : {}),
        })
        if (!response.ok) throw new EsperError(`OSV answered ${response.status} for ${pkg.name}`)
        const body = (await response.json()) as { vulns?: OsvEntry[]; next_page_token?: string }
        entries.push(...(body.vulns ?? []))
        token = body.next_page_token
        if (!token) break
      }
      return entries
    },
    async get(id) {
      const response = await call(`/v1/vulns/${encodeURIComponent(id)}`)
      if (response.status === 404) return undefined
      if (!response.ok) throw new EsperError(`OSV answered ${response.status} for ${id}`)
      return (await response.json()) as OsvEntry
    },
  }
}

// A recording of OSV's answers, by `<ecosystem>:<name>` for a query and by id for an entry: what
// tests read instead of the network. What it does not hold, OSV did not have.
export interface OsvRecording {
  queries?: Record<string, OsvEntry[]>
  entries?: Record<string, OsvEntry | null>
}

export function recordedSource(recording: OsvRecording = {}): AdvisorySource {
  return {
    query: async (pkg) => recording.queries?.[`${pkg.ecosystem}:${pkg.name}`] ?? [],
    get: async (id) => recording.entries?.[id] ?? undefined,
  }
}

export const severities = ['critical', 'high', 'moderate', 'low', 'unrated'] as const
export type Severity = (typeof severities)[number]

export interface Advisory {
  // Its OSV identifier: the entry Esper took as the advisory, others being its aliases.
  id: string
  aliases: string[]
  summary: string
  details: string
  severity: Severity
  // Where the severity comes from: an entry's rating by its database, or a CVSS 3 base score.
  rating: { from: string; by: 'rating' | 'cvss'; score?: number } | null
  published: string | null
  modified: string | null
  package: Package
  // The version ranges the advisory gives for the package.
  ranges: Range[]
  // The functions it names, by import path.
  symbols: { path: string; symbols: string[] }[]
  references: { type: string; url: string }[]
}

export interface AdvisoryImport {
  packages: Package[]
  advisories: Advisory[]
  // The advisories rated low, left out.
  low: string[]
}

const ratings: Record<string, Severity> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MODERATE: 'moderate',
  MEDIUM: 'moderate',
  LOW: 'low',
}

const fromScore = (score: number): Severity =>
  score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'moderate' : 'low'

// How many aliases are fetched, at most, to rate an advisory its own entries do not rate.
const aliasLookups = 5

// The advisories of the target's packages: the entries OSV holds for each, an entry and its
// aliases taken as one advisory, kept when rated medium or more, or not rated at all.
export async function importAdvisories(
  source: AdvisorySource,
  packages: Package[],
): Promise<AdvisoryImport> {
  const entries = new Map<string, { entry: OsvEntry; pkg: Package }>()
  for (const pkg of packages) {
    for (const entry of await source.query(pkg)) {
      if (entry.withdrawn || entries.has(entry.id)) continue
      entries.set(entry.id, { entry, pkg })
    }
  }
  // An entry and its aliases are one advisory: the Go database's entry and GitHub's, say.
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== undefined && parent.get(root) !== root)
      root = parent.get(root) as string
    return root
  }
  for (const id of entries.keys()) parent.set(id, id)
  for (const { entry } of entries.values()) {
    for (const alias of entry.aliases ?? []) {
      if (!entries.has(alias)) continue
      const a = find(entry.id)
      const b = find(alias)
      // The smaller identifier is the root, so that the grouping does not depend on order.
      const [root, child] = [a, b].sort() as [string, string]
      if (root !== child) parent.set(child, root)
    }
  }
  const groups = new Map<string, { entry: OsvEntry; pkg: Package }[]>()
  for (const [id, found] of entries) {
    const root = find(id)
    groups.set(root, [...(groups.get(root) ?? []), found])
  }
  const advisories: Advisory[] = []
  const low: string[] = []
  for (const members of groups.values()) {
    const advisory = await merge(members, source)
    if (advisory.severity === 'low') low.push(advisory.id)
    else advisories.push(advisory)
  }
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1)
  return { packages, advisories: advisories.sort(byId), low: low.sort() }
}

// One advisory from an entry and its aliases. The entry it is known by is the one that says the
// most about the code: one that names functions, then one that points to its fix, then one its
// database rates.
async function merge(
  members: { entry: OsvEntry; pkg: Package }[],
  source: AdvisorySource,
): Promise<Advisory> {
  const affectedOf = (entry: OsvEntry, pkg: Package) =>
    (entry.affected ?? []).filter(
      (a) => a.package?.name === pkg.name && a.package?.ecosystem === pkg.ecosystem,
    )
  const symbolsOf = (entry: OsvEntry, pkg: Package) =>
    affectedOf(entry, pkg).flatMap((a) =>
      (a.ecosystem_specific?.imports ?? []).filter((i) => (i.symbols ?? []).length > 0),
    )
  const rank = ({ entry, pkg }: { entry: OsvEntry; pkg: Package }) =>
    (symbolsOf(entry, pkg).length > 0 ? 0 : 4) +
    ((entry.references ?? []).some((r) => r.type === 'FIX') ? 0 : 2) +
    (entry.database_specific?.severity ? 0 : 1)
  const sorted = [...members].sort(
    (a, b) => rank(a) - rank(b) || (a.entry.id < b.entry.id ? -1 : 1),
  )
  const { entry: primary, pkg } = sorted[0] as { entry: OsvEntry; pkg: Package }
  const ids = new Set(members.map((m) => m.entry.id))
  const aliases = [...new Set(members.flatMap((m) => [m.entry.id, ...(m.entry.aliases ?? [])]))]
    .filter((id) => id !== primary.id)
    .sort()
  // A rating, from the entries first, then from aliases OSV holds apart.
  const rated: OsvEntry[] = sorted.map((m) => m.entry)
  let rating: Advisory['rating'] = null
  let severity: Severity = 'unrated'
  const rate = (entry: OsvEntry) => {
    const text = entry.database_specific?.severity
    const found = typeof text === 'string' ? ratings[text.toUpperCase()] : undefined
    if (found) {
      rating = { from: entry.id, by: 'rating' }
      severity = found
    }
    return found !== undefined
  }
  if (!rated.some(rate)) {
    for (const alias of aliases.filter((a) => !ids.has(a)).slice(0, aliasLookups)) {
      const entry = await source.get(alias)
      if (!entry) continue
      rated.push(entry)
      if (rate(entry)) break
    }
  }
  if (!rating) {
    for (const entry of rated) {
      const score = (entry.severity ?? [])
        .map((s) => cvss3Score(s.score))
        .find((s) => s !== undefined)
      if (score !== undefined) {
        rating = { from: entry.id, by: 'cvss', score }
        severity = fromScore(score)
        break
      }
    }
  }
  const references = new Map<string, { type: string; url: string }>()
  for (const entry of sorted.map((m) => m.entry)) {
    for (const r of entry.references ?? []) {
      const known = references.get(r.url)
      if (!known || (known.type !== 'FIX' && r.type === 'FIX')) references.set(r.url, r)
    }
  }
  const text = (key: 'summary' | 'details') =>
    sorted.map((m) => m.entry[key]).find((t) => typeof t === 'string' && t.trim() !== '') ?? ''
  return {
    id: primary.id,
    aliases,
    summary: text('summary'),
    details: text('details'),
    severity,
    rating,
    published: primary.published ?? null,
    modified:
      sorted
        .map((m) => m.entry.modified ?? '')
        .sort()
        .at(-1) || null,
    package: pkg,
    ranges: affectedOf(primary, pkg).flatMap((a) => a.ranges ?? []),
    symbols: symbolsOf(primary, pkg).map((i) => ({ path: i.path, symbols: i.symbols ?? [] })),
    references: [...references.values()],
  }
}

export const precisions = ['symbol', 'fix-diff', 'file'] as const
export type Precision = (typeof precisions)[number]

// A link from an advisory to the code, as made on the version its fix changed.
export interface AdvisoryLink {
  precision: Precision
  kind: 'decl' | 'file'
  // The node's reference in the fix's parent, or, for a symbol, the symbol as the advisory names
  // it, found by name in each snapshot under `dir`.
  ref: string
  dir?: string
  fix?: string
  // Where the fix changed the node, in its parent: `file:line`.
  hunk?: string
  // The node's fingerprint before the fix and after it; null when it was not there.
  before?: string | null
  after?: string | null
  // `osv` when the advisory names it or its commit, `git` when the commit was found in the
  // target's history.
  source: 'osv' | 'git'
}

export interface Linked {
  status: 'linked' | 'unlinked'
  // How it was linked: `symbols`, `references`, `git log`, or why it was not.
  how: string
  fixes: string[]
  links: AdvisoryLink[]
}

export interface LinkContext {
  // The project's folder, and whether it is a git repository.
  dir: string
  git: boolean
  language: Language
  profile: ResolvedProfile
  modules: Module[]
}

// How many commits a search of the history keeps, at most.
const searched = 5

// The commits an advisory points to: a commit URL among its references, or a fixed event of a git
// range, each kept when the target's repository holds it. An abbreviated id is taken only from a
// URL of one of the target's remotes: from another repository, it could name an unrelated commit
// of the target. A full id cannot.
export async function fixCommits(advisory: Advisory, dir: string): Promise<string[]> {
  const ids = new Set<string>()
  const remotes = new Set(await remoteRepositories(dir))
  for (const r of advisory.references) {
    const match = /\/commits?\/([0-9a-f]{7,40})(?:[/?#.]|$)/i.exec(r.url)
    if (!match?.[1]) continue
    const own = remotes.has(repositoryOf(r.url) ?? '')
    if (match[1].length === 40 || own) ids.add(match[1])
  }
  for (const range of advisory.ranges) {
    if (range.type !== 'GIT') continue
    for (const event of range.events) if (event.fixed) ids.add(event.fixed)
  }
  const found: string[] = []
  for (const id of ids) {
    const sha = await commitOf(dir, id)
    if (sha && !found.includes(sha)) found.push(sha)
  }
  return found
}

// Links an advisory to the code: the functions it names (`symbol`), else the declarations its fix
// commit touched in the parent commit (`fix-diff`), or the file when the fix touched lines outside
// any (`file`). An advisory with neither has its fix searched in the history by its identifiers;
// without one, it is `unlinked`.
export async function linkAdvisory(advisory: Advisory, context: LinkContext): Promise<Linked> {
  const fixes = context.git ? await fixCommits(advisory, context.dir) : []
  const symbols: AdvisoryLink[] = []
  for (const { path, symbols: names } of advisory.symbols) {
    const module = context.modules.find((m) => path === m.path || path.startsWith(`${m.path}/`))
    if (!module) continue
    const dir = posix.normalize(posix.join(module.dir, path.slice(module.path.length + 1) || '.'))
    for (const name of names) {
      symbols.push({
        precision: 'symbol',
        kind: 'decl',
        ref: name,
        dir,
        ...(fixes[0] ? { fix: fixes[0] } : {}),
        source: 'osv',
      })
    }
  }
  if (symbols.length > 0) {
    // With a fix commit, a symbol also says how its code stood before and after the fix.
    if (fixes[0]) await fingerprintSymbols(symbols, fixes[0], context)
    return { status: 'linked', how: 'symbols', fixes, links: symbols }
  }
  let how = 'references'
  let source: 'osv' | 'git' = 'osv'
  let commits = fixes
  if (commits.length === 0 && context.git) {
    commits = await commitsNaming(context.dir, [advisory.id, ...advisory.aliases], searched)
    how = 'git log'
    source = 'git'
  }
  if (commits.length === 0) {
    return {
      status: 'unlinked',
      how: context.git
        ? 'no symbol, no fix commit in the repository, and no commit naming it'
        : 'no symbol, and the project is not a git repository',
      fixes: [],
      links: [],
    }
  }
  const links: AdvisoryLink[] = []
  const seen = new Set<string>()
  for (const commit of commits) {
    for (const link of await diffLinks(commit, context, source)) {
      if (seen.has(link.ref)) continue
      seen.add(link.ref)
      links.push(link)
    }
  }
  if (links.length === 0) {
    return {
      status: 'unlinked',
      how: `${how}: the fix touches no source file Esper reads`,
      fixes: commits,
      links: [],
    }
  }
  return { status: 'linked', how, fixes: commits, links }
}

// The declarations of some files of a commit, as the index names them: their reference, lines and
// fingerprint. Only these files are indexed: a declaration's reference and fingerprint depend on
// its own file alone.
async function declsAt(
  commit: string,
  wanted: (path: string) => boolean,
  context: LinkContext,
): Promise<GraphNode[]> {
  const snapshot = await readRef(context.dir, commit).catch(() => undefined)
  if (!snapshot) return []
  const files = snapshot.files.filter((f) => !context.language.source(f.path) || wanted(f.path))
  if (!files.some((f) => context.language.source(f.path))) return []
  const { graph } = await context.language.index(files, {
    modules: context.language.modules(files),
    profile: context.profile,
  })
  return graph.nodes.filter((n) => n.kind === 'decl' || n.kind === 'file')
}

async function diffLinks(
  commit: string,
  context: LinkContext,
  source: 'osv' | 'git',
): Promise<AdvisoryLink[]> {
  const parent = await parentOf(context.dir, commit)
  if (!parent) return []
  const hunks = await changedLines(context.dir, parent, commit).catch(
    () => new Map<string, { start: number; count: number }[]>(),
  )
  const touched = new Set(
    [...hunks.keys()].filter((p) => context.language.source(p) && classify(p).read),
  )
  if (touched.size === 0) return []
  const before = await declsAt(parent, (p) => touched.has(p), context)
  const after = new Map(
    (await declsAt(commit, (p) => touched.has(p), context)).map((n) => [n.ref, n.fingerprint]),
  )
  const links: AdvisoryLink[] = []
  for (const path of [...touched].sort()) {
    const decls = before.filter((n) => n.kind === 'decl' && n.file === path)
    const spanning = (line: number) =>
      decls
        .filter((n) => (n.startLine ?? 0) <= line && line <= (n.endLine ?? 0))
        .sort((a, b) => span(a) - span(b) || (a.ref < b.ref ? -1 : 1))
    let outside: number | undefined
    const found = new Map<string, number>()
    for (const { start, count } of hunks.get(path) ?? []) {
      // A hunk that only adds lines falls in a declaration when both lines around it do.
      const lines = count > 0 ? range(start, count) : [start]
      for (const line of lines) {
        const inner =
          count > 0 ? spanning(line)[0] : spanning(line).find((n) => (n.endLine ?? 0) >= line + 1)
        if (inner) {
          if (!found.has(inner.ref)) found.set(inner.ref, line)
        } else if (count > 0) outside ??= line
        // Lines added between declarations are new code: nothing of the parent stood there.
      }
    }
    for (const [ref, line] of found) {
      const node = decls.find((n) => n.ref === ref) as GraphNode
      links.push({
        precision: 'fix-diff',
        kind: 'decl',
        ref,
        fix: commit,
        hunk: `${path}:${line}`,
        before: node.fingerprint ?? null,
        after: after.get(ref) ?? null,
        source,
      })
    }
    // A file is the link only when no declaration of it is.
    if (found.size === 0 && outside !== undefined) {
      const file = before.find((n) => n.kind === 'file' && n.ref === path)
      links.push({
        precision: 'file',
        kind: 'file',
        ref: path,
        fix: commit,
        hunk: `${path}:${outside}`,
        before: file?.fingerprint ?? null,
        after: after.get(path) ?? null,
        source,
      })
    }
  }
  return links
}

async function fingerprintSymbols(links: AdvisoryLink[], fix: string, context: LinkContext) {
  const parent = await parentOf(context.dir, fix)
  const dirs = new Set(links.map((l) => l.dir))
  const inDirs = (p: string) => dirs.has(posix.dirname(p))
  const before = parent ? await declsAt(parent, inDirs, context) : []
  const after = await declsAt(fix, inDirs, context)
  const find = (nodes: GraphNode[], link: AdvisoryLink) =>
    nodes.find((n) => n.kind === 'decl' && symbolMatches(n, link))
  for (const link of links) {
    link.before = find(before, link)?.fingerprint ?? null
    link.after = find(after, link)?.fingerprint ?? null
  }
}

const symbolMatches = (node: GraphNode, link: AdvisoryLink) =>
  !!node.file && posix.dirname(node.file) === link.dir && node.ref.endsWith(`#${link.ref}`)

const range = (start: number, count: number) => Array.from({ length: count }, (_, i) => start + i)
const span = (n: GraphNode) => (n.endLine ?? 0) - (n.startLine ?? 0)

export const advisoryStates = ['affected', 'fixed', 'unaffected', 'unknown'] as const
export type AdvisoryState = (typeof advisoryStates)[number]

// The version a snapshot is of: its ref, or a tag that names its commit, read as a version.
export async function snapshotVersion(
  dir: string,
  git: boolean,
  snapshot: { ref: string | null; commit: string | null },
): Promise<{ text: string; version: Semver } | undefined> {
  const names = [
    ...(snapshot.ref ? [snapshot.ref] : []),
    ...(git && snapshot.commit ? await tagsAt(dir, snapshot.commit) : []),
  ]
  for (const name of names) {
    // A tag of a module in a folder is `folder/v1.2.3`.
    const text = name.split('/').at(-1) as string
    const version = parseVersion(text)
    if (version) return { text, version }
  }
  return undefined
}

// Whether a snapshot's version is affected or fixed: from the advisory's version ranges when the
// snapshot has a version, else from whether its commit holds a fix commit.
// The snapshot's version, from `snapshotVersion`, is read once by the caller for every advisory.
export async function stateOn(
  advisory: Advisory,
  fixes: string[],
  snapshot: { commit: string | null },
  version: { text: string; version: Semver } | undefined,
  context: { dir: string; git: boolean },
): Promise<{ state: AdvisoryState; how: string }> {
  if (version) {
    const state = versionState(version.version, advisory.ranges)
    if (state) return { state, how: `version ${version.text}` }
  }
  if (context.git && snapshot.commit && fixes.length > 0) {
    for (const fix of fixes) {
      if (await isAncestor(context.dir, fix, snapshot.commit)) {
        return { state: 'fixed', how: `holds fix ${fix.slice(0, 12)}` }
      }
    }
    return { state: 'affected', how: `lacks fix ${fixes.map((f) => f.slice(0, 12)).join(', ')}` }
  }
  return { state: 'unknown', how: 'no version and no fix commit to compare with' }
}

// What an import reported, for `esper advisories` and `esper index`.
export interface AdvisoryReport {
  fetched: boolean
  // Why the advisories were not fetched: offline, or the error.
  reason?: string
  packages: Package[]
  advisories: number
  severity: Record<Severity, number>
  low: number
  linked: Record<Precision, number>
  unlinked: number
}

// A stored advisory, with how it is linked.
export interface StoredAdvisory extends Advisory {
  status: 'linked' | 'unlinked'
  how: string
  fixes: string[]
  links: AdvisoryLink[]
  fetchedAt: string
}

// The project's advisories, in its database.
export class Advisories {
  readonly store: Store

  constructor(store: Store) {
    this.store = store
  }

  private sql(text: string): StatementSync {
    return this.store.statement(text)
  }

  list(): StoredAdvisory[] {
    return this.sql(`SELECT * FROM advisories ORDER BY id`)
      .all()
      .map((row) => {
        const json = (key: string) => JSON.parse(String(row[key])) as never
        return {
          id: String(row.id),
          aliases: json('aliases'),
          summary: String(row.summary),
          details: String(row.details),
          severity: row.severity as Severity,
          rating: row.rating === null ? null : json('rating'),
          published: (row.published as string | null) ?? null,
          modified: (row.modified as string | null) ?? null,
          package: json('package'),
          ranges: json('ranges'),
          symbols: json('symbols'),
          references: json('refs'),
          status: row.status as 'linked' | 'unlinked',
          how: String(row.how),
          fixes: json('fixes'),
          links: json('links'),
          fetchedAt: String(row.fetched_at),
        }
      })
  }

  // Replaces the stored advisories with an import: those no longer returned are removed, those
  // whose entry did not change keep their links unless they were unlinked. An advisory that cannot
  // be linked is kept unlinked, with why: one fix the index cannot read loses no other advisory.
  // `changed` lists the advisories new, changed or linked again, whose states are stale.
  async save(
    imported: AdvisoryImport,
    link: (advisory: Advisory) => Promise<Linked>,
    at = new Date().toISOString(),
  ): Promise<{ report: AdvisoryReport; changed: string[] }> {
    const known = new Map(this.list().map((a) => [a.id, a]))
    const rows: StoredAdvisory[] = []
    const changed: string[] = []
    for (const advisory of imported.advisories) {
      const old = known.get(advisory.id)
      let keep: Linked
      if (old && old.status === 'linked' && old.modified === advisory.modified) {
        keep = { status: old.status, how: old.how, fixes: old.fixes, links: old.links }
      } else {
        changed.push(advisory.id)
        try {
          keep = await link(advisory)
        } catch (error) {
          if (process.env.ESPER_DEBUG) throw error
          keep = {
            status: 'unlinked',
            how: `could not be linked: ${(error as Error).message || String(error)}`,
            fixes: [],
            links: [],
          }
        }
      }
      rows.push({ ...advisory, ...keep, fetchedAt: at })
    }
    this.store.transaction(() => {
      this.sql(`DELETE FROM advisories`).run()
      const insert = this.sql(
        `INSERT INTO advisories (id, aliases, summary, details, severity, rating, published, modified,
           package, ranges, symbols, refs, status, how, fixes, links, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const a of rows) {
        insert.run(
          a.id,
          JSON.stringify(a.aliases),
          a.summary,
          a.details,
          a.severity,
          a.rating === null ? null : JSON.stringify(a.rating),
          a.published,
          a.modified,
          JSON.stringify(a.package),
          JSON.stringify(a.ranges),
          JSON.stringify(a.symbols),
          JSON.stringify(a.references),
          a.status,
          a.how,
          JSON.stringify(a.fixes),
          JSON.stringify(a.links),
          a.fetchedAt,
        )
      }
      this.sql(
        `DELETE FROM advisory_states WHERE advisory_id NOT IN (SELECT id FROM advisories)`,
      ).run()
      this.sql(
        `INSERT INTO advisory_fetches (at, packages, advisories, low) VALUES (?, ?, ?, ?)`,
      ).run(at, JSON.stringify(imported.packages), rows.length, imported.low.length)
    })
    return { report: this.report(imported.packages, imported.low.length), changed }
  }

  // The last import's counts, and how the stored advisories are linked.
  report(packages?: Package[], low?: number): AdvisoryReport {
    const last = this.lastFetch()
    const stored = this.list()
    const severity = Object.fromEntries(severities.map((s) => [s, 0])) as Record<Severity, number>
    const linked = Object.fromEntries(precisions.map((p) => [p, 0])) as Record<Precision, number>
    let unlinked = 0
    for (const a of stored) {
      severity[a.severity]++
      if (a.status === 'unlinked') unlinked++
      // An advisory counts once, by its most precise link.
      const best = precisions.find((p) => a.links.some((l) => l.precision === p))
      if (best) linked[best]++
    }
    return {
      fetched: last !== undefined,
      packages: packages ?? last?.packages ?? [],
      advisories: stored.length,
      severity,
      low: low ?? last?.low ?? 0,
      linked,
      unlinked,
    }
  }

  lastFetch(): { at: string; packages: Package[]; low: number } | undefined {
    const row = this.sql(`SELECT * FROM advisory_fetches ORDER BY id DESC LIMIT 1`).get()
    return row
      ? {
          at: String(row.at),
          packages: JSON.parse(String(row.packages)) as Package[],
          low: Number(row.low),
        }
      : undefined
  }

  setState(id: string, snapshotId: number, state: { state: AdvisoryState; how: string }) {
    this.sql(
      `INSERT INTO advisory_states (advisory_id, snapshot_id, state, how) VALUES (?, ?, ?, ?)
       ON CONFLICT (advisory_id, snapshot_id) DO UPDATE SET state = excluded.state, how = excluded.how`,
    ).run(id, snapshotId, state.state, state.how)
  }

  states(snapshotId: number): Map<string, { state: AdvisoryState; how: string }> {
    return new Map(
      this.sql(`SELECT advisory_id, state, how FROM advisory_states WHERE snapshot_id = ?`)
        .all(snapshotId)
        .map((r) => [
          String(r.advisory_id),
          { state: r.state as AdvisoryState, how: String(r.how) },
        ]),
    )
  }

  // What changes when advisories are fetched or their states computed: a cached snapshot read
  // before is read again.
  generation(): string {
    const row = this.sql(
      `SELECT (SELECT coalesce(max(id), 0) FROM advisory_fetches) AS f,
              (SELECT count(*) FROM advisory_states) AS s`,
    ).get()
    return `${String(row?.f)}:${String(row?.s)}`
  }
}

// Where each link sits on a snapshot: the node of the same reference (for a symbol, the
// declaration of that name in its folder), else a node of the same kind with its code from before
// or after the fix, elsewhere.
export interface PlacedLink extends AdvisoryLink {
  node: string
  moved: boolean
  // How the node's code stands against the fix: as the fix left it, as it was before the fix, or
  // changed since. Absent without the fingerprints to compare with.
  code?: 'as-fixed' | 'as-before-fix' | 'changed'
}

export function placeLinks(links: AdvisoryLink[], graph: Graph): PlacedLink[] {
  const byRef = new Map(graph.nodes.map((n) => [n.ref, n]))
  const placed: PlacedLink[] = []
  for (const link of links) {
    let node: GraphNode | undefined
    let moved = false
    if (link.precision === 'symbol') {
      node = graph.nodes.find((n) => n.kind === 'decl' && symbolMatches(n, link))
    } else {
      node = byRef.get(link.ref)
      if (!node) {
        const prints = new Set([link.before, link.after].filter((p): p is string => !!p))
        const candidates = graph.nodes.filter(
          (n) => n.kind === link.kind && n.fingerprint && prints.has(n.fingerprint),
        )
        const name = link.ref.split('#')[1]
        node =
          candidates.find((n) => name !== undefined && n.ref.endsWith(`#${name}`)) ?? candidates[0]
        moved = node !== undefined
      }
    }
    if (!node) continue
    const fp = node.fingerprint ?? null
    const code =
      link.after !== undefined && link.after !== null && fp === link.after
        ? 'as-fixed'
        : link.before !== undefined && link.before !== null && fp === link.before
          ? 'as-before-fix'
          : link.after || link.before
            ? 'changed'
            : undefined
    placed.push({ ...link, node: node.ref, moved, ...(code ? { code } : {}) })
  }
  return placed
}

// The advisories as a snapshot reads them: a node each, an `affects` edge for each link placed on
// its code, and `fix-downstream` on each entry point whose handler or chain reaches an affected
// declaration through calls.
export function advisoryLayer(
  advisories: StoredAdvisory[],
  states: Map<string, { state: AdvisoryState; how: string }>,
  graph: Graph,
): { nodes: GraphNode[]; edges: GraphEdge[]; facts: Fact[] } {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const facts: Fact[] = []
  const byRef = new Map(graph.nodes.map((n) => [n.ref, n]))
  const affected = new Map<string, { advisory: string; edge: GraphEdge }[]>()
  for (const advisory of advisories) {
    const ref = `osv:${advisory.id}`
    const state = states.get(advisory.id) ?? { state: 'unknown' as const, how: 'not computed' }
    const placed = placeLinks(advisory.links, graph)
    nodes.push({
      ref,
      kind: 'advisory',
      name: advisory.id,
      data: {
        summary: advisory.summary,
        severity: advisory.severity,
        aliases: advisory.aliases,
        published: advisory.published,
        status: advisory.status,
        state: state.state,
        stateHow: state.how,
        links: placed.length,
      },
    })
    for (const link of placed) {
      const node = byRef.get(link.node) as GraphNode
      const edge: GraphEdge = {
        kind: 'affects',
        from: ref,
        to: link.node,
        citation: { file: node.file ?? link.node, line: node.startLine ?? 1 },
        source: link.source,
        data: {
          precision: link.precision,
          state: state.state,
          ...(link.fix ? { fix: link.fix } : {}),
          ...(link.hunk ? { hunk: link.hunk } : {}),
          ...(link.code ? { code: link.code } : {}),
          ...(link.moved ? { movedFrom: link.ref } : {}),
        },
      }
      edges.push(edge)
      if (node.kind === 'decl') {
        affected.set(link.node, [
          ...(affected.get(link.node) ?? []),
          { advisory: advisory.id, edge },
        ])
      }
    }
  }
  if (affected.size === 0) return { nodes, edges, facts }
  const calls = callsOf(graph.edges)
  const members = new Map<string, { to: string; from: 'handler' | 'chain' }[]>()
  for (const e of graph.edges) {
    if (e.kind === 'handles' || e.kind === 'chain') {
      members.set(e.from, [
        ...(members.get(e.from) ?? []),
        { to: e.to, from: e.kind === 'handles' ? 'handler' : 'chain' },
      ])
    }
  }
  for (const entry of graph.nodes) {
    if (entry.kind !== 'entry') continue
    const seen = new Set<string>()
    for (const part of ['handler', 'chain'] as const) {
      const best = reach(
        calls,
        (members.get(entry.ref) ?? []).filter((m) => m.from === part).map((m) => m.to),
      )
      for (const [ref, guessed] of best) {
        for (const { advisory, edge } of affected.get(ref) ?? []) {
          if (seen.has(advisory)) continue
          seen.add(advisory)
          facts.push({
            node: entry.ref,
            kind: 'signal',
            value: 'fix-downstream',
            citation: edge.citation,
            source: edge.source,
            data: {
              via: ref,
              from: part,
              advisory: advisory,
              ...(guessed ? { guessed: true } : {}),
            },
          })
        }
      }
    }
  }
  return { nodes, edges, facts }
}
