import { useEffect, useState } from 'react'
import { api, type Job, type Project, type Snapshot } from './api.ts'
import {
  formatDate,
  formatNumber,
  formatShortDate,
  href,
  Link,
  plural,
  shortCommit,
  shortRef,
  snapshotLabel,
  useData,
  useLive,
  useLocation,
} from './lib.tsx'
import { ErrorNotice, Icon, KindBadge, NoteStates, plainText, Spinner, StateBadge } from './ui.tsx'
import { useWorkspace, Workspace } from './workspace.tsx'

// The workspace: every project in a rail, and the one selected in full: where its latest snapshot
// stands, what needs a look, its history with what changed between snapshots, how an agent
// connects, and the notes as they are written.

export function ProjectsPage() {
  const { params } = useLocation()
  return (
    <Workspace project={params.get('project') ?? undefined} current="overview">
      <Projects />
    </Workspace>
  )
}

function Projects() {
  const { projects, selected, add, index } = useWorkspace()

  useEffect(() => {
    document.title = selected ? `${selected.name} · Esper` : 'Projects · Esper'
  }, [selected])

  if (selected) {
    return <Overview key={selected.name} project={selected} onIndex={() => index(selected.name)} />
  }
  return (
    <main className="overview" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      {projects?.error ? <ErrorNotice error={projects.error} /> : null}
      {projects?.data ? (
        <section className="card empty" aria-labelledby="empty-title">
          <h1 className="h2" id="empty-title" style={{ color: 'var(--text)' }}>
            No project yet
          </h1>
          <p style={{ margin: 0 }}>
            Add a folder or a git repository: Esper reads it, never runs it, and maps its entry
            points.
          </p>
          <button type="button" className="btn btn-primary" onClick={add}>
            <Icon name="plus" />
            Add project
          </button>
        </section>
      ) : (
        <h1 className="sr-only">Projects</h1>
      )}
      {!projects?.data && !projects?.error ? <Spinner /> : null}
    </main>
  )
}

function Overview({ project, onIndex }: { project: Project; onIndex: () => void }) {
  const name = project.name
  const live = useLive()
  const version = live.version(name)
  const snapshots = useData(`${name}:snapshots:${version}`, () => api.snapshots(name))
  const list = snapshots.data?.snapshots ?? []
  const latest = list.find((s) => s.id === snapshots.data?.latest)
  const previous = latest ? list.find((s) => s.id < latest.id) : undefined
  const job = [...live.jobs.values()].find((j) => j.project === name && j.state === 'running')
  const indexed = project.latest !== null
  const p = encodeURIComponent(name)

  return (
    <main className="overview">
      <div className="stack" style={{ gap: 24 }}>
        <section className="stack" style={{ gap: 8 }} aria-labelledby="p-title">
          <div className="head" style={{ alignItems: 'flex-start' }}>
            <div className="stack" style={{ gap: 8 }}>
              <div className="row" style={{ gap: 10 }}>
                <h1 className="title" id="p-title">
                  {name}
                </h1>
                {project.kind ? <span className="chip">{project.kind}</span> : null}
                {latest?.profiles.map((x) => (
                  <span key={x} className="chip chip-strong">
                    {x}
                  </span>
                ))}
              </div>
              <span className="row muted" style={{ gap: 8 }}>
                <Icon name="source" size={14} />
                <span className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {project.shown}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {'path' in project.source
                    ? 'read in place, never written to'
                    : 'cloned into Esper’s home, never run'}
                </span>
              </span>
            </div>
            <div className="row" style={{ gap: 8 }}>
              {indexed ? (
                <>
                  <button type="button" className="btn" onClick={onIndex} disabled={!!job}>
                    <Icon name="refresh" />
                    Index a ref
                  </button>
                  <Link className="btn btn-primary" to={`/p/${p}`}>
                    Open entry points
                    <Icon name="move" />
                  </Link>
                </>
              ) : null}
            </div>
          </div>
        </section>

        {snapshots.error ? <ErrorNotice error={snapshots.error} /> : null}

        {latest ? <Glance project={name} latest={latest} previous={previous} /> : null}

        {indexed || job ? <Attention project={name} latest={latest} job={job} /> : null}

        {snapshots.data && list.length === 0 && !job ? (
          <section className="card empty" aria-labelledby="none-title">
            <h2 className="h2" id="none-title" style={{ color: 'var(--text)' }}>
              {name} is not indexed yet
            </h2>
            <p style={{ margin: 0, maxWidth: '56ch' }}>
              Indexing reads its files, maps its entry points and what they call, and keeps the
              result as a snapshot. Nothing in it runs.
            </p>
            <button type="button" className="btn btn-primary" onClick={onIndex}>
              <Icon name="refresh" />
              Index {name}
            </button>
          </section>
        ) : null}

        {list.length > 0 ? (
          <History project={name} snapshots={list} latest={snapshots.data?.latest ?? null} />
        ) : null}
      </div>

      <aside className="stack" style={{ gap: 24 }} aria-label="Agents and activity">
        <Connect project={name} />
        {indexed ? <Activity project={name} version={version} /> : null}
      </aside>
    </main>
  )
}

// The latest snapshot in four figures, each opening where it is detailed.
function Glance({
  project,
  latest,
  previous,
}: {
  project: string
  latest: Snapshot
  previous: Snapshot | undefined
}) {
  const p = encodeURIComponent(project)
  const notes = latest.notes
  const total = notes.attached + notes.moved + notes.stale + notes.orphaned
  const edges = previous ? latest.counts.edges - previous.counts.edges : 0
  const tools = [...latest.analyzers]
  return (
    <section className="card" aria-labelledby="glance-title">
      <div className="phead">
        <h2 className="eyebrow" id="glance-title">
          Latest · #{latest.id} ·{' '}
          <span style={{ textTransform: 'none' }}>{snapshotLabel(latest)}</span>
        </h2>
        <span className="muted" style={{ fontSize: '0.75rem' }}>
          Indexed {formatShortDate(latest.createdAt)}
          {tools.length > 0 ? ` with ${tools.join(' and ')}` : ''}
        </span>
      </div>
      <div className="metrics">
        <Link className="metric" to={`/p/${p}`}>
          <span className="eyebrow">Entry points</span>
          <span className="v">{formatNumber(latest.counts.entries)}</span>
          <span className="s">grouped by chain</span>
        </Link>
        <div className="metric">
          <span className="eyebrow">Call edges</span>
          <span className="v">{formatNumber(latest.counts.edges)}</span>
          <span className="s">
            {previous && edges !== 0 ? (
              <>
                <Signed n={edges} /> since #{previous.id}
              </>
            ) : previous ? (
              `as in #${previous.id}`
            ) : (
              'first snapshot'
            )}
          </span>
        </div>
        <div className="metric">
          <span className="eyebrow">Files</span>
          <span className="v">{formatNumber(latest.counts.files)}</span>
          <span className="s">read, never run</span>
        </div>
        <Link className="metric" to={`/p/${p}/notes`}>
          <span className="eyebrow">Notes</span>
          <span className="v" style={total === 0 ? { color: 'var(--edge)' } : undefined}>
            {formatNumber(total)}
          </span>
          <span className="s">
            {total === 0
              ? 'none written yet'
              : `${notes.attached} attached${notes.stale ? `, ${notes.stale} stale` : ''}${notes.orphaned ? `, ${notes.orphaned} orphaned` : ''}`}
          </span>
        </Link>
      </div>
    </section>
  )
}

function Signed({ n }: { n: number }) {
  return (
    <span className={n > 0 ? 'plus' : 'minus'}>
      {n > 0 ? `+${formatNumber(n)}` : `−${formatNumber(-n)}`}
    </span>
  )
}

// What needs a look on the latest snapshot: an index running, notes whose code changed or went
// away, advisories that affect this version. Said plainly when there is none.
function Attention({
  project,
  latest,
  job,
}: {
  project: string
  latest: Snapshot | undefined
  job: Job | undefined
}) {
  const p = encodeURIComponent(project)
  const advisories = useData(latest ? `${project}:affected:${latest.id}` : undefined, () =>
    api.advisories(project, { state: 'affected', limit: 1 }),
  )
  const notes = latest?.notes
  const affected = advisories.data?.total ?? 0
  const items: React.ReactNode[] = []
  if (job) {
    items.push(
      <li key="job" className="att">
        <Spinner />
        <span className="what">
          <b style={{ fontWeight: 600 }}>Indexing {project}.</b>{' '}
          <span className="muted">{job.messages.at(-1) ?? 'Starting…'}</span>
        </span>
      </li>,
    )
  }
  if (notes && notes.stale + notes.orphaned > 0) {
    const n = notes.stale + notes.orphaned
    items.push(
      <li key="notes" className="att">
        <StateBadge state={notes.orphaned > 0 ? 'orphaned' : 'stale'} count={n} />
        <span className="what muted">
          {notes.orphaned > 0
            ? 'The code some notes sat on is gone, or changed since they were written.'
            : 'The code these notes sit on changed since they were written.'}
        </span>
        <Link
          className="btn btn-small"
          to={href(`/p/${p}/notes`, { anchorState: notes.orphaned > 0 ? 'orphaned' : 'stale' })}
        >
          Review {plural(n, 'it', 'them')}
        </Link>
      </li>,
    )
  }
  if (affected > 0) {
    items.push(
      <li key="advisories" className="att">
        <span className="badge sev-high">
          {affected} {plural(affected, 'advisory', 'advisories')}
        </span>
        <span className="what muted">affect the version of this snapshot.</span>
        <Link className="btn btn-small" to={href(`/p/${p}/advisories`, { state: 'affected' })}>
          See {plural(affected, 'it', 'them')}
        </Link>
      </li>,
    )
  }
  if (items.length === 0 && latest && advisories.data) {
    items.push(
      <li key="calm" className="att">
        <span style={{ color: 'var(--coverage)', display: 'inline-flex' }}>
          <Icon name="check" stroke={2.5} />
        </span>
        <span className="what">
          <b style={{ fontWeight: 600 }}>Nothing to review.</b>{' '}
          <span className="muted">
            No stale or orphaned note,{' '}
            {advisories.data.fetched
              ? 'no advisory affecting this snapshot.'
              : 'and its advisories were not fetched.'}
          </span>
        </span>
      </li>,
    )
  }
  if (items.length === 0) return null
  return (
    <ul className="attention" aria-label="What needs a look">
      {items}
    </ul>
  )
}

// The snapshots, newest first, and between two of them what changed as their counts and tools tell
// it. Ticking two compares them with the diff: entry points added, removed and changed, and notes.
function History({
  project,
  snapshots,
  latest,
}: {
  project: string
  snapshots: Snapshot[]
  latest: number | null
}) {
  const p = encodeURIComponent(project)
  const [picked, setPicked] = useState<number[]>(() => snapshots.slice(0, 2).map((s) => s.id))
  const toggle = (id: number) =>
    setPicked((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id].slice(-2)))
  const [from, to] = [...picked].sort((a, b) => a - b)
  const entries = (id: number) => href(`/p/${p}`, id === latest ? {} : { snapshot: id })
  return (
    <section className="card" aria-labelledby="h-title">
      <div className="phead">
        <h2 className="eyebrow" id="h-title">
          History · {snapshots.length} {plural(snapshots.length, 'snapshot', 'snapshots')}
        </h2>
        {snapshots.length > 1 ? (
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            Tick two to compare them
          </span>
        ) : null}
      </div>
      <ol className="hist">
        {snapshots.map((s, i) => {
          const older = snapshots[i + 1]
          return [
            <li key={s.id} className="snap" data-latest={s.id === latest}>
              {snapshots.length > 1 ? (
                <input
                  type="checkbox"
                  aria-label={`Compare snapshot ${s.id}`}
                  checked={picked.includes(s.id)}
                  onChange={() => toggle(s.id)}
                />
              ) : (
                <span />
              )}
              <span className="mark" aria-hidden="true">
                <b className="knot" />
              </span>
              <div className="body">
                <div className="row" style={{ gap: 10 }}>
                  <span className="id">#{s.id}</span>
                  <span className="mono">{s.ref ?? 'folder'}</span>
                  {s.id === latest ? <span className="chip chip-accent">latest</span> : null}
                  {s.dirty ? <span className="chip">dirty</span> : null}
                  {s.commit ? <span className="mono muted">{shortCommit(s.commit)}</span> : null}
                </div>
                <div className="sub">
                  <span>{formatDate(s.createdAt)}</span>
                  <span aria-hidden="true">·</span>
                  {[...s.profiles, ...s.analyzers].map((x) => (
                    <span key={x} className="chip chip-strong">
                      {x}
                    </span>
                  ))}
                  {s.notes.attached + s.notes.moved + s.notes.stale + s.notes.orphaned > 0 ? (
                    <NoteStates notes={s.notes} />
                  ) : null}
                </div>
              </div>
              <div className="side">
                <span className="fig">
                  <b className="fig-v">{formatNumber(s.counts.entries)}</b>entry points
                </span>
                <span className="fig">
                  <b className="fig-v">{formatNumber(s.counts.edges)}</b>edges
                </span>
                <Link
                  className="btn btn-small"
                  to={entries(s.id)}
                  aria-label={`Open the entry points of snapshot ${s.id}`}
                >
                  Open
                </Link>
              </div>
            </li>,
            older ? <Delta key={`${s.id}:delta`} from={older} to={s} /> : null,
          ]
        })}
      </ol>
      {from !== undefined && to !== undefined ? (
        <Compare project={project} from={from} to={to} />
      ) : null}
    </section>
  )
}

// What changed from one snapshot to the next, as far as their counts and tools say.
function Delta({ from, to }: { from: Snapshot; to: Snapshot }) {
  const before = [...from.profiles, ...from.analyzers]
  const after = [...to.profiles, ...to.analyzers]
  const added = after.filter((x) => !before.includes(x))
  const removed = before.filter((x) => !after.includes(x))
  const entries = to.counts.entries - from.counts.entries
  const edges = to.counts.edges - from.counts.edges
  const commit = from.commit !== to.commit
  const nothing = !commit && added.length + removed.length === 0 && entries === 0 && edges === 0
  return (
    <li className="delta" aria-label={`From snapshot ${from.id} to ${to.id}`}>
      <span />
      <span className="mark" aria-hidden="true" />
      <div className="what">
        <span className="mono" style={{ fontSize: '0.6875rem' }}>
          #{from.id} → #{to.id}
        </span>
        {nothing ? (
          <span>Same commit, same profiles: nothing changed</span>
        ) : (
          <>
            {commit ? (
              <span>
                commit <span className="mono">{shortCommit(from.commit) || 'folder'}</span> →{' '}
                <span className="mono">{shortCommit(to.commit) || 'folder'}</span>
              </span>
            ) : null}
            {added.map((x) => (
              <span key={`+${x}`} className="chip chip-new">
                + {x}
              </span>
            ))}
            {removed.map((x) => (
              <span key={`-${x}`} className="chip chip-gone">
                − {x}
              </span>
            ))}
            {entries === 0 ? (
              <span className="muted">as many entry points</span>
            ) : (
              <span>
                entry points <Signed n={entries} />
              </span>
            )}
            {edges === 0 ? (
              <span className="muted">as many edges</span>
            ) : (
              <span>
                edges <Signed n={edges} />
              </span>
            )}
          </>
        )}
      </div>
    </li>
  )
}

function Compare({ project, from, to }: { project: string; from: number; to: number }) {
  const live = useLive()
  const version = live.version(project)
  const diff = useData(`${project}:diff:${from}:${to}:${version}`, () =>
    api.diff(project, { from, to }),
  )
  return (
    <section className="compare" aria-labelledby="cmp-title">
      <h3 className="eyebrow" id="cmp-title">
        Compared · #{from} → #{to}
      </h3>
      {diff.error ? <ErrorNotice error={diff.error} /> : null}
      {diff.data ? (
        <dl className="kv">
          <dt>Entry points added</dt>
          <dd>
            <Refs refs={diff.data.entrypoints.added} />
          </dd>
          <dt>Entry points removed</dt>
          <dd>
            <Refs refs={diff.data.entrypoints.removed} />
          </dd>
          <dt>Entry points changed</dt>
          <dd>
            <Refs refs={diff.data.entrypoints.changed.map((c) => c.ref)} />
          </dd>
          <dt>Notes that changed state</dt>
          <dd>
            {diff.data.notes.length === 0 ? (
              <span className="muted">none</span>
            ) : (
              <Link className="link" to={href(`/p/${encodeURIComponent(project)}/notes`)}>
                {diff.data.notes.length} {plural(diff.data.notes.length, 'note', 'notes')}
              </Link>
            )}
          </dd>
        </dl>
      ) : (
        <Spinner />
      )}
    </section>
  )
}

function Refs({ refs }: { refs: string[] }) {
  if (refs.length === 0) return <span className="muted">none</span>
  return (
    <>
      <span className="num">{refs.length}</span> ·{' '}
      {refs.slice(0, 3).map((r, i) => (
        <span key={r}>
          {i > 0 ? ', ' : ''}
          <span className="mono">{shortRef(r)}</span>
        </span>
      ))}
      {refs.length > 3 ? ` and ${refs.length - 3} more` : ''}
    </>
  )
}

// Where an agent connects: the project's address over HTTP, or the command over stdio.
function Connect({ project }: { project: string }) {
  const [way, setWay] = useState<'http' | 'stdio'>('http')
  const [copied, setCopied] = useState(false)
  const text = way === 'http' ? `${location.origin}/mcp/${project}` : `esper mcp ${project}`
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <section className="card" aria-labelledby="a-title">
      <div className="phead">
        <h2 className="eyebrow" id="a-title">
          Connect an agent
        </h2>
      </div>
      <div className="tabs" role="tablist" aria-label="How the agent connects">
        {(
          [
            ['http', 'HTTP'],
            ['stdio', 'Stdio'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={way === value}
            onClick={() => setWay(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="stack" style={{ gap: 14, padding: 16 }} role="tabpanel">
        <div className="copyfield">
          <code>{text}</code>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true))}
          >
            <Icon name={copied ? 'check' : 'copy'} size={14} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <ol className="howto">
          {way === 'http' ? (
            <>
              <li>Add this address as an MCP server in your agent.</li>
              <li>
                <span>
                  Send the token <span className="mono">esper serve</span> printed as{' '}
                  <span className="mono">Authorization: Bearer</span>.
                </span>
              </li>
            </>
          ) : (
            <li>Have your agent run this command as an MCP server, on this machine.</li>
          )}
          <li>Ask it to review an entry point: its notes appear here as it writes them.</li>
        </ol>
      </div>
    </section>
  )
}

// The notes as they are written, newest first, by you or an agent.
function Activity({ project, version }: { project: string; version: number }) {
  const notes = useData(`${project}:activity:${version}`, () => api.notes(project, {}))
  const p = encodeURIComponent(project)
  const recent = [...(notes.data?.notes ?? [])]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5)
  return (
    <section className="card" aria-labelledby="act-title">
      <div className="phead">
        <h2 className="eyebrow" id="act-title">
          Activity
        </h2>
        {notes.data && notes.data.total > recent.length ? (
          <Link className="link" style={{ fontSize: '0.75rem' }} to={`/p/${p}/notes`}>
            All {notes.data.total} notes
          </Link>
        ) : null}
      </div>
      {notes.error ? (
        <div style={{ padding: 16 }}>
          <ErrorNotice error={notes.error} />
        </div>
      ) : null}
      {notes.data && recent.length === 0 ? (
        <div className="stack" style={{ gap: 6, padding: 16, fontSize: '0.8125rem' }}>
          <b style={{ fontWeight: 600 }}>No notes on {project} yet</b>
          <span className="muted">
            Notes you or an agent write on entry points appear here, newest first.
          </span>
          <Link
            className="btn btn-small"
            to={`/p/${p}`}
            style={{ alignSelf: 'flex-start', marginTop: 6 }}
          >
            Browse entry points
          </Link>
        </div>
      ) : null}
      {recent.map((n) => (
        <Link key={n.id} className="activity" to={href(`/p/${p}/notes`, { id: n.id })}>
          <span className="row" style={{ gap: 6 }}>
            <KindBadge kind={n.kind} status={n.status} />
            {n.state !== 'attached' ? <StateBadge state={n.state} /> : null}
          </span>
          <p className="clamp">{plainText(n.body)}</p>
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            {n.author} · {formatShortDate(n.updatedAt)}
          </span>
        </Link>
      ))}
      {!notes.data && !notes.error ? (
        <div style={{ padding: 16 }}>
          <Spinner />
        </div>
      ) : null}
    </section>
  )
}
