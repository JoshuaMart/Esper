---
title: Analyzers
description: The contract every analyzer follows, the import format Esper reads from it, and the analyzers built on it, scip-go and scip-typescript.
---

An analyzer adds what tree-sitter cannot see, from a container and through one contract
([D12](/decisions/#d12--precision-scip-right-after-the-first-index-dataflow-later),
[D22](/decisions/#d22--precision-runs-inside-the-index-when-asked)). It reads the snapshot's code and
writes one file; it never sees the database. The source of truth is the code:
`packages/core/src/analyzer.ts` for the manifest and the import, `packages/core/src/docker.ts` for
the container, and the two schemas in `schemas/`.

## Running one

```sh
esper index chi --ref v5.3.2 --precise
```

```text
chi: snapshot 3 (v5.3.2, 38939062c5df)
  profiles     net-http/application, chi/framework
  analyzers    scip-go@0.2.9
  files        35 read
  skipped      27: .github/ (hidden), _examples/ (examples), context_test.go (tests), …
  entry points 40
  call edges   618, 99.8 % resolved; 28 calls without an edge
               582 of 646 calls named by scip-go@0.2.9
  reads        55, signals on entry points 10
  notes        none
```

`--precise` runs the analyzer that resolves the call edges of the target's language, while the
snapshot is indexed; over MCP, `esper_index` takes `precise: true`. It needs Docker, and the
network: the first run builds the analyzer's image, and each run fetches the dependencies the
analyzer's cache does not hold yet. Once both are there, chi takes about 4 seconds, and Wakapi about
20 the first time it is fetched. The command line says each step on its standard error; over MCP, a
client that asks for progress gets a notification at each step and every 10 seconds while a
container runs, so that its request does not time out. A precise snapshot is a
snapshot of its own, listed with its analyzers by `esper list` and `esper_snapshots`, and a commit
indexed without `--precise` is indexed again with it.

If Docker does not answer, if the container fails, or if its file is refused, the index fails with
the reason and stores nothing.

## The manifest

Each analyzer is a folder, `analyzers/<name>/`, with a `manifest.yaml` validated against
`schemas/analyzer.schema.json`, and what its image is built from.

```yaml
name: scip-go
version: 0.2.9
description: Resolves Go call edges with the Go type checker.
languages: [go]
provides: [edges.resolve]
answers: snapshot
image:
  dockerfile: Dockerfile
fetch: [fetch]
analyze: [analyze]
```

| Field | |
|---|---|
| `name` | the folder's name; facts it brings have `<name>@<version>` as their source |
| `version` | the version of the tool the image runs; letters, digits, `.`, `_` and `-` only, since it is part of the image's tag |
| `description` | optional: what it does, in one line |
| `languages` | the languages it reads: `go`, `typescript` |
| `provides` | `edges.resolve`, the callees of call sites; `flows`, dataflow paths, which come with [M9](/roadmap/#m9--dataflow-on-demand) |
| `answers` | `snapshot`, run while a snapshot is indexed; `question`, run for one dataflow question (M9) |
| `image.dockerfile` | the Dockerfile in the folder |
| `fetch` | the arguments, given to the image's entry point, that fetch the dependencies; absent when there are none to fetch |
| `analyze` | the arguments that analyze the snapshot |

One analyzer per language may provide `edges.resolve`: each call site takes its callees from one
source. Esper builds the image from the folder the first time it is needed, and tags it
`esper-analyzer-<name>:<version>-<hash>`, from a hash of every file of the folder but hidden ones
(`.DS_Store`): a changed
Dockerfile or program builds a new image, and is a new indexer for
[D20](/decisions/#d20--a-reindex-reads-the-whole-target). Images carry the label
`esper.analyzer=<name>`, so that old ones can be found and removed.

## The container

Esper writes the snapshot's whole tree to a temporary folder: every regular file of the commit, or
of the folder (tracked and untracked files, not ignored ones), with the files it read written as it
read them. Links and submodules are left out, as are `.git/` and `node_modules/`. The container sees:

| Path | |
|---|---|
| `/esper/src` | the tree, read-only |
| `/esper/input.json` | the analyzer's name and version, the files of the snapshot, and its modules, read-only |
| `/esper/cache` | the analyzer's dependency cache, the volume `esper-cache-<name>`: writable while fetching, read-only while analyzing |
| `/esper/out` | where the analysis writes `analysis.jsonl`; only while analyzing |

```json
{
  "analyzer": { "name": "scip-go", "version": "0.2.9" },
  "snapshot": {
    "files": ["chain.go", "chi.go", "context.go", "…"],
    "modules": [{ "path": "github.com/go-chi/chi/v5", "dir": "." }]
  }
}
```

It runs twice, and both runs have user 65532 rather than root, a read-only root file system, every
capability dropped, no privilege escalation, a `/tmp` in memory, and are removed when they end. The
image owns `/esper/cache` by that user, so that the volume starts writable for it:

1. **fetch**, with the network: the dependencies are downloaded into the volume, with scripts
   disabled;
2. **analyze**, with `--network none`: the analysis reads the tree and the volume, and writes its
   file.

Only that file leaves the container. The cache is kept between runs and shared by every project:
what fetching puts there is checked against the checksums the language's tools verify (for Go,
`go.sum` and the checksum database), so one target cannot leave another a changed module.
`docker volume rm esper-cache-scip-go` empties it.

## The import format

One JSON Lines file, each line validated against `schemas/analysis.schema.json`. The first line
names the analyzer; every other line is a `reference` or an `implementation`.

```json
{"type":"analyzer","format":1,"name":"scip-go","version":"0.2.9"}
{"type":"reference","at":{"file":"middleware/compress.go","line":233,"column":21},"name":"Get","target":{"external":"sync#Pool.Get"}}
{"type":"reference","at":{"file":"middleware/get_head.go","line":29,"column":20},"name":"Match","target":{"file":"chi.go","line":129,"column":2}}
{"type":"implementation","at":{"file":"mux.go","line":365,"column":16},"name":"Match","of":{"file":"chi.go","line":129,"column":2}}
```

| Line | Says |
|---|---|
| `analyzer` | who wrote the file: `format` (1), `name` and `version`, which must be the manifest's |
| `reference` | the name at `at` refers to the function or method defined at `target`, a place in the snapshot, or to `target.external`, a symbol outside it written `<import path>#<symbol>` (`net/http#Request.FormValue`) |
| `implementation` | the method defined at `at` implements the interface method `of`, a place or an external symbol; one of an external symbol is checked and not kept, since a call through such an interface stays a call to that symbol |

A **place** is a `file`, relative to the target's root with `/`, a 1-based `line`, and a 1-based
`column` in UTF-8 bytes, where the line's `name` starts. A name is an identifier: letters, digits,
`_` and `$`, not starting with a digit. Places are positions, not Esper's
references: an analyzer needs to know nothing of [D7](/decisions/#d7--stable-references-and-fingerprints).

### What Esper checks

- every line is JSON and valid against the schema;
- the first line names the analyzer of the manifest, at its version, and no other line does;
- every place is in a file of the snapshot, on a line it has, and the line holds `name` at that
  column, as a whole name (`Get` is not cited inside `GetHead`);
- no place refers to two different targets.

If any line fails, the whole file is refused, with the number of the first line that failed and
why: `scip-go@0.2.9: line 2 of its output is refused, and the file with it: mux.go:82:8 does not
hold Reset`.

### What Esper makes of it

- **A call.** The callee of each call expression, where the analyzer cites its name, takes its
  callees from the analyzer: a declaration of the snapshot, by the place of its name; an external
  symbol, `ext:<import path>#<symbol>`; or, for a method of an interface of the module, each method
  of the module that implements it, with `data.interface` naming the interface method
  (`Routes.Match`). Its edges have the analyzer as their source, `scip-go@0.2.9`, and are
  `resolved`. A call the analyzer says nothing of keeps what tree-sitter found.
- **Build variants.** A call to a function that the package declares once per platform
  (`sock_unix.go`, `sock_windows.go`) stays a guess to each variant: the analyzer type-checks one
  platform, Linux, and never sees the others.
- **A function returned as a value** (`return compressor.Handler`) is resolved the same way, and so
  are the reads made through a call that a profile names.
- **Handlers and chain members** take the analyzer's answer where it names declarations of the
  module. For a method of a value from outside it, what built the value (`http.FileServer(…)`) says
  more than the interface method the analyzer names, and is kept. Routers and adapters are still
  recognised by the names the profiles give them, as the syntax states them.
- **What follows.** The entry points, their reads and their signals are computed after, from the
  resolved edges ([graph schema](/reference/graph/)).

## scip-go

[scip-go](https://github.com/scip-code/scip-go) 0.2.9 runs the Go type checker over the snapshot
and writes a SCIP index. The image (`analyzers/scip-go/`) is built on Go 1.27.3, pinned by digest,
with scip-go installed at its version and a small program, `esper-scip-go`, that does both runs:

- **fetch** runs `go mod download` in each module;
- **analyze** runs `scip-go index --skip-tests` in each module, and writes a `reference` for each
  use of a function or method in a file of the snapshot, and an `implementation` for each method
  that implements an interface method. Columns are converted to UTF-8 bytes from the SCIP index's
  own encoding.

The image's environment keeps both runs from running anything of the target's: `GOTOOLCHAIN=local`,
so that a `toolchain` line in `go.mod` cannot download a Go; the module proxy only, with
`GOVCS=*:off`, so that no version control command runs; `GOFLAGS=-mod=readonly`, so that `go.mod`
and `go.sum` are never written; and `CGO_ENABLED=0`, so that no C compiler runs. Type-checking
compiles the target's packages; it runs none of them. A target that requires a newer Go than the
image's is refused with Go's own message, and the image's Go is then raised.

Measured at the counted commits ([D22](/decisions/#d22--precision-runs-inside-the-index-when-asked)):

| | chi 5.3.2 | Wakapi `aba6a44` |
|---|---|---|
| calls named by scip-go | 582 of 646 | 6549 of 6924 |
| guessed edges, tree-sitter alone | 30 of 540 | 567 of 5515 |
| guessed edges, with scip-go | 1 of 618 | 0 of 6666 |
| calls without an edge, tree-sitter alone | 106 | 1437 |
| calls without an edge, with scip-go | 28 | 299 |
| entry points, as counted by hand | 40 | 71 |

What stays without an edge is a call of a function value (a parameter, a field, a variable), a
conversion (`string(b)`), or a method of an interface of the module that only types outside it
implement. chi's one guess left is `DefaultLogger(next)`, a call through a package variable that
`init` assigns, which a type checker cannot name either.

## scip-typescript

[scip-typescript](https://github.com/sourcegraph/scip-typescript) 0.5.2, its latest release, runs
the TypeScript compiler (6.0.3) over the snapshot and writes a SCIP index
([D26](/decisions/#d26--scip-typescript-with-the-dependencies-the-lockfile-pins)). The image
(`analyzers/scip-typescript/`) is built on Node 24.22.1, pinned by digest; scip-typescript and pnpm
10.34.9 are pinned by the lockfile of its program, `esper-scip-typescript`, and installed without
scripts. The program does both runs:

- **fetch** reads the lockfile at the root of the snapshot's tree: `pnpm fetch` for `pnpm-lock.yaml`,
  `npm ci` for `package-lock.json`, with every `package.json` of the tree for a workspace's
  packages, from npm's registry whatever the target's `.npmrc` says, with
  scripts disabled, into the cache volume. pnpm stays at its own version whatever the target's
  `packageManager` names. A tree without a lockfile fetches nothing.
- **analyze** copies the tree into `/tmp`, installs the dependencies from the cache without the
  network (`--offline`, the volume read-only), and runs `scip-typescript index` on each folder with a
  `tsconfig.json` that holds files of the snapshot, or on the root with an inferred configuration
  when there is none. A `tsconfig.json` that extends one neither in the tree nor in a package the
  install brought is read without it, and says so.

It writes a `reference` for each name whose symbol the index defines, in a file of the snapshot or
outside it, and an `implementation` for each method that implements an interface method of the
snapshot. Left out: a name that refers to several symbols, such as a member of a union type, and a
name renamed by its import (`import { a as b }`), since the line holds one name for both places.
Outside the snapshot, a symbol is named by its package and its names (`drizzle-orm#PgDatabase.select`),
the TypeScript library's by `globalThis` and `@types/node`'s by `node:<module>`. Where the syntax
names the same call outside the target too, its own name is kept: it is the module the code imports
it from, which profiles and `library.yaml` name (`hono/cors#cors`), while SCIP names the package
that declares it. Columns are converted to UTF-8 bytes from the index's UTF-16 code units.

Measured at the counted commits, with the TypeScript module as it is since M7:

| | Hono v4.13.14 | Kaneo v2.48.0, `apps/api` | Budget `cfce07b` |
|---|---|---|---|
| dependencies | installed from `pnpm-lock.yaml` | none: the lockfile is at the repository's root | installed from `pnpm-lock.yaml` |
| calls named by scip-typescript | 2180 of 3646 | 4576 of 15171 | 414 of 891 |
| guessed edges, tree-sitter alone | 106 of 2035 | 85 of 10055 | none of 554 |
| guessed edges, with scip-typescript | 9 of 3277 | 85 of 11317 | none of 831 |
| calls without an edge, tree-sitter alone | 1697 | 5123 | 337 |
| calls without an edge, with scip-typescript | 423 | 3861 | 60 |
| entry points, as counted by hand | 108 | 211 | 24 |
| time, image and dependencies there | about 12 s | about 7 s | about 5 s |

On a SvelteKit application, scip-typescript type-checks the `.ts` and `.js` files as the index
reads them; the `.svelte` components, which TypeScript does not read either without Svelte's own
tooling, take no part, and the types SvelteKit generates (`./$types`) are not there, since nothing
of the target runs.

Without the dependencies, scip-typescript still names the calls between the target's own modules;
calls on values from outside it, and the guesses on them, stay as tree-sitter left them.

## Tests

`packages/core/test/analyzer.test.ts` checks the manifests and the import: a file with one invalid
line, or one place that does not match the snapshot, is refused whole. `packages/core/test/scip-go.test.ts`
runs scip-go in Docker on chi 5.3.2 and Wakapi at their counted commits, and on a folder that is not
a git checkout; `packages/core/test/scip-typescript.test.ts` runs scip-typescript on Hono,
Kaneo's API and Budget at theirs, and on a folder without a lockfile. Without Docker these tests are skipped and say so; without the targets of
`pnpm fetch-targets`, the ones on the counted targets are. GitHub's Ubuntu runners have Docker, so CI
runs them.
