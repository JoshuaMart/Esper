// Measures the bounded tier's guard claims against the questions answered by hand in
// `profiles/*/claims/` (D17): each target, at the commit it was answered at, is indexed into a home
// of its own, and its questions are asked of one model through a provider. It spends the plan or
// the key it runs on: run it on purpose. The targets come from $ESPER_TARGETS (`pnpm fetch-targets`).
//
//   node scripts/measure-claims.ts --model claude-opus-5-5 --effort low [--out result.json]
import { glob, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { parse } from 'yaml'
import { Home, profilesDir, recordedSource } from '../packages/core/src/index.ts'
import { ClaudeCode, enrich, scoreGuards } from '../packages/enrich/src/index.ts'
import { Connection } from '../packages/mcp/src/index.ts'

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'claude-opus-5-5' },
    effort: { type: 'string', default: 'low' },
    batch: { type: 'string', default: '10' },
    out: { type: 'string' },
  },
})
const targets = process.env.ESPER_TARGETS
if (!targets) throw new Error('set ESPER_TARGETS to the folder pnpm fetch-targets fetched into')
const model = { id: values.model as string, effort: values.effort as 'low' | 'medium' | 'high' }
const main = fileURLToPath(new URL('../packages/cli/src/main.ts', import.meta.url))

const results = []
for await (const path of glob('*/claims/*.yaml', { cwd: profilesDir })) {
  const set = parse(await readFile(join(profilesDir, path), 'utf8')) as {
    target: string
    commit: string
    questions: Record<string, string>
  }
  const name = set.target.split('/').at(-1) as string
  const home = new Home(await mkdtemp(join(tmpdir(), 'esper-measure-')), {
    advisories: recordedSource(),
  })
  await home.add(join(targets, name), { name })
  await home.index(name, { ref: set.commit, offline: true })
  const connection = new Connection(home, name)
  try {
    const provider = new ClaudeCode({
      folder: join(home.dir, 'enrich', name),
      esper: { command: process.execPath, args: [main], home: home.dir, project: name },
    })
    const ids = Object.keys(set.questions)
    const started = Date.now()
    const report = await enrich(connection.view(), connection.store, provider, {
      tier: 'bounded',
      model,
      limit: ids.length,
      batch: Number(values.batch),
      only: ids,
      progress: (m) => console.error(`${name}: ${m}`),
    })
    const score = scoreGuards(set.questions, report.claims)
    const missing = ids.filter((id) => !report.asked.some((q) => q.id === id))
    results.push({
      target: name,
      model: model.id,
      effort: model.effort,
      seconds: Math.round((Date.now() - started) / 1000),
      calls: report.calls,
      missing,
      stopped: report.stopped ?? null,
      unanswered: report.unanswered,
      usage: report.usage ?? null,
      ...score,
    })
    console.error(
      `${name}: ${score.outcomes.right}/${score.questions} right, ${score.outcomes['false-guard']} false guards, ${score.outcomes['missed-guard']} missed, ${score.outcomes['wrong-kind']} wrong kind, ${score.exploring} insufficient, ${score.outcomes.rejected} rejected; ${report.usage?.outputTokens ?? 0} output tokens, $${(report.usage?.costUsd ?? 0).toFixed(4)}`,
    )
  } finally {
    connection.close()
    // The home was the measure's own: its index and its claims go with it.
    await rm(home.dir, { recursive: true, force: true })
  }
}
const text = `${JSON.stringify(results, null, 2)}\n`
if (values.out) await writeFile(values.out, text)
else process.stdout.write(text)
