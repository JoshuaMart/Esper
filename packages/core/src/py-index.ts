import { posix } from 'node:path'
import type { Analysis } from './analyzer.ts'
import { addEntries } from './entries.ts'
import type { Graph } from './graph.ts'
import type { IndexStats, Language, Module } from './language.ts'
import { loadLibrary } from './library.ts'
import { mergeMembers, type ResolvedProfile } from './profile.ts'
import { isPySource, PyProgram, parametersOf } from './py.ts'
import { isManifest, modulesOf } from './py-modules.ts'
import { PyRouteInterpreter } from './py-routes.ts'
import { declFacts, extractReads } from './py-signals.ts'
import type { TargetFile } from './target.ts'

// A Python target indexed with a profile: the call graph, the entry points with their chains and
// handlers, and what each declaration and entry point reads from the request.

export async function indexPy(
  files: TargetFile[],
  options: { modules?: Module[]; profile: ResolvedProfile; analysis?: Analysis },
): Promise<{ graph: Graph; stats: IndexStats }> {
  const profile = options.profile
  const library = await loadLibrary('python')
  const returns = new Map([...library.returns, ...Object.entries(profile.returns)])
  const program = await PyProgram.load(files, {
    library: { ...library, returns },
    ...(options.analysis ? { analysis: options.analysis } : {}),
  })
  try {
    program.reexports = new Map(Object.entries(profile.reexports))
    program.externalBases = new Map(Object.entries(profile.bases))
    program.members = new Map(
      Object.entries(mergeMembers([Object.fromEntries(library.members), profile.members])),
    )
    // Routes first: they say which functions are handlers and dependencies, and what they receive.
    const found =
      profile.kind === 'application'
        ? new PyRouteInterpreter(program, profile).routes()
        : { routes: [], parameterized: new Map<string, Set<string>>() }
    const { graph, stats } = program.callGraph()
    const reads = extractReads(program, profile, found.parameterized)
    const dependencies = new Set(
      found.routes.flatMap((r) => r.chain.flatMap((m) => m.targets.map((t) => t.ref))),
    )
    const signals = declFacts(program, profile, library, reads, dependencies)
    graph.facts.push(...reads, ...signals)
    const handlers =
      profile.kind === 'framework' ? handlerDecls(program, profile) : new Set<string>()
    const added = addEntries(graph, {
      profile,
      routes: found.routes,
      facts: [...reads, ...signals],
      surfaced: (node) =>
        !node.data?.class &&
        ((profile.surface.exported && node.data?.exported === true) ||
          (profile.surface.handlers && handlers.has(node.ref))),
    })
    return {
      graph,
      stats: {
        ...stats,
        files: program.files.length,
        entries: added.entries,
        reads: reads.length,
        signals: added.signals,
      },
    }
  } finally {
    program.dispose()
  }
}

// The functions and methods that take the request, or what stands for it: a framework's handlers.
function handlerDecls(program: PyProgram, profile: ResolvedProfile): Set<string> {
  const wanted = new Set(
    [profile.request, profile.context, ...profile.handlerTypes].filter((t): t is string => !!t),
  )
  const found = new Set<string>()
  for (const file of program.files) {
    for (const decl of file.decls) {
      if (decl.kind === 'literal' || decl.kind === 'class') continue
      const typed = parametersOf(decl.node).some(
        (p) =>
          p.type &&
          program.symbolsOf(program.typeOfAnnotation(p.type, file)).some((s) => wanted.has(s)),
      )
      if (typed) found.add(decl.ref)
    }
  }
  return found
}

const tests = /^(test_.*|.*_test|conftest|tests)\.py$/

// Folders that are not the code that serves requests, beside those every language skips.
const skipped: Record<string, string> = {
  'site-packages': 'vendored',
  venv: 'vendored',
  __pycache__: 'generated',
  docs_src: 'examples',
  migrations: 'migrations',
  alembic: 'migrations',
}

// Python, as the shared machinery reads it: its source files, and the `pyproject.toml` and
// requirements files that say what a project depends on.
export const python: Language = {
  name: 'python',
  label: 'Python',
  ecosystem: 'PyPI',
  reads: (path) => isPySource(path) || isManifest(path),
  source: isPySource,
  test: (path) => isPySource(path) && tests.test(posix.basename(path)),
  skip: (dir) => skipped[dir],
  modules: (files) => modulesOf(files),
  imports: (files) => {
    const found = new Set<string>()
    for (const file of files) {
      if (!isPySource(file.path)) continue
      for (const match of file.source.matchAll(
        /^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import\b|import[ \t]+([\w., \t]+))/gm,
      )) {
        const modules = match[1]
          ? [match[1]]
          : (match[2] ?? '').split(',').map((m) => m.trim().split(/\s+/)[0] ?? '')
        for (const module of modules) {
          const parts = module.split('.')
          for (let i = 1; i <= parts.length; i++)
            if (parts[0]) found.add(parts.slice(0, i).join('.'))
        }
      }
    }
    return [...found].sort()
  },
  index: (files, options) =>
    indexPy(files, {
      modules: options.modules,
      profile: options.profile,
      ...(options.analysis ? { analysis: options.analysis } : {}),
    }),
}
