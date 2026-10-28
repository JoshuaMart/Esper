import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { parse as parseYaml } from 'yaml'

// Framework profiles (D10): YAML files validated against `schemas/profile.schema.json` before
// any is used, so that a broken profile is refused rather than producing an empty attack surface.

export type ReadKind =
  | 'header'
  | 'query'
  | 'path'
  | 'body'
  | 'cookie'
  | 'form'
  | 'host'
  | 'remoteaddr'
  | 'method'
  | 'context'

export type MethodRole = 'route' | 'use' | 'with' | 'group' | 'subrouter' | 'mount' | 'prefix'
export type ArgRole = 'method' | 'path' | 'handler' | 'callback' | 'chain' | 'config' | 'other'
export type PatternSyntax = 'braces' | 'servemux' | 'colon'

export interface RouterMethod {
  name: string
  does: MethodRole
  method?: string
  args?: ArgRole[]
  // For a `config` argument: the role of each of its properties (`{ method, path, middleware }`).
  config?: Record<string, 'method' | 'path' | 'chain'>
  // Functions that return the configuration they are given (`createRoute`), seen through.
  through?: string[]
  // How this method's paths are written, when not as the router's are.
  pattern?: PatternSyntax
}

export interface RouterSpec {
  types: string[]
  create?: string[]
  default?: string[]
  pattern: PatternSyntax
  // Middleware applies to the routes registered after it, whose path its own matches; otherwise
  // to every route of the router.
  ordered?: boolean
  // Its methods return the router, so that registrations chain.
  chained?: boolean
  methods: RouterMethod[]
  registers?: { import: string; routes: { pattern: string; handler: string }[] }[]
}

export type ReadRule =
  | { read: ReadKind; chain: string; on?: string; by?: Partial<Record<string, ReadKind>> }
  | { read: ReadKind; call: string; request?: number; name?: number }

export type SinkKind = 'sql' | 'process' | 'file' | 'fetch' | 'redirect' | 'unescaped'

export type GuardKind =
  | 'authn'
  | 'authz-role'
  | 'authz-owner'
  | 'csrf'
  | 'rate-limit'
  | 'validation'

export interface GuardRule {
  call: string
  kind: GuardKind
}

export interface Profile {
  name: string
  kind: 'application' | 'framework'
  language: string
  description?: string
  extends?: string[]
  detect: { dependency?: string[]; module?: string[]; import?: string[] }
  request?: string
  response?: string
  context?: string
  handlers?: { adapters?: string[]; types?: string[] }
  routers?: RouterSpec[]
  surface?: { exported?: boolean; handlers?: boolean }
  guards?: GuardRule[]
  reads?: ReadRule[]
  mutations?: { chain: string; on?: string }[]
  sinks?: Partial<Record<SinkKind, string[]>>
}

// A profile with what its `extends` bring: the request type, adapters, routers and reads.
export interface ResolvedProfile {
  name: string
  kind: Profile['kind']
  language: Profile['language']
  detect: Profile['detect']
  // The profile and every profile it extends, as `<name>/<kind>`.
  sources: string[]
  request?: string
  response?: string
  // What a handler or a middleware receives first, when its code does not say.
  context?: string
  adapters: string[]
  // Types of functions that are handlers or middleware: one typed so receives the context.
  handlerTypes: string[]
  routers: RouterSpec[]
  surface: { exported: boolean; handlers: boolean }
  guards: GuardRule[]
  reads: ReadRule[]
  mutations: { chain: string; on?: string }[]
  sinks: Partial<Record<SinkKind, string[]>>
}

// Adds up the sinks of several profiles.
export function mergeSinks(
  all: Partial<Record<SinkKind, string[]>>[],
): Partial<Record<SinkKind, string[]>> {
  const merged: Partial<Record<SinkKind, string[]>> = {}
  for (const sinks of all) {
    for (const [kind, symbols] of Object.entries(sinks) as [SinkKind, string[]][]) {
      merged[kind] = [...new Set([...(merged[kind] ?? []), ...symbols])]
    }
  }
  return merged
}

export class ProfileError extends Error {}

const schemaUrl = new URL('../../../schemas/profile.schema.json', import.meta.url)
let validator: Promise<(value: unknown) => string[]> | undefined

function validate(): Promise<(value: unknown) => string[]> {
  validator ??= readFile(schemaUrl, 'utf8').then((schema) => {
    const check = new Ajv2020({ allErrors: true }).compile(JSON.parse(schema))
    return (value: unknown) =>
      check(value)
        ? []
        : (check.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`)
  })
  return validator
}

// Parses and validates one profile.
export async function parseProfile(text: string, origin: string): Promise<Profile> {
  let value: unknown
  try {
    value = parseYaml(text)
  } catch (error) {
    throw new ProfileError(`${origin}: not valid YAML: ${(error as Error).message}`)
  }
  const errors = (await validate())(value)
  if (errors.length > 0) throw new ProfileError(`${origin}: ${errors.join('; ')}`)
  return value as Profile
}

// Loads every `<framework>/<kind>.yaml` under a folder of profiles.
export async function loadProfiles(dir: string): Promise<Profile[]> {
  const profiles: Profile[] = []
  for (const framework of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (!framework.isDirectory()) continue
    for (const kind of ['application', 'framework']) {
      const path = join(dir, framework.name, `${kind}.yaml`)
      const text = await readFile(path, 'utf8').catch(() => undefined)
      if (text === undefined) continue
      const profile = await parseProfile(text, path)
      if (profile.kind !== kind) throw new ProfileError(`${path}: declares kind ${profile.kind}`)
      profiles.push(profile)
    }
  }
  return profiles
}

// Resolves a profile's `extends`, by name.
export function resolveProfile(profile: Profile, all: Profile[]): ResolvedProfile {
  const chain: Profile[] = []
  const id = (p: Profile) => `${p.name}/${p.kind}`
  const visit = (p: Profile, path: string[]) => {
    if (path.includes(id(p))) {
      throw new ProfileError(`${p.name}: extends itself through ${[...path, id(p)].join(' → ')}`)
    }
    for (const name of p.extends ?? []) {
      // A profile of the same kind, or else of the other: a framework profile can take the
      // request type and its reads from an application profile, its own framework's included.
      const parent =
        all.find((other) => other !== p && other.name === name && other.kind === p.kind) ??
        all.find((other) => other !== p && other.name === name)
      if (!parent) throw new ProfileError(`${p.name}: extends unknown profile ${name}`)
      visit(parent, [...path, id(p)])
    }
    if (!chain.includes(p)) chain.push(p)
  }
  visit(profile, [])
  // The nearest profile's request type wins; lists add up, the extended profiles' first.
  const request = [...chain].reverse().find((p) => p.request)?.request
  const response = [...chain].reverse().find((p) => p.response)?.response
  const context = [...chain].reverse().find((p) => p.context)?.context
  return {
    name: profile.name,
    kind: profile.kind,
    language: profile.language,
    detect: profile.detect,
    sources: chain.map((p) => `${p.name}/${p.kind}`),
    ...(request ? { request } : {}),
    ...(response ? { response } : {}),
    ...(context ? { context } : {}),
    adapters: chain.flatMap((p) => p.handlers?.adapters ?? []),
    handlerTypes: chain.flatMap((p) => p.handlers?.types ?? []),
    routers: chain.flatMap((p) => p.routers ?? []),
    surface: {
      exported: profile.surface?.exported ?? false,
      handlers: profile.surface?.handlers ?? false,
    },
    guards: chain.flatMap((p) => p.guards ?? []),
    reads: chain.flatMap((p) => p.reads ?? []),
    mutations: chain.flatMap((p) => p.mutations ?? []),
    sinks: mergeSinks(chain.map((p) => p.sinks ?? {})),
  }
}
