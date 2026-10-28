---
title: Command line
description: The esper commands available today, where Esper keeps its projects, and how a target is read.
---

The commands planned are in [D18](/decisions/#d18--running-esper-one-home-many-projects). This page
lists those that exist. From the repository, `pnpm esper <command>` runs them from the sources.

## Commands

| Command | Does |
|---|---|
| `esper add <path or git URL>` | adds a project. A path is read in place and never written; a URL is cloned into the project's folder. `--name` sets its name (by default, the folder's or the repository's), `--kind application\|framework` overrides the detection |
| `esper index <project>` | indexes a snapshot. Without options, it reads the folder as it is. With `--ref <tag, branch or commit>`, it reads that ref from git and leaves the checkout alone. A clean commit already indexed with the same profiles is not indexed again; `--force` does it anyway |
| `esper list` | the projects, and the snapshots of each |

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
```

## Where projects live

In `$ESPER_HOME`, or `~/.esper` by default:

```text
projects/<name>/project.json   the project: its name, its source, its kind if forced
projects/<name>/esper.db       its snapshots
projects/<name>/checkout/      its clone, for a project added by URL
```

## How a target is read

- **What is read.** Go files and `go.mod`. A folder that is a git checkout is listed by git, so
  that ignored files stay out; any other folder is walked.
- **What is skipped.** Tests (`*_test.go`), examples (`examples/`, `_examples/`, `example/`), fixtures
  (`testdata/`, `fixtures/`), mocks (`mocks/`), vendored code (`vendor/`, `third_party/`,
  `node_modules/`) and hidden folders. Each skipped folder, and each skipped test file, is stored
  with the snapshot and its reason.
- **Which profile.** A target whose `go.mod` declares a framework's module is that framework, read
  with its `framework` profile. Otherwise, the `application` profiles of the frameworks it requires
  or imports apply, together when there are several. A profile that another matching one extends,
  such as `net-http` under `chi`, is not applied twice.
- **What is refused.** A target with no Go file, or that no profile matches, is refused with the
  reason, rather than indexed into an empty attack surface.
- **Which version.** A snapshot records the commit, the ref asked for, and whether the folder had
  changes. Changes are found by hashing each file the way git does and comparing it with the index,
  so that no filter of the repository runs.
- **What runs.** Nothing of the target. Git is called with the repository's hooks and file system
  monitor turned off, and only for commands that run none of its filters (`ls-files`, `ls-tree`,
  `cat-file` without `--filters`, `rev-parse`). A clone brings no hooks.

Each index reads every file again, which takes about a second for a few hundred files
([D20](/decisions/#d20--a-reindex-reads-the-whole-target)). An error says what failed in one line;
`ESPER_DEBUG=1` shows where it came from.
