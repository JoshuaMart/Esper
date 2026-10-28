import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractGo, Notes, noteState, Store, textLines } from '../src/index.ts'

// Two versions of a small package: what each note's anchor becomes from one to the other (D8).
const v1 = {
  'a.go': `package a

func Kept() { work(1) }

func Edited() { work(1) }

func Renamed() { work(3) }

func Removed() { work(4) }

func Twin() { work(5) }

func Travels() { work(6) }

func work(n int) {}
`,
}
const v2 = {
  'a.go': `package a

func Kept() { work(1) }

func Edited() { work(2) }

func NewName() { work(3) }

func Twin() { work(5) }

func Copy() { work(5) }

func work(n int) {}
`,
  'b.go': `package a

func Travels() { work(6) }
`,
}

async function snapshot(store: Store, files: Record<string, string>) {
  const sources = Object.entries(files).map(([path, source]) => ({ path, source }))
  const { graph } = await extractGo(sources, { module: 'x' })
  return store.addSnapshot(graph, { sources })
}

async function setup() {
  const store = new Store(':memory:')
  const notes = new Notes(store)
  const first = await snapshot(store, v1)
  return { store, notes, first }
}

const lead = (snapshot: number, anchors: string[], body = 'a hypothesis') => ({
  kind: 'lead' as const,
  body,
  anchors,
  author: 'hunter',
  snapshot,
})

test('after a reindex, each anchor is attached, stale, moved or orphaned, and no note is lost', async () => {
  const { store, notes, first } = await setup()
  const ids = Object.fromEntries(
    ['Kept', 'Edited', 'Renamed', 'Removed', 'Twin', 'Travels'].map((name) => [
      name,
      notes.create(lead(first, [`a.go#${name}`])).id,
    ]),
  )
  const second = await snapshot(store, v2)
  const placed = (name: string) => {
    const note = notes.get(ids[name] as number)
    assert.ok(note)
    return notes.place(note, second)[0]
  }
  assert.deepEqual(
    Object.keys(ids).map((name) => [name, placed(name)?.state, placed(name)?.node]),
    [
      ['Kept', 'attached', 'a.go#Kept'],
      ['Edited', 'stale', 'a.go#Edited'],
      ['Renamed', 'moved', 'a.go#NewName'],
      ['Removed', 'orphaned', null],
      // `Copy` has Twin's code, but Twin is still there: a copy is not a move.
      ['Twin', 'attached', 'a.go#Twin'],
      ['Travels', 'moved', 'b.go#Travels'],
    ],
  )
  assert.equal(notes.list().length, 6)
  assert.deepEqual(notes.summary(second), { attached: 2, moved: 2, stale: 1, orphaned: 1 })
  // On the snapshot it was written on, every note is attached.
  assert.deepEqual(notes.summary(first), { attached: 6, moved: 0, stale: 0, orphaned: 0 })
  store.close()
})

test('a note takes the state of its least settled anchor, and anchoring it again settles it', async () => {
  const { store, notes, first } = await setup()
  const note = notes.create(lead(first, ['a.go#Kept', 'a.go#Edited']))
  const second = await snapshot(store, v2)
  assert.equal(noteState(notes.place(note, second)), 'stale')
  // Reviewed against the new code: the same anchors, taken from the new snapshot.
  const reviewed = notes.update(note.id, {
    author: 'reviewer',
    anchors: ['a.go#Kept', 'a.go#Edited'],
    snapshot: second,
  })
  assert.equal(reviewed.snapshot, second)
  assert.equal(noteState(notes.place(reviewed, second)), 'attached')
  store.close()
})

test('an edit adds a revision, and a deletion is recorded and kept', async () => {
  const { store, notes, first } = await setup()
  const note = notes.create(lead(first, ['a.go#Kept']))
  assert.equal(note.status, 'open')
  const ruled = notes.update(note.id, {
    author: 'reviewer',
    status: 'ruled-out',
    body: 'the input is checked upstream',
    snapshot: first,
  })
  assert.deepEqual([ruled.revision, ruled.status, ruled.author], [2, 'ruled-out', 'hunter'])
  const deleted = notes.delete(note.id, { author: 'auditor', reason: 'duplicate' })
  assert.deepEqual(deleted.deleted && [deleted.deleted.by, deleted.deleted.reason], [
    'auditor',
    'duplicate',
  ])
  assert.deepEqual(
    notes.revisions(note.id).map((r) => [r.revision, r.action, r.author, r.status, r.body]),
    [
      [1, 'create', 'hunter', 'open', 'a hypothesis'],
      [2, 'update', 'reviewer', 'ruled-out', 'the input is checked upstream'],
      [3, 'delete', 'auditor', 'ruled-out', 'the input is checked upstream'],
    ],
  )
  assert.deepEqual(notes.list(), [])
  assert.deepEqual(
    notes.list({ includeDeleted: true }).map((n) => n.id),
    [note.id],
  )
  assert.throws(
    () => notes.update(note.id, { author: 'x', body: 'again', snapshot: first }),
    /was deleted/,
  )
  assert.throws(() => notes.delete(note.id, { author: 'x' }), /was deleted/)
  store.close()
})

test('each kind takes its own statuses, and a change of kind keeps a status it allows', async () => {
  const { store, notes, first } = await setup()
  const coverage = notes.create({ ...lead(first, ['a.go#Kept']), kind: 'coverage' })
  assert.equal(coverage.status, null)
  assert.throws(
    () => notes.create({ ...lead(first, ['a.go#Kept']), kind: 'coverage', status: 'open' }),
    /a coverage note has no status/,
  )
  assert.throws(
    () => notes.create({ ...lead(first, ['a.go#Kept']), status: 'fixed' }),
    /a lead is open, ruled-out, confirmed, not fixed/,
  )
  assert.throws(
    () => notes.create({ ...lead(first, ['a.go#Kept']), kind: 'idea' as 'lead' }),
    /not a kind of note/,
  )
  const finding = notes.update(
    notes.create({ ...lead(first, ['a.go#Kept']), status: 'confirmed' }).id,
    { author: 'auditor', kind: 'finding', snapshot: first },
  )
  assert.deepEqual([finding.kind, finding.status], ['finding', 'open'])
  const open = notes.create(lead(first, ['a.go#Kept']))
  assert.equal(
    notes.update(open.id, { author: 'auditor', kind: 'finding', snapshot: first }).status,
    'open',
  )
  assert.equal(
    notes.update(open.id, { author: 'auditor', kind: 'context', snapshot: first }).status,
    null,
  )
  store.close()
})

test('a note is refused without an anchor of the snapshot, an author, a body, or with a citation outside it', async () => {
  const { store, notes, first } = await setup()
  assert.throws(() => notes.create(lead(first, [])), /at least one anchor/)
  assert.throws(() => notes.create(lead(first, ['a.go#Nope'])), /has no node a.go#Nope/)
  assert.throws(() => notes.create(lead(99, ['a.go#Kept'])), /no snapshot 99/)
  assert.throws(() => notes.create({ ...lead(first, ['a.go#Kept']), author: ' ' }), /author/)
  assert.throws(() => notes.create(lead(first, ['a.go#Kept'], '  ')), /needs a body/)
  const cite = (citations: string[]) => notes.create({ ...lead(first, ['a.go#Kept']), citations })
  assert.deepEqual(cite(['a.go:3', 'a.go:3-5']).citations, ['a.go:3', 'a.go:3-5'])
  assert.throws(() => cite(['a.go']), /not a citation/)
  assert.throws(() => cite(['b.go:1']), /has no file b.go/)
  assert.throws(() => cite(['a.go:99']), /has lines 1 to/)
  assert.throws(() => cite(['a.go:5-3']), /has lines 1 to/)
  // a.go ends with a newline: its last line is the one before it, as esper_read numbers them.
  const last = textLines(v1['a.go']).length
  assert.deepEqual(cite([`a.go:${last}`]).citations, [`a.go:${last}`])
  assert.throws(() => cite([`a.go:${last + 1}`]), new RegExp(`has lines 1 to ${last}$`))
  assert.throws(() => notes.update(1, { author: 'x', snapshot: first }), /nothing to change/)
  assert.throws(() => notes.update(404, { author: 'x', body: 'y', snapshot: first }), /no note 404/)
  store.close()
})

test("a snapshot's files are stored with it, and read back from it alone", async () => {
  const { store, first } = await setup()
  assert.equal(store.content(first, 'a.go'), v1['a.go'])
  assert.equal(store.content(first, 'b.go'), undefined)
  const { graph } = await extractGo([{ path: 'c.go', source: 'package a\n' }], { module: 'x' })
  assert.equal(store.content(store.addSnapshot(graph), 'c.go'), null)
  store.close()
})
