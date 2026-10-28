import { EsperError, type Home } from '@esper/core'
import { Connection } from '@esper/mcp'

// The projects the server has opened: one connection each, shared by the JSON API and the MCP
// endpoint, so that both read and write the same store (D14). Each open project is watched for
// what changed in its database, whoever changed it: this server, or an agent on `esper mcp` in
// another process.

export type ServerEvent =
  | {
      type: 'note'
      project: string
      id: number
      revision: number
      action: 'create' | 'update' | 'delete'
      author: string
      at: string
      kind: string
    }
  | { type: 'snapshot'; project: string; id: number }
  // The advisories were fetched again, or placed on a new snapshot.
  | { type: 'advisories'; project: string }
  // A model's claim was added, by `esper enrich` or an agent.
  | { type: 'claims'; project: string; count: number }
  | {
      type: 'job'
      project: string
      id: number
      action: 'index' | 'advisories'
      state: 'running' | 'done' | 'failed'
      message?: string
      result?: unknown
      error?: string
    }

type Listener = (event: ServerEvent) => void

// How often a watched database is looked at, while someone listens.
export const watchInterval = 500

interface Watched {
  connection: Connection
  // What was last seen: the newest snapshot, how many note revisions there were, and the
  // advisories' generation.
  snapshot: number
  revisions: number
  advisories: string
  claims: number
}

export class Projects {
  readonly home: Home
  private readonly open = new Map<string, Watched>()
  private readonly listeners = new Set<Listener>()
  private timer: NodeJS.Timeout | undefined

  constructor(home: Home) {
    this.home = home
  }

  // The connection of a project, opened on first use. A name that is not a project is refused.
  async connection(name: string): Promise<Connection> {
    const found = this.open.get(name)
    if (found) return found.connection
    await this.home.project(name)
    // Another request may have opened it while the project was read.
    const again = this.open.get(name)
    if (again) return again.connection
    const connection = new Connection(this.home, name)
    this.open.set(name, { connection, ...this.seen(connection) })
    return connection
  }

  // Tells every listener about an event, now.
  emit(event: ServerEvent) {
    for (const listener of this.listeners) listener(event)
  }

  // Listens to the events of every project; the returned function stops.
  listen(listener: Listener): () => void {
    this.listeners.add(listener)
    if (!this.timer) {
      this.timer = setInterval(() => this.check(), watchInterval)
      this.timer.unref()
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer)
        this.timer = undefined
      }
    }
  }

  // Looks at each open project's database for snapshots and note revisions it has not seen, and
  // tells the listeners about them. Called on a timer, and right after this server writes.
  check() {
    for (const [project, watched] of this.open) {
      const now = this.seen(watched.connection)
      if (now.snapshot > watched.snapshot) {
        this.emit({ type: 'snapshot', project, id: now.snapshot })
      }
      if (now.revisions > watched.revisions) {
        const rows = watched.connection.store.db
          .prepare(
            `SELECT r.note_id AS id, r.revision, r.action, r.author, r.at, n.kind
             FROM note_revisions r JOIN notes n ON n.id = r.note_id
             ORDER BY r.rowid LIMIT -1 OFFSET ?`,
          )
          .all(watched.revisions) as {
          id: number
          revision: number
          action: 'create' | 'update' | 'delete'
          author: string
          at: string
          kind: string
        }[]
        for (const row of rows) this.emit({ type: 'note', project, ...row })
      }
      if (now.advisories !== watched.advisories) this.emit({ type: 'advisories', project })
      if (now.claims > watched.claims) {
        this.emit({ type: 'claims', project, count: now.claims - watched.claims })
      }
      watched.snapshot = now.snapshot
      watched.revisions = now.revisions
      watched.advisories = now.advisories
      watched.claims = now.claims
    }
  }

  private seen(connection: Connection) {
    const row = connection.store.db
      .prepare(
        `SELECT (SELECT coalesce(max(id), 0) FROM snapshots) AS snapshot,
                (SELECT count(*) FROM note_revisions) AS revisions`,
      )
      .get() as { snapshot: number; revisions: number }
    return {
      snapshot: Number(row.snapshot),
      revisions: Number(row.revisions),
      advisories: connection.advisories.generation(),
      claims: connection.claims.count(),
    }
  }

  close() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.listeners.clear()
    for (const { connection } of this.open.values()) connection.close()
    this.open.clear()
  }
}

// A refusal the API answers with a status, and the reason.
export class HttpError extends EsperError {
  readonly status: 400 | 401 | 403 | 404 | 409 | 415

  constructor(status: 400 | 401 | 403 | 404 | 409 | 415, message: string) {
    super(message)
    this.status = status
  }
}
