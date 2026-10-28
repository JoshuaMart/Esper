import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import pkg from '../package.json' with { type: 'json' }
import { detectProfile } from './detect.ts'
import { type IndexStats, indexGo } from './go-index.ts'
import { loadProfiles } from './profile.ts'
import { Store } from './store.ts'
import { cloneTarget, isGitRepository, readFolder, readRef, type TargetSnapshot } from './target.ts'

// Esper's home (D18): one folder per project, holding its settings and its database, and the
// clone of a target added by URL. Nothing is ever written to a target added by path.

export interface Project {
  name: string
  source: { path: string } | { url: string }
  kind?: 'application' | 'framework'
}

export class EsperError extends Error {}

export const profilesDir = new URL('../../../profiles', import.meta.url).pathname

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ESPER_HOME ?? join(homedir(), '.esper')
}

const validName = /^[a-z0-9][a-z0-9._-]*$/

export class Home {
  readonly dir: string

  constructor(dir: string = homeDir()) {
    this.dir = dir
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
    if (!text) throw new EsperError(`no project named ${name}; \`esper list\` shows the projects`)
    return JSON.parse(text) as Project
  }

  // Where the project's code is: the folder it was added from, or its clone.
  sourceDir(project: Project): string {
    return 'path' in project.source
      ? project.source.path
      : join(this.projectDir(project.name), 'checkout')
  }

  async add(
    source: string,
    options: { name?: string; kind?: 'application' | 'framework' } = {},
  ): Promise<Project> {
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
  // indexed, clean, by the same Esper with the same profiles is not indexed again (D20), unless
  // `force` is set; the result then has no stats.
  async index(
    name: string,
    options: { ref?: string; force?: boolean } = {},
  ): Promise<{
    id: number
    snapshot: TargetSnapshot
    stats?: IndexStats
    profiles: string[]
    unchanged?: boolean
  }> {
    const project = await this.project(name)
    const dir = this.sourceDir(project)
    if (options.ref && !(await isGitRepository(dir))) {
      throw new EsperError(`--ref needs a git repository, and ${dir} is not one`)
    }
    const snapshot = options.ref ? await readRef(dir, options.ref) : await readFolder(dir)
    const detection = detectProfile(snapshot.files, await loadProfiles(profilesDir), {
      ...(project.kind ? { kind: project.kind } : {}),
    })
    if ('refused' in detection) throw new EsperError(`refused: ${detection.refused}`)
    const library = await readFile(new URL('../queries/go/library.yaml', import.meta.url), 'utf8')
    const indexer = createHash('sha256')
      .update(JSON.stringify([pkg.version, detection.profile, library]))
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
          return { id: same.id, snapshot, profiles: detection.profile.sources, unchanged: true }
        }
      } finally {
        store.close()
      }
    }
    const goFiles = snapshot.files.filter((f) => f.path.endsWith('.go'))
    const { graph, stats } = await indexGo(goFiles, {
      ...(detection.module.path ? { module: detection.module.path } : {}),
      profile: detection.profile,
    })
    graph.skips.push(...snapshot.skips)
    const store = new Store(this.database(name))
    try {
      const id = store.addSnapshot(graph, {
        ...(snapshot.ref ? { ref: snapshot.ref } : {}),
        ...(snapshot.commit ? { commit: snapshot.commit } : {}),
        dirty: snapshot.dirty,
        profiles: detection.profile.sources,
        indexer,
      })
      return { id, snapshot, stats, profiles: detection.profile.sources }
    } finally {
      store.close()
    }
  }
}
