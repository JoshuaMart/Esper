import type { StatementSync } from 'node:sqlite'
import { EsperError } from './errors.ts'
import type { NodeKind } from './graph.ts'
import { type Store, textLines } from './store.ts'

// Notes (D8): what an audit produces, written by agents and humans on nodes of a snapshot. A note
// keeps the fingerprint of each node it was written on, every edit is a new revision, a deletion
// is recorded, and no reindex ever drops one: on any snapshot, each anchor is placed by its
// reference and its fingerprint, and gets an anchor state.

export const noteKinds = ['lead', 'coverage', 'finding', 'context'] as const
export type NoteKind = (typeof noteKinds)[number]

// The statuses a kind takes, the first being the one a new note gets. Coverage and context have
// none.
export const noteStatuses: Record<NoteKind, readonly string[]> = {
  lead: ['open', 'ruled-out', 'confirmed'],
  finding: ['open', 'reported', 'fixed'],
  coverage: [],
  context: [],
}

// From the most settled to the least: a note takes the state of its least settled anchor.
export const anchorStates = ['attached', 'moved', 'stale', 'orphaned'] as const
export type AnchorState = (typeof anchorStates)[number]

export const noteLimits = { body: 20_000, anchors: 20, citations: 50, author: 200, reason: 2_000 }

export interface Anchor {
  // The node's reference and kind, and its fingerprint, in the snapshot the note was anchored on.
  ref: string
  kind: NodeKind
  fingerprint: string | null
}

export interface Note {
  id: number
  kind: NoteKind
  status: string | null
  body: string
  citations: string[]
  author: string
  createdAt: string
  updatedAt: string
  revision: number
  // The snapshot its anchors were taken from: where the note was written, or last anchored.
  snapshot: number
  anchors: Anchor[]
  deleted?: { at: string; by: string; reason?: string }
}

export interface NoteRevision {
  revision: number
  action: 'create' | 'update' | 'delete'
  author: string
  at: string
  kind: NoteKind
  status: string | null
  body: string
  citations: string[]
  anchors: Anchor[]
  snapshot: number
  reason?: string
}

// An anchor as found on a snapshot: its state, and the node it is on there, if any.
export interface PlacedAnchor extends Anchor {
  state: AnchorState
  node: string | null
}

export interface NewNote {
  kind: NoteKind
  status?: string
  body: string
  citations?: string[]
  // References of nodes of `snapshot`.
  anchors: string[]
  author: string
  snapshot: number
  at?: string
}

export interface NoteChange {
  author: string
  kind?: NoteKind
  status?: string
  body?: string
  citations?: string[]
  // New anchors, taken from `snapshot`. Giving the same ones again anchors the note on the code
  // as it is there: this is how a stale note is marked as reviewed.
  anchors?: string[]
  snapshot: number
  at?: string
}

export interface NoteFilter {
  kind?: NoteKind
  status?: string
  author?: string
  includeDeleted?: boolean
}

const citationPattern = /^(.+):(\d+)(?:-(\d+))?$/

export class Notes {
  readonly store: Store

  constructor(store: Store) {
    this.store = store
  }

  // Statements prepared once: placing every note on a snapshot runs the same few queries many
  // times.
  private readonly statements = new Map<string, StatementSync>()

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text)
    if (!statement) {
      statement = this.store.db.prepare(text)
      this.statements.set(text, statement)
    }
    return statement
  }

  create(input: NewNote): Note {
    const kind = checkKind(input.kind)
    const status = checkStatus(kind, input.status)
    const body = checkBody(input.body)
    const author = checkAuthor(input.author)
    const citations = this.checkCitations(input.snapshot, input.citations ?? [])
    const at = input.at ?? new Date().toISOString()
    return this.store.transaction(() => {
      const anchors = this.anchor(input.snapshot, input.anchors)
      const { lastInsertRowid } = this.sql(
        `INSERT INTO notes (kind, status, body, citations, author, created_at, updated_at, revision, snapshot_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      ).run(kind, status, body, JSON.stringify(citations), author, at, at, input.snapshot)
      const id = Number(lastInsertRowid)
      this.writeAnchors(id, anchors)
      this.revise(id, 1, 'create', author, at, {
        kind,
        status,
        body,
        citations,
        anchors,
        snapshot: input.snapshot,
      })
      return this.get(id) as Note
    })
  }

  update(id: number, change: NoteChange): Note {
    const author = checkAuthor(change.author)
    const changed = ['kind', 'status', 'body', 'citations', 'anchors'].some(
      (key) => change[key as keyof NoteChange] !== undefined,
    )
    if (!changed)
      throw new EsperError('nothing to change: give a kind, status, body, citations or anchors')
    const at = change.at ?? new Date().toISOString()
    return this.store.transaction(() => {
      const note = this.live(id)
      const kind = change.kind === undefined ? note.kind : checkKind(change.kind)
      // A note that changes kind keeps its status when the new kind has it.
      const status =
        change.status !== undefined
          ? checkStatus(kind, change.status)
          : noteStatuses[kind].includes(note.status ?? '')
            ? note.status
            : checkStatus(kind, undefined)
      const body = change.body === undefined ? note.body : checkBody(change.body)
      const citations =
        change.citations === undefined
          ? note.citations
          : this.checkCitations(change.snapshot, change.citations)
      const anchors =
        change.anchors === undefined ? note.anchors : this.anchor(change.snapshot, change.anchors)
      const snapshot = change.anchors === undefined ? note.snapshot : change.snapshot
      const revision = note.revision + 1
      this.sql(
        `UPDATE notes SET kind = ?, status = ?, body = ?, citations = ?, updated_at = ?, revision = ?,
           snapshot_id = ? WHERE id = ?`,
      ).run(kind, status, body, JSON.stringify(citations), at, revision, snapshot, id)
      if (change.anchors !== undefined) {
        this.sql(`DELETE FROM note_anchors WHERE note_id = ?`).run(id)
        this.writeAnchors(id, anchors)
      }
      this.revise(id, revision, 'update', author, at, {
        kind,
        status,
        body,
        citations,
        anchors,
        snapshot,
      })
      return this.get(id) as Note
    })
  }

  // A deleted note is kept, with who deleted it, when and why, and no longer listed by default.
  delete(id: number, options: { author: string; reason?: string; at?: string }): Note {
    const author = checkAuthor(options.author)
    const reason = options.reason?.trim() || undefined
    if (reason && reason.length > noteLimits.reason) {
      throw new EsperError(`a reason is at most ${noteLimits.reason} characters`)
    }
    const at = options.at ?? new Date().toISOString()
    return this.store.transaction(() => {
      const note = this.live(id)
      const revision = note.revision + 1
      this.sql(
        `UPDATE notes SET deleted_at = ?, deleted_by = ?, deleted_reason = ?, updated_at = ?,
           revision = ? WHERE id = ?`,
      ).run(at, author, reason ?? null, at, revision, id)
      this.revise(id, revision, 'delete', author, at, {
        kind: note.kind,
        status: note.status,
        body: note.body,
        citations: note.citations,
        anchors: note.anchors,
        snapshot: note.snapshot,
        ...(reason ? { reason } : {}),
      })
      return this.get(id) as Note
    })
  }

  get(id: number): Note | undefined {
    const row = this.sql(`SELECT * FROM notes WHERE id = ?`).get(id)
    return row ? this.note(row) : undefined
  }

  list(filter: NoteFilter = {}): Note[] {
    const where = filter.includeDeleted ? [] : ['deleted_at IS NULL']
    const args: string[] = []
    for (const key of ['kind', 'status', 'author'] as const) {
      const value = filter[key]
      if (value === undefined) continue
      where.push(`${key} = ?`)
      args.push(value)
    }
    return this.sql(
      `SELECT * FROM notes ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`,
    )
      .all(...args)
      .map((row) => this.note(row))
  }

  revisions(id: number): NoteRevision[] {
    return this.sql(`SELECT * FROM note_revisions WHERE note_id = ? ORDER BY revision`)
      .all(id)
      .map((row) => ({
        revision: Number(row.revision),
        action: row.action as NoteRevision['action'],
        author: String(row.author),
        at: String(row.at),
        ...(JSON.parse(String(row.content)) as Omit<
          NoteRevision,
          'revision' | 'action' | 'author' | 'at'
        >),
      }))
  }

  // Where each anchor of a note is on a snapshot (D8):
  // - same reference, same fingerprint: `attached`;
  // - same reference, new fingerprint: `stale`;
  // - reference gone, a node of the same kind with the same fingerprint that was not already
  //   there when the note was anchored: `moved`, onto that node;
  // - nothing matches: `orphaned`.
  // Anchors are compared with the snapshot the note was anchored on, so a note's state on a
  // snapshot depends on that snapshot alone, whatever was indexed in between.
  place(note: Note, snapshotId: number): PlacedAnchor[] {
    const byRef = this.sql(`SELECT fingerprint FROM nodes WHERE snapshot_id = ? AND ref = ?`)
    const byPrint = this.sql(
      `SELECT ref FROM nodes WHERE snapshot_id = ? AND kind = ? AND fingerprint = ? ORDER BY ref`,
    )
    return note.anchors.map((anchor) => {
      const same = byRef.get(snapshotId, anchor.ref)
      if (same) {
        const fingerprint = (same.fingerprint as string | null) ?? null
        return {
          ...anchor,
          state: fingerprint === anchor.fingerprint ? 'attached' : 'stale',
          node: anchor.ref,
        }
      }
      if (anchor.fingerprint) {
        const candidates = byPrint
          .all(snapshotId, anchor.kind, anchor.fingerprint)
          .map((row) => String(row.ref))
          .filter((ref) => {
            const before = byRef.get(note.snapshot, ref)
            return !before || before.fingerprint !== anchor.fingerprint
          })
        const target = closest(anchor.ref, candidates)
        if (target) return { ...anchor, state: 'moved', node: target }
      }
      return { ...anchor, state: 'orphaned', node: null }
    })
  }

  // How the notes stand on a snapshot, by anchor state.
  summary(snapshotId: number): Record<AnchorState, number> {
    const counts = { attached: 0, moved: 0, stale: 0, orphaned: 0 }
    for (const note of this.list()) counts[noteState(this.place(note, snapshotId))]++
    return counts
  }

  private live(id: number): Note {
    const note = this.get(id)
    if (!note) throw new EsperError(`no note ${id}`)
    if (note.deleted) throw new EsperError(`note ${id} was deleted on ${note.deleted.at}`)
    return note
  }

  private anchor(snapshotId: number, refs: string[]): Anchor[] {
    const unique = [...new Set(refs)]
    if (unique.length === 0) throw new EsperError('a note needs at least one anchor')
    if (unique.length > noteLimits.anchors) {
      throw new EsperError(`a note has at most ${noteLimits.anchors} anchors`)
    }
    if (!this.store.snapshot(snapshotId)) throw new EsperError(`no snapshot ${snapshotId}`)
    const node = this.sql(`SELECT kind, fingerprint FROM nodes WHERE snapshot_id = ? AND ref = ?`)
    return unique.map((ref) => {
      const row = node.get(snapshotId, ref)
      if (!row) throw new EsperError(`snapshot ${snapshotId} has no node ${ref}`)
      return {
        ref,
        kind: row.kind as NodeKind,
        fingerprint: (row.fingerprint as string | null) ?? null,
      }
    })
  }

  private writeAnchors(id: number, anchors: Anchor[]) {
    const insert = this.sql(`INSERT INTO note_anchors VALUES (?, ?, ?, ?, ?)`)
    anchors.forEach((a, position) => {
      insert.run(id, position, a.ref, a.kind, a.fingerprint)
    })
  }

  private revise(
    id: number,
    revision: number,
    action: NoteRevision['action'],
    author: string,
    at: string,
    content: Omit<NoteRevision, 'revision' | 'action' | 'author' | 'at'>,
  ) {
    this.sql(`INSERT INTO note_revisions VALUES (?, ?, ?, ?, ?, ?)`).run(
      id,
      revision,
      action,
      author,
      at,
      JSON.stringify(content),
    )
  }

  // A citation is `file:line` or `file:start-end`, on a file of the snapshot and within it.
  private checkCitations(snapshotId: number, citations: string[]): string[] {
    if (citations.length > noteLimits.citations) {
      throw new EsperError(`a note has at most ${noteLimits.citations} citations`)
    }
    return [...new Set(citations)].map((citation) => {
      const match = citationPattern.exec(citation)
      if (!match)
        throw new EsperError(`${citation} is not a citation: write file:line or file:start-end`)
      const [, file, start, end] = match as unknown as [string, string, string, string | undefined]
      const text = this.store.content(snapshotId, file)
      if (text === undefined) {
        throw new EsperError(`${citation}: snapshot ${snapshotId} has no file ${file}`)
      }
      const first = Number(start)
      const last = end === undefined ? first : Number(end)
      const lines = text === null ? Number.POSITIVE_INFINITY : textLines(text).length
      if (first < 1 || last < first || last > lines) {
        throw new EsperError(`${citation}: ${file} has lines 1 to ${lines}`)
      }
      return citation
    })
  }

  private note(row: Record<string, unknown>): Note {
    const id = Number(row.id)
    const anchors = this.sql(
      `SELECT ref, kind, fingerprint FROM note_anchors WHERE note_id = ? ORDER BY position`,
    )
      .all(id)
      .map((a) => ({
        ref: String(a.ref),
        kind: a.kind as NodeKind,
        fingerprint: (a.fingerprint as string | null) ?? null,
      }))
    return {
      id,
      kind: row.kind as NoteKind,
      status: (row.status as string | null) ?? null,
      body: String(row.body),
      citations: JSON.parse(String(row.citations)) as string[],
      author: String(row.author),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      revision: Number(row.revision),
      snapshot: Number(row.snapshot_id),
      anchors,
      ...(row.deleted_at
        ? {
            deleted: {
              at: String(row.deleted_at),
              by: String(row.deleted_by),
              ...(row.deleted_reason ? { reason: String(row.deleted_reason) } : {}),
            },
          }
        : {}),
    }
  }
}

// A note's state is the state of its least settled anchor.
export function noteState(anchors: PlacedAnchor[]): AnchorState {
  let worst = 0
  for (const a of anchors) worst = Math.max(worst, anchorStates.indexOf(a.state))
  return anchorStates[worst] as AnchorState
}

// Of the nodes code moved to, the one closest to where it was: the same name in another file,
// then the same file under another name, then the first by reference.
function closest(ref: string, candidates: string[]): string | undefined {
  const [file, name] = ref.includes('#') ? (ref.split('#', 2) as [string, string]) : [ref, '']
  return (
    candidates.find((c) => name !== '' && c.endsWith(`#${name}`)) ??
    candidates.find((c) => c.startsWith(`${file}#`)) ??
    candidates[0]
  )
}

function checkKind(kind: string): NoteKind {
  if (!(noteKinds as readonly string[]).includes(kind)) {
    throw new EsperError(`${kind} is not a kind of note: ${noteKinds.join(', ')}`)
  }
  return kind as NoteKind
}

function checkStatus(kind: NoteKind, status: string | undefined): string | null {
  const statuses = noteStatuses[kind]
  if (status === undefined) return statuses[0] ?? null
  if (!statuses.includes(status)) {
    throw new EsperError(
      statuses.length === 0
        ? `a ${kind} note has no status`
        : `a ${kind} is ${statuses.join(', ')}, not ${status}`,
    )
  }
  return status
}

function checkBody(body: string): string {
  if (body.trim() === '') throw new EsperError('a note needs a body')
  if (body.length > noteLimits.body) {
    throw new EsperError(`a note's body is at most ${noteLimits.body} characters`)
  }
  return body
}

function checkAuthor(author: string): string {
  const name = author.trim()
  if (name === '') throw new EsperError('a note needs an author: an agent or a person')
  if (name.length > noteLimits.author) {
    throw new EsperError(`an author is at most ${noteLimits.author} characters`)
  }
  return name
}
