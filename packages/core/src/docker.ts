import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type Analyzer, analyzerSource } from './analyzer.ts'
import { EsperError } from './errors.ts'

// Runs an analyzer's container on a snapshot (D12). The source is mounted read-only; the
// dependencies are fetched with the network into the analyzer's cache volume, then the analysis
// runs without the network, the volume read-only, and writes one file. The container drops every
// capability, has a read-only root, and is removed after.

const exec = promisify(execFile)

// What the analyzer is given about the snapshot: the files Esper read, and its modules.
export interface AnalyzerInput {
  files: string[]
  modules: { path: string; dir: string }[]
}

// Runs an analyzer on a snapshot whose whole tree is in `src`, and returns what it wrote. A
// different runner stands in for Docker in tests.
// `progress` is told each step, for a caller that must show it is still working.
export type AnalyzerRunner = (
  analyzer: Analyzer,
  src: string,
  input: AnalyzerInput,
  progress?: (message: string) => void,
) => Promise<string>

// The analyzer's dependency cache, kept between runs and shared by every project: what fetching
// puts there is checked against the checksums the language's tools verify (for Go, go.sum and the
// checksum database), so one target cannot leave another a changed module.
// `docker volume rm esper-cache-<name>` empties it.
export const cacheVolume = (analyzer: Pick<Analyzer, 'name'>) => `esper-cache-${analyzer.name}`

async function docker(args: string[], what: string): Promise<string> {
  try {
    return (await exec('docker', args, { maxBuffer: 1 << 28, encoding: 'utf8' })).stdout
  } catch (error) {
    const e = error as { code?: string; stderr?: string; message: string }
    if (e.code === 'ENOENT')
      throw new EsperError(`${what} needs Docker, and docker is not installed`)
    const tail = (e.stderr ?? e.message).trim().split('\n').slice(-12).join('\n')
    throw new EsperError(`${what} failed:\n${tail}`)
  }
}

// Whether Docker answers, and why not.
export async function dockerAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await exec('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 15_000 })
    return { ok: true }
  } catch (error) {
    const e = error as { code?: string; stderr?: string; message: string }
    return {
      ok: false,
      reason: e.code === 'ENOENT' ? 'docker is not installed' : (e.stderr ?? e.message).trim(),
    }
  }
}

// The analyzer's image, built from its folder the first time: its tag names the folder's hash,
// so that a changed Dockerfile or program builds a new one.
export async function analyzerImage(analyzer: Analyzer): Promise<string> {
  const tag = `esper-analyzer-${analyzer.name}:${analyzer.version}-${analyzer.hash.slice(0, 12)}`
  const have = await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]).then(
    () => true,
    () => false,
  )
  if (!have) {
    await docker(
      [
        'build',
        '--label',
        `esper.analyzer=${analyzer.name}`,
        '--quiet',
        '--file',
        join(analyzer.dir, analyzer.image.dockerfile),
        '--tag',
        tag,
        analyzer.dir,
      ],
      `building the image of ${analyzerSource(analyzer)}`,
    )
  }
  return tag
}

export const dockerRunner: AnalyzerRunner = async (analyzer, src, input, progress) => {
  const what = analyzerSource(analyzer)
  progress?.(`${what}: preparing its image`)
  const image = await analyzerImage(analyzer)
  const work = await mkdtemp(join(tmpdir(), 'esper-analysis-'))
  const volume = cacheVolume(analyzer)
  try {
    const inputPath = join(work, 'input.json')
    await writeFile(
      inputPath,
      JSON.stringify({
        analyzer: { name: analyzer.name, version: analyzer.version },
        snapshot: input,
      }),
    )
    const out = join(work, 'out')
    await mkdir(out)
    // The container's user is not the host's: it may write here, and nowhere else.
    await chmod(out, 0o777)
    await docker(['volume', 'create', '--label', 'esper', volume], 'creating the dependency cache')
    const base = [
      'run',
      '--rm',
      // Not root, whatever the image says; the image gives /esper/cache to this user.
      '--user',
      '65532:65532',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=4g',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--mount',
      `type=bind,src=${src},dst=/esper/src,readonly`,
      '--mount',
      `type=bind,src=${inputPath},dst=/esper/input.json,readonly`,
    ]
    if (analyzer.fetch) {
      progress?.(`${what}: fetching the dependencies`)
      await docker(
        [
          ...base,
          '--mount',
          `type=volume,src=${volume},dst=/esper/cache`,
          image,
          ...analyzer.fetch,
        ],
        `${what} fetching the dependencies`,
      )
    }
    progress?.(`${what}: analyzing the snapshot`)
    await docker(
      [
        ...base,
        '--network',
        'none',
        '--mount',
        `type=volume,src=${volume},dst=/esper/cache,readonly`,
        '--mount',
        `type=bind,src=${out},dst=/esper/out`,
        image,
        ...analyzer.analyze,
      ],
      `${what} analyzing the snapshot`,
    )
    return await readFile(join(out, 'analysis.jsonl'), 'utf8').catch(() => {
      throw new EsperError(`${what} wrote no /esper/out/analysis.jsonl`)
    })
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
