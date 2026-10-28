import { createContext, useContext, useEffect, useState } from 'react'
import { ApiError, api } from './api.ts'
import { EntriesPage } from './entries.tsx'
import { EntryPage } from './entry.tsx'
import { LiveProvider, navigate, useAuthor, useData, useLive, useLocation } from './lib.tsx'
import { NotesPage } from './notes.tsx'
import { ProjectsPage } from './projects.tsx'
import { Icon, Spinner, Toasts } from './ui.tsx'

// The interface: it trades the token in its address for a session, then routes by the path.

interface Me {
  author: string
  setAuthor: (name: string) => void
}
const MeContext = createContext<Me>({ author: '', setAuthor: () => {} })
export const useMe = () => useContext(MeContext)

type Session = 'checking' | 'open' | 'refused' | 'failed'

export function App() {
  const [session, setSession] = useState<Session>('checking')
  const [user, setUser] = useState<string>()
  const [author, setAuthor] = useAuthor(user)

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const token = params.get('token')
    const start = async () => {
      if (token) {
        params.delete('token')
        const q = params.toString()
        // The token leaves the address, and the history, at once.
        history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}`)
        await api.session(token).catch(() => undefined)
      }
      try {
        const info = await api.info()
        setUser(info.user)
        setSession('open')
      } catch (error) {
        setSession(error instanceof ApiError && error.status === 401 ? 'refused' : 'failed')
      }
    }
    void start()
  }, [])

  if (session === 'checking') {
    return (
      <main className="page" style={{ alignItems: 'center', paddingTop: 96 }}>
        <Spinner />
      </main>
    )
  }
  if (session === 'failed') {
    return (
      <main className="page" style={{ maxWidth: 560, paddingTop: 96 }}>
        <h1 className="h1">Esper</h1>
        <p className="prose">
          Unable to reach the server. Check that <span className="mono">esper serve</span> is
          running, then reload this page.
        </p>
      </main>
    )
  }
  if (session === 'refused') {
    return (
      <main className="page" style={{ maxWidth: 560, paddingTop: 96 }}>
        <div className="row" style={{ gap: 8 }}>
          <Icon name="logo" size={22} />
          <h1 className="h1">Esper</h1>
        </div>
        <p className="prose">
          This server needs its token. Open the address that{' '}
          <span className="mono">esper serve</span> printed: it carries the token, and this page
          keeps it for the session.
        </p>
        <code className="box">esper serve</code>
      </main>
    )
  }
  return (
    <MeContext.Provider value={{ author, setAuthor }}>
      <LiveProvider enabled>
        <Routes />
        <Toasts me={author} />
      </LiveProvider>
    </MeContext.Provider>
  )
}

function Routes() {
  const { path } = useLocation()
  const match = path.match(/^\/p\/([^/]+)(\/entry|\/notes)?\/?$/)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on each new path, which is the point
  useEffect(() => {
    // Focus moves to the new view's heading, as a page load would put it at the top.
    const heading = document.querySelector<HTMLElement>('main h1')
    heading?.setAttribute('tabindex', '-1')
    heading?.focus({ preventScroll: true })
  }, [path])
  if (path === '/' || path === '') return <ProjectsPage />
  if (!match) {
    return (
      <main className="page">
        <h1 className="h1">Nothing here</h1>
        <p>
          <button type="button" className="link" onClick={() => navigate('/')}>
            Go to the projects
          </button>
        </p>
      </main>
    )
  }
  const project = decodeURIComponent(match[1] as string)
  if (match[2] === '/entry') return <EntryPage project={project} />
  if (match[2] === '/notes') return <NotesPage project={project} />
  return <EntriesPage project={project} />
}

// What a project's screens share: the projects for the switcher, the project's snapshots, and the
// snapshot the address names, else the latest.
export function useProject(project: string) {
  const { params } = useLocation()
  const live = useLive()
  const version = live.version(project)
  const projects = useData('projects', () => api.projects())
  const snapshots = useData(`${project}:snapshots:${version}`, () => api.snapshots(project))
  const asked = params.get('snapshot')
  const latest = snapshots.data?.latest ?? null
  const snapshot = asked ? Number(asked) : (latest ?? undefined)
  useEffect(() => {
    document.title = `${project} · Esper`
  }, [project])
  return {
    projects: projects.data?.projects,
    snapshots: snapshots.data?.snapshots,
    latest,
    snapshot,
    // The snapshot named in the address, to pass on in links; none for the latest.
    asked: asked ? Number(asked) : undefined,
    version,
    error: snapshots.error,
    loading: snapshots.loading && !snapshots.data,
  }
}
