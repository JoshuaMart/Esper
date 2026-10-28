import { useEffect, useMemo, useState } from 'react'
import { api, type Entry } from './api.ts'
import { useProject } from './app.tsx'
import { href, Link, navigate, shortRef, useData, useLocation, withParams } from './lib.tsx'
import { MapView } from './map.tsx'
import { ErrorNotice, Icon, Spinner, TopBar } from './ui.tsx'

// The entry points of a snapshot, as tables grouped by chain, read or signal (D14), or as a map
// of the code a group shares.

export const signalNames = [
  'live-state',
  'retained-mutation',
  'short-circuit',
  'data-write',
  'data-read',
  'request-key',
  'mass-assignment',
  'divergent-guard',
  'callback-passed',
  'sink-reachable',
  'fix-downstream',
]
const guardKinds = ['authn', 'authz-role', 'authz-owner', 'csrf', 'rate-limit', 'validation']

export interface Group {
  key: string
  // What the group is: the members that follow the shared prefix, a read, a signal.
  lead: string
  tail: string[]
  entries: Entry[]
}

// The longest chain prefix that most entry points start with, to show once.
export function commonPrefix(entries: Entry[]): string[] {
  let prefix: string[] = []
  for (let k = 1; ; k++) {
    const counts = new Map<string, number>()
    for (const e of entries) {
      if (e.chain.length < k) continue
      const key = e.chain.slice(0, k).join('\0')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const [best] = [...counts].sort((a, b) => b[1] - a[1])
    if (!best || best[1] < Math.max(2, entries.length * 0.6)) break
    prefix = best[0].split('\0')
  }
  return prefix.length >= 2 ? prefix : []
}

const startsWith = (chain: string[], prefix: string[]) =>
  prefix.length > 0 && prefix.every((m, i) => chain[i] === m)

export function groupsBy(by: string, entries: Entry[], prefix: string[]): Group[] {
  const groups = new Map<string, Group>()
  const put = (key: string, make: () => Omit<Group, 'entries' | 'key'>, entry: Entry) => {
    let g = groups.get(key)
    if (!g) {
      g = { key, ...make(), entries: [] }
      groups.set(key, g)
    }
    g.entries.push(entry)
  }
  for (const e of entries) {
    if (by === 'chain') {
      const key = `chain:${e.chain.join(' > ')}`
      put(
        key,
        () => {
          if (e.chain.length === 0) return { lead: 'No chain', tail: [] }
          if (startsWith(e.chain, prefix)) {
            const tail = e.chain.slice(prefix.length).map(shortRef)
            return tail.length === 0
              ? { lead: `${prefix.length}, nothing more`, tail }
              : { lead: `${prefix.length} + `, tail }
          }
          return { lead: '', tail: e.chain.map(shortRef) }
        },
        e,
      )
    } else if (by === 'read') {
      if (e.reads.length === 0) put('read:', () => ({ lead: 'No read', tail: [] }), e)
      for (const r of e.reads) put(`read:${r}`, () => ({ lead: '', tail: [r] }), e)
    } else if (by === 'signal') {
      if (e.signals.length === 0) put('signal:', () => ({ lead: 'No signal', tail: [] }), e)
      for (const s of e.signals) put(`signal:${s}`, () => ({ lead: '', tail: [s] }), e)
    } else {
      put('all', () => ({ lead: 'All entry points', tail: [] }), e)
    }
  }
  return [...groups.values()].sort(
    (a, b) => b.entries.length - a.entries.length || (a.key < b.key ? -1 : 1),
  )
}

const count = (lists: string[][]) => {
  const counts = new Map<string, number>()
  for (const list of lists) for (const v of new Set(list)) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}

export function EntriesPage({ project }: { project: string }) {
  const p = useProject(project)
  const { params } = useLocation()
  const asked = params.get('by')
  const view = params.get('view') ?? 'table'
  const filters = {
    path: params.get('path') ?? undefined,
    method: params.get('method') ?? undefined,
    read: params.get('read') ?? undefined,
    signal: params.get('signal') ?? undefined,
    withoutGuard: params.get('withoutGuard') ?? undefined,
  }
  const key = p.snapshot
    ? `${project}:${p.snapshot}:${JSON.stringify(filters)}:${p.version}`
    : undefined
  const entries = useData(key, () =>
    api.entrypoints(project, { snapshot: p.snapshot, limit: 500, ...filters }),
  )
  const list = entries.data?.entrypoints ?? []
  // A framework's entry points have no chain: they are grouped by signal unless asked otherwise.
  const by =
    asked ?? (list.length > 0 && list.every((e) => e.chain.length === 0) ? 'signal' : 'chain')
  const prefix = useMemo(() => commonPrefix(list), [list])
  const groups = useMemo(() => groupsBy(by, list, prefix), [by, list, prefix])
  const current = p.snapshots?.find((s) => s.id === p.snapshot)
  const filtered = Object.values(filters).some(Boolean)

  const set = (changes: Record<string, string | undefined>) =>
    navigate(withParams(changes), { replace: true })

  return (
    <>
      <TopBar
        project={project}
        {...(p.projects ? { projects: p.projects } : {})}
        {...(p.snapshots ? { snapshots: p.snapshots } : {})}
        {...(p.snapshot !== undefined ? { snapshot: p.snapshot } : {})}
        latest={p.latest}
        current="entries"
      />
      <main className="page">
        <div className="head">
          <div className="stack">
            <h1 className="h1">
              Entry points{' '}
              {entries.data ? (
                <span className="muted" style={{ fontWeight: 400 }}>
                  {entries.data.total}
                </span>
              ) : null}
            </h1>
            <p className="muted" style={{ margin: 0 }}>
              {current
                ? `${project} at ${current.ref ?? current.commit?.slice(0, 12) ?? `snapshot ${current.id}`}, read with ${current.profiles.join(' and ')}`
                : ' '}
            </p>
          </div>
          <div className="row" style={{ gap: 16 }}>
            {view === 'table' ? (
              <div className="row" style={{ gap: 8 }}>
                <span className="muted" id="group-label">
                  Group by
                </span>
                <fieldset className="seg" aria-labelledby="group-label">
                  {['chain', 'read', 'signal', 'none'].map((b) => (
                    <button
                      key={b}
                      type="button"
                      aria-pressed={by === b}
                      onClick={() => set({ by: b })}
                    >
                      {b[0]?.toUpperCase()}
                      {b.slice(1)}
                    </button>
                  ))}
                </fieldset>
              </div>
            ) : null}
            <div className="row" style={{ gap: 8 }}>
              <span className="muted" id="view-label">
                View
              </span>
              <fieldset className="seg" aria-labelledby="view-label">
                <button
                  type="button"
                  aria-pressed={view === 'table'}
                  onClick={() => set({ view: undefined })}
                >
                  Table
                </button>
                <button
                  type="button"
                  aria-pressed={view === 'map'}
                  onClick={() => set({ view: 'map' })}
                >
                  Map
                </button>
              </fieldset>
            </div>
          </div>
        </div>

        {p.error ? <ErrorNotice error={p.error} /> : null}
        {p.snapshots && p.snapshots.length === 0 ? (
          <section className="card empty">
            <p style={{ margin: 0 }}>{project} has no snapshot yet.</p>
            <Link className="btn btn-primary" to={href('/', { project })}>
              Index it from its project
            </Link>
          </section>
        ) : null}

        <Filters
          filters={filters}
          set={set}
          methods={[...new Set(list.map((e) => e.method).filter(Boolean))] as string[]}
        />

        {entries.error ? <ErrorNotice error={entries.error} /> : null}
        {entries.data?.truncated ? <p className="hint">{entries.data.cut.join('; ')}</p> : null}

        {view === 'map' && entries.data && p.snapshot ? (
          <MapView
            project={project}
            snapshot={p.snapshot}
            asked={p.asked}
            entries={list}
            prefix={prefix}
          />
        ) : (
          <div className="split" style={{ gap: 24 }}>
            <Facets list={list} filters={filters} set={set} />
            <div className="stack" style={{ flex: '999 1 640px', minWidth: 0, gap: 16 }}>
              {by === 'chain' && prefix.length > 0 ? (
                <section
                  className="card stack"
                  style={{ padding: '14px 16px', gap: 8 }}
                  aria-labelledby="prefix-title"
                >
                  <h2 className="h2" id="prefix-title" style={{ fontWeight: 500 }}>
                    {list.filter((e) => startsWith(e.chain, prefix)).length} of {list.length} chains
                    start with these {prefix.length} members
                  </h2>
                  <ol className="row" style={{ gap: 4, margin: 0, padding: 0, listStyle: 'none' }}>
                    {prefix.map((m, i) => (
                      <li key={m} className="row" style={{ gap: 4 }}>
                        <span className="chip" title={m}>
                          {shortRef(m)}
                        </span>
                        {i < prefix.length - 1 ? (
                          <span className="muted">
                            <Icon name="chevron" size={12} />
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                  <p className="muted" style={{ margin: 0 }}>
                    Groups below name what follows them.
                  </p>
                </section>
              ) : null}
              {entries.loading && !entries.data ? <Spinner /> : null}
              {entries.data && list.length === 0 ? (
                <section className="card empty">
                  <p style={{ margin: 0 }}>
                    {filtered
                      ? 'No entry point matches these filters.'
                      : 'This snapshot has no entry point.'}
                  </p>
                  {filtered ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        set({
                          path: undefined,
                          method: undefined,
                          read: undefined,
                          signal: undefined,
                          withoutGuard: undefined,
                        })
                      }
                    >
                      Clear filters
                    </button>
                  ) : null}
                </section>
              ) : null}
              {groups.length > 0 ? (
                <section className="card" aria-label={`Entry points by ${by}`}>
                  {groups.map((g, i) => (
                    <GroupRows
                      key={`${by}:${g.key}`}
                      group={g}
                      open={i < 2 || groups.length === 1}
                      project={project}
                      asked={p.asked}
                    />
                  ))}
                </section>
              ) : null}
            </div>
          </div>
        )}
      </main>
    </>
  )
}

function Filters({
  filters,
  set,
  methods,
}: {
  filters: Record<string, string | undefined>
  set: (changes: Record<string, string | undefined>) => void
  methods: string[]
}) {
  const [path, setPath] = useState(filters.path ?? '')
  const [read, setRead] = useState(filters.read ?? '')
  // Typing filters after a pause, not on every key.
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((filters.path ?? '') !== path) set({ path: path || undefined })
    }, 250)
    return () => clearTimeout(timer)
  }, [path, filters.path, set])
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((filters.read ?? '') !== read) set({ read: read || undefined })
    }, 250)
    return () => clearTimeout(timer)
  }, [read, filters.read, set])
  // The fields follow the address when it changes elsewhere: Clear filters, the back button.
  useEffect(() => setRead(filters.read ?? ''), [filters.read])
  useEffect(() => setPath(filters.path ?? ''), [filters.path])
  return (
    <form
      className="row filters"
      style={{ gap: 12, alignItems: 'flex-end' }}
      aria-label="Filters"
      onSubmit={(e) => e.preventDefault()}
    >
      <div className="field" style={{ flex: '1 1 260px' }}>
        <label htmlFor="f-path">Path</label>
        <input
          id="f-path"
          className="input mono"
          type="search"
          placeholder="/api/users/{user}"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="f-method">Method</label>
        <select
          id="f-method"
          className="input"
          value={filters.method ?? ''}
          onChange={(e) => set({ method: e.target.value || undefined })}
        >
          <option value="">Any</option>
          {[...new Set([...methods, ...(filters.method ? [filters.method] : [])])]
            .sort()
            .map((m) => (
              <option key={m}>{m}</option>
            ))}
        </select>
      </div>
      <div className="field" style={{ flex: '0 1 220px' }}>
        <label htmlFor="f-read">Read</label>
        <input
          id="f-read"
          className="input mono"
          type="text"
          placeholder="header.X-Real-IP"
          value={read}
          onChange={(e) => setRead(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="f-signal">Signal</label>
        <select
          id="f-signal"
          className="input"
          value={filters.signal ?? ''}
          onChange={(e) => set({ signal: e.target.value || undefined })}
        >
          <option value="">Any</option>
          {signalNames.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="f-guard">Without guard</label>
        <select
          id="f-guard"
          className="input"
          value={filters.withoutGuard ?? ''}
          onChange={(e) => set({ withoutGuard: e.target.value || undefined })}
        >
          <option value="">Any</option>
          <option value="any">any guard</option>
          {guardKinds.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
      </div>
    </form>
  )
}

function Facets({
  list,
  filters,
  set,
}: {
  list: Entry[]
  filters: Record<string, string | undefined>
  set: (changes: Record<string, string | undefined>) => void
}) {
  const [allReads, setAllReads] = useState(false)
  const signals = count(list.map((e) => e.signals))
  const reads = count(list.map((e) => e.reads))
  const guards = count(list.map((e) => e.guards))
  return (
    <aside className="facets" aria-label="Facets">
      <section className="stack" style={{ gap: 8 }}>
        <h2 className="h3">Signals</h2>
        {signals.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            None
          </p>
        ) : null}
        <ul className="facet">
          {signals.map(([s, n]) => (
            <li key={s}>
              <button
                type="button"
                aria-pressed={filters.signal === s}
                onClick={() => set({ signal: filters.signal === s ? undefined : s })}
              >
                <span className="mono">{s}</span>
                <span className="n">{n}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="stack" style={{ gap: 8 }}>
        <h2 className="h3">Reads</h2>
        <ul className="facet">
          {(allReads ? reads : reads.slice(0, 10)).map(([r, n]) => (
            <li key={r}>
              <button
                type="button"
                aria-pressed={filters.read === r}
                onClick={() => set({ read: filters.read === r ? undefined : r })}
              >
                <span className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {r}
                </span>
                <span className="n">{n}</span>
              </button>
            </li>
          ))}
        </ul>
        {reads.length > 10 ? (
          <button
            type="button"
            className="link"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setAllReads(!allReads)}
          >
            {allReads ? 'Fewer reads' : `All ${reads.length} reads`}
          </button>
        ) : null}
      </section>
      <section className="stack" style={{ gap: 8 }}>
        <h2 className="h3">Guards</h2>
        {guards.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            None recorded: the profiles name no guard that these entry points call.
          </p>
        ) : (
          <ul className="facet">
            {guards.map(([g, n]) => (
              <li key={g}>
                <button
                  type="button"
                  aria-pressed={filters.withoutGuard === g}
                  onClick={() => set({ withoutGuard: filters.withoutGuard === g ? undefined : g })}
                  title={`Show the entry points without ${g}`}
                >
                  <span className="mono">{g}</span>
                  <span className="n">{n}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}

const shown = 8

function GroupRows({
  group,
  open: initially,
  project,
  asked,
}: {
  group: Group
  open: boolean
  project: string
  asked: number | undefined
}) {
  const [open, setOpen] = useState(initially)
  const [all, setAll] = useState(false)
  const rows = all ? group.entries : group.entries.slice(0, shown)
  const id = `g-${group.key.replace(/[^a-z0-9]/gi, '-')}`
  return (
    <div className="group">
      <button
        type="button"
        className="ghead"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span className="caret muted">
          <Icon name="chevron" size={14} />
        </span>
        {group.lead ? <span className="muted">{group.lead}</span> : null}
        <span className="chips">
          {group.tail.map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a chain can name a member twice
            <span key={i} className="chip chip-strong">
              {t}
            </span>
          ))}
        </span>
        <span
          className="muted"
          style={{ marginInlineStart: 'auto', fontVariantNumeric: 'tabular-nums' }}
        >
          {group.entries.length} {group.entries.length === 1 ? 'entry point' : 'entry points'}
        </span>
      </button>
      {open ? (
        <div id={id}>
          <div className="scroll">
            <table className="t">
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Handler</th>
                  <th className="num">Reads</th>
                  <th>Signals</th>
                  <th className="num">Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.ref}>
                    <td>
                      <span className="method">{e.method ?? '–'}</span>
                    </td>
                    <td>
                      <Link
                        className="path"
                        to={href(`/p/${encodeURIComponent(project)}/entry`, {
                          node: e.ref,
                          snapshot: asked,
                        })}
                      >
                        {e.path ?? e.name}
                      </Link>
                    </td>
                    <td className="mono muted">{e.handlers.map(shortRef).join(', ') || '–'}</td>
                    <td className="num">{e.reads.length}</td>
                    <td>
                      <span className="chips">
                        {e.signals.map((s) => (
                          <span key={s} className="chip">
                            {s}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="num">{e.notes || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {group.entries.length > shown ? (
            <div className="more">
              <button type="button" className="btn" onClick={() => setAll(!all)}>
                {all ? 'Show fewer' : `Show ${group.entries.length - shown} more`}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
