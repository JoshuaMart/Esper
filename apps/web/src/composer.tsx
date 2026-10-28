import { useEffect, useRef, useState } from 'react'
import { api, type NoteKind, statuses } from './api.ts'
import { useMe } from './app.tsx'
import { shortRef, useData } from './lib.tsx'
import { Icon, Spinner } from './ui.tsx'

// Writing a note on one or more nodes: its kind, its status, its text, the lines it cites and
// who writes it (D8). It opens as a drawer beside the code, which stays readable behind it.

const hints: Record<NoteKind, string> = {
  lead: 'A hypothesis to check. It starts open; mark it ruled out or confirmed later.',
  coverage: 'What was examined, from which angle, and what came out.',
  finding: 'A confirmed issue. It starts open; mark it reported or fixed later.',
  context: 'Anything else worth knowing about this code.',
}

export function Composer({
  project,
  snapshot,
  anchors: initialAnchors,
  citations: initialCitations,
  onClose,
  onSaved,
}: {
  project: string
  snapshot: number
  anchors: string[]
  citations: string[]
  onClose: () => void
  onSaved: (id: number) => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const me = useMe()
  const [anchors, setAnchors] = useState(initialAnchors)
  const [kind, setKind] = useState<NoteKind>('lead')
  const [status, setStatus] = useState('open')
  const [body, setBody] = useState('')
  const [citations, setCitations] = useState(initialCitations.join(', '))
  const [author, setAuthor] = useState(me.author)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const found = useData(
    query.trim().length >= 2 ? `${project}:${snapshot}:search:${query}` : undefined,
    () => api.search(project, { query: query.trim(), snapshot, limit: 8 }),
  )

  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    dialog?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
    return () => dialog?.close()
  }, [])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!body.trim()) return setError('Write what the note says.')
    if (!author.trim()) return setError('Enter who writes the note.')
    if (anchors.length === 0) return setError('Add the node the note is about.')
    setBusy(true)
    setError(undefined)
    try {
      const cited = citations
        .split(/[,\s]+/)
        .map((c) => c.trim())
        .filter(Boolean)
      const { note } = await api.createNote(project, {
        kind,
        ...(statuses[kind].length > 0 ? { status } : {}),
        body,
        citations: cited,
        anchors,
        author: author.trim(),
        snapshot,
      })
      me.setAuthor(author.trim())
      onSaved(note.id)
      ref.current?.close()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog ref={ref} className="drawer" aria-labelledby="c-title" onClose={onClose}>
      <form className="dialog-body" style={{ minHeight: '100%' }} onSubmit={save} noValidate>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 className="h2" id="c-title" style={{ fontSize: '1.0625rem' }}>
            Write a note
          </h2>
          <button
            type="button"
            className="btn icon-btn"
            aria-label="Close the note"
            onClick={() => ref.current?.close()}
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="field">
          <span className="label" id="anchors-label">
            On
          </span>
          <ul
            className="row"
            style={{ gap: 8, listStyle: 'none', margin: 0, padding: 0 }}
            aria-labelledby="anchors-label"
          >
            {anchors.map((a) => (
              <li
                key={a}
                className="chip"
                style={{
                  paddingInlineEnd: 2,
                  minHeight: 24,
                  whiteSpace: 'normal',
                  overflowWrap: 'anywhere',
                }}
              >
                {a}
                <button
                  type="button"
                  className="btn icon-btn"
                  style={{ width: 20, height: 20 }}
                  aria-label={`Remove ${shortRef(a)}`}
                  onClick={() => setAnchors(anchors.filter((x) => x !== a))}
                >
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                className="btn btn-small"
                aria-expanded={adding}
                onClick={() => setAdding(!adding)}
              >
                Add a node
              </button>
            </li>
          </ul>
          {adding ? (
            <div className="stack" style={{ gap: 6 }}>
              <label className="sr-only" htmlFor="c-search">
                Find a node
              </label>
              <input
                id="c-search"
                className="input mono"
                placeholder="Name, reference or file:line"
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {found.data ? (
                <ul className="list">
                  {found.data.nodes
                    .filter((n) => !anchors.includes(n.ref))
                    .map((n) => (
                      <li key={n.ref}>
                        <button
                          type="button"
                          className="item"
                          style={{ padding: '6px 8px' }}
                          onClick={() => {
                            setAnchors([...anchors, n.ref])
                            setQuery('')
                            setAdding(false)
                          }}
                        >
                          <span className="mono">{n.ref}</span>
                          <span className="hint">{n.kind}</span>
                        </button>
                      </li>
                    ))}
                  {found.data.nodes.length === 0 ? (
                    <li className="hint">No node matches “{query}”.</li>
                  ) : null}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>

        <fieldset>
          <legend>Kind</legend>
          <div className="seg">
            {(['lead', 'coverage', 'finding', 'context'] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => {
                  setKind(k)
                  setStatus(statuses[k][0] ?? '')
                }}
              >
                {k[0]?.toUpperCase()}
                {k.slice(1)}
              </button>
            ))}
          </div>
          <p className="hint">{hints[kind]}</p>
        </fieldset>

        {statuses[kind].length > 0 ? (
          <div className="field">
            <label htmlFor="c-status">Status</label>
            <select
              id="c-status"
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {statuses[kind].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="c-body">Note</label>
          <textarea
            id="c-body"
            className="input"
            placeholder="What to check, and why. Markdown."
            value={body}
            maxLength={20000}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="c-cite">Citations</label>
          <input
            id="c-cite"
            className="input mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="routes/login.go:448, routes/login.go:440-452"
            value={citations}
            onChange={(e) => setCitations(e.target.value)}
          />
          <p className="hint">
            file:line or file:start-end, separated by commas. Clicking line numbers in the code adds
            them.
          </p>
        </div>

        <div className="field">
          <label htmlFor="c-author">Author</label>
          <input
            id="c-author"
            className="input mono"
            autoComplete="nickname"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </div>

        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}

        <div className="dialog-actions" style={{ marginTop: 'auto' }}>
          <button type="button" className="btn" onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner /> : null}
            Save note
          </button>
        </div>
      </form>
    </dialog>
  )
}

// Line numbers picked in the code, as citations: runs of lines become ranges.
export function citationsOf(file: string, lines: number[]): string[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b)
  const out: string[] = []
  let start: number | undefined
  let prev: number | undefined
  for (const n of [...sorted, Number.NaN]) {
    if (start !== undefined && prev !== undefined && n === prev + 1) {
      prev = n
      continue
    }
    if (start !== undefined && prev !== undefined)
      out.push(start === prev ? `${file}:${start}` : `${file}:${start}-${prev}`)
    start = n
    prev = n
  }
  return out
}
