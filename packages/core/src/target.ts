import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { promisify } from 'node:util'
import { EsperError } from './errors.ts'
import type { Skip } from './graph.ts'
import { languages } from './languages.ts'

// Reading a target (D11): its files, from a folder as it is or from a git ref, and what is skipped.
// The target is data: only git plumbing that runs none of the repository's hooks, filters or
// configured commands is used, and nothing is written to it.

const run = promisify(execFile)

export interface TargetFile {
  path: string
  source: string
}

export interface TargetSnapshot {
  files: TargetFile[]
  skips: Skip[]
  commit?: string
  ref?: string
  dirty: boolean
}

// Folders skipped by default, and why: they are not the code that serves requests.
const skippedDirs: Record<string, string> = {
  vendor: 'vendored',
  node_modules: 'vendored',
  third_party: 'vendored',
  testdata: 'fixtures',
  fixtures: 'fixtures',
  examples: 'examples',
  _examples: 'examples',
  example: 'examples',
  mocks: 'tests',
  __mocks__: 'tests',
  __tests__: 'tests',
  test: 'tests',
  tests: 'tests',
  e2e: 'tests',
  benchmarks: 'benchmarks',
  bench: 'benchmarks',
  dist: 'generated',
}

// The language whose source file a path is.
export function languageOf(path: string): string | undefined {
  return languages.find((l) => l.source(path))?.name
}

// Whether a path is read, or the reason it is skipped. A skipped folder is reported once.
export function classify(path: string): { skip?: Skip; read: boolean } {
  const parts = path.split('/')
  const language = languages.find((l) => l.reads(path))
  for (let i = 0; i < parts.length - 1; i++) {
    const dir = parts[i] as string
    const reason =
      skippedDirs[dir] ??
      language?.skip?.(dir) ??
      (dir.startsWith('.') ? 'hidden' : /[-_]tests?$/.test(dir) ? 'tests' : undefined)
    if (reason)
      return { skip: { path: `${parts.slice(0, i + 1).join('/')}/`, reason }, read: false }
  }
  if (languages.some((l) => l.test(path))) return { skip: { path, reason: 'tests' }, read: false }
  return { read: languages.some((l) => l.reads(path)) }
}

// Git, with every option that could run something of the repository's turned off.
const safe = (cwd: string) => [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '--no-optional-locks',
  '-C',
  cwd,
]

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run('git', [...safe(cwd), ...args], { maxBuffer: 1 << 30, encoding: 'utf8' }))
    .stdout
}

// Many blobs at once, as stored: `cat-file --batch` without `--filters` runs no filter.
function blobs(cwd: string, specs: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...safe(cwd), 'cat-file', '--batch'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`git cat-file exited with ${code}`)),
    )
    child.stdin.end(`${specs.join('\n')}\n`)
  })
}

export async function isGitRepository(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch {
    return false
  }
}

// Git modes that are not a regular file: a symbolic link, whose target may be outside the
// target (`leak.go -> ~/.ssh/id_rsa`), and a submodule, which is another repository.
const notFiles: Record<string, string> = { '120000': 'symlink', '160000': 'submodule' }

function select(
  paths: string[],
  modes: Map<string, string> = new Map(),
): { read: string[]; skips: Skip[] } {
  const read: string[] = []
  const skips = new Map<string, Skip>()
  for (const path of [...paths].sort()) {
    const { skip, read: kept } = classify(path)
    const other = notFiles[modes.get(path) ?? '']
    if (skip) skips.set(skip.path, skip)
    else if (kept && other) skips.set(path, { path, reason: other })
    else if (kept) read.push(path)
  }
  return { read, skips: [...skips.values()] }
}

// The blob id git gives a content, computed here so that comparing the working tree with the
// index runs none of the repository's filters.
const blobId = (content: Buffer) =>
  createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')

// A folder as it is: its files and, for a git checkout, its commit and whether it has changes.
export async function readFolder(dir: string): Promise<TargetSnapshot> {
  if (await isGitRepository(dir)) {
    const tracked = (await git(dir, ['ls-files', '-s', '-z'])).split('\0').filter(Boolean)
    const index = new Map<string, string>()
    const modes = new Map<string, string>()
    for (const line of tracked) {
      const [meta, path] = line.split('\t') as [string, string]
      const [mode, id] = meta.split(' ') as [string, string]
      index.set(path, id)
      modes.set(path, mode)
    }
    const untracked = (await git(dir, ['ls-files', '-o', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean)
    const { read, skips } = select([...index.keys(), ...untracked], modes)
    let dirty = untracked.some((p) => select([p]).read.length > 0)
    const files: TargetFile[] = []
    for (const path of read) {
      // What is on disk may differ from the index: a link is never followed.
      const info = await lstat(join(dir, path)).catch(() => undefined)
      if (info?.isSymbolicLink()) {
        skips.push({ path, reason: 'symlink' })
        dirty = true
        continue
      }
      const content = info?.isFile()
        ? await readFile(join(dir, path)).catch(() => undefined)
        : undefined
      if (!content) {
        dirty = true
        continue
      }
      if (index.has(path) && index.get(path) !== blobId(content)) dirty = true
      files.push({ path, source: content.toString('utf8') })
    }
    const commit = (await git(dir, ['rev-parse', 'HEAD']).catch(() => '')).trim() || undefined
    return { files, skips, dirty, ...(commit ? { commit } : {}) }
  }
  const paths: string[] = []
  const walk = async (rel: string) => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (classify(`${path}/x`).skip) paths.push(`${path}/x`)
        else await walk(path)
      } else if (entry.isFile()) paths.push(path)
    }
  }
  await walk('')
  const { read, skips } = select(paths)
  const files = await Promise.all(
    read.map(async (path) => ({ path, source: await readFile(join(dir, path), 'utf8') })),
  )
  return { files, skips, dirty: false }
}

// Files of a commit, read from the object database as stored.
async function readBlobs(
  dir: string,
  commit: string,
  paths: string[],
): Promise<{ path: string; content: Buffer }[]> {
  const files: { path: string; content: Buffer }[] = []
  if (paths.length === 0) return files
  // `<commit>:./<path>` is relative to the folder git runs in, as `ls-tree` is.
  const data = await blobs(
    dir,
    paths.map((p) => `${commit}:./${p}`),
  )
  let offset = 0
  for (const path of paths) {
    const end = data.indexOf(10, offset)
    const header = data.subarray(offset, end).toString('utf8')
    const [, type, size] = header.split(' ')
    if (type !== 'blob' || !/^\d+$/.test(size ?? '')) {
      throw new Error(`git could not read ${path} at ${commit}: ${header}`)
    }
    offset = end + 1
    const length = Number(size)
    files.push({ path, content: data.subarray(offset, offset + length) })
    offset += length + 1
  }
  return files
}

// A git ref, read from the object database: the checkout is not touched.
export async function readRef(dir: string, ref: string): Promise<TargetSnapshot> {
  // A ref is a name for git, never an option: `--output=…` must not reach its command line.
  if (ref === '' || /^-|[\0-\x20\x7f]/.test(ref)) {
    throw new EsperError(`${JSON.stringify(ref)} is not a git ref`)
  }
  // A ref that does not exist is a refusal said in one line, not git's own error, which names
  // the folder and the command.
  const commit = (
    await git(dir, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).catch(() => {
      throw new EsperError(`${ref} is not a commit, tag or branch of the repository`)
    })
  ).trim()
  // Paths are relative to the project's folder, which may be a subfolder of the repository.
  const entries = (await git(dir, ['ls-tree', '-r', '-z', commit])).split('\0').filter(Boolean)
  const modes = new Map<string, string>()
  for (const entry of entries) {
    const [meta, path] = entry.split('\t') as [string, string]
    modes.set(path, meta.split(' ')[0] as string)
  }
  const { read, skips } = select([...modes.keys()], modes)
  const files = (await readBlobs(dir, commit, read)).map((f) => ({
    path: f.path,
    source: f.content.toString('utf8'),
  }))
  return { files, skips, dirty: false, commit, ref }
}

export async function cloneTarget(url: string, into: string): Promise<void> {
  // Cloning runs none of the target's code: a repository's hooks and configuration are not
  // cloned, so the checkout runs only what the user's own git configuration defines.
  await run('git', [
    '-c',
    'core.hooksPath=/dev/null',
    'clone',
    '--quiet',
    '--no-recurse-submodules',
    url,
    into,
  ])
}

// How much of a commit is read from git at once when its tree is written out.
export const batchBytes = 32 << 20

// Regular files only: a link may point outside the target, a submodule is another repository.
const regular = new Set(['100644', '100755'])
// Folders that hold no source an analyzer needs and can be large.
const notCopied = new Set(['.git', 'node_modules'])

// The whole tree of a snapshot, written into `into` for an analyzer (D12): every regular file of
// the commit or of the folder, not only the files Esper reads (a typed indexer needs `go.sum`,
// embedded files, vendored code), with the files Esper read written as it read them. Links and
// submodules are left out.
export async function materialise(
  dir: string,
  snapshot: TargetSnapshot,
  into: string,
  options: { batch?: number } = {},
) {
  const batchLimit = options.batch ?? batchBytes
  const write = async (path: string, content: string | Buffer) => {
    if (path.split('/').some((part) => part === '..' || part === '' || part === '.')) return
    await mkdir(join(into, posix.dirname(path)), { recursive: true })
    await writeFile(join(into, path), content)
  }
  if (snapshot.ref !== undefined && snapshot.commit) {
    // `-l` gives each blob's size: they are read in batches of a bounded size, so that a target
    // with large assets is never held in memory whole.
    const entries = (await git(dir, ['ls-tree', '-r', '-l', '-z', snapshot.commit]))
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const [meta, path] = entry.split('\t') as [string, string]
        const [mode, , , size] = meta.split(/ +/)
        return { mode: mode as string, size: Number(size), path }
      })
      .filter((e) => regular.has(e.mode) && !skipped(e.path))
      .sort((a, b) => (a.path < b.path ? -1 : 1))
    let batch: string[] = []
    let size = 0
    const flush = async () => {
      for (const file of await readBlobs(dir, snapshot.commit as string, batch)) {
        await write(file.path, file.content)
      }
      batch = []
      size = 0
    }
    for (const entry of entries) {
      if (batch.length > 0 && size + entry.size > batchLimit) await flush()
      batch.push(entry.path)
      size += entry.size
    }
    await flush()
  } else {
    const paths: string[] = []
    if (await isGitRepository(dir)) {
      const listed = await git(dir, ['ls-files', '-c', '-o', '--exclude-standard', '-z'])
      paths.push(...new Set(listed.split('\0').filter(Boolean)))
    } else {
      const walk = async (rel: string) => {
        for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
          const path = rel ? `${rel}/${entry.name}` : entry.name
          if (entry.isDirectory() && !notCopied.has(entry.name)) await walk(path)
          else if (entry.isFile()) paths.push(path)
        }
      }
      await walk('')
    }
    for (const path of paths.filter((p) => !skipped(p)).sort()) {
      const info = await lstat(join(dir, path)).catch(() => undefined)
      if (!info?.isFile()) continue
      const content = await readFile(join(dir, path)).catch(() => undefined)
      if (content) await write(path, content)
    }
  }
  for (const file of snapshot.files) await write(file.path, file.source)
}

const skipped = (path: string) => path.split('/').some((part) => notCopied.has(part))

// History, for the advisories of D19: plumbing that runs none of the repository's filters, hooks
// or configured diff tools. Each answers undefined or nothing rather than failing when the
// repository does not hold what it is asked about, as a shallow clone may not.

// A commit of the repository, by a full or abbreviated id, or undefined.
export async function commitOf(dir: string, id: string): Promise<string | undefined> {
  if (!/^[0-9a-f]{7,40}$/i.test(id)) return undefined
  const sha = await git(dir, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${id}^{commit}`,
  ])
    .then((out) => out.trim())
    .catch(() => '')
  return sha || undefined
}

// The first parent of a commit, or undefined for a root commit or a parent the clone lacks.
export async function parentOf(dir: string, commit: string): Promise<string | undefined> {
  const sha = await git(dir, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${commit}^1`,
  ])
    .then((out) => out.trim())
    .catch(() => '')
  return sha || undefined
}

// The lines a commit changed, against its first parent, per file of the folder git runs in and
// with paths relative to it: each hunk as the first line and the count of lines it replaced in the
// parent. A hunk that only adds lines replaces none, after `start`.
export async function changedLines(
  dir: string,
  parent: string,
  commit: string,
): Promise<Map<string, { start: number; count: number }[]>> {
  const out = await git(dir, [
    '-c',
    'diff.noprefix=false',
    'diff-tree',
    '-p',
    '-U0',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--no-color',
    '--relative',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    parent,
    commit,
  ])
  const hunks = new Map<string, { start: number; count: number }[]>()
  let file: string | undefined
  for (const line of out.split('\n')) {
    if (line.startsWith('--- ')) {
      // A name with a space is followed by a tab, so that the header can be read back.
      const name = unquote(line.slice(4).replace(/\t$/, ''))
      file = name === '/dev/null' ? undefined : name.replace(/^a\//, '')
      continue
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line)
    if (hunk && file !== undefined) {
      const list = hunks.get(file) ?? []
      list.push({ start: Number(hunk[1]), count: hunk[2] === undefined ? 1 : Number(hunk[2]) })
      hunks.set(file, list)
    }
  }
  return hunks
}

// A path as git writes it in a diff header: quoted, with C escapes and its bytes in octal, when it
// holds a space, a quote or a byte outside ASCII (`"a/caf\303\251.go"`).
function unquote(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"'))) return path
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 }
  const bytes: number[] = []
  const text = path.slice(1, -1)
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'))
      continue
    }
    const next = text[++i] ?? ''
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(text.slice(i, i + 3), 8))
      i += 2
    } else bytes.push(escapes[next] ?? next.charCodeAt(0))
  }
  return Buffer.from(bytes).toString('utf8')
}

// Whether `ancestor` is `commit` or one of its ancestors.
export async function isAncestor(dir: string, ancestor: string, commit: string): Promise<boolean> {
  return git(dir, ['merge-base', '--is-ancestor', ancestor, commit]).then(
    () => true,
    () => false,
  )
}

// The tags that name a commit.
export async function tagsAt(dir: string, commit: string): Promise<string[]> {
  return (await git(dir, ['tag', '--points-at', commit]).catch(() => ''))
    .split('\n')
    .filter(Boolean)
}

// The commits of every branch and tag whose message names one of the texts, newest first, at most
// `limit`.
export async function commitsNaming(
  dir: string,
  texts: string[],
  limit: number,
): Promise<string[]> {
  if (texts.length === 0) return []
  const out = await git(dir, [
    'log',
    '--all',
    '--format=%H',
    '-F',
    '-i',
    `--max-count=${limit}`,
    ...texts.map((t) => `--grep=${t}`),
  ]).catch(() => '')
  return out.split('\n').filter(Boolean)
}

// The repositories the target's remotes name, as `host/owner/name` in lower case: what a commit
// URL of an advisory is compared with.
export async function remoteRepositories(dir: string): Promise<string[]> {
  const out = await git(dir, ['config', '--get-regexp', '^remote\\..*\\.url$']).catch(() => '')
  return out
    .split('\n')
    .map((line) => repositoryOf(line.split(' ').slice(1).join(' ')))
    .filter((r): r is string => r !== undefined)
}

// `https://github.com/Owner/Repo.git`, `git@github.com:owner/repo` or a commit URL under it, as
// `github.com/owner/repo`.
export function repositoryOf(url: string): string | undefined {
  const match =
    /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?]|$)/i.exec(
      url.trim(),
    )
  return match ? `${match[1]}/${match[2]}/${match[3]}`.toLowerCase() : undefined
}
