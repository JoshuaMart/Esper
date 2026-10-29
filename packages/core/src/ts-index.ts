import { posix } from 'node:path'
import type { Analysis } from './analyzer.ts'
import { addEntries } from './entries.ts'
import type { Graph } from './graph.ts'
import type { IndexStats, Language, Module } from './language.ts'
import { loadLibrary } from './library.ts'
import { mergeMembers, type ResolvedProfile } from './profile.ts'
import type { TargetFile } from './target.ts'
import { isTsSource, parametersOf, TsProgram, type TsType, typeSymbol } from './ts.ts'
import { TsFileRoutes } from './ts-files.ts'
import { isConfig, isManifest, modulesOf } from './ts-modules.ts'
import { TsRouteInterpreter } from './ts-routes.ts'
import { declFacts, extractReads } from './ts-signals.ts'

// A TypeScript or JavaScript target indexed with a profile: the call graph, the entry points with
// their chains and handlers, and what each declaration and entry point reads from the request.

export async function indexTs(
  files: TargetFile[],
  options: { modules?: Module[]; profile: ResolvedProfile; analysis?: Analysis },
): Promise<{ graph: Graph; stats: IndexStats }> {
  const profile = options.profile
  const library = await loadLibrary('typescript')
  // What the profile says functions outside the target return, beside the library's.
  const returns = new Map([...library.returns, ...Object.entries(profile.returns)])
  const program = await TsProgram.load(files, {
    library: { ...library, returns },
    aliases: profile.aliases,
    ...(options.analysis ? { analysis: options.analysis } : {}),
  })
  try {
    // What a handler receives, when its code does not say: a type outside the target for an
    // application (`hono#Context`), or the framework's own for the framework itself.
    const typeFor = (symbol: string) => {
      const at = symbol.indexOf('#')
      return contextType(program, symbol.slice(0, at), symbol.slice(at + 1))
    }
    const context = profile.context ? typeFor(profile.context) : undefined
    program.handlerTypes = new Set(profile.handlerTypes)
    program.contextType = context
    program.members = new Map(
      Object.entries(mergeMembers([Object.fromEntries(library.members), profile.members])),
    )
    // Routes first: they say which functions are handlers, and so what their first parameter is.
    const interpreter = new TsRouteInterpreter(program, profile, context)
    const routes = profile.kind === 'application' ? interpreter.routes() : []
    if (profile.kind === 'application' && profile.files) {
      const tree = profile.files
      routes.push(...new TsFileRoutes(program, { ...profile, files: tree }, typeFor).routes())
    }
    const { graph, stats } = program.callGraph()
    const reads = extractReads(program, profile)
    const signals = declFacts(program, profile, library, reads)
    graph.facts.push(...reads, ...signals)
    const handlers =
      profile.kind === 'framework' ? handlerDecls(program, profile) : new Set<string>()
    const added = addEntries(graph, {
      profile,
      routes,
      facts: [...reads, ...signals],
      // Each exported function, method and function an exported object holds; and each function
      // that takes the request or the context, exported or not.
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

// The context type a profile names: one of the target's own when the target is that package (a
// framework's `Context`), otherwise the symbol outside it.
function contextType(program: TsProgram, module: string, name: string): TsType {
  for (const file of program.files) {
    if (file.package?.name !== module) continue
    const node = file.types.get(name)
    if (node && file.exports.has(name)) {
      const kind =
        node.type === 'interface_declaration' || node.type === 'type_alias_declaration'
          ? 'interface'
          : 'class'
      return { kind, file, node, name }
    }
  }
  return { kind: 'external', module, name }
}

// The functions and methods that take the request or the context: a framework's handlers.
function handlerDecls(program: TsProgram, profile: ResolvedProfile): Set<string> {
  const wanted = new Set([profile.request, profile.context].filter((t): t is string => !!t))
  const found = new Set<string>()
  for (const file of program.files) {
    for (const decl of file.decls) {
      if (decl.kind === 'literal' || decl.kind === 'class') continue
      const params = parametersOf(decl.node)
      const typed = params.some(
        (p) => p.type && wanted.has(typeSymbol(program.typeOfAnnotation(p.type, file)) ?? ''),
      )
      if (typed) found.add(decl.ref)
    }
  }
  return found
}

const tests = /(\.|_)(test|spec|bench)\.[cm]?[jt]sx?$/

// TypeScript and JavaScript, as the shared machinery reads them: their source files, and the
// `package.json` and `tsconfig.json` that say how imports resolve.
export const typescript: Language = {
  name: 'typescript',
  label: 'TypeScript and JavaScript',
  ecosystem: 'npm',
  reads: (path) => isTsSource(path) || isManifest(path) || isConfig(path),
  source: isTsSource,
  test: (path) => tests.test(posix.basename(path)),
  modules: (files) => modulesOf(files),
  imports: (files) => {
    const found = new Set<string>()
    for (const file of files) {
      if (!isTsSource(file.path)) continue
      for (const match of file.source.matchAll(
        /^[ \t]*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|^[ \t]*import\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/gm,
      )) {
        const spec = match[1] ?? match[2] ?? match[3]
        if (spec) found.add(spec)
      }
    }
    return [...found].sort()
  },
  index: (files, options) =>
    indexTs(files, {
      modules: options.modules,
      profile: options.profile,
      ...(options.analysis ? { analysis: options.analysis } : {}),
    }),
}
