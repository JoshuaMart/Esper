import { posix } from 'node:path'
import type { GoModuleRoot } from './go.ts'
import { type Profile, type ResolvedProfile, resolveProfile } from './profile.ts'
import { languageOf, type TargetFile } from './target.ts'

// Which profile reads a target (D5, D11): the framework itself when one of its modules is the
// framework, an application profile when the target requires or imports the framework. A target
// no profile matches is refused, with the reason, rather than given an empty attack surface.

export interface GoModule {
  path?: string
  // Direct requirements only: an `// indirect` one is not something the code uses.
  requires: string[]
}

export function parseGoMod(text: string): GoModule {
  const path = /^module\s+(\S+)/m.exec(text)?.[1]
  const requires: string[] = []
  const requirement = (line: string) => {
    if (/\/\/\s*indirect\b/.test(line)) return
    const dep = /^\s*(\S+)\s+v\S+/.exec(line)?.[1]
    if (dep) requires.push(dep)
  }
  for (const block of text.matchAll(/^require\s*\(([^)]*)\)/gm)) {
    for (const line of (block[1] ?? '').split('\n')) requirement(line)
  }
  for (const single of text.matchAll(/^require\s+(\S+\s+v\S+.*)$/gm)) requirement(single[1] ?? '')
  return { ...(path ? { path } : {}), requires }
}

// The import paths a Go file declares, read from its import declarations only: a path in a
// comment or a string is not an import.
export function goImports(source: string): string[] {
  const found: string[] = []
  const spec = /^\s*(?:[\w.]+\s+)?"([^"]+)"/
  for (const block of source.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) {
    for (const line of (block[1] ?? '').split('\n')) {
      const path = spec.exec(line.replace(/\/\/.*$/, ''))?.[1]
      if (path) found.push(path)
    }
  }
  for (const single of source.matchAll(/^import\s+((?:[\w.]+\s+)?"[^"]+")/gm)) {
    const path = spec.exec(single[1] ?? '')?.[1]
    if (path) found.push(path)
  }
  return found
}

export type Detection =
  | {
      profile: ResolvedProfile
      // Every module of the target, by the folder its `go.mod` is in.
      modules: (GoModuleRoot & GoModule)[]
      matched: string[]
    }
  | { refused: string }

export function detectProfile(
  files: TargetFile[],
  profiles: Profile[],
  options: { kind?: 'application' | 'framework' } = {},
): Detection {
  const languages = new Set(files.map((f) => languageOf(f.path)).filter(Boolean))
  if (!languages.has('go')) {
    return { refused: 'no supported language: Esper reads Go, and the target has no Go file' }
  }
  const modules = files
    .filter((f) => posix.basename(f.path) === 'go.mod')
    .flatMap((f) => {
      const mod = parseGoMod(f.source)
      return mod.path ? [{ ...mod, path: mod.path, dir: posix.dirname(f.path) }] : []
    })
  const requires = new Set(modules.flatMap((m) => m.requires))
  const imported = new Set(
    files.filter((f) => f.path.endsWith('.go')).flatMap((f) => goImports(f.source)),
  )

  const matches = (p: Profile) =>
    p.kind === 'framework'
      ? (p.detect.module ?? []).some((m) => modules.some((mod) => mod.path === m))
      : (p.detect.dependency ?? []).some((d) => requires.has(d)) ||
        (p.detect.import ?? []).some((i) => imported.has(i))
  const candidates = profiles.filter((p) => p.language === 'go' && matches(p))
  const kind =
    options.kind ?? (candidates.some((p) => p.kind === 'framework') ? 'framework' : 'application')
  let chosen = candidates.filter((p) => p.kind === kind)
  // A profile another matching profile extends is already part of it: chi brings net-http.
  const resolved = chosen.map((p) => resolveProfile(p, profiles))
  chosen = chosen.filter(
    (p) => !resolved.some((r) => r.name !== p.name && r.sources.includes(`${p.name}/${p.kind}`)),
  )

  if (chosen.length === 0) {
    const names = modules.map((m) => m.path).join(', ') || '(no go.mod)'
    return {
      refused:
        kind === 'framework'
          ? `no framework profile matches: no framework profile names the modules ${names}`
          : 'no application profile matches the target: it requires and imports none of the frameworks the profiles know',
    }
  }
  const parts = chosen.map((p) => resolveProfile(p, profiles))
  const [first] = parts
  if (parts.length === 1 && first) return { profile: first, modules, matched: [first.name] }
  // Several frameworks in one application: their rules apply together.
  const request = parts.find((p) => p.request)?.request
  const response = parts.find((p) => p.response)?.response
  const merged: ResolvedProfile = {
    name: parts.map((p) => p.name).join('+'),
    kind,
    language: 'go',
    detect: {},
    sources: [...new Set(parts.flatMap((p) => p.sources))],
    ...(request ? { request } : {}),
    ...(response ? { response } : {}),
    adapters: [...new Set(parts.flatMap((p) => p.adapters))],
    routers: parts.flatMap((p) => p.routers),
    surface: {
      exported: parts.some((p) => p.surface.exported),
      handlers: parts.some((p) => p.surface.handlers),
    },
    guards: parts.flatMap((p) => p.guards),
    reads: parts.flatMap((p) => p.reads),
  }
  return { profile: merged, modules, matched: parts.map((p) => p.name) }
}
