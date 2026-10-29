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

export type MethodRole =
  | 'route'
  | 'use'
  | 'with'
  | 'group'
  | 'subrouter'
  | 'mount'
  | 'prefix'
  | 'routes'
  | 'include'
export type ArgRole =
  | 'method'
  | 'path'
  | 'handler'
  | 'callback'
  | 'chain'
  | 'config'
  | 'routes'
  | 'middleware'
  | 'other'
export type PatternSyntax = 'braces' | 'servemux' | 'colon' | 'brackets'

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
  // The role of each keyword argument, by its keyword (`prefix: path`), where a language has them.
  keywords?: Record<string, ArgRole>
  // What the handler receives first, when its code does not say.
  receives?: string
  // The handler's parameters are read by the profile's `parameters` rules, and declare its
  // dependencies.
  parameters?: boolean
}

// A call that builds a route, or a mount, given to a router as a value (`Route('/', endpoint)`).
export interface Declare {
  call: string
  does: 'route' | 'mount'
  method?: string
  args?: ArgRole[]
  keywords?: Record<string, ArgRole>
  receives?: string
  parameters?: boolean
}

// How the parameters of a handler and of its dependencies are read, where a framework declares
// what a request gives a function by its parameters.
export interface ParametersSpec {
  // Calls whose argument is a dependency, run before the function: `Depends(get_user)`.
  depends: string[]
  // Calls that say what a parameter reads, by its default or its annotation's metadata.
  markers: { call: string; read: ReadKind; hyphens?: boolean }[]
  // The keyword that names what a marker reads, when not the parameter's name.
  alias?: string
  // Types a parameter is given rather than read: the request, a response, a background task.
  given?: string[]
  // Types read from the body as a whole: models.
  models?: string[]
  // Types read from a form: uploaded files.
  files?: string[]
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
  // The role of each keyword of the call that creates it (`prefix: path`).
  construct?: Record<string, ArgRole>
  // Attributes of a router that are the router itself (`app.router`).
  self?: string[]
  registers?: { import: string; routes: { pattern: string; handler: string }[] }[]
}

export type ReadRule =
  | {
      read: ReadKind
      chain: string
      on?: string
      by?: Partial<Record<string, ReadKind>>
      // Names that are not read from the request: what the server sets in an ASGI scope (`type`).
      except?: string[]
    }
  // A call's `request` is the argument that is the request, by its position, or by its keyword
  // where a language has them: the call reads only when it is given (`Headers(scope=…)`).
  | { read: ReadKind; call: string; request?: number | string; name?: number }

export type SinkKind = 'sql' | 'process' | 'file' | 'fetch' | 'redirect' | 'unescaped'

export type GuardKind =
  | 'authn'
  | 'authz-role'
  | 'authz-owner'
  | 'csrf'
  | 'rate-limit'
  | 'validation'

// A guard is a call the profile names (`basicAuth`), or a check: a function that refuses the
// request, by a call `refusals` lists, when a value read from it is missing (`context.user`).
// A guard is also a dependency that refuses with a status (`raise HTTPException(401)`). A call
// guard built with an argument `unless` names (`auto_error=False`) lets every request through.
export type GuardRule =
  | { call: string; kind: GuardKind; unless?: Record<string, string> }
  | { check: string; kind: GuardKind }
  | { status: number; kind: GuardKind }

// An export of a file of the route tree, or of the package, and what it declares.
export interface FileExport {
  name: string
  // `route`: a route for the folder; `each`: a route for each property of the object exported,
  // at the folder's path and `path`, the property named `default` at the folder's own; `layout`:
  // a chain member of the routes in its folder and below that take `layouts`; `use`, for hooks:
  // a chain member of every route.
  does: 'route' | 'each' | 'layout' | 'use'
  method?: string
  path?: string
  default?: string
  layouts?: boolean
  // What its function receives first, when not the profile's `context`.
  receives?: string
}

export interface FilesSpec {
  // The folder of the route tree, from the root of the package that uses the framework.
  routes: string
  pattern: PatternSyntax
  modules: { name: string; exports: FileExport[] }[]
  // Files of the package, without their extension, whose exports apply to every route, in order.
  hooks?: { file: string; exports: FileExport[] }[]
  // Functions whose arguments are a chain, in order (`sequence(a, b)`).
  compose?: string[]
  // Where a parameter's matcher is: `{matcher}` stands for its name.
  matchers?: { file: string; name: string; property?: string; through?: string[] }[]
  // Modules whose exports, built by these calls, are routes of their own at `path`, where
  // `$file` is the module's path and `$name` the export's.
  remote?: { suffix: string; path: string; calls: { call: string; method: string }[] }
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
  files?: FilesSpec
  aliases?: Record<string, string>
  members?: Record<string, Record<string, string>>
  returns?: Record<string, string>
  refusals?: string[]
  surface?: { exported?: boolean; handlers?: boolean; except?: string[] }
  guards?: GuardRule[]
  reads?: ReadRule[]
  mutations?: { chain: string; on?: string }[]
  sinks?: Partial<Record<SinkKind, string[]>>
  declares?: Declare[]
  middleware?: { wrap?: string[]; classes?: Record<string, string>; forwards?: string[] }
  // How exceptions say their status: the router methods that register an exception handler
  // (`exception_handler`), the keywords that hold a status (`status_code`), and a pattern of a
  // constant that names one, its status the first group (`HTTP_(\d{3})_`).
  exceptions?: { handlers?: string[]; status?: string[]; named?: string }
  parameters?: ParametersSpec
  // Symbols outside the target that are another's, re-exported: `fastapi#Request` is
  // `starlette.requests#Request`.
  reexports?: Record<string, string>
  // The bases of types outside the target, which the index cannot read: rules on a base apply to
  // its subclasses (`starlette.requests#Request` is an `HTTPConnection`).
  bases?: Record<string, string[]>
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
  // The nearest profile's route tree, if one declares it.
  files?: FilesSpec
  // Import specifiers mapped to a folder of the package (`$lib` to `src/lib`).
  aliases: Record<string, string>
  // The members of types outside the target, and what functions outside it return.
  members: Record<string, Record<string, string>>
  returns: Record<string, string>
  // Calls that answer the request with a refusal: an error, a redirect, a failure.
  refusals: string[]
  surface: { exported: boolean; handlers: boolean; except: string[] }
  guards: GuardRule[]
  reads: ReadRule[]
  mutations: { chain: string; on?: string }[]
  sinks: Partial<Record<SinkKind, string[]>>
  declares: Declare[]
  middleware: { wrap: string[]; classes: Record<string, string>; forwards: string[] }
  exceptions: { handlers: string[]; status: string[]; named?: string }
  parameters?: ParametersSpec
  reexports: Record<string, string>
  bases: Record<string, string[]>
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

// Adds up the members several profiles state, type by type.
export function mergeMembers(
  all: Record<string, Record<string, string>>[],
): Record<string, Record<string, string>> {
  const merged: Record<string, Record<string, string>> = {}
  for (const members of all) {
    for (const [type, properties] of Object.entries(members))
      merged[type] = { ...merged[type], ...properties }
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
  const files = [...chain].reverse().find((p) => p.files)?.files
  const parameters = [...chain].reverse().find((p) => p.parameters)?.parameters
  const named = [...chain].reverse().find((p) => p.exceptions?.named)?.exceptions?.named
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
    ...(files ? { files } : {}),
    aliases: Object.assign({}, ...chain.map((p) => p.aliases ?? {})),
    members: mergeMembers(chain.map((p) => p.members ?? {})),
    returns: Object.assign({}, ...chain.map((p) => p.returns ?? {})),
    refusals: [...new Set(chain.flatMap((p) => p.refusals ?? []))],
    surface: {
      exported: profile.surface?.exported ?? false,
      handlers: profile.surface?.handlers ?? false,
      except: profile.surface?.except ?? [],
    },
    guards: chain.flatMap((p) => p.guards ?? []),
    reads: chain.flatMap((p) => p.reads ?? []),
    mutations: chain.flatMap((p) => p.mutations ?? []),
    sinks: mergeSinks(chain.map((p) => p.sinks ?? {})),
    declares: chain.flatMap((p) => p.declares ?? []),
    middleware: {
      wrap: chain.flatMap((p) => p.middleware?.wrap ?? []),
      classes: Object.assign({}, ...chain.map((p) => p.middleware?.classes ?? {})),
      forwards: [...new Set(chain.flatMap((p) => p.middleware?.forwards ?? []))],
    },
    exceptions: {
      handlers: [...new Set(chain.flatMap((p) => p.exceptions?.handlers ?? []))],
      status: [...new Set(chain.flatMap((p) => p.exceptions?.status ?? []))],
      ...(named ? { named } : {}),
    },
    ...(parameters ? { parameters } : {}),
    reexports: Object.assign({}, ...chain.map((p) => p.reexports ?? {})),
    bases: Object.assign({}, ...chain.map((p) => p.bases ?? {})),
  }
}
