import type { Analysis } from './analyzer.ts'
import type { Graph } from './graph.ts'
import type { ResolvedProfile } from './profile.ts'
import type { TargetFile } from './target.ts'

// A language Esper reads (D10): the files it reads, how a target names its modules and their
// dependencies, and how a target is indexed with a profile. The shared machinery (reading a
// target, detecting its profile, the home, the store) knows a language only through this.

// A module of the target: a Go module, an npm package. Its path is the name others import it by,
// its folder is relative to the target's root (`.` at the root).
export interface Module {
  path: string
  dir: string
  // Its direct dependencies.
  requires: string[]
}

export interface CallStats {
  calls: number
  resolved: number
  guessed: number
  unresolved: number
  // Calls whose callees an analyzer named (D22).
  analyzed: number
}

export interface IndexStats extends CallStats {
  // Source files read.
  files: number
  entries: number
  reads: number
  signals: number
}

export interface Language {
  // As profiles and analyzers name it: `go`, `typescript`.
  name: string
  // As messages name it: `Go`.
  label: string
  // Whether the index reads a file: a source file or a manifest.
  reads(path: string): boolean
  // Whether a file is a source file, parsed into the graph.
  source(path: string): boolean
  // Whether a file is a test, skipped like a folder of tests.
  test(path: string): boolean
  // The modules the target declares, from its manifests.
  modules(files: TargetFile[]): Module[]
  // What the target's source files import, for profiles that detect a target by an import.
  imports(files: TargetFile[]): string[]
  // Indexes the files the language reads with a profile; an analyzer's output, when given, is
  // imported before the entry points follow the calls (D12).
  index(
    files: TargetFile[],
    options: { modules: Module[]; profile: ResolvedProfile; analysis?: Analysis },
  ): Promise<{ graph: Graph; stats: IndexStats }>
}
