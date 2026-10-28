// Fetches each hand-counted target at the commit it was counted at, into $ESPER_TARGETS, so that
// the counts run as tests (D16). Only the objects of that commit are fetched, unless the target's
// advisories are linked too; nothing is run.
import { execFile } from 'node:child_process'
import { glob, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'yaml'

const run = promisify(execFile)
const root = process.env.ESPER_TARGETS
if (!root) throw new Error('set ESPER_TARGETS to the folder the targets go in')

// A target whose advisories are linked (`profiles/*/advisories/`) needs its whole history and its
// tags: the commits that fixed them, and the versions they were fixed in.
const histories = new Set<string>()
for await (const path of glob('profiles/*/advisories/*.yaml')) {
  histories.add((parse(await readFile(path, 'utf8')) as { target: string }).target)
}

for await (const path of glob('profiles/*/counts/*.yaml')) {
  const count = parse(await readFile(path, 'utf8')) as {
    target: string
    commit: string
    dir?: string
  }
  const name = count.target
    .replace(/\.git$/, '')
    .split('/')
    .at(-1) as string
  const dir = join(root, name)
  const git = (...args: string[]) =>
    run('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...args])
  if (!(await stat(join(dir, '.git')).catch(() => undefined))) {
    await mkdir(dir, { recursive: true })
    await git('init', '--quiet')
  }
  const have = await git('cat-file', '-e', `${count.commit}^{commit}`).then(
    () => true,
    () => false,
  )
  if (histories.has(count.target)) {
    // A clone fetched with a depth before is deepened to the whole history.
    const shallow = await stat(join(dir, '.git', 'shallow')).catch(() => undefined)
    await git('fetch', '--quiet', '--tags', ...(shallow ? ['--unshallow'] : []), count.target)
    if (!have) await git('fetch', '--quiet', count.target, count.commit)
  } else if (!have) await git('fetch', '--quiet', '--depth', '1', count.target, count.commit)
  // A target that is a folder of the repository is read from git in that folder, which must exist;
  // nothing is checked out.
  if (count.dir) await mkdir(join(dir, count.dir), { recursive: true })
  console.log(`${name} at ${count.commit.slice(0, 12)}`)
}
