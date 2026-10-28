import { type Profile, type ResolvedProfile, resolveProfile } from './profile.ts'
import { languageOf, type TargetFile } from './target.ts'

// Which profile reads a target (D5, D11): the framework itself when its module is the target,
// an application profile when the target requires or imports the framework. A target no profile
// matches is refused, with the reason, rather than given an empty attack surface.

export interface GoModule {
  path?: string
  requires: string[]
}

export function parseGoMod(text: string): GoModule {
  const path = /^module\s+(\S+)/m.exec(text)?.[1]
  const requires: string[] = []
  for (const block of text.matchAll(/^require\s*\(([^)]*)\)/gm)) {
    for (const line of (block[1] ?? '').split('\n')) {
      const dep = /^\s*(\S+)\s+v\S+/.exec(line)?.[1]
      if (dep) requires.push(dep)
    }
  }
  for (const single of text.matchAll(/^require\s+(\S+)\s+v\S+/gm))
    if (single[1]) requires.push(single[1])
  return { ...(path ? { path } : {}), requires }
}

export type Detection =
  | { profile: ResolvedProfile; module: GoModule; matched: string[] }
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
  const goMod = files.find((f) => f.path === 'go.mod')
  const module = goMod ? parseGoMod(goMod.source) : { requires: [] }
  const imports = (path: string) => files.some((f) => f.source.includes(`"${path}"`))

  const matches = (p: Profile) =>
    p.kind === 'framework'
      ? (p.detect.module ?? []).some((m) => m === module.path)
      : (p.detect.dependency ?? []).some((d) => module.requires.includes(d)) ||
        (p.detect.import ?? []).some(imports)
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
    const what = kind === 'framework' ? `module ${module.path ?? '(no go.mod)'}` : 'the target'
    return {
      refused: `no ${kind} profile matches ${what}: ${
        kind === 'framework'
          ? 'no framework profile names this module'
          : 'it requires and imports none of the frameworks the profiles know'
      }`,
    }
  }
  const parts = chosen.map((p) => resolveProfile(p, profiles))
  const [first] = parts
  if (parts.length === 1 && first) return { profile: first, module, matched: [first.name] }
  // Several frameworks in one application: their rules apply together.
  const merged: ResolvedProfile = {
    name: parts.map((p) => p.name).join('+'),
    kind,
    language: 'go',
    detect: {},
    sources: [...new Set(parts.flatMap((p) => p.sources))],
    ...(parts.find((p) => p.request)?.request
      ? { request: parts.find((p) => p.request)?.request as string }
      : {}),
    ...(parts.find((p) => p.response)?.response
      ? { response: parts.find((p) => p.response)?.response as string }
      : {}),
    adapters: [...new Set(parts.flatMap((p) => p.adapters))],
    routers: parts.flatMap((p) => p.routers),
    surface: {
      exported: parts.some((p) => p.surface.exported),
      handlers: parts.some((p) => p.surface.handlers),
    },
    guards: parts.flatMap((p) => p.guards),
    reads: parts.flatMap((p) => p.reads),
  }
  return { profile: merged, module, matched: parts.map((p) => p.name) }
}
