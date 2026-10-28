import assert from 'node:assert/strict'
import { glob, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { detectProfile, indexGo, loadProfiles, profilesDir, readRef } from '../src/index.ts'

// Each profile against the targets counted by hand (D16): no entry point missing, none
// invented. The targets are fetched by `pnpm fetch-targets` into $ESPER_TARGETS; without them,
// these tests are skipped.

interface Count {
  target: string
  commit: string
  kind: 'application' | 'framework'
  entries: { ref: string; at: string }[]
}

const targets = process.env.ESPER_TARGETS
const counts: [string, Count][] = []
for await (const path of glob('*/counts/*.yaml', { cwd: profilesDir })) {
  counts.push([path, parse(await readFile(join(profilesDir, path), 'utf8')) as Count])
}

for (const [path, count] of counts.sort(([a], [b]) => (a < b ? -1 : 1))) {
  const name = count.target
    .replace(/\.git$/, '')
    .split('/')
    .at(-1) as string
  const dir = targets ? join(targets, name) : undefined
  const present = dir ? await stat(join(dir, '.git')).catch(() => undefined) : undefined
  test(`${path}: every entry point counted by hand, and no other`, {
    skip: present ? false : 'set ESPER_TARGETS and run pnpm fetch-targets',
  }, async () => {
    const snapshot = await readRef(dir as string, count.commit)
    const detection = detectProfile(snapshot.files, await loadProfiles(profilesDir))
    assert.ok('profile' in detection, 'refused' in detection ? detection.refused : '')
    assert.equal(detection.profile.kind, count.kind)
    const { graph } = await indexGo(
      snapshot.files.filter((f) => f.path.endsWith('.go')),
      {
        ...(detection.module.path ? { module: detection.module.path } : {}),
        profile: detection.profile,
      },
    )
    const found = graph.nodes
      .filter((n) => n.kind === 'entry')
      .map((n) => ({ ref: n.ref, at: `${n.file}:${n.startLine}` }))
      .sort((a, b) => (a.ref < b.ref ? -1 : 1))
    const expected = [...count.entries].sort((a, b) => (a.ref < b.ref ? -1 : 1))
    const missing = expected.filter((e) => !found.some((f) => f.ref === e.ref)).map((e) => e.ref)
    const invented = found.filter((f) => !expected.some((e) => e.ref === f.ref)).map((f) => f.ref)
    assert.deepEqual({ missing, invented }, { missing: [], invented: [] })
    assert.deepEqual(found, expected)
  })
}
