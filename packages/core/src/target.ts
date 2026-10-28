import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { promisify } from 'node:util'
import type { Skip } from './graph.ts'

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
}

const languages: Record<string, string> = { '.go': 'go' }

export function languageOf(path: string): string | undefined {
  return languages[posix.extname(path)]
}

// Whether a path is read, or the reason it is skipped. A skipped folder is reported once.
export function classify(path: string): { skip?: Skip; read: boolean } {
  const parts = path.split('/')
  for (let i = 0; i < parts.length - 1; i++) {
    const dir = parts[i] as string
    const reason = skippedDirs[dir] ?? (dir.startsWith('.') ? 'hidden' : undefined)
    if (reason)
      return { skip: { path: `${parts.slice(0, i + 1).join('/')}/`, reason }, read: false }
  }
  if (path.endsWith('_test.go')) return { skip: { path, reason: 'tests' }, read: false }
  return { read: languageOf(path) !== undefined || posix.basename(path) === 'go.mod' }
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

// A git ref, read from the object database: the checkout is not touched.
export async function readRef(dir: string, ref: string): Promise<TargetSnapshot> {
  const commit = (await git(dir, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()
  // Paths are relative to the project's folder, which may be a subfolder of the repository.
  const entries = (await git(dir, ['ls-tree', '-r', '-z', commit])).split('\0').filter(Boolean)
  const modes = new Map<string, string>()
  for (const entry of entries) {
    const [meta, path] = entry.split('\t') as [string, string]
    modes.set(path, meta.split(' ')[0] as string)
  }
  const { read, skips } = select([...modes.keys()], modes)
  const files: TargetFile[] = []
  if (read.length > 0) {
    // `<commit>:./<path>` is relative to the folder git runs in, as `ls-tree` is.
    const data = await blobs(
      dir,
      read.map((p) => `${commit}:./${p}`),
    )
    let offset = 0
    for (const path of read) {
      const end = data.indexOf(10, offset)
      const header = data.subarray(offset, end).toString('utf8')
      const [, type, size] = header.split(' ')
      if (type !== 'blob' || !/^\d+$/.test(size ?? '')) {
        throw new Error(`git could not read ${path} at ${commit}: ${header}`)
      }
      offset = end + 1
      const length = Number(size)
      files.push({ path, source: data.subarray(offset, offset + length).toString('utf8') })
      offset += length + 1
    }
  }
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
