import {
  EsperError,
  type Home,
  type Note,
  Notes,
  noteState,
  type PlacedAnchor,
  type SnapshotInfo,
  SnapshotView,
  Store,
} from '@esper/core'

// What one MCP connection reads and writes: a single project (D18), its store, and the snapshots
// it has loaded. A snapshot never changes once written, so a loaded one is kept, up to a few.

const kept = 4

export class Connection {
  readonly home: Home
  readonly project: string
  readonly store: Store
  readonly notes: Notes
  private readonly views = new Map<number, SnapshotView>()

  constructor(home: Home, project: string) {
    this.home = home
    this.project = project
    this.store = new Store(home.database(project))
    this.notes = new Notes(this.store)
  }

  close() {
    this.store.close()
  }

  // The snapshot asked for, or the latest one.
  snapshot(id?: number): SnapshotInfo {
    const info = id === undefined ? this.store.latest() : this.store.snapshot(id)
    if (info) return info
    if (id !== undefined) throw new EsperError(`no snapshot ${id}; esper_snapshots lists them`)
    throw new EsperError(`${this.project} has no snapshot yet; esper_index indexes one`)
  }

  view(id?: number): SnapshotView {
    const info = this.snapshot(id)
    let view = this.views.get(info.id)
    if (!view) {
      view = SnapshotView.load(this.store, info.id)
      this.views.set(info.id, view)
      if (this.views.size > kept) this.views.delete(this.views.keys().next().value as number)
    }
    return view
  }

  // Each live note with its anchors placed on a snapshot.
  placed(snapshotId: number, notes: Note[] = this.notes.list()) {
    return notes.map((note) => {
      const anchors = this.notes.place(note, snapshotId)
      return { note, anchors, state: noteState(anchors) }
    })
  }
}

export type Placed = { note: Note; anchors: PlacedAnchor[]; state: ReturnType<typeof noteState> }
