import assert from 'node:assert/strict'
import { glob, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { Advisories, Home, profilesDir, recordedSource, SnapshotView, Store } from '../src/index.ts'

// Each target's advisories, linked as the hand-checked files of `profiles/*/advisories/` say
// (D19): from OSV's answers as recorded, on the target's whole history, which
// `pnpm fetch-targets` fetches into $ESPER_TARGETS. Without it, these tests are skipped.

interface Expected {
  target: string
  commit: string
  recording: string
  // Links placed on the snapshot's code, and entry points that carry fix-downstream.
  placed: number
  downstream: number
  advisories: Record<
    string,
    { severity: string; precision: string; state: string; fix?: string[]; links?: string[] }
  >
}

const targets = process.env.ESPER_TARGETS
const files: [string, Expected][] = []
for await (const path of glob('*/advisories/*.yaml', { cwd: profilesDir })) {
  files.push([path, parse(await readFile(join(profilesDir, path), 'utf8')) as Expected])
}

for (const [path, expected] of files.sort(([a], [b]) => (a < b ? -1 : 1))) {
  const name = expected.target.split('/').at(-1) as string
  const dir = targets ? join(targets, name) : undefined
  const present = dir ? await stat(join(dir, '.git')).catch(() => undefined) : undefined
  test(`${path}: every advisory linked as checked`, {
    skip: present ? false : 'set ESPER_TARGETS and run pnpm fetch-targets',
  }, async () => {
    const recording = JSON.parse(
      await readFile(new URL(`fixtures/osv/${expected.recording}.json`, import.meta.url), 'utf8'),
    )
    const home = new Home(await mkdtemp(join(tmpdir(), 'esper-home-')), {
      advisories: recordedSource(recording),
    })
    try {
      await home.add(dir as string, { name })
      const { id } = await home.index(name, { ref: expected.commit })
      const store = new Store(home.database(name))
      try {
        const advisories = new Advisories(store)
        const states = advisories.states(id)
        const found = Object.fromEntries(
          advisories.list().map((a) => {
            const precision =
              ['symbol', 'fix-diff', 'file'].find((p) => a.links.some((l) => l.precision === p)) ??
              'unlinked'
            return [
              a.id,
              {
                severity: a.severity,
                precision,
                state: states.get(a.id)?.state,
                ...(a.fixes.length > 0 ? { fix: a.fixes.map((f) => f.slice(0, 12)) } : {}),
                ...(a.links.length > 0
                  ? {
                      links: a.links
                        .map((l) => (l.precision === 'symbol' ? `${l.dir}#${l.ref}` : l.ref))
                        .sort(),
                    }
                  : {}),
              },
            ]
          }),
        )
        assert.deepEqual(found, expected.advisories)
        const view = SnapshotView.load(store, id)
        assert.equal(view.graph.edges.filter((e) => e.kind === 'affects').length, expected.placed)
        const downstream = view.graph.facts.filter((f) => f.value === 'fix-downstream')
        assert.equal(new Set(downstream.map((f) => f.node)).size, expected.downstream)
      } finally {
        store.close()
      }
    } finally {
      await rm(home.dir, { recursive: true })
    }
  })
}
