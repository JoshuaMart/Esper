import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonical, type Graph, type GraphNode, schemaVersion } from './graph.ts'

// One database per project (D9). Snapshots are rebuilt from the code; claims and notes, added in
// later milestones, live in their own tables.
const schema = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  ref TEXT,
  commit_sha TEXT,
  dirty INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  profiles TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS files (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  language TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, path)
);
CREATE TABLE IF NOT EXISTS skips (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  file TEXT,
  start_line INTEGER,
  end_line INTEGER,
  fingerprint TEXT,
  data TEXT,
  PRIMARY KEY (snapshot_id, ref)
);
CREATE TABLE IF NOT EXISTS edges (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  from_ref TEXT NOT NULL,
  to_ref TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  source TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS edges_from ON edges (snapshot_id, from_ref, kind);
CREATE INDEX IF NOT EXISTS edges_to ON edges (snapshot_id, to_ref, kind);
CREATE TABLE IF NOT EXISTS facts (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  node_ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  source TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS facts_node ON facts (snapshot_id, node_ref);
CREATE INDEX IF NOT EXISTS facts_kind ON facts (snapshot_id, kind, value);
`

export interface SnapshotInfo {
  id: number
  ref: string | null
  commit: string | null
  dirty: boolean
  createdAt: string
  profiles: string[]
}

export interface NewSnapshot {
  ref?: string
  commit?: string
  dirty?: boolean
  profiles?: string[]
  createdAt?: string
}

const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value))
const parse = (value: unknown) =>
  typeof value === 'string' ? (JSON.parse(value) as Record<string, unknown>) : undefined

export class Store {
  readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    // Several processes write to one project (agents, the server): a writer waits for the lock
    // rather than failing at once.
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(schema)
    const version = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()
    if (!version) {
      this.db
        .prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`)
        .run(String(schemaVersion))
    } else if (Number(version.value) !== schemaVersion) {
      throw new Error(
        `database schema ${String(version.value)} does not match Esper's schema ${schemaVersion}`,
      )
    }
  }

  close() {
    this.db.close()
  }

  // Writes a whole snapshot in one transaction, in canonical order.
  addSnapshot(graph: Graph, info: NewSnapshot = {}): number {
    const g = canonical(graph)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO snapshots (ref, commit_sha, dirty, created_at, schema_version, profiles)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          info.ref ?? null,
          info.commit ?? null,
          info.dirty ? 1 : 0,
          info.createdAt ?? new Date().toISOString(),
          schemaVersion,
          JSON.stringify(info.profiles ?? []),
        )
      const id = Number(lastInsertRowid)
      const file = this.db.prepare(`INSERT INTO files VALUES (?, ?, ?, ?)`)
      for (const f of g.files) file.run(id, f.path, f.hash, f.language)
      const skip = this.db.prepare(`INSERT INTO skips VALUES (?, ?, ?)`)
      for (const s of g.skips) skip.run(id, s.path, s.reason)
      const node = this.db.prepare(`INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const n of g.nodes) {
        node.run(
          id,
          n.ref,
          n.kind,
          n.name,
          n.file ?? null,
          n.startLine ?? null,
          n.endLine ?? null,
          n.fingerprint ?? null,
          json(n.data),
        )
      }
      const edge = this.db.prepare(`INSERT INTO edges VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const e of g.edges) {
        edge.run(id, e.kind, e.from, e.to, e.citation.file, e.citation.line, e.source, json(e.data))
      }
      const fact = this.db.prepare(`INSERT INTO facts VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const f of g.facts) {
        fact.run(
          id,
          f.node,
          f.kind,
          f.value,
          f.citation.file,
          f.citation.line,
          f.source,
          json(f.data),
        )
      }
      this.db.exec('COMMIT')
      return id
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  snapshots(): SnapshotInfo[] {
    return this.db
      .prepare(`SELECT id, ref, commit_sha, dirty, created_at, profiles FROM snapshots ORDER BY id`)
      .all()
      .map((row) => ({
        id: Number(row.id),
        ref: (row.ref as string | null) ?? null,
        commit: (row.commit_sha as string | null) ?? null,
        dirty: row.dirty === 1,
        createdAt: String(row.created_at),
        profiles: JSON.parse(String(row.profiles)) as string[],
      }))
  }

  // Reads a snapshot back into the in-memory model, in canonical order.
  graph(snapshotId: number): Graph {
    const rows = (sql: string) => this.db.prepare(sql).all(snapshotId)
    const opt = <T>(value: unknown) => (value === null ? undefined : (value as T))
    return {
      files: rows(`SELECT * FROM files WHERE snapshot_id = ? ORDER BY path`).map((r) => ({
        path: String(r.path),
        hash: String(r.hash),
        language: String(r.language),
      })),
      skips: rows(`SELECT * FROM skips WHERE snapshot_id = ? ORDER BY path`).map((r) => ({
        path: String(r.path),
        reason: String(r.reason),
      })),
      nodes: rows(`SELECT * FROM nodes WHERE snapshot_id = ? ORDER BY ref`).map((r) => {
        const node: GraphNode = {
          ref: String(r.ref),
          kind: r.kind as GraphNode['kind'],
          name: String(r.name),
        }
        const file = opt<string>(r.file)
        if (file !== undefined) node.file = file
        const start = opt<number>(r.start_line)
        if (start !== undefined) node.startLine = start
        const end = opt<number>(r.end_line)
        if (end !== undefined) node.endLine = end
        const fingerprint = opt<string>(r.fingerprint)
        if (fingerprint !== undefined) node.fingerprint = fingerprint
        const data = parse(r.data)
        if (data !== undefined) node.data = data
        return node
      }),
      edges: rows(`SELECT rowid, * FROM edges WHERE snapshot_id = ? ORDER BY rowid`).map((r) => {
        const data = parse(r.data)
        return {
          kind: r.kind as Graph['edges'][number]['kind'],
          from: String(r.from_ref),
          to: String(r.to_ref),
          citation: { file: String(r.file), line: Number(r.line) },
          source: String(r.source),
          ...(data === undefined ? {} : { data }),
        }
      }),
      facts: rows(`SELECT rowid, * FROM facts WHERE snapshot_id = ? ORDER BY rowid`).map((r) => {
        const data = parse(r.data)
        return {
          node: String(r.node_ref),
          kind: r.kind as Graph['facts'][number]['kind'],
          value: String(r.value),
          citation: { file: String(r.file), line: Number(r.line) },
          source: String(r.source),
          ...(data === undefined ? {} : { data }),
        }
      }),
    }
  }
}
