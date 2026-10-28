import { useEffect, useRef, useState } from 'react'
import { api, type IndexResult, type Job } from './api.ts'
import {
  formatDate,
  formatNumber,
  formatShortDate,
  href,
  Link,
  navigate,
  shortCommit,
  shortRef,
  snapshotLabel,
  useData,
  useLive,
  useLocation,
} from './lib.tsx'
import { ErrorNotice, Icon, NoteStates, Spinner, TopBar } from './ui.tsx'

// Projects and their snapshots: what is indexed, how the notes stand on each, what changed
// between the last two, and where an agent connects.

export function ProjectsPage() {
  const { params } = useLocation()
  const live = useLive()
  // Read again when an index finishes, or when a project's notes change.
  const finished = [...live.jobs.values()].filter((j) => j.state !== 'running').length
  const projects = useData(`projects:${finished}`, () => api.projects())
  const list = projects.data?.projects ?? []
  const selected = params.get('project') ?? list[0]?.name
  const [dialog, setDialog] = useState<{ step: 'add' | 'index'; project?: string }>()

  useEffect(() => {
    document.title = 'Projects · Esper'
  }, [])

  return (
    <>
      <TopBar />
      <main className="page" style={{ gap: 32 }}>
        <div className="head">
          <div className="stack">
            <h1 className="h1">Projects</h1>
            <p className="muted" style={{ margin: 0 }}>
              {projects.data
                ? `${list.length} ${list.length === 1 ? 'project' : 'projects'}`
                : 'Loading…'}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setDialog({ step: 'add' })}
          >
            <Icon name="plus" />
            Add project
          </button>
        </div>

        {projects.error ? <ErrorNotice error={projects.error} /> : null}

        {projects.data && list.length === 0 ? (
          <section className="card empty">
            <h2 className="h2" style={{ color: 'var(--text)' }}>
              No project yet
            </h2>
            <p style={{ margin: 0 }}>
              Add a folder or a git repository: Esper reads it, never runs it, and maps its entry
              points.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setDialog({ step: 'add' })}
            >
              <Icon name="plus" />
              Add project
            </button>
          </section>
        ) : null}

        {list.length > 0 ? (
          <section className="card scroll" aria-label="Projects">
            <table className="t">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Source</th>
                  <th>Kind</th>
                  <th className="num">Snapshots</th>
                  <th>Latest snapshot</th>
                  <th className="num">Entry points</th>
                  <th>Notes on the latest</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.name} aria-selected={p.name === selected}>
                    <td>
                      <Link
                        className="link"
                        style={{ fontWeight: 600 }}
                        to={href('/', { project: p.name })}
                        onClick={(e) => {
                          e.preventDefault()
                          navigate(href('/', { project: p.name }), { replace: true })
                        }}
                      >
                        {p.name}
                      </Link>
                    </td>
                    <td className="mono muted" style={{ overflowWrap: 'anywhere' }}>
                      {p.shown}
                      {'path' in p.source ? ' · read in place' : ' · cloned'}
                    </td>
                    <td>{p.kind ?? <span className="muted">not indexed</span>}</td>
                    <td className="num">{p.snapshots}</td>
                    <td>
                      {p.latest ? (
                        <>
                          <span className="mono">{snapshotLabel(p.latest)}</span>{' '}
                          <span className="muted">· {formatShortDate(p.latest.createdAt)}</span>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="link"
                          onClick={() => setDialog({ step: 'index', project: p.name })}
                        >
                          Index it
                        </button>
                      )}
                    </td>
                    <td className="num">
                      {p.latest ? formatNumber(p.latest.counts.entries) : '–'}
                    </td>
                    <td>{p.latest ? <NoteStates notes={p.latest.notes} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {selected && list.some((p) => p.name === selected) ? (
          <Snapshots
            key={selected}
            project={selected}
            onIndex={() => setDialog({ step: 'index', project: selected })}
          />
        ) : null}
      </main>
      {dialog ? (
        <AddAndIndex
          step={dialog.step}
          {...(dialog.project ? { project: dialog.project } : {})}
          onClose={() => {
            setDialog(undefined)
            projects.reload()
          }}
        />
      ) : null}
    </>
  )
}

function Snapshots({ project, onIndex }: { project: string; onIndex: () => void }) {
  const live = useLive()
  const version = live.version(project)
  const snapshots = useData(`${project}:${version}`, () => api.snapshots(project))
  const list = snapshots.data?.snapshots ?? []
  const [latest, previous] = list
  const diff = useData(
    latest && previous ? `${project}:diff:${previous.id}:${latest.id}:${version}` : undefined,
    () => api.diff(project, { from: previous?.id, to: latest?.id }),
  )
  const entries = (id: number) =>
    href(`/p/${encodeURIComponent(project)}`, id === snapshots.data?.latest ? {} : { snapshot: id })
  const mcp = `${location.origin}/mcp/${project}`
  return (
    <>
      <section className="stack" style={{ gap: 16 }} aria-labelledby="snap-title">
        <div className="head" style={{ alignItems: 'center' }}>
          <h2 className="h2" id="snap-title">
            {project} · snapshots
          </h2>
          <button type="button" className="btn" onClick={onIndex}>
            <Icon name="refresh" />
            Index a ref
          </button>
        </div>
        {snapshots.error ? <ErrorNotice error={snapshots.error} /> : null}
        {snapshots.data && list.length === 0 ? (
          <div className="card empty">
            <p style={{ margin: 0 }}>{project} has no snapshot yet.</p>
            <button type="button" className="btn btn-primary" onClick={onIndex}>
              Index {project}
            </button>
          </div>
        ) : null}
        {list.length > 0 ? (
          <div className="card scroll">
            <table className="t">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Version</th>
                  <th>Commit</th>
                  <th>Indexed</th>
                  <th>Profiles and analyzers</th>
                  <th className="num">Files</th>
                  <th className="num">Entry points</th>
                  <th className="num">Edges</th>
                  <th>Notes on it</th>
                  <th>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id}>
                    <td className="num">{s.id}</td>
                    <td>
                      <span className="row" style={{ gap: 6 }}>
                        <span className="mono">{s.ref ?? 'folder'}</span>
                        {s.id === snapshots.data?.latest ? (
                          <span className="chip chip-accent">latest</span>
                        ) : null}
                        {s.dirty ? <span className="chip">dirty</span> : null}
                      </span>
                    </td>
                    <td className="mono">{shortCommit(s.commit) || '–'}</td>
                    <td className="muted">{formatDate(s.createdAt)}</td>
                    <td>
                      <span className="chips">
                        {[...s.profiles, ...s.analyzers].map((x) => (
                          <span key={x} className="chip">
                            {x}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="num">{formatNumber(s.counts.files)}</td>
                    <td className="num">{formatNumber(s.counts.entries)}</td>
                    <td className="num">{formatNumber(s.counts.edges)}</td>
                    <td>
                      <NoteStates notes={s.notes} />
                    </td>
                    <td>
                      <Link className="link" to={entries(s.id)} style={{ whiteSpace: 'nowrap' }}>
                        Open entry points
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <div className="split" style={{ gap: 24 }}>
        {latest && previous ? (
          <section
            className="card pad stack"
            style={{ flex: '1 1 520px', gap: 12 }}
            aria-labelledby="diff-title"
          >
            <h2 className="h2" id="diff-title">
              From {snapshotLabel(previous)} to {snapshotLabel(latest)}
            </h2>
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
                    'none'
                  ) : (
                    <Link className="link" to={href(`/p/${encodeURIComponent(project)}/notes`)}>
                      {diff.data.notes.length} {diff.data.notes.length === 1 ? 'note' : 'notes'}
                    </Link>
                  )}
                </dd>
              </dl>
            ) : (
              <Spinner />
            )}
          </section>
        ) : null}
        <section
          className="card pad stack"
          style={{ flex: '1 1 420px', gap: 12 }}
          aria-labelledby="mcp-title"
        >
          <h2 className="h2" id="mcp-title">
            Connect an agent to {project}
          </h2>
          <p className="muted" style={{ margin: 0 }}>
            Over HTTP, with the token <span className="mono">esper serve</span> printed as{' '}
            <span className="mono">Authorization: Bearer</span>:
          </p>
          <code className="box">{mcp}</code>
          <p className="muted" style={{ margin: 0 }}>
            Or over stdio: <span className="mono">esper mcp {project}</span>. Notes the agent writes
            appear here as it writes them.
          </p>
        </section>
      </div>
    </>
  )
}

function Refs({ refs }: { refs: string[] }) {
  if (refs.length === 0) return <>none</>
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

// Adding a project, then indexing it; or indexing an existing one. One dialog, three steps.
function AddAndIndex({
  step: first,
  project: given,
  onClose,
}: {
  step: 'add' | 'index'
  project?: string
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [step, setStep] = useState(first)
  const [project, setProject] = useState(given)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [source, setSource] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState('')
  const [gitRef, setGitRef] = useState('')
  const [precise, setPrecise] = useState(false)
  const [force, setForce] = useState(false)
  const [jobId, setJobId] = useState<number>()
  const { jobs } = useLive()
  // The job as the events tell it, unless the server, asked, says it has ended.
  const [polled, setPolled] = useState<Job>()
  const job = jobId !== undefined ? (polled ?? jobs.get(jobId)) : undefined
  const finished = job !== undefined && job.state !== 'running'
  useEffect(() => {
    if (jobId === undefined || finished) return
    const timer = setInterval(() => {
      api.jobs().then(
        (all) => {
          const found = all.jobs.find((j) => j.id === jobId)
          if (found && found.state !== 'running') setPolled(found)
        },
        () => undefined,
      )
    }, 2000)
    return () => clearInterval(timer)
  }, [jobId, finished])

  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  const guessed = (() => {
    const s = source
      .trim()
      .replace(/\.git$/, '')
      .replace(/\/+$/, '')
    return s.split(/[/\\]/).at(-1)?.toLowerCase() ?? ''
  })()

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!source.trim()) return setError('Enter a folder or a git URL.')
    setBusy(true)
    setError(undefined)
    try {
      const added = await api.addProject({
        source: source.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(kind ? { kind } : {}),
      })
      setProject(added.project.name)
      setStep('index')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const index = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!project) return
    setBusy(true)
    setError(undefined)
    try {
      const started = await api.index(project, {
        ...(gitRef.trim() ? { ref: gitRef.trim() } : {}),
        ...(precise ? { precise: true } : {}),
        ...(force ? { force: true } : {}),
      })
      setJobId(started.job.id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const running = job?.state === 'running' || (jobId !== undefined && !job)
  const result = job?.state === 'done' ? (job.result as IndexResult) : undefined

  return (
    <dialog
      ref={ref}
      aria-labelledby="dlg-title"
      onClose={onClose}
      onCancel={(e) => running && e.preventDefault()}
    >
      {step === 'add' ? (
        <form className="dialog-body" onSubmit={add} noValidate>
          <div className="stack">
            <p className="step">1 · Add</p>
            <h2 className="h2" id="dlg-title">
              Add a project
            </h2>
          </div>
          <div className="field">
            <label htmlFor="src">Folder or git URL</label>
            <input
              className="input mono"
              id="src"
              name="source"
              autoComplete="off"
              spellCheck={false}
              placeholder="~/code/budget"
              value={source}
              aria-invalid={error ? true : undefined}
              aria-describedby="src-hint src-error"
              onChange={(e) => setSource(e.target.value)}
            />
            <p className="hint" id="src-hint">
              A folder is read in place and never written to. A URL is cloned into Esper’s home, and
              nothing in it runs.
            </p>
          </div>
          <div className="field">
            <label htmlFor="pname">Name</label>
            <input
              className="input mono"
              id="pname"
              name="name"
              autoComplete="off"
              spellCheck={false}
              placeholder={guessed || 'budget'}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="hint">
              Agents connect to it at{' '}
              <span className="mono">/mcp/{name.trim() || guessed || '<name>'}</span>.
            </p>
          </div>
          <fieldset>
            <legend>Kind</legend>
            <div className="radios">
              {[
                ['', 'Detect from the profiles'],
                ['application', 'Application'],
                ['framework', 'Framework'],
              ].map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="kind"
                    checked={kind === value}
                    onChange={() => setKind(value as string)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          {error ? (
            <p className="error-text" id="src-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => ref.current?.close()}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <Spinner /> : null}
              Add project
            </button>
          </div>
        </form>
      ) : result ? (
        <section className="dialog-body" aria-labelledby="dlg-title">
          <div className="stack">
            <p className="step">{first === 'add' ? '3 · Indexed' : 'Indexed'}</p>
            <h2 className="h2" id="dlg-title">
              {project}: snapshot {result.snapshot.id}
            </h2>
            <p className="muted" style={{ margin: 0 }}>
              <span className="mono">{snapshotLabel(result.snapshot)}</span>, read with{' '}
              {result.profiles.join(' and ')}
            </p>
          </div>
          {result.unchanged || !result.stats ? (
            <p style={{ margin: 0 }}>
              This commit was already indexed with these profiles: its snapshot is kept.
            </p>
          ) : (
            <dl className="kv">
              <dt>Files</dt>
              <dd>{formatNumber(result.stats.files)} read</dd>
              <dt>Skipped</dt>
              <dd>
                {result.skipped}
                {result.skips.length > 0
                  ? ` · ${result.skips
                      .slice(0, 2)
                      .map((s) => `${s.path} ${s.reason}`)
                      .join(', ')}${result.skipped > 2 ? ` and ${result.skipped - 2} more` : ''}`
                  : ''}
              </dd>
              <dt>Entry points</dt>
              <dd>{formatNumber(result.stats.entries)}</dd>
              <dt>Call edges</dt>
              <dd>
                {formatNumber(result.stats.resolved + result.stats.guessed)},{' '}
                {(
                  (100 * result.stats.resolved) /
                  Math.max(1, result.stats.resolved + result.stats.guessed)
                ).toFixed(1)}{' '}
                % resolved; {formatNumber(result.stats.unresolved)} calls without an edge
              </dd>
              <dt>Reads</dt>
              <dd>{formatNumber(result.stats.reads)}</dd>
              <dt>Signals</dt>
              <dd>{formatNumber(result.stats.signals)} on entry points</dd>
              <dt>Notes</dt>
              <dd>
                <NoteStates notes={result.notes} />
              </dd>
            </dl>
          )}
          <div className="dialog-actions">
            {result.notes.stale + result.notes.moved + result.notes.orphaned > 0 ? (
              <button
                type="button"
                className="btn"
                onClick={() => navigate(href(`/p/${encodeURIComponent(project ?? '')}/notes`))}
              >
                Review the notes
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => navigate(href(`/p/${encodeURIComponent(project ?? '')}`))}
            >
              Open entry points
            </button>
          </div>
        </section>
      ) : (
        <form className="dialog-body" onSubmit={index} noValidate>
          <div className="stack">
            <p className="step">{first === 'add' ? '2 · Index' : 'Index'}</p>
            <h2 className="h2" id="dlg-title">
              Index {project}
            </h2>
          </div>
          <div className="field">
            <label htmlFor="gref">Git ref</label>
            <input
              className="input mono"
              id="gref"
              name="ref"
              autoComplete="off"
              spellCheck={false}
              placeholder="v1.2.0"
              value={gitRef}
              disabled={running}
              onChange={(e) => setGitRef(e.target.value)}
            />
            <p className="hint">
              A tag, branch or commit, read from git without touching the checkout. Empty: the
              folder as it is.
            </p>
          </div>
          <label className="row" style={{ gap: 8, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
            <input
              type="checkbox"
              checked={precise}
              disabled={running}
              onChange={(e) => setPrecise(e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span>
              Resolve calls with the language’s analyzer
              <br />
              <span className="hint">Runs in Docker and takes minutes; guessed edges drop.</span>
            </span>
          </label>
          <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
            <input
              type="checkbox"
              checked={force}
              disabled={running}
              onChange={(e) => setForce(e.target.checked)}
            />
            <span>Index again a commit already indexed</span>
          </label>
          {running ? (
            <ol className="steps" aria-live="polite">
              {(job?.messages ?? []).slice(-4).map((m, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: messages come in order and stay
                <li key={i}>
                  <Icon name="check" size={16} stroke={2.5} />
                  <span>{m}</span>
                </li>
              ))}
              <li>
                <Spinner />
                <span>
                  Indexing {project}
                  {gitRef.trim() ? ` at ${gitRef.trim()}` : ''}…
                </span>
              </li>
            </ol>
          ) : null}
          {error || job?.error ? (
            <p className="error-text" role="alert">
              {error ?? job?.error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => ref.current?.close()}>
              {running ? 'Run in the background' : 'Close'}
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || running}>
              {running ? 'Indexing…' : 'Index'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  )
}
