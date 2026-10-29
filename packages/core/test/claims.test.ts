import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import {
  Claims,
  Home,
  insufficient,
  questionsOf,
  questionText,
  recordedSource,
  SnapshotView,
  Store,
} from '../src/index.ts'

// Claims (D17): the questions a snapshot asks, the checks every answer goes through, and claims
// reused until the code they rest on changes. No model is called here: answers are written by
// the test, as a model's would come back.

const run = promisify(execFile)
const fixture = new URL('fixtures/chiapp/', import.meta.url).pathname

async function indexed() {
  const dir = await mkdtemp(join(tmpdir(), 'esper-claims-'))
  await cp(fixture, dir, { recursive: true })
  const git = (...args: string[]) =>
    run('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  await git('init', '--quiet')
  await git('add', '.')
  await git('commit', '--quiet', '-m', 'v1')
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-home-')), {
    advisories: recordedSource(),
  })
  await home.add(dir, { name: 'app' })
  const { id } = await home.index('app', { ref: 'HEAD', offline: true })
  return { dir, git, home, id }
}

test('a snapshot asks about its chain members, handlers and what they call, then the repository', async () => {
  const { dir, home, id } = await indexed()
  const store = new Store(home.database('app'))
  try {
    const view = SnapshotView.load(store, id)
    const questions = questionsOf(view)
    const guard = questions.find((q) => q.id === 'guard:mw/mw.go#RequireUser')
    assert.deepEqual(guard && [guard.tier, guard.why], ['bounded', 'chain member'])
    assert.ok(
      questions.some((q) => q.id === 'guard:routes/users.go#Users.get' && q.why === 'handler'),
    )
    assert.ok(questions.some((q) => q.id === 'intent:routes/users.go#Users.get'))
    // Chain members come first: a check there guards every route behind it.
    assert.equal(questions[0]?.why, 'chain member')
    // An application asks which applications it holds and how each authenticates, with an agent.
    assert.deepEqual(
      questions.filter((q) => q.tier === 'exploring').map((q) => q.id),
      ['applications:repository', 'authentication:repository'],
    )
    // A question carries the node's code, numbered, its facts, and what it calls.
    const text = questionText(view, store, guard as (typeof questions)[number])
    assert.match(text, /^## Question guard:mw\/mw.go#RequireUser\n/)
    assert.match(text, /\d+: \t\treturn http\.HandlerFunc/)
    // The facts of the function literals it defines are its own: the check is in them.
    assert.match(text, /read header\.Authorization at mw\/mw\.go:\d+/)
  } finally {
    store.close()
    await rm(dir, { recursive: true })
    await rm(home.dir, { recursive: true })
  }
})

test('every rejected claim names the citation that failed', async () => {
  const { dir, home, id } = await indexed()
  const store = new Store(home.database('app'))
  try {
    const view = SnapshotView.load(store, id)
    const claims = new Claims(store)
    const question = questionsOf(view).find((q) => q.id === 'guard:mw/mw.go#RequireUser')
    assert.ok(question)
    const lines = (await readFile(join(dir, 'mw/mw.go'), 'utf8')).split('\n')
    const at = lines.findIndex((l) => l.includes('Authorization')) + 1
    const base = {
      question: question.id,
      value: 'yes',
      kind: 'authn' as string | null,
      text: null,
      reason: 'it reads the Authorization header before passing on',
    }
    const add = (
      answer: Partial<typeof base> & {
        citations: { file: string; line: number; identifier: string }[]
      },
    ) =>
      claims.add({
        question,
        answer: { ...base, ...answer },
        tier: 'bounded',
        model: 'claude-opus-5-5',
        provider: 'test',
        snapshot: id,
        author: 'esper enrich',
      })
    const accepted = add({
      citations: [{ file: 'mw/mw.go', line: at, identifier: 'Authorization' }],
    })
    assert.deepEqual([accepted.status, accepted.rejection], ['accepted', null])
    assert.ok(accepted.fingerprints['mw/mw.go#RequireUser'])

    const rejections = [
      [
        { file: 'mw/mw.go', line: at, identifier: 'Bearer' },
        `citation mw/mw.go:${at}: the line does not hold "Bearer"`,
      ],
      [
        { file: 'mw/mw.go', line: 999, identifier: 'x' },
        /^citation mw\/mw\.go:999: mw\/mw\.go has lines 1 to \d+$/,
      ],
      [
        { file: 'nope.go', line: 1, identifier: 'x' },
        `citation nope.go:1: snapshot ${id} has no file nope.go`,
      ],
      [
        { file: 'mw/mw.go', line: at, identifier: ' ' },
        `citation mw/mw.go:${at}: it names no identifier`,
      ],
    ] as const
    for (const [citation, why] of rejections) {
      const rejected = add({
        citations: [{ file: 'mw/mw.go', line: at, identifier: 'Authorization' }, citation],
      })
      assert.equal(rejected.status, 'rejected')
      if (typeof why === 'string') assert.equal(rejected.rejection, why)
      else assert.match(rejected.rejection ?? '', why)
    }
    // An answer the question does not take, or without the kind it needs, is rejected too.
    assert.match(
      add({ value: 'maybe', citations: [] }).rejection ?? '',
      /maybe is not an answer to a guard question/,
    )
    assert.match(add({ kind: 'admin', citations: [] }).rejection ?? '', /a guard needs its kind/)
    assert.equal(add({ citations: [] }).rejection, 'an answer cites at least one line it rests on')
    // Insufficient context needs no citation: the question moves to the exploring tier.
    const unsure = add({ value: insufficient, kind: null, citations: [] })
    assert.equal(unsure.status, 'insufficient')
    // A claim never becomes a fact: the snapshot's facts are unchanged.
    const again = SnapshotView.load(store, id)
    assert.equal(again.graph.facts.length, view.graph.facts.length)
  } finally {
    store.close()
    await rm(dir, { recursive: true })
    await rm(home.dir, { recursive: true })
  }
})

test('a claim is reused until a fingerprint it rests on changes; insufficient context moves on', async () => {
  const { dir, git, home, id } = await indexed()
  const store = new Store(home.database('app'))
  try {
    const view = SnapshotView.load(store, id)
    const claims = new Claims(store)
    const all = questionsOf(view)
    const bounded = claims.due(view, 'bounded', all)
    assert.equal(bounded.length, all.filter((q) => q.tier === 'bounded').length)
    const guard = all.find((q) => q.id === 'guard:routes/users.go#Users.get')
    const intent = all.find((q) => q.id === 'intent:routes/users.go#Users.get')
    assert.ok(guard && intent)
    const lines = (await readFile(join(dir, 'routes/users.go'), 'utf8')).split('\n')
    const at = lines.findIndex((l) => l.includes('func (u *Users) get')) + 1
    const answer = (question: string, value: string, text: string | null = null) => ({
      question,
      value,
      kind: null,
      text,
      citations:
        value === insufficient ? [] : [{ file: 'routes/users.go', line: at, identifier: 'get' }],
      reason: null,
    })
    const common = {
      tier: 'bounded' as const,
      model: 'm',
      provider: 'test',
      snapshot: id,
      author: 'a',
    }
    claims.add({ question: guard, answer: answer(guard.id, 'no'), ...common })
    claims.add({ question: intent, answer: answer(intent.id, insufficient), ...common })
    const due = claims.due(view, 'bounded', all).map((q) => q.id)
    assert.ok(!due.includes(guard.id) && !due.includes(intent.id))
    // Insufficient context: the question is due in the exploring tier.
    assert.ok(claims.due(view, 'exploring', all).some((q) => q.id === intent.id))

    // The handler changes: its claims no longer hold, and its questions are due again.
    const text = lines.join('\n').replace('load(id)', 'load(id)\n\tload(id)')
    await writeFile(join(dir, 'routes/users.go'), text)
    await git('commit', '--quiet', '-am', 'v2')
    const { id: next } = await home.index('app', { ref: 'HEAD', offline: true })
    const changed = SnapshotView.load(store, next)
    assert.ok(!claims.current(claims.list({ question: guard.id })[0] as never, changed))
    assert.ok(claims.due(changed, 'bounded').some((q) => q.id === guard.id))
    // On the snapshot it was asked on, it still holds.
    assert.ok(claims.current(claims.list({ question: guard.id })[0] as never, view))

    // A claim about the repository that read nothing rests on every file: it changed too.
    const repo = all.find((q) => q.id === 'authentication:repository')
    assert.ok(repo)
    const whole = claims.add({
      question: repo,
      answer: answer(repo.id, insufficient),
      ...common,
      tier: 'exploring',
    })
    assert.deepEqual(Object.keys(whole.fingerprints), ['@files'])
    assert.ok(claims.current(whole, view))
    assert.ok(!claims.current(whole, changed))
    assert.ok(claims.due(changed, 'exploring').some((q) => q.id === repo.id))
    assert.ok(!claims.due(view, 'exploring').some((q) => q.id === repo.id))
  } finally {
    store.close()
    await rm(dir, { recursive: true })
    await rm(home.dir, { recursive: true })
  }
})

test('schemas/claims.schema.json is the schema the providers pass to the model', async () => {
  const { answerSchema } = await import('../src/index.ts')
  const file = JSON.parse(
    await readFile(new URL('../../../schemas/claims.schema.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>
  const { $schema: _, $id: __, title: ___, description: ____, ...schema } = file
  assert.deepEqual(schema, answerSchema)
  // A "no" without a citation would be rejected and asked again: the schema takes none.
  assert.equal(answerSchema.properties.answers.items.properties.citations.minItems, 1)
})
