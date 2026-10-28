import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import {
  type Analyzer,
  type AnalyzerInput,
  classify,
  detectProfile,
  goImports,
  Home,
  loadProfiles,
  materialise,
  parseGoMod,
  profilesDir,
  readFolder,
  readRef,
  Store,
} from '../src/index.ts'

const run = promisify(execFile)
const fixture = new URL('fixtures/chiapp/', import.meta.url).pathname

async function repository() {
  const dir = await mkdtemp(join(tmpdir(), 'esper-target-'))
  await cp(fixture, dir, { recursive: true })
  await writeFile(join(dir, 'main_test.go'), 'package main\n')
  const git = (...args: string[]) =>
    run('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  await git('init', '--quiet')
  await git('add', '.')
  await git('commit', '--quiet', '-m', 'v1')
  await git('tag', 'v1')
  return { dir, git }
}

test('tests, examples, fixtures, vendored and hidden folders are skipped, and said so', () => {
  assert.deepEqual(classify('vendor/x/y.go'), {
    skip: { path: 'vendor/', reason: 'vendored' },
    read: false,
  })
  assert.deepEqual(classify('a/testdata/b.go').skip, { path: 'a/testdata/', reason: 'fixtures' })
  assert.deepEqual(classify('mux_test.go').skip, { path: 'mux_test.go', reason: 'tests' })
  assert.deepEqual(classify('.github/x.go').skip, { path: '.github/', reason: 'hidden' })
  assert.deepEqual(classify('README.md'), { read: false })
  assert.deepEqual(classify('go.mod'), { read: true })
})

test('go.mod gives the module path and its direct requirements', () => {
  const mod = parseGoMod(
    'module example.com/a\n\ngo 1.24\n\nrequire (\n\tgithub.com/go-chi/chi/v5 v5.2.0\n\tgolang.org/x/net v0.1.0 // indirect\n)\nrequire gorm.io/gorm v1.31.2\n',
  )
  assert.deepEqual(mod, {
    path: 'example.com/a',
    requires: ['github.com/go-chi/chi/v5', 'gorm.io/gorm'],
  })
})

test('a profile is chosen from the module, or the target is refused with the reason', async () => {
  const profiles = await loadProfiles(profilesDir)
  const go = (source: string) => ({ path: 'main.go', source })
  const mod = (text: string) => ({ path: 'go.mod', source: text })

  const app = detectProfile(
    [mod('module x\nrequire github.com/go-chi/chi/v5 v5.2.0\n'), go('package main')],
    profiles,
  )
  assert.ok('profile' in app)
  assert.deepEqual(app.profile.sources, ['net-http/application', 'chi/application'])

  const framework = detectProfile(
    [mod('module github.com/go-chi/chi/v5\n'), go('package chi')],
    profiles,
  )
  assert.ok('profile' in framework)
  assert.equal(framework.profile.kind, 'framework')

  const plain = detectProfile(
    [mod('module x\n'), go('package main\nimport "net/http"\n')],
    profiles,
  )
  assert.ok('profile' in plain)
  assert.deepEqual(plain.profile.sources, ['net-http/application'])

  const unknown = detectProfile([mod('module x\n'), go('package main')], profiles)
  assert.ok('refused' in unknown)
  assert.match(unknown.refused, /no application profile matches/)

  const noGo = detectProfile([{ path: 'README.md', source: '' }], profiles)
  assert.ok('refused' in noGo)
  assert.match(noGo.refused, /no supported language/)
})

test('a folder is read as it is, a ref from git, and a changed checkout is dirty', async () => {
  const { dir } = await repository()
  try {
    const clean = await readFolder(dir)
    assert.equal(clean.dirty, false)
    assert.ok(clean.skips.some((s) => s.path === 'main_test.go'))
    await writeFile(join(dir, 'main.go'), '// changed\n', { flag: 'a' })
    const changed = await readFolder(dir)
    assert.equal(changed.dirty, true)
    const tagged = await readRef(dir, 'v1')
    assert.equal(tagged.ref, 'v1')
    assert.equal(tagged.commit, clean.commit)
    // The ref is read from git: the change in the checkout is not in it.
    const main = tagged.files.find((f) => f.path === 'main.go')
    assert.ok(main && !main.source.includes('// changed'))
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('a project added by path is indexed into its own database, and its folder is not written', async () => {
  const { dir } = await repository()
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-home-')))
  try {
    const before = (await readdir(dir)).sort()
    const project = await home.add(dir, { name: 'shop' })
    assert.deepEqual(project.source, { path: dir })
    const { id, stats, profiles } = await home.index('shop', { ref: 'v1' })
    assert.deepEqual(profiles, ['net-http/application', 'chi/application'])
    assert.equal(stats?.entries, 10)
    assert.deepEqual((await readdir(dir)).sort(), before)
    const store = new Store(home.database('shop'))
    assert.deepEqual(
      store.snapshots().map((s) => [s.id, s.ref]),
      [[id, 'v1']],
    )
    assert.ok(store.graph(id).skips.some((s) => s.path === 'main_test.go'))
    store.close()
    // The same commit, by the same Esper and profiles, is not indexed twice, unless forced.
    const again = await home.index('shop', { ref: 'v1' })
    assert.deepEqual([again.id, again.unchanged, again.stats], [id, true, undefined])
    const forced = await home.index('shop', { ref: 'v1', force: true })
    assert.notEqual(forced.id, id)
    await assert.rejects(home.add(dir, { name: 'shop' }), /already exists/)
    await assert.rejects(home.index('nope'), /no project named nope/)
  } finally {
    await rm(dir, { recursive: true })
    await rm(home.dir, { recursive: true })
  }
})

test('a symbolic link is skipped, never followed out of the target', async () => {
  const { dir, git } = await repository()
  try {
    await symlink('/etc/hosts', join(dir, 'leak.go'))
    await git('add', 'leak.go')
    await git('commit', '--quiet', '-m', 'link')
    for (const snapshot of [await readFolder(dir), await readRef(dir, 'HEAD')]) {
      assert.ok(!snapshot.files.some((f) => f.path === 'leak.go'))
      assert.ok(snapshot.skips.some((s) => s.path === 'leak.go' && s.reason === 'symlink'))
    }
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('a ref is read for a project in a subfolder of the repository, with its own go.mod', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'esper-mono-'))
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-home-')))
  try {
    await cp(fixture, join(dir, 'backend'), { recursive: true })
    const git = (...args: string[]) =>
      run('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
    await git('init', '--quiet')
    await git('add', '.')
    await git('commit', '--quiet', '-m', 'v1')
    await git('tag', 'v1')

    const sub = await readRef(join(dir, 'backend'), 'v1')
    const main = sub.files.find((f) => f.path === 'main.go')
    assert.ok(main?.source.includes('chi.NewRouter()'))

    // The repository's root has no go.mod: the module is found in `backend/`.
    await home.add(dir, { name: 'mono' })
    const { stats } = await home.index('mono', { ref: 'v1' })
    assert.equal(stats?.entries, 10)
  } finally {
    await rm(dir, { recursive: true })
    await rm(home.dir, { recursive: true })
  }
})

test('an import is read from import declarations, not from comments or strings', async () => {
  assert.deepEqual(
    goImports(
      'package a\n// see "net/http"\nimport (\n\tchi "github.com/go-chi/chi/v5"\n\t"fmt" // fmt\n)\nimport "os"\nvar s = "net/http"\n',
    ),
    ['github.com/go-chi/chi/v5', 'fmt', 'os'],
  )
  const refused = detectProfile(
    [{ path: 'main.go', source: 'package main\n// talks to "net/http" servers\nfunc main() {}\n' }],
    await loadProfiles(profilesDir),
  )
  assert.ok('refused' in refused)
})

test('a ref is refused in one line when it looks like an option or names nothing', async () => {
  const { dir } = await repository()
  try {
    for (const ref of ['--output=/tmp/x', '-n', '', 'a b']) {
      await assert.rejects(readRef(dir, ref), { name: 'Error', message: /is not a git ref/ })
    }
    await assert.rejects(readRef(dir, 'nope'), (error: Error) => {
      assert.equal(error.message, 'nope is not a commit, tag or branch of the repository')
      assert.ok(!error.message.includes(dir))
      return true
    })
  } finally {
    await rm(dir, { recursive: true })
  }
})

// An analyzer that runs nowhere: what it is given, and what it answers, are the test's.
const fake: Analyzer = {
  name: 'fake',
  version: '1.0',
  languages: ['go'],
  provides: ['edges.resolve'],
  answers: 'snapshot',
  image: { dockerfile: 'Dockerfile' },
  analyze: ['analyze'],
  dir: '/nonexistent',
  hash: '0'.repeat(64),
}

test('a precise index runs the analyzer on the whole tree, and is a snapshot of its own', async () => {
  const { dir, git } = await repository()
  await writeFile(join(dir, 'go.sum'), 'sum\n')
  await git('add', 'go.sum')
  await git('commit', '--quiet', '-m', 'sum')
  const seen: { input: AnalyzerInput; tree: string[]; main: string; sum: string }[] = []
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-home-')), {
    analyzers: [fake],
    runner: async (analyzer, src, input) => {
      seen.push({
        input,
        tree: (await readdir(src, { recursive: true })).sort(),
        main: await readFile(join(src, 'main.go'), 'utf8'),
        sum: await readFile(join(src, 'go.sum'), 'utf8'),
      })
      return `${JSON.stringify({ type: 'analyzer', format: 1, name: analyzer.name, version: analyzer.version })}\n`
    },
  })
  try {
    await home.add(dir, { name: 'shop' })
    const plain = await home.index('shop', { ref: 'HEAD' })
    assert.deepEqual(plain.analyzers, [])
    // Changed in the checkout, not in the commit: the ref is what the analyzer sees.
    await writeFile(join(dir, 'main.go'), 'package main\n')
    const told: string[] = []
    const precise = await home.index('shop', {
      ref: 'HEAD',
      precise: true,
      progress: (m) => told.push(m),
    })
    assert.deepEqual(told, [
      "fake@1.0: writing the snapshot's tree",
      'fake@1.0: importing its output',
    ])
    assert.notEqual(precise.id, plain.id)
    assert.deepEqual(precise.analyzers, ['fake@1.0'])
    assert.equal(precise.stats?.analyzed, 0)
    const [run] = seen
    assert.ok(run)
    // Every file of the commit, not only those Esper reads, but never the repository itself.
    assert.ok(run.tree.includes('go.sum') && run.tree.includes('main_test.go'))
    assert.ok(!run.tree.some((p) => p.startsWith('.git')))
    assert.equal(run.sum, 'sum\n')
    assert.notEqual(run.main, 'package main\n')
    assert.ok(run.input.files.includes('main.go') && !run.input.files.includes('main_test.go'))
    assert.deepEqual(run.input.modules, [{ path: 'example.com/app', dir: '.' }])
    const again = await home.index('shop', { ref: 'HEAD', precise: true })
    assert.deepEqual([again.id, again.unchanged, again.analyzers], [precise.id, true, ['fake@1.0']])
    // The checkout as it is: the analyzer sees the files as Esper read them.
    await home.index('shop', { precise: true })
    assert.equal(seen[1]?.main, 'package main\n')
    const store = new Store(home.database('shop'))
    assert.deepEqual(
      store.snapshots().map((s) => s.analyzers),
      [[], ['fake@1.0'], ['fake@1.0']],
    )
    store.close()
  } finally {
    await rm(dir, { recursive: true })
    await rm(home.dir, { recursive: true })
  }
})

test("an analyzer's file that is refused fails the index, and stores no snapshot", async () => {
  const { dir } = await repository()
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-home-')), {
    analyzers: [fake],
    runner: async () =>
      [
        { type: 'analyzer', format: 1, name: 'fake', version: '1.0' },
        {
          type: 'reference',
          at: { file: 'main.go', line: 1, column: 1 },
          name: 'Nope',
          target: { external: 'x#Y' },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
  })
  try {
    await home.add(dir, { name: 'shop' })
    await assert.rejects(
      home.index('shop', { ref: 'v1', precise: true }),
      /fake@1.0: line 2 of its output is refused, and the file with it: main.go:1:1 does not hold Nope/,
    )
    const store = new Store(home.database('shop'))
    assert.deepEqual(store.snapshots(), [])
    store.close()
    const none = new Home(home.dir, { analyzers: [{ ...fake, provides: ['flows'] }] })
    await assert.rejects(
      none.index('shop', { precise: true }),
      /no analyzer resolves the call edges of go/,
    )
    const two = new Home(home.dir, { analyzers: [fake, { ...fake, name: 'other' }] })
    await assert.rejects(
      two.index('shop', { precise: true }),
      /fake@1.0 and other@1.0 both resolve/,
    )
  } finally {
    await rm(dir, { recursive: true })
    await rm(home.dir, { recursive: true })
  }
})

test("a commit's tree is written out in batches, never read whole", async () => {
  const { dir, git } = await repository()
  const into = await mkdtemp(join(tmpdir(), 'esper-tree-'))
  try {
    await writeFile(join(dir, 'asset.bin'), Buffer.alloc(4096, 7))
    await git('add', 'asset.bin')
    await git('commit', '--quiet', '-m', 'asset')
    const snapshot = await readRef(dir, 'HEAD')
    // One byte per batch: every file is read on its own, and all of them are written.
    await materialise(dir, snapshot, into, { batch: 1 })
    const listed = (await run('git', ['-C', dir, 'ls-files'])).stdout.trim().split('\n').sort()
    const written = (await readdir(into, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name).slice(into.length + 1))
      .sort()
    assert.deepEqual(written, listed)
    assert.deepEqual(await readFile(join(into, 'asset.bin')), Buffer.alloc(4096, 7))
  } finally {
    await rm(dir, { recursive: true })
    await rm(into, { recursive: true })
  }
})

test('a folder named from the home directory is read there, as the shell would expand ~', async () => {
  const fake = await mkdtemp(join(tmpdir(), 'esper-user-'))
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-home-')))
  const before = process.env.HOME
  try {
    await mkdir(join(fake, 'code', 'budget'), { recursive: true })
    process.env.HOME = fake
    const project = await home.add('~/code/budget')
    assert.equal(project.name, 'budget')
    assert.deepEqual(project.source, { path: join(fake, 'code', 'budget') })
    await assert.rejects(
      home.add('~/nothing'),
      new RegExp(`${join(fake, 'nothing')} is not a folder`),
    )
  } finally {
    process.env.HOME = before
    await rm(fake, { recursive: true })
    await rm(home.dir, { recursive: true })
  }
})
