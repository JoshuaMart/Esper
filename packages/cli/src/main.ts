#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { Home } from '@esper/core'
import pkg from '../package.json' with { type: 'json' }

const usage = `Usage: esper <command> [options]

Commands:
  add <path or git URL>   add a project; --name <name>, --kind application|framework
  index <project>         index a snapshot of it; --ref <git ref> reads that ref, not the checkout;
                          --force indexes a commit already indexed
  list                    the projects and their snapshots
  mcp <project>           serve the project over MCP on stdio; --read-only exposes no tool
                          that writes

Options:
  --version  print the version
  --help     print this help

Esper keeps its projects in $ESPER_HOME, or ~/.esper.`

// Each command's options. Unknown options are refused, not ignored: a mistyped `--read-only`
// must not start a server that writes.
const options = {
  name: { type: 'string' },
  kind: { type: 'string' },
  ref: { type: 'string' },
  force: { type: 'boolean' },
  'read-only': { type: 'boolean' },
  version: { type: 'boolean' },
  help: { type: 'boolean' },
} as const
const commands: Record<string, (keyof typeof options)[]> = {
  add: ['name', 'kind'],
  index: ['ref', 'force'],
  list: [],
  mcp: ['read-only'],
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
    const { id, snapshot, stats, profiles, unchanged, notes } = await home.index(name, {
      ...(ref ? { ref } : {}),
      ...(values.force ? { force: true } : {}),
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
        `${label} already indexes this commit with these profiles; --force indexes it again`,
      )
      if (states.length > 0) console.log(noteLine)
      return
    }
    const edges = stats.resolved + stats.guessed
    console.log(label)
    console.log(`  profiles     ${profiles.join(', ')}`)
    console.log(
      `  files        ${snapshot.files.filter((f) => f.path.endsWith('.go')).length} read`,
    )
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
    console.log(`  reads        ${stats.reads}, signals on entry points ${stats.signals}`)
    console.log(noteLine)
    return
  }

  if (command === 'mcp') {
    const [name] = rest
    if (!name || rest.length > 1) fail('mcp takes one project name')
    // Loaded here: the other commands do not need the MCP SDK.
    const { serve } = await import('@esper/mcp')
    await serve(home, name, { readOnly: values['read-only'] ?? false })
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
          `  ${s.id}  ${s.createdAt}  ${version.join(', ') || 'folder'}  ${s.profiles.join(', ')}`,
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
