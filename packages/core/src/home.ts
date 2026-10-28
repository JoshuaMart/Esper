import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import pkg from '../package.json' with { type: 'json' }
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
import type { IndexStats } from './language.ts'
import { languageNamed } from './languages.ts'
import { type AnchorState, Notes } from './notes.ts'
import { loadProfiles } from './profile.ts'
import { Store } from './store.ts'
import {
  cloneTarget,
  isGitRepository,
  materialise,
  readFolder,
  readRef,
  type TargetSnapshot,
} from './target.ts'

// Esper's home (D18): one folder per project, holding its settings and its database, and the
// clone of a target added by URL. Nothing is ever written to a target added by path.

export { EsperError }

export interface Project {
  name: string
  source: { path: string } | { url: string }
  kind?: 'application' | 'framework'
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

  constructor(
    dir: string = homeDir(),
    options: { runner?: AnalyzerRunner; analyzers?: Analyzer[] } = {},
  ) {
    this.dir = dir
    this.runner = options.runner
    this.analyzers = options.analyzers
  }

  private projectDir(name: string) {
    return join(this.dir, 'projects', name)
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
    options: { name?: string; kind?: 'application' | 'framework' } = {},
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
    if (url) {
      project = { name, source: { url: source }, ...(options.kind ? { kind: options.kind } : {}) }
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
      project = { name, source: { path }, ...(options.kind ? { kind: options.kind } : {}) }
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
      return { id, snapshot, stats, profiles, analyzers: sources, notes }
    } finally {
      store.close()
    }
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
