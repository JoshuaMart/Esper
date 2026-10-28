import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import {
  Advisories,
  changedLines,
  compareVersions,
  cvss3Score,
  fixCommits,
  Home,
  importAdvisories,
  type OsvEntry,
  type OsvRecording,
  parseVersion,
  recordedSource,
  remoteRepositories,
  repositoryOf,
  SnapshotView,
  Store,
  versionState,
} from '../src/index.ts'

const run = promisify(execFile)
const fixture = new URL('fixtures/chiapp/', import.meta.url).pathname
const recording = async (name: string) =>
  JSON.parse(
    await readFile(new URL(`fixtures/osv/${name}.json`, import.meta.url), 'utf8'),
  ) as OsvRecording

test('versions are compared as semantic versioning orders them', () => {
  const v = (text: string) => parseVersion(text) as NonNullable<ReturnType<typeof parseVersion>>
  assert.equal(compareVersions(v('v5.2.2'), v('5.2.10')), -1)
  assert.equal(compareVersions(v('4.6.0-rc.1'), v('4.6.0')), -1)
  assert.equal(compareVersions(v('1.0.0-alpha.2'), v('1.0.0-alpha.10')), -1)
  assert.equal(compareVersions(v('1.2'), v('1.2.0')), 0)
  assert.equal(parseVersion('main'), undefined)
  const ranges = [{ type: 'SEMVER', events: [{ introduced: '5.2.2' }, { fixed: '5.2.4' }] }]
  assert.equal(versionState(v('5.2.3'), ranges), 'affected')
  assert.equal(versionState(v('5.3.2'), ranges), 'fixed')
  assert.equal(versionState(v('5.2.1'), ranges), 'unaffected')
  const all = [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { last_affected: '1.4.0' }] }]
  assert.equal(versionState(v('1.4.0'), all), 'affected')
  assert.equal(versionState(v('1.4.1'), all), 'fixed')
  // Two vulnerable spans, the second after a regression.
  const twice = [
    {
      type: 'SEMVER',
      events: [
        { introduced: '1.0.0' },
        { fixed: '1.1.0' },
        { introduced: '2.0.0' },
        { fixed: '2.0.3' },
      ],
    },
  ]
  assert.equal(versionState(v('1.5.0'), twice), 'fixed')
  assert.equal(versionState(v('2.0.1'), twice), 'affected')
  assert.equal(versionState(v('2.0.1'), [{ type: 'GIT', events: [{ fixed: 'abc' }] }]), undefined)
})

test("a CVSS 3 vector's base score is the specification's", () => {
  assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8)
  assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:L/A:N'), 4.8)
  assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:N/A:N'), 4.7)
  assert.equal(cvss3Score('CVSS:3.0/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H'), 9.9)
  assert.equal(cvss3Score('CVSS:3.1/AV:L/AC:L/PR:H/UI:R/S:U/C:N/I:N/A:N'), 0)
  assert.equal(
    cvss3Score('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:A/VC:L/VI:L/VA:N/SC:N/SI:N/SA:N'),
    undefined,
  )
})

test("chi's advisories on OSV: an entry and its aliases are one, rated from an alias if need be", async () => {
  const imported = await importAdvisories(recordedSource(await recording('chi')), [
    { name: 'github.com/go-chi/chi/v5', ecosystem: 'Go' },
  ])
  // Eight entries, two of them the Go database's and GitHub's of the same advisory.
  assert.deepEqual(
    imported.advisories.map((a) => [a.id, a.severity, a.rating?.from]),
    [
      ['GHSA-j6qf-3m9c-vwj3', 'moderate', 'GHSA-j6qf-3m9c-vwj3'],
      ['GO-2025-3770', 'moderate', 'GHSA-vrw8-fxc6-2r93'],
      ['GO-2026-4316', 'moderate', 'GHSA-mqqf-5wvp-8fh8'],
      ['GO-2026-5774', 'moderate', 'GHSA-3fxj-6jh8-hvhx'],
      ['GO-2026-5775', 'high', 'GHSA-9g5q-2w5x-hmxf'],
      ['GO-2026-5777', 'high', 'GHSA-rjr7-jggh-pgcp'],
    ],
  )
  const redirect = imported.advisories.find((a) => a.id === 'GO-2026-4316')
  // The entry that names the function is the one kept, with its range for this module.
  assert.deepEqual(redirect?.symbols, [
    { path: 'github.com/go-chi/chi/v5/middleware', symbols: ['RedirectSlashes'] },
  ])
  assert.deepEqual(redirect?.aliases, ['CVE-2025-69725', 'GHSA-mqqf-5wvp-8fh8'])
  assert.deepEqual(redirect?.ranges, [
    { type: 'SEMVER', events: [{ introduced: '5.2.2' }, { fixed: '5.2.4' }] },
  ])
  assert.deepEqual(imported.low, [])
})

test("Hono's advisories on OSV: 52, of which the 4 rated low are left out", async () => {
  const data = await recording('hono')
  assert.equal(data.queries?.['npm:hono']?.length, 52)
  const imported = await importAdvisories(recordedSource(data), [
    { name: 'hono', ecosystem: 'npm' },
  ])
  assert.equal(imported.advisories.length, 48)
  assert.deepEqual(imported.low, [
    'GHSA-79qm-7rj5-m7r9',
    'GHSA-gq3j-xvxp-8hrf',
    'GHSA-hm8q-7f3q-5f36',
    'GHSA-rpfr-3m35-5vx5',
  ])
  const commits = imported.advisories.filter((a) =>
    a.references.some((r) => /\/commit\/[0-9a-f]{7,40}/.test(r.url)),
  )
  // 41 of the 52 point to a commit, none with the FIX type; 38 of the 48 kept.
  assert.equal(commits.length, 38)
  assert.ok(!imported.advisories.some((a) => a.references.some((r) => r.type === 'FIX')))
})

// An entry as OSV writes it, for the advisories of the test repository.
function entry(id: string, extra: Partial<OsvEntry> = {}): OsvEntry {
  return {
    id,
    summary: `${id} summary`,
    modified: '2026-10-01T00:00:00Z',
    affected: [{ package: { name: 'example.com/app', ecosystem: 'Go' } }],
    ...extra,
  }
}

async function repository() {
  const dir = await mkdtemp(join(tmpdir(), 'esper-advisories-'))
  await cp(fixture, dir, { recursive: true })
  const git = async (...args: string[]) =>
    (
      await run('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
    ).stdout.trim()
  const edit = async (path: string, from: string, to: string) => {
    const text = await readFile(join(dir, path), 'utf8')
    assert.ok(text.includes(from), `${path} holds ${from}`)
    await writeFile(join(dir, path), text.replace(from, to))
  }
  await writeFile(join(dir, 'mw/limits.go'), 'package mw\n\nvar MaxBody = 1 << 30\n')
  await git('init', '--quiet')
  await git('add', '.')
  await git('commit', '--quiet', '-m', 'first')
  await git('tag', 'v1.0.0')
  // A fix in a function's body, that its advisory points to.
  await edit(
    'routes/users.go',
    'func load(id string) {}',
    'func load(id string) {\n\tif id == "" {\n\t\treturn\n\t}\n}',
  )
  await git('commit', '--quiet', '-am', 'check the id before loading')
  const fixA = await git('rev-parse', 'HEAD')
  // A fix outside any declaration, whose commit only its message names.
  await edit('mw/limits.go', '1 << 30', '1 << 20')
  await git('commit', '--quiet', '-am', 'Lower the body limit (GHSA-aaaa-bbbb-cccc)')
  await git('tag', 'v1.1.0')
  // The fixed function, renamed: its code is the same.
  await edit('routes/users.go', 'func load(id string) {', 'func fetch(id string) {')
  await edit('routes/users.go', '\tload(id)', '\tfetch(id)')
  await git('commit', '--quiet', '-am', 'rename')
  await git('tag', 'v1.2.0')
  return { dir, fixA, git }
}

test('advisories are linked to the code their fix touched, and follow it across versions', async () => {
  const { dir, fixA } = await repository()
  const advisories: OsvEntry[] = [
    // Rated through its alias, which OSV holds apart; points to its fix commit.
    entry('GO-2026-0001', {
      aliases: ['GHSA-1111-2222-3333'],
      affected: [
        {
          package: { name: 'example.com/app', ecosystem: 'Go' },
          ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.1.0' }] }],
        },
      ],
      references: [{ type: 'WEB', url: `https://example.com/app/commit/${fixA}` }],
    }),
    // No rating, a CVSS 3 vector of 4.8; no commit: the history names it.
    entry('GHSA-aaaa-bbbb-cccc', {
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:L/A:N' }],
    }),
    // Names the middleware every route of /api has.
    entry('GO-2026-0002', {
      affected: [
        {
          package: { name: 'example.com/app', ecosystem: 'Go' },
          ecosystem_specific: {
            imports: [{ path: 'example.com/app/mw', symbols: ['RequireUser'] }],
          },
        },
      ],
      database_specific: { severity: 'HIGH' },
    }),
    // Nothing to link it with.
    entry('GHSA-dddd-eeee-ffff', { database_specific: { severity: 'CRITICAL' } }),
    // Rated low: left out.
    entry('GHSA-llll-llll-llll', { database_specific: { severity: 'LOW' } }),
  ]
  const source = recordedSource({
    queries: { 'Go:example.com/app': advisories },
    entries: {
      'GHSA-1111-2222-3333': entry('GHSA-1111-2222-3333', {
        database_specific: { severity: 'HIGH' },
      }),
    },
  })
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-home-')), { advisories: source })
  try {
    await home.add(dir, { name: 'app' })
    const v1 = await home.index('app', { ref: 'v1.0.0' })
    assert.deepEqual(v1.advisories, {
      fetched: true,
      packages: [{ name: 'example.com/app', ecosystem: 'Go' }],
      advisories: 4,
      severity: { critical: 1, high: 2, moderate: 1, low: 0, unrated: 0 },
      low: 1,
      linked: { symbol: 1, 'fix-diff': 1, file: 1 },
      unlinked: 1,
    })
    const v11 = await home.index('app', { ref: 'v1.1.0', offline: true })
    assert.equal(v11.advisories?.fetched, false)
    assert.equal(v11.advisories?.reason, 'offline')
    const v12 = await home.index('app', { ref: 'v1.2.0', offline: true })

    const store = new Store(home.database('app'))
    try {
      const stored = new Map(new Advisories(store).list().map((a) => [a.id, a]))
      assert.deepEqual(
        stored.get('GO-2026-0001')?.links.map((l) => [l.precision, l.ref, l.hunk, l.source]),
        [['fix-diff', 'routes/users.go#load', 'routes/users.go:37', 'osv']],
      )
      assert.deepEqual(
        stored.get('GHSA-aaaa-bbbb-cccc')?.links.map((l) => [l.precision, l.ref, l.source]),
        [['file', 'mw/limits.go', 'git']],
      )
      assert.equal(stored.get('GHSA-aaaa-bbbb-cccc')?.how, 'git log')
      assert.deepEqual(stored.get('GHSA-aaaa-bbbb-cccc')?.rating, {
        from: 'GHSA-aaaa-bbbb-cccc',
        by: 'cvss',
        score: 4.8,
      })
      assert.equal(stored.get('GHSA-dddd-eeee-ffff')?.status, 'unlinked')

      const affects = (id: number) =>
        SnapshotView.load(store, id)
          .graph.edges.filter((e) => e.kind === 'affects')
          .map((e) => [
            e.from,
            e.to,
            e.data?.precision,
            e.data?.state,
            e.data?.code,
            e.data?.movedFrom,
          ])
          .sort()
      // Before the fix: the version is affected, its code as it was.
      assert.deepEqual(affects(v1.id), [
        ['osv:GHSA-aaaa-bbbb-cccc', 'mw/limits.go', 'file', 'affected', 'as-before-fix', undefined],
        [
          'osv:GO-2026-0001',
          'routes/users.go#load',
          'fix-diff',
          'affected',
          'as-before-fix',
          undefined,
        ],
        ['osv:GO-2026-0002', 'mw/mw.go#RequireUser', 'symbol', 'unknown', undefined, undefined],
      ])
      // After it: fixed, from its range, or because the commit holds the fix.
      assert.deepEqual(affects(v11.id), [
        ['osv:GHSA-aaaa-bbbb-cccc', 'mw/limits.go', 'file', 'fixed', 'as-fixed', undefined],
        ['osv:GO-2026-0001', 'routes/users.go#load', 'fix-diff', 'fixed', 'as-fixed', undefined],
        ['osv:GO-2026-0002', 'mw/mw.go#RequireUser', 'symbol', 'unknown', undefined, undefined],
      ])
      // Renamed since: the link follows the code by its fingerprint.
      assert.deepEqual(affects(v12.id)[1], [
        'osv:GO-2026-0001',
        'routes/users.go#fetch',
        'fix-diff',
        'fixed',
        'as-fixed',
        'routes/users.go#load',
      ])
      const states = new Advisories(store).states(v12.id)
      assert.deepEqual(states.get('GO-2026-0001'), { state: 'fixed', how: 'version v1.2.0' })
      assert.match(states.get('GHSA-aaaa-bbbb-cccc')?.how ?? '', /^holds fix [0-9a-f]{12}$/)

      // The entry points that reach an affected declaration, from their handler or their chain.
      const view = SnapshotView.load(store, v1.id)
      const downstream = view.graph.facts
        .filter((f) => f.value === 'fix-downstream')
        .map((f) => [f.node, f.data?.advisory, f.data?.from, f.data?.via])
        .sort()
      assert.deepEqual(
        downstream.filter((d) => d[1] === 'GO-2026-0001'),
        [['route:GET /api/users/{id}', 'GO-2026-0001', 'handler', 'routes/users.go#load']],
      )
      const chained = downstream.filter((d) => d[1] === 'GO-2026-0002')
      assert.ok(chained.length >= 3)
      assert.ok(chained.every((d) => d[2] === 'chain' && d[3] === 'mw/mw.go#RequireUser'))
      // A file link sets no signal: no declaration is known to be reached.
      assert.ok(!downstream.some((d) => d[1] === 'GHSA-aaaa-bbbb-cccc'))
      assert.deepEqual(
        view
          .entrypoints({ signal: 'fix-downstream' })
          .map((e) => e.ref)
          .includes('route:GET /api/users/{id}'),
        true,
      )
      // An advisory is a node of the snapshot, its text data from a third party.
      const node = view.nodes.get('osv:GO-2026-0001')
      assert.equal(node?.kind, 'advisory')
      assert.equal(node?.data?.summary, 'GO-2026-0001 summary')
    } finally {
      store.close()
    }

    // Fetched again unchanged, the states already computed are kept, not asked of git again; an
    // advisory whose entry changed has its states computed again.
    const touch = (id: string) => {
      const s2 = new Store(home.database('app'))
      s2.db
        .prepare(
          `UPDATE advisory_states SET state = 'unknown', how = 'touched' WHERE advisory_id = ? AND snapshot_id = ?`,
        )
        .run(id, v1.id)
      s2.close()
    }
    const stateOf = (id: string) => {
      const s2 = new Store(home.database('app'))
      const state = new Advisories(s2).states(v1.id).get(id)
      s2.close()
      return state
    }
    touch('GO-2026-0001')
    await new Home(home.dir, { advisories: source }).advisories('app')
    assert.deepEqual(stateOf('GO-2026-0001'), { state: 'unknown', how: 'touched' })
    const modified = advisories.map((a) =>
      a.id === 'GO-2026-0001' ? { ...a, modified: '2026-10-20T00:00:00Z' } : a,
    )
    await new Home(home.dir, {
      advisories: recordedSource({
        queries: { 'Go:example.com/app': modified },
        entries: {
          'GHSA-1111-2222-3333': entry('GHSA-1111-2222-3333', {
            database_specific: { severity: 'HIGH' },
          }),
        },
      }),
    }).advisories('app')
    assert.deepEqual(stateOf('GO-2026-0001'), { state: 'affected', how: 'version v1.0.0' })

    // Fetched again, an advisory gone from OSV is gone, and a failure keeps what was stored.
    const failing = new Home(home.dir, {
      advisories: {
        query: async () => {
          throw new Error('OSV is down')
        },
        get: async () => undefined,
      },
    })
    await assert.rejects(failing.advisories('app'), /advisories not fetched: OSV is down/)
    const fewer = new Home(home.dir, {
      advisories: recordedSource({ queries: { 'Go:example.com/app': advisories.slice(0, 1) } }),
    })
    const report = await fewer.advisories('app')
    assert.equal(report.advisories, 1)
  } finally {
    await rm(dir, { recursive: true })
    await rm(home.dir, { recursive: true })
  }
})

test('an advisory that cannot be linked is kept unlinked, with why; the others are saved', async () => {
  const store = new Store(':memory:')
  try {
    const advisory = (id: string) => ({
      id,
      aliases: [],
      summary: id,
      details: '',
      severity: 'high' as const,
      rating: null,
      published: null,
      modified: null,
      package: { name: 'x', ecosystem: 'Go' },
      ranges: [],
      symbols: [],
      references: [],
    })
    const { report, changed } = await new Advisories(store).save(
      {
        packages: [{ name: 'x', ecosystem: 'Go' }],
        advisories: [advisory('A'), advisory('B')],
        low: [],
      },
      async (a) => {
        if (a.id === 'A') throw new Error('the parent commit could not be read')
        return {
          status: 'linked',
          how: 'symbols',
          fixes: [],
          links: [{ precision: 'symbol', kind: 'decl', ref: 'F', dir: '.', source: 'osv' }],
        }
      },
    )
    assert.deepEqual(changed, ['A', 'B'])
    assert.equal(report.advisories, 2)
    const stored = new Advisories(store).list()
    assert.deepEqual(
      stored.map((a) => [a.id, a.status, a.how]),
      [
        ['A', 'unlinked', 'could not be linked: the parent commit could not be read'],
        ['B', 'linked', 'symbols'],
      ],
    )
  } finally {
    store.close()
  }
})

test("an abbreviated fix commit is taken only from a URL of the target's own repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'esper-fix-'))
  const git = async (...args: string[]) =>
    (
      await run('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
    ).stdout.trim()
  try {
    await git('init', '--quiet')
    await writeFile(join(dir, 'a.go'), 'package a\n')
    await git('add', '.')
    await git('commit', '--quiet', '-m', 'fix')
    const sha = await git('rev-parse', 'HEAD')
    await git('remote', 'add', 'origin', 'git@github.com:Example/App.git')
    assert.equal(
      repositoryOf('https://github.com/example/app/commit/abc'),
      'github.com/example/app',
    )
    assert.deepEqual(await remoteRepositories(dir), ['github.com/example/app'])
    const fixes = (url: string) =>
      fixCommits(
        {
          id: 'X',
          aliases: [],
          summary: '',
          details: '',
          severity: 'high',
          rating: null,
          published: null,
          modified: null,
          package: { name: 'x', ecosystem: 'Go' },
          ranges: [],
          symbols: [],
          references: [{ type: 'WEB', url }],
        },
        dir,
      )
    // Another repository's commit whose short id the target happens to hold: not the fix.
    assert.deepEqual(await fixes(`https://github.com/other/lib/commit/${sha.slice(0, 7)}`), [])
    assert.deepEqual(await fixes(`https://github.com/example/app/commit/${sha.slice(0, 7)}`), [sha])
    // A full id names one commit, wherever the URL points.
    assert.deepEqual(await fixes(`https://github.com/fork/app/commit/${sha}`), [sha])
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('the lines a fix changed are read in files whose names git quotes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'esper-diff-'))
  const git = async (...args: string[]) =>
    (
      await run('git', [
        '-C',
        dir,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        '-c',
        'core.quotePath=true',
        ...args,
      ])
    ).stdout.trim()
  try {
    await git('init', '--quiet')
    await writeFile(join(dir, 'my file.go'), 'package a\n\nfunc A() {}\n')
    await writeFile(join(dir, 'café.go'), 'package a\n\nfunc B() {}\n')
    await git('add', '.')
    await git('commit', '--quiet', '-m', 'one')
    const parent = await git('rev-parse', 'HEAD')
    await writeFile(join(dir, 'my file.go'), 'package a\n\nfunc A() { return }\n')
    await writeFile(join(dir, 'café.go'), 'package a\n\nfunc B() { return }\n')
    await git('commit', '--quiet', '-am', 'two')
    const hunks = await changedLines(dir, parent, await git('rev-parse', 'HEAD'))
    assert.deepEqual([...hunks.keys()].sort(), ['café.go', 'my file.go'])
    assert.deepEqual(hunks.get('café.go'), [{ start: 3, count: 1 }])
  } finally {
    await rm(dir, { recursive: true })
  }
})
