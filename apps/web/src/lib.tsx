import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { api, type Job } from './api.ts'

// What every page shares: the address it reads its state from, the data it loads, and the events
// the server sends as notes, snapshots and index jobs change.

// --- The address -------------------------------------------------------------------------------

const subscribers = new Set<() => void>()
const notify = () => {
  for (const s of subscribers) s()
}
window.addEventListener('popstate', notify)

export function useLocation() {
  const href = useSyncExternalStore(
    (s) => {
      subscribers.add(s)
      return () => subscribers.delete(s)
    },
    () => location.pathname + location.search,
  )
  const url = new URL(href, location.origin)
  return { path: url.pathname, params: url.searchParams }
}

export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (options.replace) history.replaceState(null, '', to)
  else history.pushState(null, '', to)
  notify()
  if (!options.replace) window.scrollTo(0, 0)
}

// An address with these query parameters changed; undefined removes one.
export function withParams(changes: Record<string, string | number | undefined>) {
  const params = new URLSearchParams(location.search)
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined || value === '') params.delete(key)
    else params.set(key, String(value))
  }
  const q = params.toString()
  return `${location.pathname}${q ? `?${q}` : ''}`
}

export function href(path: string, params: Record<string, string | number | undefined> = {}) {
  const q = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') q.set(key, String(value))
  }
  const text = q.toString()
  return `${path}${text ? `?${text}` : ''}`
}

// A link that routes inside the interface, and still opens in a new tab on a modified click.
export function Link({
  to,
  children,
  className,
  ...rest
}: { to: string; children: ReactNode; className?: string } & Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  'href'
>) {
  return (
    <a
      {...rest}
      href={to}
      className={className}
      onClick={(event) => {
        rest.onClick?.(event)
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return
        event.preventDefault()
        navigate(to)
      }}
    >
      {children}
    </a>
  )
}

// --- Events from the server --------------------------------------------------------------------

export interface NoteEvent {
  type: 'note'
  project: string
  id: number
  revision: number
  action: 'create' | 'update' | 'delete'
  author: string
  at: string
  kind: string
}

interface Live {
  // Bumped when a project's notes, snapshots, advisories or claims change: queries that read them load
  // again.
  version: (project: string) => number
  connected: boolean
  jobs: Map<number, Job>
  lastNote: NoteEvent | undefined
}

const LiveContext = createContext<Live>({
  version: () => 0,
  connected: false,
  jobs: new Map(),
  lastNote: undefined,
})

export function LiveProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const [versions, setVersions] = useState<Map<string, number>>(new Map())
  const [connected, setConnected] = useState(false)
  const [jobs, setJobs] = useState<Map<number, Job>>(new Map())
  const [lastNote, setLastNote] = useState<NoteEvent>()
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    if (!enabled) return
    const source = new EventSource('/api/events')
    const bump = (project: string) =>
      setVersions((v) => new Map(v).set(project, (v.get(project) ?? 0) + 1))
    let opened = false
    source.addEventListener('ready', () => {
      setConnected(true)
      // Events sent while the stream was down are lost: after a reconnection, every query loads
      // again and the jobs are read from the server.
      if (opened) setEpoch((n) => n + 1)
      opened = true
      void api.jobs().then(
        ({ jobs }) => setJobs((all) => new Map([...all, ...jobs.map((j) => [j.id, j] as const)])),
        () => undefined,
      )
    })
    source.addEventListener('error', () => setConnected(false))
    source.addEventListener('note', (e) => {
      const event = JSON.parse((e as MessageEvent).data) as NoteEvent
      bump(event.project)
      setLastNote(event)
    })
    source.addEventListener('snapshot', (e) => {
      bump((JSON.parse((e as MessageEvent).data) as { project: string }).project)
    })
    source.addEventListener('claims', (e) => {
      bump((JSON.parse((e as MessageEvent).data) as { project: string }).project)
    })
    source.addEventListener('advisories', (e) => {
      bump((JSON.parse((e as MessageEvent).data) as { project: string }).project)
    })
    source.addEventListener('job', (e) => {
      const event = JSON.parse((e as MessageEvent).data) as Job & { message?: string }
      setJobs((all) => {
        const before = all.get(event.id)
        const job: Job = {
          id: event.id,
          project: event.project,
          action: event.action,
          state: event.state,
          messages: [...(before?.messages ?? []), ...(event.message ? [event.message] : [])],
          ...(event.result ? { result: event.result } : {}),
          ...(event.error ? { error: event.error } : {}),
        }
        return new Map(all).set(event.id, job)
      })
    })
    return () => source.close()
  }, [enabled])

  const version = useCallback(
    (project: string) => epoch * 1_000_000 + (versions.get(project) ?? 0),
    [versions, epoch],
  )
  return (
    <LiveContext.Provider value={{ version, connected, jobs, lastNote }}>
      {children}
    </LiveContext.Provider>
  )
}

export const useLive = () => useContext(LiveContext)

// --- Data --------------------------------------------------------------------------------------

export interface Loaded<T> {
  data: T | undefined
  error: Error | undefined
  loading: boolean
  reload: () => void
}

// Loads `load()` whenever `key` changes, keeping the last answer on screen while the next loads.
export function useData<T>(key: string | undefined, load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean; key?: string }>({
    loading: key !== undefined,
  })
  const [tick, setTick] = useState(0)
  const loader = useRef(load)
  loader.current = load
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is how reload asks again
  useEffect(() => {
    if (key === undefined) return
    let current = true
    setState((s) => ({ ...s, loading: true }))
    loader.current().then(
      (data) => current && setState({ data, loading: false, key }),
      (error: Error) => current && setState((s) => ({ ...s, error, loading: false, key })),
    )
    return () => {
      current = false
    }
  }, [key, tick])
  return {
    data: state.key === key || state.data !== undefined ? state.data : undefined,
    error: state.key === key ? state.error : undefined,
    loading: state.loading,
    reload: () => setTick((t) => t + 1),
  }
}

// --- Who writes ----------------------------------------------------------------------------------

const authorKey = 'esper.author'

export function useAuthor(fallback: string | undefined): [string, (name: string) => void] {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(authorKey) ?? ''
    } catch {
      return ''
    }
  })
  const set = (value: string) => {
    setName(value)
    try {
      localStorage.setItem(authorKey, value)
    } catch {}
  }
  return [name || fallback || '', set]
}

// --- Formatting ----------------------------------------------------------------------------------

const dateTime = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})
const shortDateTime = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})
const number = new Intl.NumberFormat()

export const formatDate = (iso: string) => dateTime.format(new Date(iso))
export const formatShortDate = (iso: string) => shortDateTime.format(new Date(iso))
export const formatNumber = (n: number) => number.format(n)

export const shortCommit = (commit: string | null | undefined) => commit?.slice(0, 12) ?? ''
export const snapshotLabel = (s: { ref: string | null; commit: string | null; id: number }) =>
  s.ref ?? shortCommit(s.commit) ?? `snapshot ${s.id}`

// The last part of a reference: `middlewares/auth.go#Auth.Handler` reads `Auth.Handler`.
export const shortRef = (ref: string) => {
  const hash = ref.lastIndexOf('#')
  if (hash !== -1) return ref.slice(hash + 1)
  return ref.replace(/^(route|entry|ext|osv):/, '')
}

// The words are English, so English rules choose them, whatever the browser's language.
const englishPlural = new Intl.PluralRules('en')
export function plural(n: number, one: string, many: string) {
  return englishPlural.select(n) === 'one' ? one : many
}
