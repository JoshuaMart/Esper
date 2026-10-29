import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import pkg from '../package.json' with { type: 'json' }
import {
  Advisories,
  type AdvisoryReport,
  type AdvisorySource,
  importAdvisories,
  linkAdvisory,
  osvSource,
  type Package,
  snapshotVersion,
  stateOn,
} from './advisories.ts'
import {
  type Analysis,
  type Analyzer,
  analyzerSource,
  importAnalysis,
  loadAnalyzers,
} from './analyzer.ts'
import { detectProfile } from './detect.ts'
import { type AnalyzerRunner, dockerAvailable, dockerRunner } from './docker.ts'
import { EsperError, NotFound } from './errors.ts'
import type { IndexStats, Language, Module } from './language.ts'
import { languageNamed } from './languages.ts'
import { type AnchorState, Notes } from './notes.ts'
import { loadProfiles, type ResolvedProfile } from './profile.ts'
import { Store } from './store.ts'
import {
  cloneTarget,
  isGitRepository,
  materialise,
  readFolder,
  readRef,
  type TargetFile,
  type TargetSnapshot,
} from './target.ts'

// Esper's home (D18): one folder per project, holding its settings and its database, and the
// clone of a target added by URL. Nothing is ever written to a target added by path.

export { EsperError }

export interface Project {
  name: string
  source: { path: string } | { url: string }
  kind?: 'application' | 'framework'
  // Packages whose advisories are the target's, beside those its manifests declare (D19).
  packages?: string[]
}

export const profilesDir = new URL('../../../profiles', import.meta.url).pathname

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ESPER_HOME ?? join(homedir(), '.esper')
}

const validName = /^[a-z0-9][a-z0-9._-]*$/

export class Home {
  readonly dir: string
  // How analyzers run, and which: Docker and the repository's, unless a test stands in for them.
  private readonly runner: AnalyzerRunner | undefined
  private readonly analyzers: Analyzer[] | undefined
  // Where advisories come from: OSV, unless a test stands in for it.
  private readonly osv: AdvisorySource

  constructor(
    dir: string = homeDir(),
    options: { runner?: AnalyzerRunner; analyzers?: Analyzer[]; advisories?: AdvisorySource } = {},
  ) {
    this.dir = dir
    this.runner = options.runner
    this.analyzers = options.analyzers
    this.osv = options.advisories ?? osvSource()
  }

  // A project's name is kept in lower case, so it is found whatever case it is asked in, on a file
  // system that tells cases apart as on one that does not.
  private projectDir(name: string) {
    return join(this.dir, 'projects', name.toLowerCase())
  }

  database(name: string) {
    return join(this.projectDir(name), 'esper.db')
  }

  async projects(): Promise<Project[]> {
    const dir = join(this.dir, 'projects')
    const names = await readdir(dir).catch(() => [] as string[])
    const projects: Project[] = []
    for (const name of names.sort()) {
      const text = await readFile(join(dir, name, 'project.json'), 'utf8').catch(() => undefined)
      if (text) projects.push(JSON.parse(text) as Project)
    }
    return projects
  }

  async project(name: string): Promise<Project> {
    const text = await readFile(join(this.projectDir(name), 'project.json'), 'utf8').catch(
      () => undefined,
    )
    if (!text) throw new NotFound(`no project named ${name}; \`esper list\` shows the projects`)
    return JSON.parse(text) as Project
  }

  // Where the project's code is: the folder it was added from, or its clone.
  sourceDir(project: Project): string {
    return 'path' in project.source
      ? project.source.path
      : join(this.projectDir(project.name), 'checkout')
  }

  async add(
    typed: string,
    options: { name?: string; kind?: 'application' | 'framework'; packages?: string[] } = {},
  ): Promise<Project> {
    // A folder named from the home directory, as the shell would expand it: the web interface
    // sends the path as it was typed.
    const source = typed === '~' || typed.startsWith('~/') ? join(homedir(), typed.slice(1)) : typed
    const url = /^(https?:\/\/|git@|ssh:\/\/)/.test(source)
    const name = (
      options.name ??
      basename(url ? source.replace(/\.git$/, '').replace(/\/+$/, '') : resolve(source))
    ).toLowerCase()
    if (!validName.test(name)) {
      throw new EsperError(
        `${name} is not a valid project name: use letters, digits, '.', '_' or '-'`,
      )
    }
    const dir = this.projectDir(name)
    if (await stat(dir).catch(() => undefined))
      throw new EsperError(`a project named ${name} already exists`)
    let project: Project
    const extra = {
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.packages && options.packages.length > 0
        ? { packages: [...new Set(options.packages)] }
        : {}),
    }
    if (url) {
      project = { name, source: { url: source }, ...extra }
      await mkdir(dir, { recursive: true })
      try {
        await cloneTarget(source, join(dir, 'checkout'))
      } catch (error) {
        await rm(dir, { recursive: true, force: true })
        throw new EsperError(`could not clone ${source}: ${(error as Error).message.trim()}`)
      }
    } else {
      const path = resolve(source)
      if (!(await stat(path).catch(() => undefined))?.isDirectory()) {
        throw new EsperError(`${path} is not a folder`)
      }
      project = { name, source: { path }, ...extra }
      await mkdir(dir, { recursive: true })
    }
    await writeFile(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`)
    return project
  }

  // Indexes a snapshot of a project: its checkout as it is, or a git ref. A commit already
  // indexed, clean, by the same Esper with the same profiles and analyzers is not indexed again
  // (D20), unless `force` is set; the result then has no stats. `precise` runs the analyzers that
  // resolve the call edges of the target's language, in their containers (D12, D22).
  async index(
    name: string,
    options: {
      ref?: string
      force?: boolean
      precise?: boolean
      // Skips fetching the advisories: those already fetched are still placed (D19).
      offline?: boolean
      // Told what a precise index is doing, and every few seconds while it waits on a container.
      progress?: (message: string) => void
    } = {},
  ): Promise<{
    id: number
    snapshot: TargetSnapshot
    stats?: IndexStats
    profiles: string[]
    // The analyzers whose facts the snapshot holds, as `<name>@<version>`.
    analyzers: string[]
    unchanged?: boolean
    // How the project's notes stand on the snapshot, by anchor state (D8).
    notes: Record<AnchorState, number>
    // The advisories fetched and linked, or why they were not (D19); absent when the commit was
    // already indexed.
    advisories?: AdvisoryReport
  }> {
    const project = await this.project(name)
    const dir = this.sourceDir(project)
    if (options.ref !== undefined && !(await isGitRepository(dir))) {
      throw new EsperError(`--ref needs a git repository, and ${dir} is not one`)
    }
    const snapshot =
      options.ref !== undefined ? await readRef(dir, options.ref) : await readFolder(dir)
    const detection = detectProfile(snapshot.files, await loadProfiles(profilesDir), {
      ...(project.kind ? { kind: project.kind } : {}),
    })
    if ('refused' in detection) throw new EsperError(`refused: ${detection.refused}`)
    const language = languageNamed(detection.profile.language)
    const library = await readFile(
      new URL(`../queries/${language.name}/library.yaml`, import.meta.url),
      'utf8',
    )
    const analyzers = options.precise ? await this.analyzersFor(language.name) : []
    const sources = analyzers.map(analyzerSource)
    const indexer = createHash('sha256')
      .update(
        JSON.stringify([
          pkg.version,
          detection.profile,
          library,
          // An analyzer is known by its folder: a new image is a new indexer.
          ...(analyzers.length > 0 ? [analyzers.map((a) => [analyzerSource(a), a.hash])] : []),
        ]),
      )
      .digest('hex')
    if (!options.force && snapshot.commit && !snapshot.dirty) {
      const store = new Store(this.database(name))
      try {
        const same = store
          .snapshots()
          .reverse()
          .find(
            (s) =>
              s.commit === snapshot.commit &&
              !s.dirty &&
              s.indexer === indexer &&
              (s.ref ?? undefined) === snapshot.ref,
          )
        if (same) {
          return {
            id: same.id,
            snapshot,
            profiles: detection.profile.sources,
            analyzers: same.analyzers,
            unchanged: true,
            notes: new Notes(store).summary(same.id),
          }
        }
      } finally {
        store.close()
      }
    }
    const [analyzer] = analyzers
    const analysis = analyzer
      ? await this.analyze(analyzer, dir, snapshot, detection.modules, options.progress)
      : undefined
    const { graph, stats } = await language.index(snapshot.files, {
      modules: detection.modules,
      profile: detection.profile,
      ...(analysis ? { analysis } : {}),
    })
    graph.skips.push(...snapshot.skips)
    const store = new Store(this.database(name))
    try {
      const info = {
        ...(snapshot.ref ? { ref: snapshot.ref } : {}),
        ...(snapshot.commit ? { commit: snapshot.commit } : {}),
        dirty: snapshot.dirty,
        profiles: detection.profile.sources,
        analyzers: sources,
        indexer,
        sources: snapshot.files.filter((f) => language.source(f.path)),
      }
      const { id, existed } = options.force
        ? { id: store.addSnapshot(graph, info), existed: false }
        : store.addSnapshotOnce(graph, info)
      const notes = new Notes(store).summary(id)
      // Another index of the same commit finished first: its snapshot is the one kept.
      const profiles = detection.profile.sources
      if (existed) {
        return { id, snapshot, profiles, analyzers: sources, unchanged: true, notes }
      }
      if (!options.offline) options.progress?.('advisories: fetching from OSV and linking them')
      const advisories = await this.refreshAdvisories(store, project, dir, {
        files: snapshot.files,
        language,
        profile: detection.profile,
        modules: detection.modules,
        offline: options.offline ?? false,
      })
      return { id, snapshot, stats, profiles, analyzers: sources, notes, advisories }
    } finally {
      store.close()
    }
  }

  // Fetches the project's advisories again and links them, from the folder as it is now (D19).
  async advisories(name: string): Promise<AdvisoryReport> {
    const project = await this.project(name)
    const dir = this.sourceDir(project)
    const snapshot = await readFolder(dir)
    const detection = detectProfile(snapshot.files, await loadProfiles(profilesDir), {
      ...(project.kind ? { kind: project.kind } : {}),
    })
    if ('refused' in detection) throw new EsperError(`refused: ${detection.refused}`)
    const store = new Store(this.database(name))
    try {
      const report = await this.refreshAdvisories(store, project, dir, {
        files: snapshot.files,
        language: languageNamed(detection.profile.language),
        profile: detection.profile,
        modules: detection.modules,
        offline: false,
      })
      if (!report.fetched) throw new EsperError(`advisories not fetched: ${report.reason}`)
      return report
    } finally {
      store.close()
    }
  }

  // Fetches and links the advisories of the target's packages, unless offline, then says how each
  // stands on every snapshot of the project. A failed fetch keeps the advisories already stored,
  // and says why.
  private async refreshAdvisories(
    store: Store,
    project: Project,
    dir: string,
    target: {
      files: TargetFile[]
      language: Language
      profile: ResolvedProfile
      modules: Module[]
      offline: boolean
    },
  ): Promise<AdvisoryReport> {
    const advisories = new Advisories(store)
    const git = await isGitRepository(dir)
    const ecosystem = target.language.ecosystem
    const packages: Package[] = [
      ...new Set([
        ...target.language.modules(target.files).map((m) => m.path),
        ...(project.packages ?? []),
      ]),
    ].map((name) => ({ name, ecosystem }))
    let report: AdvisoryReport
    let changed: string[] = []
    if (target.offline) {
      report = { ...advisories.report(), fetched: false, reason: 'offline' }
    } else {
      try {
        const imported = await importAdvisories(this.osv, packages)
        ;({ report, changed } = await advisories.save(imported, (advisory) =>
          linkAdvisory(advisory, {
            dir,
            git,
            language: target.language,
            profile: target.profile,
            modules: target.modules,
          }),
        ))
      } catch (error) {
        if (process.env.ESPER_DEBUG) throw error
        report = {
          ...advisories.report(),
          fetched: false,
          reason: (error as Error).message || String(error),
        }
      }
    }
    // Each advisory's state on each snapshot, where it is missing (a new snapshot, a new advisory)
    // or the advisory changed: the others still hold, and computing them asks git again.
    const stored = advisories.list()
    const states = new Map<number, Map<string, unknown>>()
    for (const snapshot of store.snapshots()) {
      states.set(snapshot.id, advisories.states(snapshot.id))
    }
    const computed: [string, number, Awaited<ReturnType<typeof stateOn>>][] = []
    for (const snapshot of store.snapshots()) {
      const missing = stored.filter(
        (a) => changed.includes(a.id) || !states.get(snapshot.id)?.has(a.id),
      )
      if (missing.length === 0) continue
      const version = await snapshotVersion(dir, git, snapshot)
      for (const advisory of missing) {
        computed.push([
          advisory.id,
          snapshot.id,
          await stateOn(advisory, advisory.fixes, snapshot, version, { dir, git }),
        ])
      }
    }
    store.transaction(() => {
      for (const [id, snapshot, state] of computed) advisories.setState(id, snapshot, state)
    })
    return report
  }

  // The analyzers that resolve the call edges of a language, answering per snapshot: one per
  // language, since each call site takes its callees from one source.
  private async analyzersFor(language: string): Promise<Analyzer[]> {
    const found = (this.analyzers ?? (await loadAnalyzers())).filter(
      (a) =>
        a.answers === 'snapshot' &&
        a.provides.includes('edges.resolve') &&
        a.languages.includes(language),
    )
    if (found.length === 0)
      throw new EsperError(`no analyzer resolves the call edges of ${language}`)
    if (found.length > 1) {
      throw new EsperError(
        `${found.map(analyzerSource).join(' and ')} both resolve the call edges of ${language}: keep one`,
      )
    }
    return found
  }

  // Runs an analyzer on the snapshot's whole tree, and imports what it wrote: the file is checked
  // against the snapshot's files and refused whole if any line fails (D12).
  private async analyze(
    analyzer: Analyzer,
    dir: string,
    snapshot: TargetSnapshot,
    modules: { path: string; dir: string }[],
    progress?: (message: string) => void,
  ): Promise<Analysis> {
    const runner = this.runner
    if (!runner) {
      const docker = await dockerAvailable()
      if (!docker.ok) {
        throw new EsperError(
          `${analyzerSource(analyzer)} runs in Docker, which does not answer: ${docker.reason}`,
        )
      }
    }
    const src = await mkdtemp(join(tmpdir(), 'esper-src-'))
    // A client waiting on a long run hears from it at least this often, and does not time out.
    let last = `${analyzerSource(analyzer)}: writing the snapshot's tree`
    const tell = (message: string) => {
      last = message
      progress?.(message)
    }
    const beat = progress
      ? setInterval(() => progress(`${last} (still running)`), heartbeat)
      : undefined
    try {
      // The container's user is not the host's: it reads the tree, and writes nothing to it.
      await chmod(src, 0o755)
      tell(last)
      await materialise(dir, snapshot, src)
      const text = await (runner ?? dockerRunner)(
        analyzer,
        src,
        {
          files: snapshot.files.map((f) => f.path),
          modules: modules.map((m) => ({ path: m.path, dir: m.dir })),
        },
        tell,
      )
      tell(`${analyzerSource(analyzer)}: importing its output`)
      return await importAnalysis(
        text,
        analyzer,
        new Map(snapshot.files.map((f) => [f.path, f.source])),
      )
    } finally {
      clearInterval(beat)
      await rm(src, { recursive: true, force: true })
    }
  }
}

// How often a precise index says it is still running.
export const heartbeat = 10_000
