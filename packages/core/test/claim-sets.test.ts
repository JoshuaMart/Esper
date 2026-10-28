import assert from 'node:assert/strict'
import { glob, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import {
  guardKinds,
  Home,
  profilesDir,
  questionsOf,
  recordedSource,
  SnapshotView,
  Store,
} from '../src/index.ts'

// The questions answered by hand in `profiles/*/claims/`, which `pnpm measure-claims` asks a model
// (D17): each must be one its target's snapshot asks, with an answer a guard question takes. No
// model is called here. The targets come from $ESPER_TARGETS; without them, these are skipped.

const targets = process.env.ESPER_TARGETS
for await (const path of glob('*/claims/*.yaml', { cwd: profilesDir })) {
  const set = parse(await readFile(join(profilesDir, path), 'utf8')) as {
    target: string
    commit: string
    questions: Record<string, string>
  }
  const name = set.target.split('/').at(-1) as string
  const dir = targets ? join(targets, name) : undefined
  const present = dir ? await stat(join(dir, '.git')).catch(() => undefined) : undefined
  test(`${path}: every question answered by hand is asked by its snapshot`, {
    skip: present ? false : 'set ESPER_TARGETS and run pnpm fetch-targets',
  }, async () => {
    for (const answer of Object.values(set.questions)) {
      assert.ok(answer === 'no' || (guardKinds as readonly string[]).includes(answer), answer)
    }
    const home = new Home(await mkdtemp(join(tmpdir(), 'esper-home-')), {
      advisories: recordedSource(),
    })
    try {
      await home.add(dir as string, { name })
      const { id } = await home.index(name, { ref: set.commit, offline: true })
      const store = new Store(home.database(name))
      try {
        const asked = new Set(questionsOf(SnapshotView.load(store, id)).map((q) => q.id))
        assert.deepEqual(
          Object.keys(set.questions).filter((q) => !asked.has(q)),
          [],
        )
      } finally {
        store.close()
      }
    } finally {
      await rm(home.dir, { recursive: true })
    }
  })
}
