import { type ReactNode, useEffect, useState } from 'react'
import type { AdvisoryState, AnchorState, NoteKind, Project, Severity } from './api.ts'
import { href, Link, type NoteEvent, navigate, shortRef, snapshotLabel, useLive } from './lib.tsx'

// The pieces every screen uses: icons, badges, a note's text, the top bar, the toasts.

const paths = {
  logo: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="12" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <path d="M8.5 6.8 15.6 11M8.5 17.2 15.6 13" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: <path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" />,
  pen: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m5 12 5 5 9-10" />,
  alert: (
    <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01" />
  ),
  circle: <circle cx="12" cy="12" r="8" />,
  bulb: <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V16h8v-1.3A7 7 0 0 0 12 2Z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  finding: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </>
  ),
  link: (
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  ),
  unlink: (
    <path d="m18.8 13.5 1.4-1.4a4 4 0 0 0-5.7-5.7l-1.4 1.4M5.2 10.5l-1.4 1.4a4 4 0 0 0 5.7 5.7l1.4-1.4M8 2v3M2 8h3M16 22v-3M22 16h-3" />
  ),
  move: <path d="M5 12h14M13 6l6 6-6 6" />,
  shield: <path d="M12 3 4 6v6c0 4.4 3.4 8.4 8 9 4.6-.6 8-4.6 8-9V6Z" />,
  external: (
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  ),
} as const

export function Icon({
  name,
  size = 16,
  stroke = 2,
  className,
}: {
  name: keyof typeof paths
  size?: number
  stroke?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ flex: 'none' }}
    >
      {paths[name]}
    </svg>
  )
}

const kindLabels: Record<NoteKind, string> = {
  lead: 'Lead',
  coverage: 'Coverage',
  finding: 'Finding',
  context: 'Context',
}
const kindIcons: Record<NoteKind, keyof typeof paths> = {
  lead: 'bulb',
  coverage: 'check',
  finding: 'finding',
  context: 'info',
}

export function KindBadge({ kind, status }: { kind: NoteKind; status?: string | null }) {
  return (
    <span className={`badge k-${kind}`}>
      <Icon name={kindIcons[kind]} size={12} stroke={2.5} />
      {kindLabels[kind]}
      {status ? ` · ${status}` : ''}
    </span>
  )
}

const stateIcons: Record<AnchorState, keyof typeof paths> = {
  attached: 'link',
  moved: 'move',
  stale: 'alert',
  orphaned: 'unlink',
}

export function StateBadge({ state, count }: { state: AnchorState; count?: number }) {
  return (
    <span className={`badge s-${state}`}>
      <Icon name={stateIcons[state]} size={12} stroke={2.5} />
      {count !== undefined ? `${count} ${state}` : state}
    </span>
  )
}

// An advisory's severity, as its database rated it (D19), always with its word.
export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`badge sev-${severity}`}>
      <Icon name="shield" size={12} stroke={2.5} />
      {severity}
    </span>
  )
}

const advisoryStateIcons: Record<AdvisoryState, keyof typeof paths> = {
  affected: 'alert',
  fixed: 'check',
  unaffected: 'circle',
  unknown: 'circle',
}

// Whether the snapshot's version is affected by an advisory, or fixed.
export function AdvisoryStateBadge({ state }: { state: AdvisoryState }) {
  return (
    <span className={`badge a-${state}`}>
      <Icon name={advisoryStateIcons[state]} size={12} stroke={2.5} />
      {state}
    </span>
  )
}

export function NoteStates({ notes }: { notes: Record<AnchorState, number> }) {
  const states = (['attached', 'moved', 'stale', 'orphaned'] as const).filter((s) => notes[s] > 0)
  if (states.length === 0) return <span className="muted">none</span>
  return (
    <span className="row" style={{ gap: 6 }}>
      {states.map((s) => (
        <StateBadge key={s} state={s} count={notes[s]} />
      ))}
    </span>
  )
}

// A note's Markdown, shown as text: paragraphs and `code`, nothing that renders markup. The body
// was written by someone who may have read untrusted code (D8): it is data, never a page.
export function NoteText({ text }: { text: string }) {
  return (
    <div className="prose">
      {text.split(/\n{2,}/).map((paragraph, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs have no identity of their own
        <p key={i} style={{ whiteSpace: 'pre-wrap' }}>
          {paragraph.split(/(`[^`\n]+`)/).map((part, j) =>
            part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: parts of a fixed string
              <code key={j}>{part.slice(1, -1)}</code>
            ) : (
              part
            ),
          )}
        </p>
      ))}
    </div>
  )
}

// Plain text of a note's Markdown, for a one-line excerpt.
export const plainText = (text: string) => text.replace(/`/g, '').replace(/\s+/g, ' ').trim()

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--accent)"
      strokeWidth={2.5}
      strokeLinecap="round"
      aria-hidden="true"
      className="spin"
    >
      <circle cx="12" cy="12" r="8" strokeDasharray="36 14" />
    </svg>
  )
}

export function ErrorNotice({ error, action }: { error: Error; action?: ReactNode }) {
  return (
    <div className="notice notice-error" role="alert">
      <Icon name="alert" size={18} />
      <span style={{ flex: '1 1 240px' }}>{error.message}</span>
      {action}
    </div>
  )
}

interface TopBarProps {
  project?: string
  projects?: Project[]
  snapshots?: { id: number; ref: string | null; commit: string | null }[]
  snapshot?: number
  latest?: number | null
  current?: 'entries' | 'notes' | 'advisories' | 'snapshots'
}

export function TopBar({ project, projects, snapshots, snapshot, latest, current }: TopBarProps) {
  const { connected } = useLive()
  return (
    <header className="top">
      <Link to="/" className="brand">
        <Icon name="logo" size={18} />
        <span>Esper</span>
      </Link>
      {project ? (
        <>
          <div className="row" style={{ gap: 8 }}>
            <label>
              <span className="sr-only">Project</span>
              <select
                className="pick"
                value={project}
                style={{ fontWeight: 600 }}
                onChange={(e) => navigate(href(`/p/${encodeURIComponent(e.target.value)}`))}
              >
                {(projects ?? [{ name: project }]).map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {snapshots && snapshots.length > 0 ? (
              <label>
                <span className="sr-only">Snapshot</span>
                <select
                  className="pick mono"
                  value={snapshot ?? latest ?? ''}
                  onChange={(e) => {
                    const id = Number(e.target.value)
                    const params = new URLSearchParams(location.search)
                    if (id === latest) params.delete('snapshot')
                    else params.set('snapshot', String(id))
                    params.delete('node')
                    const q = params.toString()
                    navigate(`${location.pathname.replace(/\/entry$/, '')}${q ? `?${q}` : ''}`)
                  }}
                >
                  {snapshots.map((s) => (
                    <option key={s.id} value={s.id}>
                      {snapshotLabel(s)}
                      {s.id === latest ? ' · latest' : ''}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <nav className="nav" aria-label="Project">
            <Link
              to={href(`/p/${encodeURIComponent(project)}`, { snapshot })}
              aria-current={current === 'entries' ? 'page' : undefined}
            >
              Entry points
            </Link>
            <Link
              to={href(`/p/${encodeURIComponent(project)}/notes`, { snapshot })}
              aria-current={current === 'notes' ? 'page' : undefined}
            >
              Notes
            </Link>
            <Link
              to={href(`/p/${encodeURIComponent(project)}/advisories`, { snapshot })}
              aria-current={current === 'advisories' ? 'page' : undefined}
            >
              Advisories
            </Link>
            <Link
              to={href('/', { project })}
              aria-current={current === 'snapshots' ? 'page' : undefined}
            >
              Snapshots
            </Link>
          </nav>
        </>
      ) : (
        <nav className="nav" aria-label="Main">
          <Link to="/" aria-current="page">
            Projects
          </Link>
        </nav>
      )}
      <div className="live">
        <span className={connected ? 'dot' : 'dot off'} aria-hidden="true" />
        <span>{connected ? 'Live' : 'Reconnecting…'}</span>
      </div>
    </header>
  )
}

// Says when someone else writes a note: an agent over MCP, or another tab. The region is always
// there, so that a screen reader hears each one.
export function Toasts({ me }: { me: string }) {
  const { lastNote } = useLive()
  const [shown, setShown] = useState<(NoteEvent & { key: string })[]>([])
  useEffect(() => {
    if (!lastNote || lastNote.author === me) return
    const key = `${lastNote.project}:${lastNote.id}:${lastNote.revision}`
    setShown((all) => [...all.filter((t) => t.key !== key), { ...lastNote, key }].slice(-3))
    const timer = setTimeout(() => setShown((all) => all.filter((t) => t.key !== key)), 8000)
    return () => clearTimeout(timer)
  }, [lastNote, me])
  const verb = { create: 'wrote', update: 'edited', delete: 'deleted' }
  return (
    <div className="toasts" role="status">
      {shown.map((t) => (
        <div className="toast" key={t.key}>
          <div className="stack" style={{ gap: 2 }}>
            <span style={{ fontWeight: 500 }}>
              {t.author} {verb[t.action]}{' '}
              {t.kind === 'context' || t.kind === 'coverage' ? `a ${t.kind} note` : `a ${t.kind}`}
            </span>
            <span style={{ color: '#d4d3cc' }}>
              in {t.project} ·{' '}
              <Link to={href(`/p/${encodeURIComponent(t.project)}/notes`, { id: t.id })}>Open</Link>
            </span>
          </div>
          <button
            type="button"
            className="close"
            aria-label="Dismiss"
            onClick={() => setShown((all) => all.filter((x) => x.key !== t.key))}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

export { shortRef }
