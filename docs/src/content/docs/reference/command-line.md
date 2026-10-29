---
title: Command line
description: The esper commands available today, where Esper keeps its projects, and how a target is read.
---

The commands planned are in [D18](/decisions/#d18--running-esper-one-home-many-projects). This page
lists those that exist. From the repository, `pnpm esper <command>` runs them from the sources.

## Running `esper`

`esper-cli` is not published on npm yet, so `esper` is the repository's own entry point, run by
Node from the sources. Inside the repository, `pnpm esper` runs it; anywhere else, and in an MCP
client's configuration, Node runs it by its path:

```sh
node ~/code/Esper/packages/cli/src/main.ts list
alias esper="node ~/code/Esper/packages/cli/src/main.ts"   # in ~/.zshrc, so that esper works as written here
```

A running `esper serve` or `esper mcp` keeps the code it started with: after pulling a new version
of Esper, start them again, and run `pnpm web` again for the interface.

## Environment

| Variable | |
|---|---|
| `ESPER_HOME` | where projects live, `~/.esper` by default ([below](#where-projects-live)) |
| `ESPER_DEBUG` | `1` shows where an error came from, rather than its one line |
| `ESPER_OSV_URL` | the OSV server advisories are fetched from, `https://api.osv.dev` by default |
| `ANTHROPIC_API_KEY` | the key of `esper enrich --provider anthropic-api`, read by the SDK |
| `ESPER_TARGETS` | for the repository's tests and scripts: the folder `pnpm fetch-targets` fetches the counted targets into |

## Commands

| Command | Does |
|---|---|
| `esper add <path or git URL>` | adds a project. A path is read in place and never written; a URL is cloned into the project's folder. `--name` sets its name (by default, the folder's or the repository's), `--kind application\|framework` overrides the detection, and `--package <name>`, once per package, names a package whose advisories are the target's, beside those its manifests declare |
| `esper index <project>` | indexes a snapshot. Without options, it reads the folder as it is. With `--ref <tag, branch or commit>`, it reads that ref from git and leaves the checkout alone. `--precise` also runs the analyzer that resolves the language's call edges, in Docker ([analyzers](/reference/analyzers/)). A clean commit already indexed with the same profiles and analyzers is not indexed again; `--force` does it anyway. It then fetches the target's advisories from OSV and links them ([below](#past-advisories)); `--offline` does not fetch them, and keeps those already fetched |
| `esper advisories <project>` | fetches the target's advisories from OSV again, links them to its code, and says how each snapshot stands against them |
| `esper enrich <project>` | asks a model the questions parsing cannot answer, and stores its answers as [claims](/reference/claims/), checked against the lines they cite. `--provider claude-code\|anthropic-api`, `--tier bounded\|exploring`, `--kind`, `--limit` (40 by default), `--model`, `--effort`, `--snapshot`, and `--dry-run`, which lists the questions without asking them |
| `esper list` | the projects, and the snapshots of each |
| `esper mcp <project>` | serves the project over MCP on stdio, for one agent ([MCP tools](/reference/mcp/)). `--read-only` exposes no tool that writes; `--trace <file>` appends each tool call to the file, as an exploring enrichment run records what it read |
| `esper serve` | starts the server on `127.0.0.1` for every project: the [web interface](/reference/interface/), its [API](/reference/api/), and MCP over HTTP at `/mcp/<project>`. `--port` sets its port, 7300 by default, 0 for any free one. It prints its address and the token, kept in `$ESPER_HOME/token` |

An unknown option is refused, as is an option of another command. A refusal exits with code 1 and
says why; a mistake in the command line exits with code 2.

```sh
esper add ~/code/chi
esper index chi --ref v5.3.2
```

```text
chi: snapshot 2 (v5.3.2, 38939062c5df)
  profiles     net-http/application, chi/framework
  files        35 read
  skipped      27: .github/ (hidden), _examples/ (examples), context_test.go (tests), …
  entry points 40
  call edges   540, 94.4 % resolved; 106 calls without an edge
  reads        55, signals on entry points 10
  notes        2 attached, 1 stale
  advisories   6 kept (2 high, 4 moderate), 0 low left out
               linked 4 by symbol, 2 by fix-diff; 0 unlinked
```

The notes line says how the project's [notes](/reference/notes/) stand on the new snapshot, by
anchor state; the advisories lines, what OSV gave and how it was linked.

## Past advisories

The target's published vulnerabilities, fetched from [OSV](https://osv.dev) when a snapshot is
indexed and by `esper advisories`
([D19](/decisions/#d19--past-vulnerabilities-advisories-linked-to-the-code-they-touched),
[D30](/decisions/#d30--advisories-belong-to-the-project-and-are-placed-on-each-snapshot)). This is
the one network call Esper makes; `ESPER_OSV_URL` points it at another server.

- **Which packages.** Each module the target's manifests declare (a `go.mod`'s module path, a
  `package.json`'s name), in its language's ecosystem, and each `--package` of `esper add`.
- **Which advisories.** Those rated `MODERATE` or more by their database, or by an alias's, or
  with a CVSS 3 base score of 4.0 or more; one no rating reaches is kept as `unrated`. An entry and
  its aliases (the Go database's and GitHub's) are one advisory. The low ones are counted, and left
  out.
- **How each is linked**, by its most precise link: `symbol` (the functions it names), `fix-diff`
  (the declarations its fix commit changed, read in the commit's parent), `file` (the fix changed
  lines outside any declaration), or `unlinked`, listed but linked to nothing. A fix commit is one
  the repository holds, pointed to by the advisory, or found by its identifiers in the messages of
  the history: a clone without its history, or a folder that is not a repository, links by symbol
  only.
- **Where it stands** on each snapshot: `affected` or `fixed` from the advisory's version ranges and
  the snapshot's version (its ref, or a tag of its commit), else from whether its commit holds a
  fix; `unaffected` before the flaw came in; `unknown` otherwise.

Advisories belong to the project, not to a snapshot: a snapshot indexed `--offline` gets those
already fetched, and fetching them again reaches every snapshot. Their text is a third party's, and
is shown as text.

## Where projects live

In `$ESPER_HOME`, or `~/.esper` by default:

```text
token                          the token of esper serve
enrich/<project>/              where esper enrich runs claude, never in the target
projects/<name>/project.json   the project: its name, its source, its kind if forced
projects/<name>/esper.db       its snapshots
projects/<name>/checkout/      its clone, for a project added by URL
```

## How a target is read

- **What is read.** Go files and every `go.mod`: a module in a subfolder, or several modules, are
  each known by their folder, so that their imports of each other are internal. TypeScript and
  JavaScript files (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, not `.d.ts`), every
  `package.json`, whose name makes a package of the target, and every `tsconfig.json` and
  `jsconfig.json`, whose `paths` imports resolve through. A folder that is a git checkout is listed
  by git, so that ignored files stay out; any other folder is walked.
- **What is skipped.** Tests (`*_test.go`, `*.test.ts`, `*.spec.js` and the like, `test/`, `tests/`,
  `__tests__/`, `e2e/`, and folders named `…-tests`), benchmarks (`benchmarks/`, `bench/`), examples
  (`examples/`, `_examples/`, `example/`), fixtures (`testdata/`, `fixtures/`), mocks (`mocks/`,
  `__mocks__/`), generated code (`dist/`), vendored code (`vendor/`, `third_party/`,
  `node_modules/`) and hidden folders. Symbolic links are never followed, so that a link in the
  target cannot read a file outside it, and submodules are not read. Each skipped folder, and each
  skipped file, is stored with the snapshot and its reason.
- **Which profile.** A target whose `go.mod`, or one of whose `package.json`, declares a framework's
  module is that framework, read with its `framework` profile. Otherwise, the `application`
  profiles of the frameworks it requires (in Go directly, not `// indirect`; in a `package.json`, as
  a dependency, peer or optional one) or imports apply, together when there are several: a SvelteKit
  application, which lists SvelteKit as a development dependency, is known by its code importing
  `@sveltejs/kit`. A profile
  that another matching one extends, such as `net-http` under `chi`, is not applied twice. A
  snapshot is read in one language: a target whose matching profiles are of two languages is
  refused, and the folder of each part is added as its own project.
- **What is refused.** A target with no file in a language Esper reads, or that no profile matches,
  is refused with the reason, rather than indexed into an empty attack surface.
- **Which version.** A snapshot records the commit, the ref asked for, and whether the folder had
  changes. Changes are found by hashing each file the way git does and comparing it with the index,
  so that no filter of the repository runs.
- **What runs.** Nothing of the target. Git is called with the repository's hooks and file system
  monitor turned off, and only for commands that run none of its filters (`ls-files`, `ls-tree`,
  `cat-file` without `--filters`, `rev-parse`). A clone brings no hooks. With `--precise`, the
  analyzer type-checks the target in a container, without running it
  ([analyzers](/reference/analyzers/#the-container)).

A project may be a folder of a repository (`esper add ~/code/kaneo/apps/api`): `--ref` then reads
that folder of the commit.

Each index reads every file again, which takes about a second for a few hundred files
([D20](/decisions/#d20--a-reindex-reads-the-whole-target)). An error says what failed in one line;
`ESPER_DEBUG=1` shows where it came from.
