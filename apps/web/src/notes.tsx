import { useEffect, useRef, useState } from 'react'
import { api, type Note, type NoteKind, statuses } from './api.ts'
import { useMe, useProject } from './app.tsx'
import {
  formatShortDate,
  href,
  Link,
  navigate,
  shortRef,
  snapshotLabel,
  useData,
  useLocation,
  withParams,
} from './lib.tsx'
import {
  ErrorNotice,
  Icon,
  KindBadge,
  NoteText,
  plainText,
  Spinner,
  StateBadge,
  TopBar,
} from './ui.tsx'

// The notes of a project, placed on the snapshot being read: each with its kind, its status, and
// where its anchors stand (D8). A stale or moved note is reviewed against the code as it is now.

const kinds = ['lead', 'finding', 'coverage', 'context'] as const

export function NotesPage({ project }: { project: string }) {
  const p = useProject(project)
  const { params } = useLocation()
  const kind = params.get('kind') ?? undefined
  const anchorState = params.get('anchorState') ?? undefined
  const author = params.get('author') ?? undefined
  const id = params.get('id') ? Number(params.get('id')) : undefined
  const set = (changes: Record<string, string | undefined>) =>
    navigate(withParams(changes), { replace: true })

  const filters = { kind, anchorState, author }
  const list = useData(
    p.snapshot
      ? `${project}:${p.snapshot}:notes:${JSON.stringify(filters)}:${p.version}`
      : undefined,
    () => api.notes(project, { snapshot: p.snapshot, limit: 100, ...filters }),
  )
  const filtered = Boolean(kind || anchorState || author)
  // The authors to filter by, from the notes unfiltered: the list itself when nothing filters it.
  const everyone = useData(
    p.snapshot && filtered ? `${project}:${p.snapshot}:authors:${p.version}` : undefined,
    () => api.notes(project, { snapshot: p.snapshot, limit: 100 }),
  )
  const unfiltered = filtered ? everyone.data : list.data
  const authors = [...new Set((unfiltered?.notes ?? []).map((n) => n.author))].sort()
  const notes = list.data?.notes ?? []
  const current = id ?? notes[0]?.id
  const snapshot = p.snapshots?.find((s) => s.id === p.snapshot)
  // How the notes stand, from the snapshot's own summary: every note, not a page of them.
  const counts = snapshot?.notes ?? { attached: 0, moved: 0, stale: 0, orphaned: 0 }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)

  return (
    <>
      <TopBar
        project={project}
        {...(p.projects ? { projects: p.projects } : {})}
        {...(p.snapshots ? { snapshots: p.snapshots } : {})}
        {...(p.snapshot !== undefined ? { snapshot: p.snapshot } : {})}
        latest={p.latest}
        current="notes"
      />
      <main className="page">
        <div className="head">
          <div className="stack">
            <h1 className="h1">
              Notes{' '}
              {snapshot ? (
                <span className="muted" style={{ fontWeight: 400 }}>
                  {total}
                </span>
              ) : null}
            </h1>
            <p className="muted" style={{ margin: 0 }}>
              {snapshot
                ? `Placed on ${snapshotLabel(snapshot)}: ${
                    Object.entries(counts)
                      .filter(([, n]) => n > 0)
                      .map(([s, n]) => `${n} ${s}`)
                      .join(', ') || 'none yet'
                  }`
                : ' '}
            </p>
          </div>
          <form
            className="row"
            style={{ gap: 8 }}
            aria-label="Filters"
            onSubmit={(e) => e.preventDefault()}
          >
            <fieldset className="seg" aria-label="Kind">
              <button
                type="button"
                aria-pressed={!kind}
                onClick={() => set({ kind: undefined, id: undefined })}
              >
                All
              </button>
              {kinds.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  onClick={() => set({ kind: k, id: undefined })}
                >
                  {k === 'coverage' || k === 'context'
                    ? `${k[0]?.toUpperCase()}${k.slice(1)}`
                    : `${k[0]?.toUpperCase()}${k.slice(1)}s`}
                </button>
              ))}
            </fieldset>
            <label className="row" style={{ gap: 6 }}>
              <span className="muted">Anchor</span>
              <select
                className="input"
                value={anchorState ?? ''}
                onChange={(e) => set({ anchorState: e.target.value || undefined, id: undefined })}
              >
                <option value="">Any state</option>
                {['attached', 'moved', 'stale', 'orphaned'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="row" style={{ gap: 6 }}>
              <span className="muted">Author</span>
              <select
                className="input"
                value={author ?? ''}
                onChange={(e) => set({ author: e.target.value || undefined, id: undefined })}
              >
                <option value="">Anyone</option>
                {authors.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
          </form>
        </div>

        {list.error ? <ErrorNotice error={list.error} /> : null}

        {list.data && notes.length === 0 ? (
          <section className="card empty">
            {kind || anchorState || author ? (
              <>
                <p style={{ margin: 0 }}>No note matches these filters.</p>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    set({ kind: undefined, anchorState: undefined, author: undefined })
                  }
                >
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <p style={{ margin: 0 }}>
                  No note yet. Open an entry point and write one on the code it reaches; notes
                  agents write over MCP appear here as they are written.
                </p>
                <Link
                  className="btn"
                  to={href(`/p/${encodeURIComponent(project)}`, { snapshot: p.asked })}
                >
                  Open the entry points
                </Link>
              </>
            )}
          </section>
        ) : null}

        {notes.length > 0 ? (
          <div className="split">
            <section
              className="card"
              style={{ flex: '1 1 400px', overflow: 'hidden' }}
              aria-label="Notes"
            >
              <ul className="list">
                {notes.map((n) => (
                  <li key={n.id}>
                    <Link
                      className="item"
                      to={withParams({ id: n.id })}
                      aria-current={n.id === current ? 'true' : undefined}
                    >
                      <span className="row" style={{ gap: 6 }}>
                        <KindBadge kind={n.kind} status={n.status} />
                        <StateBadge state={n.state} />
                        <span
                          className="mono"
                          style={{ fontSize: '0.75rem', marginInlineStart: 'auto' }}
                        >
                          {n.author}
                        </span>
                      </span>
                      <span className="mono" style={{ overflowWrap: 'anywhere' }}>
                        {n.anchors.map((a) => a.ref).join(', ')}
                      </span>
                      <p className="clamp">{plainText(n.body)}</p>
                    </Link>
                  </li>
                ))}
              </ul>
              {list.data?.truncated ? (
                <p className="hint" style={{ padding: 12 }}>
                  {list.data.cut.join('; ')}
                </p>
              ) : null}
            </section>
            {current !== undefined && p.snapshot ? (
              <NoteDetail
                key={current}
                project={project}
                id={current}
                snapshot={p.snapshot}
                version={p.version}
                snapshots={p.snapshots ?? []}
              />
            ) : null}
          </div>
        ) : null}
      </main>
    </>
  )
}

function NoteDetail({
  project,
  id,
  snapshot,
  version,
  snapshots,
}: {
  project: string
  id: number
  snapshot: number
  version: number
  snapshots: { id: number; ref: string | null; commit: string | null }[]
}) {
  const me = useMe()
  const loaded = useData(`${project}:${snapshot}:note:${id}:${version}`, () =>
    api.notes(project, { id, snapshot }),
  )
  const note = loaded.data?.notes[0]
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const placed = note?.anchors.find((a) => a.node)
  const code = useData(
    placed?.node ? `${project}:${snapshot}:${placed.node}:now:${version}` : undefined,
    () => api.node(project, { node: placed?.node as string, snapshot, excerptLines: 60 }),
  )

  if (loaded.error) return <ErrorNotice error={loaded.error} />
  if (!note) {
    return (
      <div className="card empty" style={{ flex: '999 1 600px' }}>
        <Spinner />
      </div>
    )
  }

  // Every change is a revision that names who made it (D8): without a name, nothing is written.
  const who = me.author.trim()
  const update = async (change: Record<string, unknown>) => {
    if (!who) {
      setError('Enter your name as the author of this change.')
      return false
    }
    setBusy(true)
    setError(undefined)
    try {
      await api.updateNote(project, note.id, {
        ...change,
        author: who,
        snapshot,
      })
      loaded.reload()
      return true
    } catch (err) {
      setError((err as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }
  const on = (n: number) => {
    const s = snapshots.find((x) => x.id === n)
    return s ? snapshotLabel(s) : `snapshot ${n}`
  }
  const reviewable = note.anchors.filter((a) => a.node)

  return (
    <article
      className="card pad stack"
      style={{ flex: '999 1 600px', gap: 16 }}
      aria-labelledby="note-title"
    >
      <div className="head" style={{ alignItems: 'center' }}>
        <div className="row" style={{ gap: 8 }}>
          <KindBadge kind={note.kind} />
          {statuses[note.kind].length > 0 ? (
            <label>
              <span className="sr-only">Status</span>
              <select
                className="input"
                style={{ height: 26, fontSize: '0.75rem' }}
                value={note.status ?? ''}
                disabled={busy}
                onChange={(e) => void update({ status: e.target.value })}
              >
                {statuses[note.kind].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          ) : null}
          <h2
            className="h2 mono"
            id="note-title"
            style={{ fontWeight: 500, overflowWrap: 'anywhere' }}
          >
            {note.anchors.map((a) => a.ref).join(', ')}
          </h2>
        </div>
        <div className="row" style={{ gap: 4 }}>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => setEditing(!editing)}
            aria-expanded={editing}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn btn-quiet btn-danger"
            onClick={() => setDeleting(true)}
          >
            Delete
          </button>
        </div>
      </div>

      {note.state === 'stale' || note.state === 'moved' ? (
        <div className="notice notice-stale">
          <Icon name="alert" size={18} />
          <div className="stack" style={{ flex: '1 1 300px' }}>
            <b>
              {note.state === 'stale'
                ? 'Stale: the code under this note changed'
                : 'Moved: the code was renamed or moved'}
            </b>
            <span>
              Written on {on(note.anchoredOn)}.{' '}
              {note.anchors
                .filter((a) => a.state === note.state)
                .map((a) =>
                  a.state === 'moved'
                    ? `${shortRef(a.ref)} is now ${a.node}.`
                    : `${shortRef(a.ref)} has another fingerprint on ${on(snapshot)}.`,
                )
                .join(' ')}{' '}
              Read the code as it is now, then mark the note as reviewed.
            </span>
          </div>
          <button
            type="button"
            className="btn"
            style={{ alignSelf: 'center' }}
            disabled={busy || reviewable.length === 0}
            onClick={() => void update({ anchors: reviewable.map((a) => a.node as string) })}
          >
            Mark as reviewed
          </button>
        </div>
      ) : null}
      {note.state === 'orphaned' ? (
        <div className="notice notice-orphaned">
          <Icon name="unlink" size={18} />
          <span style={{ flex: '1 1 300px' }}>
            Orphaned: nothing on {on(snapshot)} matches{' '}
            {note.anchors
              .filter((a) => a.state === 'orphaned')
              .map((a) => a.ref)
              .join(', ')}
            . The note is kept; edit it to anchor it on the code where it now belongs.
          </span>
        </div>
      ) : null}

      {!who ? (
        <div className="field" style={{ maxWidth: 320 }}>
          <label htmlFor="n-author">Your name, as the author of changes</label>
          <input
            id="n-author"
            className="input mono"
            autoComplete="nickname"
            // Kept when the field is left, so that the field stays while the name is typed.
            onBlur={(e) => me.setAuthor(e.target.value.trim())}
          />
        </div>
      ) : null}

      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}

      {editing ? (
        <EditNote
          note={note}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={async (change) => (await update(change)) && setEditing(false)}
        />
      ) : (
        <>
          <NoteText text={note.body} />
          <div className="row" style={{ gap: 6 }}>
            <span className="muted" style={{ fontSize: '0.75rem' }}>
              By <span className="mono">{note.author}</span>, {formatShortDate(note.createdAt)}
            </span>
            {note.citations.length > 0 ? (
              <>
                <span className="muted" style={{ fontSize: '0.75rem' }}>
                  · cites
                </span>
                {note.citations.map((c) => (
                  <span key={c} className="chip">
                    {c}
                  </span>
                ))}
              </>
            ) : null}
          </div>
        </>
      )}

      {placed?.node ? (
        <section className="stack" style={{ gap: 8 }} aria-labelledby="now-title">
          <div className="head" style={{ alignItems: 'center' }}>
            <h3 className="h3" id="now-title">
              The code now · {on(snapshot)}
            </h3>
            <Link
              className="link"
              style={{ fontSize: '0.8125rem' }}
              to={href(`/p/${encodeURIComponent(project)}/entry`, {
                node: placed.node,
                ...(snapshot !== snapshots[0]?.id ? { snapshot } : {}),
              })}
            >
              Open what it reaches
            </Link>
          </div>
          {code.data?.excerpt ? (
            <section
              className="code card"
              style={{ maxHeight: 360 }}
              aria-label={`Code of ${shortRef(placed.node)}`}
            >
              {code.data.excerpt.text.split('\n').map((t, i) => {
                const n = (code.data?.excerpt?.startLine ?? 1) + i
                return (
                  <div
                    key={n}
                    className="ln"
                    style={{ gridTemplateColumns: '52px 8px max-content' }}
                  >
                    <span className="n">{n}</span>
                    <span />
                    <pre>{t}</pre>
                  </div>
                )
              })}
            </section>
          ) : code.data ? (
            <p className="muted" style={{ margin: 0 }}>
              {placed.node} has no code in the target.
            </p>
          ) : (
            <Spinner />
          )}
        </section>
      ) : null}

      {note.revisions ? (
        <section className="stack" style={{ gap: 8 }} aria-labelledby="rev-title">
          <h3 className="h3" id="rev-title">
            Revisions · {note.revisions.length}
          </h3>
          <ol className="revs">
            {[...note.revisions].reverse().map((r) => (
              <li key={r.revision} className="row" style={{ gap: 8 }}>
                <span className="mono" style={{ fontSize: '0.75rem', minWidth: 18 }}>
                  {r.revision}
                </span>
                <span>
                  {r.action === 'create' ? 'written' : r.action === 'update' ? 'edited' : 'deleted'}{' '}
                  by <span className="mono">{r.author}</span>
                  {r.action === 'create' ? ` on ${on(r.snapshot)}` : ''}
                </span>
                <span className="muted">{formatShortDate(r.at)}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {deleting ? (
        <DeleteNote
          note={note}
          onClose={() => setDeleting(false)}
          onDelete={async (reason) => {
            if (!who) throw new Error('Enter your name as the author of this change.')
            await api.deleteNote(project, note.id, {
              author: who,
              ...(reason ? { reason } : {}),
            })
            navigate(withParams({ id: undefined }), { replace: true })
          }}
        />
      ) : null}
    </article>
  )
}

function EditNote({
  note,
  busy,
  onCancel,
  onSave,
}: {
  note: Note
  busy: boolean
  onCancel: () => void
  onSave: (change: Record<string, unknown>) => void
}) {
  const [kind, setKind] = useState<NoteKind>(note.kind)
  const [body, setBody] = useState(note.body)
  const [citations, setCitations] = useState(note.citations.join(', '))
  return (
    <form
      className="stack"
      style={{ gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault()
        onSave({
          kind,
          body,
          citations: citations
            .split(/[,\s]+/)
            .map((c) => c.trim())
            .filter(Boolean),
        })
      }}
    >
      <fieldset>
        <legend>Kind</legend>
        <div className="seg">
          {(['lead', 'coverage', 'finding', 'context'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k[0]?.toUpperCase()}
              {k.slice(1)}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor="e-body">Note</label>
        <textarea
          id="e-body"
          className="input"
          value={body}
          maxLength={20000}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="e-cite">Citations</label>
        <input
          id="e-cite"
          className="input mono"
          value={citations}
          onChange={(e) => setCitations(e.target.value)}
        />
      </div>
      <p className="hint">Saving adds a revision; the earlier ones are kept.</p>
      <div className="dialog-actions" style={{ justifyContent: 'flex-start' }}>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Save changes
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function DeleteNote({
  note,
  onClose,
  onDelete,
}: {
  note: Note
  onClose: () => void
  onDelete: (reason: string) => Promise<void>
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string>()
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog ref={ref} aria-labelledby="del-title" onClose={onClose}>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault()
          onDelete(reason.trim()).then(
            () => ref.current?.close(),
            (err: Error) => setError(err.message),
          )
        }}
      >
        <h2 className="h2" id="del-title">
          Delete this{' '}
          {note.kind === 'coverage' || note.kind === 'context' ? `${note.kind} note` : note.kind}?
        </h2>
        <p style={{ margin: 0 }}>
          It leaves the list. The deletion is recorded as a revision with its reason, and the note
          stays readable to agents that ask for deleted notes; it cannot be edited again.
        </p>
        <div className="field">
          <label htmlFor="d-reason">Reason</label>
          <input
            id="d-reason"
            className="input"
            placeholder="A duplicate of the lead on RealIP"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-danger-solid">
            Delete note
          </button>
        </div>
      </form>
    </dialog>
  )
}
