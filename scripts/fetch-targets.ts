// Fetches each hand-counted target at the commit it was counted at, into $ESPER_TARGETS, so that
// the counts run as tests (D16). Only the objects of that commit are fetched; nothing is run.
import { execFile } from 'node:child_process'
import { glob, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'yaml'

const run = promisify(execFile)
const root = process.env.ESPER_TARGETS
if (!root) throw new Error('set ESPER_TARGETS to the folder the targets go in')

for await (const path of glob('profiles/*/counts/*.yaml')) {
  const count = parse(await readFile(path, 'utf8')) as { target: string; commit: string }
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
  if (!have) await git('fetch', '--quiet', '--depth', '1', count.target, count.commit)
  console.log(`${name} at ${count.commit.slice(0, 12)}`)
}
