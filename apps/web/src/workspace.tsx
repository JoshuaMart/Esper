import { createContext, type ReactNode, useContext, useState } from 'react'
import { AddAndIndex } from './add.tsx'
import { api, type Project } from './api.ts'
import {
  formatNumber,
  href,
  Link,
  type Loaded,
  navigate,
  plural,
  snapshotLabel,
  useData,
  useLive,
} from './lib.tsx'
import { Icon, Spinner } from './ui.tsx'

// The frame of every screen: the projects in a rail on the left and, beside it, the project shown,
// its tabs and the snapshot read. It holds the dialog that adds a project or indexes one.

interface Workspace {
  projects: Loaded<{ projects: Project[] }> | undefined
  // The project shown: the one named, else on the overview the first.
  selected: Project | undefined
  add: () => void
  index: (project: string) => void
}

const WorkspaceContext = createContext<Workspace>({
  projects: undefined,
  selected: undefined,
  add: () => {},
  index: () => {},
})
export const useWorkspace = () => useContext(WorkspaceContext)

type Tab = 'overview' | 'entries' | 'notes' | 'advisories'

export function Workspace({
  project,
  snapshots,
  snapshot,
  latest,
  current,
  children,
}: {
  project?: string | undefined
  snapshots?: { id: number; ref: string | null; commit: string | null }[] | undefined
  snapshot?: number | undefined
  latest?: number | null | undefined
  current: Tab
  children: ReactNode
}) {
  const live = useLive()
  // Read again when an index finishes, or when a project's notes change.
  const finished = [...live.jobs.values()].filter((j) => j.state !== 'running').length
  const projects = useData(`projects:${finished}:${live.lastNote?.at ?? ''}`, () => api.projects())
  const list = projects.data?.projects ?? []
  const selected =
    list.find((p) => p.name === project) ?? (current === 'overview' ? list[0] : undefined)
  const name = project ?? selected?.name
  const [dialog, setDialog] = useState<{ step: 'add' | 'index'; project?: string }>()
  const value: Workspace = {
    projects,
    selected,
    add: () => setDialog({ step: 'add' }),
    index: (p) => setDialog({ step: 'index', project: p }),
  }
  return (
    <WorkspaceContext.Provider value={value}>
      <div className="shell">
        <Rail projects={list} selected={name} />
        <div className="workspace">
          {name ? (
            <ProjectBar
              project={name}
              indexed={selected ? selected.latest !== null : true}
              snapshots={snapshots}
              snapshot={snapshot}
              latest={latest}
              current={current}
            />
          ) : null}
          {children}
        </div>
      </div>
      {dialog ? (
        <AddAndIndex
          step={dialog.step}
          {...(dialog.project ? { project: dialog.project } : {})}
          onClose={(added) => {
            setDialog(undefined)
            projects.reload()
            if (added) navigate(href('/', { project: added }))
          }}
        />
      ) : null}
    </WorkspaceContext.Provider>
  )
}

// The project shown, selected in the rail: its screens as tabs, always in the same place, then on
// the far side the snapshot read.
function ProjectBar({
  project,
  indexed,
  snapshots,
  snapshot,
  latest,
  current,
}: {
  project: string
  indexed: boolean
  snapshots: { id: number; ref: string | null; commit: string | null }[] | undefined
  snapshot: number | undefined
  latest: number | null | undefined
  current: Tab
}) {
  const p = encodeURIComponent(project)
  // The snapshot read goes along to the other screens; the overview is always on the latest.
  const kept = snapshot !== undefined && snapshot !== latest ? snapshot : undefined
  const tabs: [Tab, string, string][] = [
    ['overview', 'Overview', href('/', { project })],
    ['entries', 'Entry points', href(`/p/${p}`, { snapshot: kept })],
    ['notes', 'Notes', href(`/p/${p}/notes`, { snapshot: kept })],
    ['advisories', 'Advisories', href(`/p/${p}/advisories`, { snapshot: kept })],
  ]
  return (
    <header className="crumbs">
      <nav className="nav" aria-label="Project">
        {tabs.map(([tab, label, to]) =>
          indexed || tab === 'overview' ? (
            <Link key={tab} to={to} aria-current={current === tab ? 'page' : undefined}>
              {label}
            </Link>
          ) : (
            <span key={tab} aria-disabled="true">
              {label}
            </span>
          ),
        )}
      </nav>
      {current !== 'overview' && snapshots && snapshots.length > 0 ? (
        <label style={{ marginInlineStart: 'auto' }}>
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
                #{s.id} · {snapshotLabel(s)}
                {s.id === latest ? ' · latest' : ''}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </header>
  )
}

// Every project, with what tells them apart at a glance: kind, entry points, and notes that need a
// look or an index running.
function Rail({ projects, selected }: { projects: Project[]; selected: string | undefined }) {
  const { add: onAdd } = useWorkspace()
  const { connected, jobs } = useLive()
  const running = new Set(
    [...jobs.values()].filter((j) => j.state === 'running').map((j) => j.project),
  )
  return (
    <nav className="rail" aria-label="Projects">
      <div className="rail-top">
        <Link to="/" className="brand">
          <Icon name="logo" size={18} />
          <span>Esper</span>
        </Link>
        <button
          type="button"
          className="btn btn-quiet icon-btn"
          aria-label="Add project"
          onClick={onAdd}
        >
          <Icon name="plus" />
        </button>
      </div>
      <h2 className="eyebrow rail-head">
        Projects{projects.length > 0 ? ` · ${projects.length}` : ''}
      </h2>
      <ul className="plist">
        {projects.map((p) => {
          const notes = p.latest?.notes
          const total = notes ? notes.attached + notes.moved + notes.stale + notes.orphaned : 0
          return (
            <li key={p.name}>
              <Link
                className="pitem"
                to={href('/', { project: p.name })}
                aria-current={p.name === selected ? 'page' : undefined}
              >
                <span className="pitem-name">{p.name}</span>
                {running.has(p.name) ? (
                  <span className="flag flag-job">
                    <Spinner size={12} />
                    indexing
                  </span>
                ) : notes && notes.orphaned > 0 ? (
                  <span className="flag flag-orphaned">
                    <i aria-hidden="true" />
                    {notes.orphaned} orphaned
                  </span>
                ) : notes && notes.stale > 0 ? (
                  <span className="flag flag-stale">
                    <i aria-hidden="true" />
                    {notes.stale} stale
                  </span>
                ) : p.latest ? (
                  <span className={total > 0 ? 'flag' : 'flag flag-quiet'}>
                    {total > 0 ? <i aria-hidden="true" /> : null}
                    {total} {plural(total, 'note', 'notes')}
                  </span>
                ) : null}
                <span className="pitem-meta">
                  {p.latest ? (
                    <>
                      <span>{p.kind ?? 'detected'}</span>
                      <span aria-hidden="true">·</span>
                      <span className="num">
                        {formatNumber(p.latest.counts.entries)}{' '}
                        {plural(p.latest.counts.entries, 'entry point', 'entry points')}
                      </span>
                    </>
                  ) : (
                    <span>not indexed yet</span>
                  )}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
      <div className="rail-foot">
        <button type="button" className="btn" onClick={onAdd}>
          <Icon name="plus" />
          Add a folder or repository
        </button>
        <div className="live">
          <span className={connected ? 'dot' : 'dot off'} aria-hidden="true" />
          <span>{connected ? `Live · ${location.host}` : 'Reconnecting…'}</span>
        </div>
      </div>
    </nav>
  )
}
