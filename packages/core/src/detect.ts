import type { Module } from './language.ts'
import { languages } from './languages.ts'
import { mergeSinks, type Profile, type ResolvedProfile, resolveProfile } from './profile.ts'
import type { TargetFile } from './target.ts'

// Which profile reads a target (D5, D11): the framework itself when one of its modules is the
// framework, an application profile when the target requires or imports the framework. A target
// no profile matches is refused, with the reason, rather than given an empty attack surface.

export type Detection =
  | {
      profile: ResolvedProfile
      // Every module of the target, by its folder, in the language of the profile.
      modules: Module[]
      matched: string[]
    }
  | { refused: string }

const list = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

export function detectProfile(
  files: TargetFile[],
  profiles: Profile[],
  options: { kind?: 'application' | 'framework' } = {},
): Detection {
  const present = languages.filter((l) => files.some((f) => l.source(f.path)))
  if (present.length === 0) {
    const labels = languages.map((l) => l.label)
    return {
      refused: `no supported language: Esper reads ${list(labels)}, and the target has no file in ${labels.length > 1 ? 'any of them' : 'it'}`,
    }
  }
  const read = present.map((language) => {
    const modules = language.modules(files)
    return {
      language,
      modules,
      requires: new Set(modules.flatMap((m) => m.requires)),
      imported: new Set(language.imports(files)),
    }
  })

  const candidates = profiles.filter((p) => {
    const target = read.find((r) => r.language.name === p.language)
    if (!target) return false
    return p.kind === 'framework'
      ? (p.detect.module ?? []).some((m) => target.modules.some((mod) => mod.path === m))
      : (p.detect.dependency ?? []).some((d) => target.requires.has(d)) ||
          (p.detect.import ?? []).some((i) => target.imported.has(i))
  })
  const kind =
    options.kind ?? (candidates.some((p) => p.kind === 'framework') ? 'framework' : 'application')
  let chosen = candidates.filter((p) => p.kind === kind)
  // A profile another matching profile extends is already part of it: chi brings net-http.
  const resolved = chosen.map((p) => resolveProfile(p, profiles))
  chosen = chosen.filter(
    (p) => !resolved.some((r) => r.name !== p.name && r.sources.includes(`${p.name}/${p.kind}`)),
  )

  if (chosen.length === 0) {
    const names = read.flatMap((r) => r.modules.map((m) => m.path)).join(', ') || '(none declared)'
    return {
      refused:
        kind === 'framework'
          ? `no framework profile matches: no framework profile names the modules ${names}`
          : 'no application profile matches the target: it requires and imports none of the frameworks the profiles know',
    }
  }
  const spoken = [...new Set(chosen.map((p) => p.language))]
  if (spoken.length > 1) {
    return {
      refused: `profiles of several languages match (${chosen.map((p) => `${p.name}, ${p.language}`).join('; ')}): a snapshot is read in one language, so add the folder of each part as its own project`,
    }
  }
  const modules = read.find((r) => r.language.name === spoken[0])?.modules ?? []
  const parts = chosen.map((p) => resolveProfile(p, profiles))
  const first = parts[0] as ResolvedProfile
  if (parts.length === 1) return { profile: first, modules, matched: [first.name] }
  // Several frameworks in one application: their rules apply together.
  const request = parts.find((p) => p.request)?.request
  const response = parts.find((p) => p.response)?.response
  const context = parts.find((p) => p.context)?.context
  const merged: ResolvedProfile = {
    name: parts.map((p) => p.name).join('+'),
    kind,
    language: first.language,
    detect: {},
    sources: [...new Set(parts.flatMap((p) => p.sources))],
    ...(request ? { request } : {}),
    ...(response ? { response } : {}),
    ...(context ? { context } : {}),
    adapters: [...new Set(parts.flatMap((p) => p.adapters))],
    handlerTypes: [...new Set(parts.flatMap((p) => p.handlerTypes))],
    routers: parts.flatMap((p) => p.routers),
    surface: {
      exported: parts.some((p) => p.surface.exported),
      handlers: parts.some((p) => p.surface.handlers),
    },
    guards: parts.flatMap((p) => p.guards),
    reads: parts.flatMap((p) => p.reads),
    mutations: parts.flatMap((p) => p.mutations),
    sinks: mergeSinks(parts.map((p) => p.sinks)),
  }
  return { profile: merged, modules, matched: parts.map((p) => p.name) }
}
