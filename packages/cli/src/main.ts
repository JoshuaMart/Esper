#!/usr/bin/env node
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { type AdvisoryReport, Home } from '@esper/core'
import pkg from '../package.json' with { type: 'json' }

const usage = `Usage: esper <command> [options]

Commands:
  add <path or git URL>   add a project; --name <name>, --kind application|framework,
                          --package <name> for each package whose advisories are the target's,
                          beside those its manifests declare
  index <project>         index a snapshot of it; --ref <git ref> reads that ref, not the checkout;
                          --force indexes a commit already indexed; --precise also runs the
                          analyzer that resolves call edges with the language's type checker,
                          in Docker; --offline does not fetch the advisories from OSV
  advisories <project>    fetch the target's advisories from OSV again, and link them to its code
  enrich <project>        ask a model the questions parsing cannot answer, as claims kept apart
                          from the facts; --provider claude-code (default) or anthropic-api,
                          --tier bounded (default) or exploring, --kind <kind>, --limit <n>
                          (40 by default), --model <id>, --effort low|medium|high, --snapshot <id>,
                          --dry-run lists the questions without asking them
  list                    the projects and their snapshots
  mcp <project>           serve the project over MCP on stdio; --read-only exposes no tool
                          that writes; --trace <file> appends each tool call to the file
  serve                   the web interface, its API and MCP over HTTP at /mcp/<project>, on
                          localhost; --port <port>, 7300 by default, 0 for any free one

Options:
  --version  print the version
  --help     print this help

Esper keeps its projects in $ESPER_HOME, or ~/.esper.`

// Each command's options. Unknown options are refused, not ignored: a mistyped `--read-only`
// must not start a server that writes.
const options = {
  name: { type: 'string' },
  kind: { type: 'string' },
  package: { type: 'string', multiple: true },
  ref: { type: 'string' },
  force: { type: 'boolean' },
  precise: { type: 'boolean' },
  offline: { type: 'boolean' },
  provider: { type: 'string' },
  tier: { type: 'string' },
  limit: { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  snapshot: { type: 'string' },
  'dry-run': { type: 'boolean' },
  'read-only': { type: 'boolean' },
  trace: { type: 'string' },
  port: { type: 'string' },
  version: { type: 'boolean' },
  help: { type: 'boolean' },
} as const
const commands: Record<string, (keyof typeof options)[]> = {
  add: ['name', 'kind', 'package'],
  index: ['ref', 'force', 'precise', 'offline'],
  advisories: [],
  enrich: ['provider', 'tier', 'kind', 'limit', 'model', 'effort', 'snapshot', 'dry-run'],
  list: [],
  mcp: ['read-only', 'trace'],
  serve: ['port'],
}

function fail(message: string, code = 2): never {
  console.error(`esper: ${message}`)
  process.exit(code)
}

function parse(args: string[]) {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true })
    const [command] = parsed.positionals
    const allowed = new Set<string>([
      'version',
      'help',
      ...(command ? (commands[command] ?? []) : []),
    ])
    const extra = Object.keys(parsed.values).find((key) => !allowed.has(key))
    if (extra) fail(`--${extra} is not an option of ${command ?? 'esper'}\n\n${usage}`)
    return parsed
  } catch (error) {
    fail(`${(error as Error).message}\n\n${usage}`)
  }
}

// What an import of advisories says, in a line or two.
function advisoryLines(report: AdvisoryReport): string[] {
  const severity = Object.entries(report.severity)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
  const linked = Object.entries(report.linked)
    .filter(([, n]) => n > 0)
    .map(([p, n]) => `${n} by ${p}`)
  const head = report.fetched
    ? `${report.advisories} kept${severity.length > 0 ? ` (${severity.join(', ')})` : ''}, ${report.low} low left out`
    : `not fetched (${report.reason}); ${report.advisories} kept from before`
  return [
    `  advisories   ${head}`,
    ...(report.advisories > 0
      ? [
          `               linked ${linked.length > 0 ? linked.join(', ') : 'none'}; ${report.unlinked} unlinked`,
        ]
      : []),
  ]
}

const percent = (part: number, whole: number) =>
  whole === 0 ? '0' : ((100 * part) / whole).toFixed(1)

async function main() {
  const { values, positionals } = parse(process.argv.slice(2))
  const [command, ...rest] = positionals
  if (values.version) return console.log(`${pkg.name} ${pkg.version}`)
  if (values.help || !command) return console.log(usage)
  if (!(command in commands)) fail(`unknown command '${command}'\n\n${usage}`)
  const home = new Home()

  if (command === 'add') {
    const [source] = rest
    if (!source || rest.length > 1) fail('add takes one path or git URL')
    const kind = values.kind
    if (kind && kind !== 'application' && kind !== 'framework') {
      fail(`--kind is application or framework, not ${kind}`)
    }
    const project = await home.add(source, {
      ...(values.name ? { name: values.name } : {}),
      ...(kind ? { kind: kind as 'application' | 'framework' } : {}),
      ...(values.package ? { packages: values.package } : {}),
    })
    const from = 'path' in project.source ? `reads ${project.source.path} in place` : 'cloned'
    console.log(`added ${project.name}: ${from}`)
    console.log(`next: esper index ${project.name}`)
    return
  }

  if (command === 'index') {
    const [name] = rest
    if (!name || rest.length > 1) fail('index takes one project name')
    const ref = values.ref
    const { id, snapshot, stats, profiles, analyzers, unchanged, notes, advisories } =
      await home.index(name, {
        ...(ref ? { ref } : {}),
        ...(values.force ? { force: true } : {}),
        ...(values.offline ? { offline: true } : {}),
        ...(values.precise ? { precise: true, progress: (m: string) => console.error(m) } : {}),
      })
    const version = [
      snapshot.ref,
      snapshot.commit?.slice(0, 12),
      snapshot.dirty ? 'dirty' : undefined,
    ].filter(Boolean)
    const label = `${name}: snapshot ${id}${version.length > 0 ? ` (${version.join(', ')})` : ''}`
    const states = Object.entries(notes)
      .filter(([, n]) => n > 0)
      .map(([state, n]) => `${n} ${state}`)
    const noteLine = `  notes        ${states.length > 0 ? states.join(', ') : 'none'}`
    if (unchanged || !stats) {
      console.log(
        `${label} already indexes this commit with these profiles${
          analyzers.length > 0 ? ` and ${analyzers.join(', ')}` : ''
        }; --force indexes it again`,
      )
      if (states.length > 0) console.log(noteLine)
      return
    }
    const edges = stats.resolved + stats.guessed
    console.log(label)
    console.log(`  profiles     ${profiles.join(', ')}`)
    if (analyzers.length > 0) console.log(`  analyzers    ${analyzers.join(', ')}`)
    console.log(`  files        ${stats.files} read`)
    console.log(
      `  skipped      ${snapshot.skips.length}${
        snapshot.skips.length > 0
          ? `: ${snapshot.skips
              .slice(0, 8)
              .map((s) => `${s.path} (${s.reason})`)
              .join(', ')}${snapshot.skips.length > 8 ? ', …' : ''}`
          : ''
      }`,
    )
    console.log(`  entry points ${stats.entries}`)
    console.log(
      `  call edges   ${edges}, ${percent(stats.resolved, edges)} % resolved; ${stats.unresolved} calls without an edge`,
    )
    if (analyzers.length > 0) {
      console.log(
        `               ${stats.analyzed} of ${stats.calls} calls named by ${analyzers.join(', ')}`,
      )
    }
    console.log(`  reads        ${stats.reads}, signals on entry points ${stats.signals}`)
    console.log(noteLine)
    if (advisories) for (const line of advisoryLines(advisories)) console.log(line)
    return
  }

  if (command === 'advisories') {
    const [name] = rest
    if (!name || rest.length > 1) fail('advisories takes one project name')
    const report = await home.advisories(name)
    console.log(
      `${name}: advisories of ${report.packages.map((p) => `${p.name} (${p.ecosystem})`).join(', ') || 'no package'}`,
    )
    for (const line of advisoryLines(report)) console.log(line)
    return
  }

  if (command === 'enrich') {
    const [name] = rest
    if (!name || rest.length > 1) fail('enrich takes one project name')
    await home.project(name)
    const provider = values.provider ?? 'claude-code'
    if (provider !== 'claude-code' && provider !== 'anthropic-api') {
      fail(`--provider is claude-code or anthropic-api, not ${provider}`)
    }
    const tier = values.tier ?? 'bounded'
    if (tier !== 'bounded' && tier !== 'exploring')
      fail(`--tier is bounded or exploring, not ${tier}`)
    const { questionKinds } = await import('@esper/core')
    const kind = values.kind
    if (kind && !(questionKinds as readonly string[]).includes(kind)) {
      fail(`--kind is one of ${questionKinds.join(', ')}, not ${kind}`)
    }
    const whole = (text: string | undefined, what: string) => {
      if (text === undefined) return undefined
      const n = Number(text)
      if (!Number.isInteger(n) || n < 1) fail(`${what} is a whole number, not ${text}`)
      return n
    }
    const limit = whole(values.limit, '--limit') ?? 40
    const snapshot = whole(values.snapshot, '--snapshot')
    const effort = values.effort
    if (effort && effort !== 'low' && effort !== 'medium' && effort !== 'high') {
      fail(`--effort is low, medium or high, not ${effort}`)
    }
    const { AnthropicApi, ClaudeCode, defaultModels, enrich } = await import('@esper/enrich')
    const { Connection } = await import('@esper/mcp')
    const connection = new Connection(home, name)
    try {
      const view = connection.view(snapshot)
      const base = defaultModels[tier]
      const model = {
        ...base,
        ...(values.model ? { id: values.model } : {}),
        ...(effort ? { effort: effort as 'low' | 'medium' | 'high' } : {}),
      }
      // Runs start in a folder of Esper's home, never in the target (D17).
      const chosen =
        provider === 'claude-code'
          ? new ClaudeCode({
              folder: join(home.dir, 'enrich', name),
              esper: {
                command: process.execPath,
                args: [process.argv[1] as string],
                home: home.dir,
                project: name,
              },
            })
          : new AnthropicApi({ connection })
      const report = await enrich(view, connection.store, chosen, {
        tier,
        model,
        limit,
        ...(kind ? { kinds: [kind as (typeof questionKinds)[number]] } : {}),
        ...(values['dry-run'] ? { dryRun: true } : {}),
        progress: (m) => console.error(m),
      })
      const counts = new Map<string, number>()
      for (const q of report.asked) counts.set(q.kind, (counts.get(q.kind) ?? 0) + 1)
      console.log(
        `${name}: snapshot ${report.snapshot}, ${report.due} questions due in the ${tier} tier`,
      )
      if (values['dry-run']) {
        const calls = tier === 'bounded' ? Math.ceil(report.asked.length / 10) : report.asked.length
        console.log(
          `  would ask    ${report.asked.length} (${[...counts].map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}) in ${calls} ${calls === 1 ? 'call' : 'calls'} to ${model.id} through ${provider}`,
        )
        for (const q of report.asked.slice(0, 20)) console.log(`    ${q.id}`)
        if (report.asked.length > 20) console.log(`    … ${report.asked.length - 20} more`)
        return
      }
      console.log(
        `  asked        ${report.asked.length} in ${report.calls} calls to ${model.id} through ${provider}`,
      )
      console.log(
        `  claims       ${report.accepted} accepted, ${report.rejected.length} rejected, ${report.insufficient} insufficient context, ${report.unanswered.length} unanswered`,
      )
      for (const r of report.rejected.slice(0, 10))
        console.log(`    rejected ${r.question}: ${r.rejection}`)
      if (report.insufficient > 0 && tier === 'bounded') {
        console.log(
          `  next         esper enrich ${name} --tier exploring, for the insufficient ones`,
        )
      }
      if (report.usage && report.usage.calls > 0) {
        const u = report.usage
        console.log(
          `  used         ${u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens} input and ${u.outputTokens} output tokens, $${u.costUsd.toFixed(4)} at list prices`,
        )
      }
      if (report.stopped) console.log(`  stopped      ${report.stopped}`)
    } finally {
      connection.close()
    }
    return
  }

  if (command === 'mcp') {
    const [name] = rest
    if (!name || rest.length > 1) fail('mcp takes one project name')
    // Loaded here: the other commands do not need the MCP SDK.
    const { serve } = await import('@esper/mcp')
    await serve(home, name, {
      readOnly: values['read-only'] ?? false,
      ...(values.trace ? { trace: values.trace } : {}),
    })
    return
  }

  if (command === 'serve') {
    if (rest.length > 0) fail('serve takes no project: it serves them all')
    const port = values.port === undefined ? undefined : Number(values.port)
    if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536)) {
      fail(`--port is a port number, not ${values.port}`)
    }
    const { serve } = await import('@esper/server')
    const server = await serve(home, port === undefined ? {} : { port }).catch((error: unknown) => {
      const code = (error as { code?: string }).code
      if (code === 'EADDRINUSE') fail(`port ${port ?? 7300} is in use; --port picks another`, 1)
      throw error
    })
    console.log(`esper serve on ${server.url}`)
    console.log(
      `  interface    ${server.web ? `${server.url}/?token=${server.token}` : 'not built: pnpm --filter @esper/web build'}`,
    )
    console.log(`  MCP          ${server.url}/mcp/<project>, with Authorization: Bearer <token>`)
    console.log(`  token        ${server.token}  (kept in ${home.dir}/token)`)
    const stop = () => void server.close().then(() => process.exit(0))
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    return
  }

  const projects = await home.projects()
  if (projects.length === 0) return console.log('no projects yet: esper add <path or git URL>')
  const { Store } = await import('@esper/core')
  for (const project of projects) {
    const source = 'path' in project.source ? project.source.path : project.source.url
    console.log(`${project.name}  ${source}${project.kind ? `  (${project.kind})` : ''}`)
    const store = new Store(home.database(project.name))
    try {
      for (const s of store.snapshots()) {
        const version = [s.ref, s.commit?.slice(0, 12), s.dirty ? 'dirty' : undefined].filter(
          Boolean,
        )
        console.log(
          `  ${s.id}  ${s.createdAt}  ${version.join(', ') || 'folder'}  ${[...s.profiles, ...s.analyzers].join(', ')}`,
        )
      }
    } finally {
      store.close()
    }
  }
}

// A refusal or a failure is said in one line; ESPER_DEBUG shows where it came from.
main().catch((error: unknown) => {
  if (process.env.ESPER_DEBUG || !(error instanceof Error)) throw error
  fail(error.message, 1)
})
