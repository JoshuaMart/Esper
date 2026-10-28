// The JSON API of `esper serve`, as the interface reads it. Its reference is
// docs/src/content/docs/reference/api.md; the shapes here are the parts the interface uses.

export interface SnapshotRef {
  id: number
  ref: string | null
  commit: string | null
  dirty?: boolean
  createdAt?: string
}

export type AnchorState = 'attached' | 'moved' | 'stale' | 'orphaned'
export type NoteKind = 'lead' | 'coverage' | 'finding' | 'context'

export interface Snapshot extends SnapshotRef {
  createdAt: string
  profiles: string[]
  analyzers: string[]
  counts: { files: number; nodes: number; entries: number; edges: number; facts: number }
  notes: Record<AnchorState, number>
}

export interface Project {
  name: string
  source: { path: string } | { url: string }
  // The source as shown: a folder in the home directory starts with ~.
  shown: string
  kind: 'application' | 'framework' | null
  kindForced: boolean
  snapshots: number
  latest: Snapshot | null
}

export interface Entry {
  ref: string
  name: string
  method?: string
  path?: string
  file?: string
  line?: number
  handlers: string[]
  chain: string[]
  guards: string[]
  reads: string[]
  signals: string[]
  notes: number
}

export interface Bounded {
  truncated: boolean
  cut: string[]
}

export interface Anchor {
  ref: string
  kind: string
  state: AnchorState
  node: string | null
}

export interface Revision {
  revision: number
  action: 'create' | 'update' | 'delete'
  author: string
  at: string
  kind: NoteKind
  status: string | null
  body: string
  citations: string[]
  anchors: string[]
  snapshot: number
  reason?: string
}

export interface Note {
  id: number
  kind: NoteKind
  status: string | null
  body: string
  citations: string[]
  author: string
  createdAt: string
  updatedAt: string
  revision: number
  anchoredOn: number
  state: AnchorState
  anchors: Anchor[]
  deleted?: { at: string; by: string; reason?: string }
  revisions?: Revision[]
}

export interface Fact {
  kind: string
  value: string
  citation: string
  source: string
}

export interface NodeDetail extends Bounded {
  snapshot: SnapshotRef
  node: {
    ref: string
    kind: string
    name: string
    file?: string
    startLine?: number
    endLine?: number
  }
  entry?: Entry
  facts: Fact[]
  edges: { out: Record<string, number>; in: Record<string, number> }
  excerpt?: { file: string; startLine: number; endLine: number; text: string }
  notes: Note[]
}

export interface DrawnNode {
  ref: string
  kind: string
  name: string
  file?: string
  line?: number
  depth: number
  chain?: number
  sinks: number
  reads: number
  signals: string[]
  notes: number
}

export interface DrawnEdge {
  from: string
  to: string
  kind: string
  citation: string
  resolution?: string
}

export interface Subgraph extends Bounded {
  snapshot: SnapshotRef
  root: string
  depth: number
  nodes: DrawnNode[]
  edges: DrawnEdge[]
  total: number
}

export interface SharedMap extends Bounded {
  snapshot: SnapshotRef
  entries: { ref: string; name: string; method?: string; path?: string; signals: string[] }[]
  shared: {
    ref: string
    kind: string
    name: string
    file?: string
    sink: boolean
    users: string[]
  }[]
  total: number
}

export interface IndexResult extends Bounded {
  snapshot: SnapshotRef
  unchanged: boolean
  profiles: string[]
  analyzers: string[]
  stats?: {
    files: number
    entries: number
    resolved: number
    guessed: number
    unresolved: number
    analyzed: number
    reads: number
    signals: number
  }
  skipped: number
  skips: { path: string; reason: string }[]
  notes: Record<AnchorState, number>
}

export interface Job {
  id: number
  project: string
  state: 'running' | 'done' | 'failed'
  messages: string[]
  result?: IndexResult
  error?: string
}

export interface Diff extends Bounded {
  from: SnapshotRef
  to: SnapshotRef
  entrypoints: {
    added: string[]
    removed: string[]
    changed: { ref: string; code: boolean; added: string[]; removed: string[] }[]
  }
  notes: { id: number; kind: string; from: AnchorState; to: AnchorState }[]
}

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type Params = Record<string, string | number | boolean | undefined>

function search(params: Params = {}) {
  const q = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') q.set(key, String(value))
  }
  const text = q.toString()
  return text ? `?${text}` : ''
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) throw new ApiError(response.status, data.error ?? `${response.status}`)
  return data as T
}

const p = (project: string) => `/projects/${encodeURIComponent(project)}`

export const api = {
  // Trades the token of the address `esper serve` printed for the session cookie.
  session: (token: string) =>
    fetch('/api/session', { method: 'POST', headers: { authorization: `Bearer ${token}` } }).then(
      (r) => {
        if (!r.ok) throw new ApiError(r.status, 'that token is not this server’s')
      },
    ),
  info: () => request<{ name: string; version: string; user: string }>('GET', '/info'),
  projects: () => request<{ projects: Project[] }>('GET', '/projects'),
  addProject: (input: { source: string; name?: string; kind?: string }) =>
    request<{ project: { name: string } }>('POST', '/projects', input),
  snapshots: (project: string) =>
    request<{ latest: number | null; snapshots: Snapshot[] }>('GET', `${p(project)}/snapshots`),
  diff: (project: string, params: Params) =>
    request<Diff>('GET', `${p(project)}/diff${search(params)}`),
  index: (project: string, input: { ref?: string; force?: boolean; precise?: boolean }) =>
    request<{ job: Job }>('POST', `${p(project)}/index`, input),
  jobs: () => request<{ jobs: Job[] }>('GET', '/jobs'),
  entrypoints: (project: string, params: Params) =>
    request<Bounded & { snapshot: SnapshotRef; entrypoints: Entry[]; total: number }>(
      'GET',
      `${p(project)}/entrypoints${search(params)}`,
    ),
  node: (project: string, params: Params) =>
    request<NodeDetail>('GET', `${p(project)}/node${search(params)}`),
  subgraph: (project: string, params: Params) =>
    request<Subgraph>('GET', `${p(project)}/subgraph${search(params)}`),
  map: (
    project: string,
    input: { entries: string[]; min: number; library: string; snapshot?: number },
  ) => request<SharedMap>('POST', `${p(project)}/map`, input),
  read: (project: string, params: Params) =>
    request<
      Bounded & {
        file: string
        startLine: number
        endLine: number
        totalLines: number
        text: string
      }
    >('GET', `${p(project)}/read${search(params)}`),
  search: (project: string, params: Params) =>
    request<{ nodes: { ref: string; kind: string; name: string; file?: string; line?: number }[] }>(
      'GET',
      `${p(project)}/search${search(params)}`,
    ),
  notes: (project: string, params: Params) =>
    request<Bounded & { snapshot: SnapshotRef; notes: Note[]; total: number }>(
      'GET',
      `${p(project)}/notes${search(params)}`,
    ),
  createNote: (project: string, input: Record<string, unknown>) =>
    request<{ note: Note }>('POST', `${p(project)}/notes`, input),
  updateNote: (project: string, id: number, input: Record<string, unknown>) =>
    request<{ note: Note }>('PATCH', `${p(project)}/notes/${id}`, input),
  deleteNote: (project: string, id: number, input: { author: string; reason?: string }) =>
    request<{ note: Note }>('DELETE', `${p(project)}/notes/${id}`, input),
}

export const statuses: Record<NoteKind, string[]> = {
  lead: ['open', 'ruled-out', 'confirmed'],
  coverage: [],
  finding: ['open', 'reported', 'fixed'],
  context: [],
}
