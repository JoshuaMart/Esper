import { useEffect, useRef, useState } from 'react'
import { api, type IndexResult, type Job } from './api.ts'
import { formatNumber, href, navigate, snapshotLabel, useLive } from './lib.tsx'
import { Icon, NoteStates, Spinner } from './ui.tsx'

// Adding a project, then indexing it; or indexing an existing one. One dialog, three steps.
export function AddAndIndex({
  step: first,
  project: given,
  onClose,
}: {
  step: 'add' | 'index'
  project?: string
  // Given the project added, when this dialog added one.
  onClose: (added?: string) => void
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
      onClose={() => onClose(first === 'add' ? project : undefined)}
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
              {result.advisories ? (
                <>
                  <dt>Advisories</dt>
                  <dd>
                    {result.advisories.fetched
                      ? `${result.advisories.advisories} from OSV, ${result.advisories.unlinked} unlinked; ${result.advisories.low} low left out`
                      : `not fetched (${result.advisories.reason}); ${result.advisories.advisories} kept`}
                  </dd>
                </>
              ) : null}
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
