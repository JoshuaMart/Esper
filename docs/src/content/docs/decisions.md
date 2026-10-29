---
title: Decisions
description: The choices that shape Esper, each with its reasons and the alternatives it rules out.
---

Each decision says what is chosen, why, and what it rules out. A decision is **proposed** until it
is confirmed, and **settled** once it is; a settled decision changes only through a new entry that
says why. Versions and behaviours cited here were checked on 2026-10-28, and those of D32 to D40 on
2026-10-29.

| # | Decision | Status |
|---|---|---|
| [D1](#d1--what-esper-is-and-is-not) | Esper maps and annotates; it does not hunt, verify or run anything | settled |
| [D2](#d2--build-the-index-reuse-the-engines-for-precision) | Build the attack-surface index; reuse existing engines for precision | settled |
| [D3](#d3--one-parser-tree-sitter-in-webassembly) | One parser for every language: tree-sitter in WebAssembly | settled |
| [D4](#d4--typescript-on-node-24-and-later) | TypeScript on Node 24 and later | settled |
| [D5](#d5--two-kinds-of-target-applications-and-the-frameworks-themselves) | Two kinds of target: applications, and the frameworks themselves | settled |
| [D6](#d6--the-graph-model) | A snapshot graph whose every fact cites its code | settled |
| [D7](#d7--stable-references-and-fingerprints) | Stable references, plus a fingerprint of each node's code | settled |
| [D8](#d8--notes) | Typed notes, with revisions, that never disappear silently | settled |
| [D9](#d9--storage-one-sqlite-database-per-project-outside-the-target) | One SQLite database per project, outside the target | settled |
| [D10](#d10--frameworks-as-profiles) | Frameworks as validated YAML profiles, two per framework | settled |
| [D11](#d11--indexing-rules) | Read only, refuse rather than return nothing, deterministic | settled |
| [D12](#d12--precision-scip-right-after-the-first-index-dataflow-later) | Precision: SCIP right after the first index, dataflow later, one analyzer contract | settled |
| [D13](#d13--the-mcp-surface) | MCP SDK v2, bounded tools, a read-only mode | settled |
| [D14](#d14--one-server-for-the-api-mcp-and-the-web-interface) | One local server for the API, MCP and the web interface | settled |
| [D15](#d15--repository-layout-and-licence) | A pnpm monorepo, under Apache-2.0 | settled |
| [D16](#d16--measured-against-hand-counted-targets) | Each profile measured against hand-counted targets | settled |
| [D17](#d17--model-enrichment-claims-beside-the-facts) | Model enrichment: claims beside the facts, bounded first, exploring when needed | settled |
| [D18](#d18--running-esper-one-home-many-projects) | Running Esper: one home, many projects, one project per MCP connection | settled |
| [D19](#d19--past-vulnerabilities-advisories-linked-to-the-code-they-touched) | Past vulnerabilities: advisories of medium severity or more, linked to the code their fix touched | settled |
| [D20](#d20--a-reindex-reads-the-whole-target) | A reindex reads the whole target; an unchanged commit is not indexed again | settled |
| [D21](#d21--a-declarations-fingerprint-leaves-its-name-out) | A declaration's fingerprint leaves its own name out | settled |
| [D22](#d22--precision-runs-inside-the-index-when-asked) | Precision runs inside the index, when asked; analyzers cite places, not references | settled |
| [D23](#d23--a-language-is-a-module-the-core-names-none) | A language is a module of its own; the shared core names no language and no framework | settled |
| [D24](#d24--typescript-and-javascript-as-their-syntax-states-them) | TypeScript and JavaScript as their syntax states them, imports resolved through the target's own configuration | settled |
| [D25](#d25--hono-middleware-in-the-order-it-is-registered) | Hono: middleware in the order it is registered; a framework's own types named by its package | settled |
| [D26](#d26--scip-typescript-with-the-dependencies-the-lockfile-pins) | scip-typescript, with the dependencies the target's lockfile pins, installed without scripts | settled |
| [D27](#d27--a-guarding-chain-member-is-known-by-the-code-that-refuses) | A guarding chain member is known by the code that refuses, not by how it is written | settled |
| [D28](#d28--the-server-a-token-kept-in-the-home-events-from-the-database) | The server: a token kept in the home, one connection per project, events found in the database | settled |
| [D29](#d29--the-map-a-groups-shared-code-drawn-bounded) | The map: the code a group of entry points shares, drawn and bounded | settled |
| [D30](#d30--advisories-belong-to-the-project-and-are-placed-on-each-snapshot) | Advisories belong to the project and are placed on each snapshot when it is read; how a fix is read | settled |
| [D31](#d31--enrichment-as-built-questions-checks-and-two-providers) | Enrichment as built: the questions, the checks, and how each provider runs; `--safe-mode` for bounded runs, `--setting-sources ""` for exploring ones; bounded questions on Sonnet 5.5 at medium effort | settled |
| [D32](#d32--routes-declared-by-files) | Routes declared by files: a profile's route tree, hooks, matchers and layouts | settled |
| [D33](#d33--javascript-typed-by-its-comments-and-types-a-profile-states) | JavaScript typed by its documentation comments; types outside the target as a profile or the library states them | settled |
| [D34](#d34--a-check-that-refuses-is-a-guard) | A check that refuses is a guard; a function that answers with a refusal can answer on its own | settled |
| [D35](#d35--sveltekit-the-server-side-in-both-modes) | SvelteKit: the server side, in both modes; its browser code is not its request surface | settled |
| [D36](#d36--python-as-its-syntax-states-it) | Python as its syntax states it: modules from the files, types from annotations, calls resolved or guessed with a reason | settled |
| [D37](#d37--fastapi-routes-and-dependencies-as-the-chain) | FastAPI: routes by decorators and route objects, included routers, dependencies as the chain, each after its own | settled |
| [D38](#d38--what-a-parameter-reads-and-a-dependency-that-refuses) | What a parameter reads, and a dependency that refuses with 401 or 403 as a guard | settled |
| [D39](#d39--fastapi-and-starlette-as-two-frameworks) | FastAPI and Starlette as two framework targets; the ASGI server's own reads are not theirs | settled |
| [D40](#d40--scip-python-wheels-only-and-no-python-in-the-analysis) | scip-python, with the dependencies' wheels only, and no Python run in the analysis | settled |

## D1 — What Esper is and is not

**Decision.** Esper parses an audited codebase into an attack-surface graph, lets agents and humans
annotate it, and serves both. It does not hunt for vulnerabilities, does not decide whether a lead
is real, does not exploit, and never builds or runs the audited code.

**Why.** The hunting, the proof and the verdict belong to the tools that consume Esper. Keeping
Esper to a map and its notes keeps its facts deterministic: the same code gives the same facts. A
tool that also judged would mix facts with guesses in the one place agents treat as ground truth.
What a model can add is kept apart, as claims ([D17](#d17--model-enrichment-claims-beside-the-facts)).

**Rules out.** A natural-language query layer, model output stored as facts, scanners that report
findings, and any execution of the target.

## D2 — Build the index, reuse the engines for precision

**Decision.** Esper builds its own attack-surface index on tree-sitter. Existing analysis engines
add precision to it ([D12](#d12--precision-scip-right-after-the-first-index-dataflow-later)), but
none is its foundation.

**Why.** No existing tool records what an audit needs (see [Sources](/sources/#code-graphs-for-agents)):

- **GitNexus** comes closest, with routes, middleware and an opt-in taint layer, but records no
  request reads, compares no guards across sibling routes, has no signals, and lacks chi and
  SvelteKit. Its PolyForm Noncommercial licence forbids reusing its code.
- **Joern** brings real interprocedural dataflow, but requires JDK 21 and a heavy heap: one
  vendor's guidance reports about 12.7 GB of heap to load a 63 MB CPG
  ([Harness](https://developer.harness.io/sast-and-sca/ocular/memory-size)). That is a cost for every
  index, for a layer an audit needs only on some questions.
- **CodeQL** needs a build of the target, and does not cover every language (PHP, for one).
- **Language servers** (Serena) need the target's toolchain and answer query by query, with no
  graph built in advance.

The routes, reads, guards and signals are the part no one else provides, and they are mostly
framework knowledge written as data ([D10](#d10--frameworks-as-profiles)), on top of a call graph
that tree-sitter gives cheaply.

**Rules out.** Forking GitNexus; making Joern or CodeQL a requirement to index anything.

## D3 — One parser: tree-sitter in WebAssembly

**Decision.** `web-tree-sitter` 0.27.1, with the WebAssembly grammars that the official grammar
packages ship: `tree-sitter-go` 0.25.0, `tree-sitter-typescript` 0.23.2 (TypeScript and TSX),
`tree-sitter-javascript` 0.25.0, `tree-sitter-python` 0.25.0. Versions are pinned exactly, and a
grammar joins the dependencies when its language's first framework starts
([D5](#d5--two-kinds-of-target-applications-and-the-frameworks-themselves)): Go in M1, TypeScript and
JavaScript in M4, Python after that. Go is parsed by tree-sitter too, not by `go/parser`.

**Why.**

- **Checked.** `web-tree-sitter` 0.27.1 loads each of these grammars and parses a handler in each
  language without error.
- **Nothing to compile.** The grammar packages carry a native-addon install script, but the
  `.wasm` file is already in the package. pnpm 10 does not run dependency install scripts unless
  allowed, so no compiler is needed and no package script runs on install.
- **Not `tree-sitter-wasms`.** It bundles grammars from the 0.20 era, was last published in
  October 2025, and pins its users to an old `web-tree-sitter`.
- **One pipeline.** `go/parser` gives syntax without types, as tree-sitter does, so it brings no
  precision, only a second extractor to keep in step with the first. Precision comes from
  typed indexers ([D12](#d12--precision-scip-right-after-the-first-index-dataflow-later)).

**Rules out.** Native Node bindings (`node-gyp`, a C toolchain on every machine), and one parser
per language.

## D4 — TypeScript on Node 24 and later

**Decision.** Esper is written in TypeScript and runs on Node 24 or later. Both are LTS lines: 24
until April 2028, and 26, which becomes LTS on 2026-10-28, until April 2029. Node runs the
TypeScript sources directly by stripping types, so working on Esper has no build step; TypeScript
7.0.2 type-checks (`tsc --noEmit`). The code uses only syntax that can be stripped: no `enum`, no
`namespace`, no parameter properties (`erasableSyntaxOnly`). Two things are built: the web interface,
by Vite, and the published `esper-cli` package, compiled to JavaScript by `tsc`, because Node does
not strip types in files under `node_modules`.

**Why.** The MCP SDK, tree-sitter's WebAssembly runtime, the HTTP server and the web interface are
all TypeScript, so one language covers the whole tool, and a contributor reads one codebase. A
compiled language (Rust, Go) would parse faster, but an audit indexes one target of a few thousand
files, where parsing takes seconds, and the web interface would stay in TypeScript anyway.

**Rules out.** A bundler for the server; Bun or Deno as the reference runtime; TypeScript syntax that
Node cannot strip.

## D5 — Two kinds of target: applications, and the frameworks themselves

**Decision.** Esper indexes two kinds of target, and every framework it supports is supported as
both:

- **An application built on a framework.** Its entry points are its routes: method, path, chain,
  handler, reads.
- **The framework itself** (chi, Hono, Next.js…). It has no routes of its own: the routes of its
  examples or tests would be an arbitrary denominator. Its entry points are its **request surface**:
  the exported symbols and the internal handlers that read the incoming request, and what they read.
  This is where framework vulnerabilities live: an internal header accepted from the client, a path
  normalised twice, a middleware that a crafted request skips.

Order of support:

1. **Go**: **chi**, and `net/http` on its own. Plain `net/http` gets an application profile only, for
   applications routed by `http.ServeMux`; the standard library itself is not a target, and chi's
   framework profile covers the `net/http` types chi reads.
2. **TypeScript**: **Hono**, then **SvelteKit**, then **Next.js**.
3. **Python**: **FastAPI**, with router prefixes and `Depends`.
4. Then Express, Nuxt and the others, as targets ask for them.

**Why.** chi, Hono and Next.js are framework targets as well as the base of application targets,
so both modes are needed from the first framework. Hono comes first in TypeScript because it is
small, which makes its framework mode measurable by hand, and it runs on the standard `Request`,
which most newer frameworks share. Next.js comes after SvelteKit because its framework mode is
large: its server reads internal headers across many files. FastAPI comes next for Python because
its prefixes and dependency injection are where route extractors get things wrong. Each framework
after that is a pair of profiles, not new code ([D10](#d10--frameworks-as-profiles)).

**Rules out.** Breadth first. A framework counts as supported only when both its profiles are
measured against a real target ([D16](#d16--measured-against-hand-counted-targets)).

## D6 — The graph model

**Decision.** A graph is a **snapshot**: one target at one commit. It holds:

| Kind | What it is |
|---|---|
| `file` | a source file that was read |
| `decl` | a declaration: function, method, class, or a property holding a function (`actions.create`) |
| `external` | a library symbol the target calls or imports, named by its import path, so that two importers share one node |
| `entry` | an entry point: a route of an application; for a framework, an exported symbol or an internal handler that reads the incoming request ([D5](#d5--two-kinds-of-target-applications-and-the-frameworks-themselves)) |
| `advisory` | a published vulnerability of the target (GHSA, CVE, GO…), imported from OSV ([D19](#d19--past-vulnerabilities-advisories-linked-to-the-code-they-touched)) |

| Edge | From → to | Carries |
|---|---|---|
| `contains` | file → decl | |
| `imports` | file → file or external | the resolved path, through the target's aliases |
| `calls` | decl → decl or external | `resolved` or `guessed`, and the reason when guessed |
| `handles` | entry → decl | the handler |
| `chain` | entry → decl | the middleware in front of the handler, with its position |
| `affects` | advisory → decl or file | the precision of the link, the fix commit, whether this snapshot's version is `affected` or `fixed`, and whether the node changed since the fix ([D19](#d19--past-vulnerabilities-advisories-linked-to-the-code-they-touched)) |
| `flows` | entry or decl → decl | that a value flows from a read of the entry, or from a decl, to a decl that carries a sink, with the read and each step cited; filled by a dataflow analyzer ([D12](#d12--precision-scip-right-after-the-first-index-dataflow-later)) |

**Facts** sit on nodes:

- on an entry: its method and path, its **reads**, its **guards** and its **signals**;
- on a decl: whether it is a **guard** or a **sink**, the reads it makes, and its signals.

**Reads** are what the code takes from the request, named `<kind>` or `<kind>.<name>` when the name is
known (`header.X-Forwarded-For`, `path.id`, `query.page`, `body`):

| Read | What it is |
|---|---|
| `header` | a request header |
| `query` | a query-string parameter |
| `path` | a parameter of the route pattern |
| `body` | the request body, whole or decoded (`body.email` for a decoded field) |
| `cookie` | a cookie |
| `form` | a field of a form or multipart body |
| `host` | the `Host` the request names |
| `remoteaddr` | the client address as the server sees it (`r.RemoteAddr`); a forwarding header is a `header` read |
| `method` | the request method |
| `context` | a request-scoped value set by earlier middleware (`r.Context().Value`, Hono's `c.get`) |

A **guard** is a check that can refuse a request: a chain member, or a call in the handler that
returns an error response before the handler's work. Each guard has a kind, `authn`, `authz-role`,
`authz-owner`, `csrf`, `rate-limit` or `validation`, and comes from a profile
([D10](#d10--frameworks-as-profiles)). A model can claim that a custom function is a guard
([D17](#d17--model-enrichment-claims-beside-the-facts)), but a claimed guard is shown as such and
counts for no signal.

**Signals** are a closed vocabulary, versioned with the schema. Each is computed by a rule from
facts, never from a claim:

| Signal | Set when |
|---|---|
| `live-state` | the code changes state that outlives the request: it assigns a package-level or module-level variable (not a lazy `if x == nil` initialisation), deletes from it, or calls a method on it that writes |
| `retained-mutation` | the code modifies request state (path, headers, parameters, context) that later middleware, the handler or the framework reads again |
| `short-circuit` | a chain member can answer or return without calling the next one, so that what follows it is skipped for some requests |
| `data-write` | the code writes persisted data: a database, a file, a store the profile names |
| `data-read` | the code reads persisted data |
| `request-key` | a value from the request selects which record or object key is used (`WHERE id = path.id`, `obj[query.key]`) |
| `mass-assignment` | a decoded body is spread or bound into a stored object without a field list |
| `divergent-guard` | the entry lacks a guard kind that most of its sibling routes, under the same prefix or group, have |
| `callback-passed` | request state is handed to a function supplied by the caller (a hook, a callback, a user option) that can read or write it |
| `sink-reachable` | a decl that carries a sink is reachable through `calls` edges; reachability only, a `flows` edge says more |
| `fix-downstream` | the entry reaches a node that a past advisory affects ([D19](#d19--past-vulnerabilities-advisories-linked-to-the-code-they-touched)) |

A **sink** is a call that interprets, opens or starts something: a query built from strings, a file
path, a process, a URL fetched by the server, a template rendered unescaped. Sinks are listed per
language in the extraction queries and per framework in the profiles.

**Every fact cites its evidence** as `file:line`: a read, a guard, a signal, an edge. A fact
without a citation is not stored. **Every fact names its source**: `tree-sitter` with the profile
that produced it, the analyzer that imported it (`scip-go`, `joern`…), or `osv` and `git` for
advisories. The `flows` edge and the source field are in the schema from the first version, empty
until an analyzer fills them, so that adding an analyzer adds rows, never a migration.

**Why.** The citation is what lets an agent or an auditor check a fact in the code instead of
trusting it. The closed vocabulary is what makes a signal comparable across routes and across
targets. The snapshot is what makes notes and diffs between versions possible.

**Rules out.** Free-form tags as signals; facts inferred by a model.

## D7 — Stable references and fingerprints

**Decision.** Each node has a **reference** and a **fingerprint**.

- The reference is readable and stable: `src/auth.ts#requireUser`, `src/users.ts#Service.update`,
  `src/routes/+page.server.ts#actions.create`. File paths are relative to the target's root, with
  `/` as the separator. A name that occurs twice in a file takes an ordinal (`#init~2`); an
  anonymous function is named by its parent and its rank (`#handler/fn1`). Lines are never part of
  a reference, since an edit above would change it.
- **Other nodes:**
  - **A route**, in an application, is referenced by its method and its normalised path:
    `route:POST /api/projects/{id}/members`. Parameters are written `{name}` and catch-alls
    `{name...}`, whatever the framework's own syntax (`[id]` in SvelteKit, `:id` in Hono); the
    original pattern is kept as a fact.
  - **An entry of a framework** is its declaration's reference prefixed with `entry:`
    (`entry:middleware/realip.go#RealIP`).
  - **An external** is its import path and symbol: `ext:database/sql#DB.Exec`.
  - **An advisory** is its OSV identifier: `osv:GO-2026-4316`.
  - **A read** is named by the node that makes it and the read: `route:GET /users/{id}@path.id`.
    This is how a dataflow question names its start
    ([D12](#d12--precision-scip-right-after-the-first-index-dataflow-later)).
- The fingerprint is the SHA-256 of the node's tree-sitter tokens, comments and whitespace left out,
  and a declaration's own name too ([D21](#d21--a-declarations-fingerprint-leaves-its-name-out)).
  An entry's fingerprint also covers its chain and its handler.

**Why.** Findings, coverage and notes cite nodes, and must survive a reindex. The reference answers
"is it the same node?", and the fingerprint answers "has its code changed?". Keeping both apart is
what lets a note move with a renamed function, or be flagged when the code under it changes.

**Rules out.** Numeric identifiers as the only identity, and references that contain line numbers.

## D8 — Notes

**Decision.** A note is attached to one or more nodes, and has:

- a **kind**: `lead` (a hypothesis), `coverage` (this was examined from this angle, and what came
  out), `finding` (a confirmed issue), or `context` (anything else worth knowing);
- a **status** fitting its kind: `open`, `ruled-out` or `confirmed` for a lead; `open`,
  `reported` or `fixed` for a finding; none for coverage and context;
- a Markdown **body**, its **citations** (`file:line`), its **author** (an agent's name or a human)
  and its dates;
- the **fingerprint** of each node when the note was written;
- its **revisions**: an edit adds a revision rather than overwriting, and a deletion is recorded.

On reindex, each anchor is checked, and gets an **anchor state**, kept apart from the note's status:

| Anchor after reindex | The note |
|---|---|
| same reference, same fingerprint | stays `attached` |
| same reference, new fingerprint | is marked `stale`: shown, and flagged for review |
| reference gone, same fingerprint elsewhere | follows the code, and is marked `moved` |
| nothing matches | is marked `orphaned`, and kept |

A note is never dropped by a reindex. Notes are returned as data with their author: a note written
by an agent that read untrusted code may carry that code's instructions, and nothing that reads it
follows them.

**Why.** Notes are what an audit produces; losing one silently, or keeping one that no longer
matches its code, is worse than not having it. A note that is only excluded when its file
changes (as in 0's Learning) is lost to any unrelated edit in that file; anchoring on nodes avoids
it. Revisions let a human see what an agent changed.

**Rules out.** Notes stored inside the audited repository; hard deletion without a trace.

## D9 — Storage: one SQLite database per project, outside the target

**Decision.** One SQLite database per project ([D18](#d18--running-esper-one-home-many-projects)),
through Node's built-in `node:sqlite`, in write-ahead logging mode. It holds the snapshots of the
graph, the claims and the notes, in separate tables: snapshots can be rebuilt from the code, claims
from a model run, notes from nothing. The database lives in Esper's home, outside the audited
repository (`~/.esper/projects/<name>/esper.db` by default). Notes export to and import from JSON
Lines, for backup or for versioning in git.

**Why.**

- **Checked.** `node:sqlite` works without a flag on Node 24 and 26, and is marked *release
  candidate* in both. It adds no native dependency; `better-sqlite3` remains the fallback if its API
  moves.
- Several agents and the web interface write notes at the same time; SQLite with WAL handles that,
  where a folder of JSON files would need its own locking.
- Esper's queries are bounded traversals over graphs of a few thousand nodes, done in memory. A
  graph database (Neo4j, Memgraph, Kuzu) would add a server or an engine to run, and a query
  language to learn, for no gain at this size.
- Nothing is written into the target, which stays read-only data.

**Rules out.** A graph database; files written inside the audited repository.

## D10 — Frameworks as profiles

**Decision.** What is specific to a **language** lives in its extraction queries (tree-sitter `.scm`
files) for declarations and imports, and in its library file (`library.yaml`) for what library calls
do: which are sinks, which read or write persisted data, which decode a body. What is specific to a
**framework** lives in a YAML profile, validated against a schema before use:

- how a route is declared: a folder convention, a decorator, a call (`r.Get(...)`);
- route prefixes, groups and mounts;
- how middleware chains are built, and what a subtree inherits;
- the **sources**: how to reach the request from a handler, mapped to the reads vocabulary;
- the **guards**: calls that refuse a request;
- data writes and reads, framework sinks, import aliases (`$lib`), and templates rendered unescaped.

Each framework has **two profiles** ([D5](#d5--two-kinds-of-target-applications-and-the-frameworks-themselves)):
an **application** profile, used to index an application built on it, and a **framework** profile,
used to index the framework's own code. The framework profile names the request type and its
accessors in the framework's own sources (`*http.Request` in Go, `Request` and `c.req` in Hono), and
the internal headers and parameters the framework reads.

**Why.** Adding a framework then adds no branch to the indexer, and a profile can be drafted by a
model ([D17](#d17--model-enrichment-claims-beside-the-facts)) and reviewed by a human in one file.
The schema catches a broken profile before it produces an empty attack surface. The two profiles
differ because the questions differ: what an application exposes, and what the framework trusts.

**Rules out.** Framework names in the indexer's code.

## D11 — Indexing rules

**Decision.**

- **Read only.** The target is never built, run, or installed: no package install, no script, no
  compiler. Only its files are read.
- **Refuse rather than return nothing.** A target with no supported language, or a framework with no
  profile, is refused with the reason. An empty list would pass for an empty attack surface.
- **Say what was skipped.** Tests, examples, fixtures and vendored code are skipped by default, and
  every skipped folder is listed in the index result.
- **Reindexing.** A reindex reads the whole target; a commit already indexed is not indexed again
  ([D20](#d20--a-reindex-reads-the-whole-target), which replaces an incremental reindex).
- **Deterministic.** The same code and the same profiles give the same graph, byte for byte.

**Why.** The target is untrusted: its build scripts, its dependencies and its instruction files
are all ways to run code or steer an agent. Refusing and listing skips are what make the absence of
a route meaningful.

## D12 — Precision: SCIP right after the first index, dataflow later

tree-sitter reads syntax: it sees that `svc.update(id)` is called, not which `update` that is when
`svc` has no visible type. Two kinds of tools answer what it cannot.

- A **SCIP indexer** runs a language's real type-checker (`go/types`, the TypeScript compiler,
  Pyright) over the project and writes, in the SCIP format, where every symbol is defined and where
  it is referenced: [scip-go](https://github.com/scip-code/scip-go),
  [scip-typescript](https://github.com/sourcegraph/scip-typescript),
  [scip-python](https://github.com/sourcegraph/scip-python). It turns a guessed call edge into a
  resolved one.
- **Joern** (or CodeQL) builds a full code property graph, with control flow and data
  dependencies, and answers dataflow questions: does the value read from this header reach this
  sink, through which statements, past which checks.

**Decision.** In this order:

1. **SCIP comes right after the first index of each language**, as the second step of its support,
   before the next language starts: for Go, MCP comes first so that the index can be used, then
   scip-go ([roadmap](/roadmap/)). Measured on chi 5.3.2 with an earlier tree-sitter prototype of
   the call graph: 486 edges, of which 262 are guessed. More than half of the paths an agent follows
   would rest on a guess, which is too much to wait for. Esper's own index, which types what the
   syntax states, guesses 30 of 540 ([graph schema](/reference/graph/#go)); SCIP is still what
   resolves the rest, and the calls left without an edge: with scip-go, 1 of 618
   ([D22](#d22--precision-runs-inside-the-index-when-asked)).
2. **Dataflow comes later, on demand**: run for a question (this read, this sink), not for every
   index, and through Joern or CodeQL depending on the language.

**One analyzer contract, from the first version.** SCIP and Joern plug in the same way, and so does
any later engine (CodeQL, a language server):

| Part | What it is |
|---|---|
| **Manifest** | name, version, languages, what it provides (`edges.resolve`, `flows`), its container image, whether it answers per snapshot or per question |
| **Input** | the snapshot's source, mounted read-only, and for a per-question analyzer the question: a read and a sink, given by their references ([D7](#d7--stable-references-and-fingerprints)) |
| **Output** | one JSON Lines file in Esper's import format: edges to resolve, `flows` edges with their steps, each with its citations |
| **Import** | Esper validates every line against the schema, checks the citations against the snapshot, tags each fact with the analyzer's name and version, and rejects the file whole if any line fails |

An analyzer never writes to the database and never sees it: it reads code and writes a file.
SCIP is the first analyzer built on the contract, so the contract is exercised before Joern needs
it; adding Joern is then an image and a manifest, with no change to the core, the store or the
interface. A dataflow question is asked through MCP (`esper_flow_request`) or the interface, and
its answer appears as `flows` edges when the analyzer is done.

The container gets the source read-only, fetches dependencies with scripts disabled
(`go mod download`, `pnpm install --ignore-scripts`) and no network after that: a typed indexer
needs the target's dependencies, and installing them can run the target's install scripts.

**Why not dataflow first.** The attack surface (routes, reads, guards, signals) does not need it,
and it costs the most: Joern requires JDK 21 and a large heap, and CodeQL needs a build. An index
should take seconds; a dataflow question can take minutes, and should be asked when it matters.

**Rules out.** Running a typed indexer or a dataflow engine on the host, or installing the target's
dependencies with scripts enabled.

## D13 — The MCP surface

**Decision.** The server uses the v2 TypeScript SDK (`@modelcontextprotocol/server` 2.4.0, which
implements the 2026-07-28 revision of the specification), over stdio for a local agent and
Streamable HTTP for the rest. The tools read the project's snapshots and their
differences, its entry points, a node with its facts, code, notes and past advisories, callers,
callees and paths, a search, a range of lines, the notes, and the claims of a model; five write:
`esper_index`, `esper_claim_submit` and the three note tools (`esper_note_create`,
`esper_note_update`, `esper_note_delete`). Two more come with the dataflow analyzer
([D12](#d12--precision-scip-right-after-the-first-index-dataflow-later)): `esper_flows`, the `flows`
edges of a node, and `esper_flow_request`, which writes a dataflow question. Each tool, its inputs,
outputs and bounds are in the [MCP reference](/reference/mcp/), written from the code.

Every tool that reads the graph takes an optional `snapshot`, and reads the latest one without it.
Every answer is bounded and says when it was cut. A node is named by its reference, a `file:line`,
or its name. A server started **read-only** exposes none of the tools that write.

**Why.** Bounded answers are what an agent can afford to ask often. Read-only mode lets a
workflow decide which agents may write notes, for example a hunter that proposes leads and a
reviewer that does not. The v2 SDK is the stable line; v1 receives only fixes.

## D14 — One server for the API, MCP and the web interface

**Decision.** `esper serve` starts one local process with [Hono](https://hono.dev/): a JSON API for
the web interface, the MCP endpoint, and the interface's static files. It listens on localhost only,
and requires a token. The interface is a React application built with Vite. It never draws the
whole graph: it draws bounded subgraphs (an entry point's chain, handler and what it reaches; a
path from a route to a sink) with React Flow (`@xyflow/react` 12) and a layered ELK layout
(`elkjs`). Overviews are tables: routes grouped by chain, by read or by signal.

**Why.** One process means one source of truth for the graph and the notes, and the interface sees
an agent's note as soon as it is written. A whole call graph drawn at once is unreadable;
an auditor reads a route and what it reaches. Layered layouts show a call path left to right, the
way it is read. The visual design is done in Claude Design against the API.

**Rules out.** A hosted service; a server listening on all interfaces; a "hairball" view as the
home screen.

## D15 — Repository layout and licence

**Decision.** A pnpm workspace:

```
packages/core          # @esper/core: parsing, graph model, references, profiles, storage
packages/core/queries  # tree-sitter extraction queries, one folder per language (.scm)
packages/mcp           # @esper/mcp: MCP tools over core
packages/enrich        # @esper/enrich: the providers of model enrichment
packages/server        # @esper/server: HTTP API, MCP endpoint, static files
packages/cli           # esper-cli on npm: the `esper` command
apps/web               # @esper/web: the web interface
profiles/<framework>   # the two profiles, their fixtures and their hand counts
schemas/               # JSON Schemas: profile, analyzer import, claims
analyzers/<name>       # an analyzer's manifest and container image
docs/                  # this documentation
scripts/               # fetching the counted targets, measuring claims, writing the MCP reference
```

Every package but `esper-cli` is private to the workspace. `docs/` joins the workspace, so the
repository has one lockfile. One command-line entry point, `esper`
([D18](#d18--running-esper-one-home-many-projects)). Licence: **Apache-2.0**.

**Tooling**, set in M0:

- **pnpm 10**, pinned in `packageManager`; Node 24 or later in `engines`, and `.nvmrc` set to 24. No
  dependency runs an install script, and a version published less than a day ago is not installed
  (`minimumReleaseAge`).
- **TypeScript** with `strict`, `noEmit`, `erasableSyntaxOnly`, `verbatimModuleSyntax`,
  `module: nodenext` and `allowImportingTsExtensions`, so that imports name the `.ts` file Node runs
  ([D4](#d4--typescript-on-node-24-and-later)).
- **Tests** with Node's own runner (`node --test`), which runs the TypeScript sources as they are.
- **Lint and format** with Biome 2.
- **CI** on GitHub Actions: type-check, lint, tests, on Node 24 and 26.

**Why.** The core is used by three surfaces and must not depend on any of them. Apache-2.0 is
permissive like MIT, and adds an explicit patent grant; it is also the licence of the MCP SDK.

## D16 — Measured against hand-counted targets

**Decision.** Each profile ships with fixtures, and is measured against at least one real target
whose entry points were counted by hand. A profile counts as supported when, on that target, no
entry point is missing and none is invented. Each index also reports its share of `resolved`
edges. Fixtures live in `profiles/<framework>/fixtures/`, and each hand count in
`profiles/<framework>/counts/<target>@<commit>.yaml`: the target, the commit it was counted at, and
every entry point with its citation, so that the measure is a test.

**Why.** An index that misses a route hides part of the attack surface, and no one notices an
absence. Counting by hand once is the only way to know the extractor's recall; the share of
resolved edges says how far its call graph can be trusted.

## D17 — Model enrichment: claims beside the facts

ZeroPath enriches its call graph with what parsing cannot see, and part of that comes from a model:
an application's authentication procedure, and the role of a function. Esper does the same, without
letting a model's answer pass for a parsed fact.

**Decision.** A model adds **claims**, a layer kept apart from the facts, in two tiers: a bounded
call for most questions, and an agent that explores the code for the rest.

### The questions

Closed questions, asked only about nodes reachable from an entry point, plus a few about the whole
repository:

| Question | Scope | Tier |
|---|---|---|
| is this function a **guard**, and of which kind (`authn`, `authz-role`, `authz-owner`, `csrf`, `rate-limit`, `validation`)? This is how a custom helper such as `assertCanEdit` becomes a guard that no profile could name | a node | bounded first |
| does this call **write or read persisted data**, or act as a **sink**, when the profile does not say? | a node | bounded first |
| what is the function's **intent**, in one line? | a node | bounded first |
| for a framework target, where does a value from the request (a header, a parameter) become **trusted** to take a decision? | a read and what it reaches | exploring |
| which **applications** does the repository hold, and where are their boundaries? | the repository | exploring |
| what is each application's **authentication procedure**, and where is it configured? | an application | exploring |

Every closed answer has an `insufficient-context` value: a bounded call that cannot answer says so,
and the question moves to the exploring tier.

### The two tiers

1. **Bounded.** One call, no tools. The question carries its context: the node's code, the
   signatures it calls, the facts already on it. Cheap, parallel, and the same answer for the same
   code. Most questions should end here.
2. **Exploring.** An agent that reads what it needs, through Esper's MCP tools in **read-only**
   mode, and nothing else:
   - `esper_search`, `esper_node`, `esper_callers`, `esper_callees`, `esper_paths` to move through the
     graph;
   - `esper_read` to read a range of lines from a file of the snapshot.

   It has no shell, no network, no write access, and no file outside the snapshot. Every read it
   makes is logged with the claim it produces. It runs on a turn cap, and answers with the same
   schema as the bounded tier.

Exploring through Esper rather than through the file system gives the same reach as reading,
searching and listing files, with three differences. The agent is **confined** to the target: an
injection in the audited code can at worst produce a wrong claim, which the checks below catch or
mark. Its reads are **traced**, so a claim says what it rests on. And the graph answers in one call
what an agent would grep for, slowly and incompletely: who calls this, by where does this route
reach that sink.

Why not explore everything: OpenAnt has an agent explore every reachable function, and reports on
OpenSSL a median of 9 iterations per function, about $0.13 per iteration, and a cap of 20
iterations, about $10.92 ([article](https://knostic.ai/blog/openant)); 390 functions put that in
the hundreds of dollars per target, or a large share of a plan's limits. Two tiers spend that only
where it is needed. The share of questions that reach the exploring tier is measured on the first
targets ([M6](/roadmap/#m6--enrichment-and-past-advisories)): if it is high, the bounded tier is not
paying for itself and is dropped.

### The checks

- **Each claim is checked and dated.** It names its node, its question and its answer, cites
  `file:line`, and records the model, the tier, the prompt version and the fingerprints of the
  nodes it rests on: the node asked about, and for an exploring claim every node it read. Code
  checks each citation: the line must exist and contain the identifier the claim names, or the claim
  is rejected. A claim is reused until one of those fingerprints changes.
- **A claim never becomes a fact.** It never sets a signal on its own, is shown as *claimed by a
  model* in the interface and returned apart from facts over MCP, and can be confirmed or contested
  by a note. The index works without any claim.
- **Profile drafting.** A model drafts a framework's profiles from its sources and documentation; a
  human reviews them before use ([D10](#d10--frameworks-as-profiles)).

### How it runs

Esper calls a model through a **provider**, and ships two.

1. **`claude-code`, the default: the auditor's own Claude Code and its plan.** Esper runs the
   `claude` binary already installed and signed in on the machine, headless (`claude -p`). It uses
   whatever sign-in that Claude Code has, a Pro or Max plan included; Esper never sees, stores or
   asks for a credential, and implements no sign-in of its own. Anthropic's support page states
   that the Agent SDK, `claude -p` and third-party app usage draw from the plan's limits when signed
   in with a Claude plan; the separate credit announced for 2026-06-15 was paused
   ([Claude support](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)).

   A bounded run answers a batch of nodes, with no tools and no MCP server:

   ```sh
   claude -p --tools "" --strict-mcp-config \
     --model opus --effort low --max-turns 1 --no-session-persistence \
     --output-format json --json-schema "$(cat claims.schema.json)" < batch.txt
   ```

   An exploring run answers one question, with no built-in tool and only Esper's read-only server:

   ```sh
   claude -p --tools "" --strict-mcp-config --mcp-config esper-readonly.json \
     --allowedTools "mcp__esper__*" --permission-mode dontAsk \
     --model opus --effort medium --max-turns 20 --no-session-persistence \
     --output-format json --json-schema "$(cat claims.schema.json)" < question.txt
   ```

   `--json-schema` takes the schema itself, as a JSON string, not a path; Esper passes it inline.
   `esper-readonly.json` declares one server, `esper mcp <project> --read-only` over stdio, so the
   run needs no token and reaches no other project. Both commands were checked with Claude Code
   2.1.312, the exploring one without Esper's server, which does not exist yet.

   - **Started from Esper's home, never from the audited repository.** A `claude -p` run loads the
     hooks and MCP servers of its working directory without a trust prompt
     ([headless mode](https://code.claude.com/docs/en/headless)).
   - **Only what the tier needs.** `--tools ""` removes every built-in tool, and
     `--strict-mcp-config` ignores every MCP server but the one Esper passes: none for a bounded
     run, the read-only server scoped to the project for an exploring run. `dontAsk` denies
     anything else. Not `--disallowedTools "*"`: it also denies the internal tool that returns
     structured output, and the run ends without an answer.
   - **None of the auditor's customisations.** `--tools ""` and `--strict-mcp-config` still let a
     run load the user's hooks, plugins, skills and `CLAUDE.md` from `~/.claude`. Esper adds
     `--safe-mode`, which starts without them, if it still honours `--mcp-config`; otherwise
     `--setting-sources ""`. Settled in M6: `--safe-mode` drops `--mcp-config`, so bounded runs
     take `--safe-mode` and exploring runs `--setting-sources ""`
     ([D31](#d31--enrichment-as-built-questions-checks-and-two-providers)).
   - **Structured answers.** `--json-schema` returns the claims in Esper's schema; a run without
     valid output is retried once, then its questions are left unanswered.
   - **Bounded spend.** A few runs go in parallel, and Esper stops when the plan's limit is reached
     rather than retrying in a loop.

2. **`anthropic-api`: an API key, unattended.** `esper enrich --provider anthropic-api` calls the
   Claude API through the official TypeScript SDK. Bounded questions go through the Message
   Batches API (half price, asynchronous), with the shared context (profile, vocabulary,
   instructions) cached. Exploring questions run through the SDK's tool runner, with the same
   read-only tools called in-process.

The questions are also exposed over MCP (`esper_enrich_next`, `esper_claim_submit`), so an agent
already working on the target can answer them in its own session.

The provider is an interface: another model provider is one more implementation, and nothing else
in Esper knows which one answered, beyond the model name recorded on each claim.

### Which model

- **Bounded tier: Claude Opus 5.5 at low effort to start**, measured against a hand-labelled set of
  guards from the first targets. Taking a non-guard for a guard hides an unprotected route, the
  worst mistake the layer can make, so the measure starts from the most reliable model. Move this
  tier to **Claude Sonnet 5.5** if it matches on that set. With an API key the difference is small:
  for 1,000 nodes at about 3,000 input and 500 output tokens each, before thinking tokens, about
  $11 for Opus 5.5 and $5.50 for Sonnet 5.5 in batch (list prices of $4 and $20, against $2 and $10,
  per million input and output tokens, as of 2026-10-28, halved by the Batches API). On a plan, the cost is the plan's limits, which Opus uses faster, so the
  move is worth more there.
  Measured in M6 ([D31](#d31--enrichment-as-built-questions-checks-and-two-providers)): Sonnet 5.5
  at medium effort answered the 41 hand-answered questions as Opus 5.5 at low effort did, all
  right, with as many tokens at half the cost; the bounded tier moved to **Sonnet 5.5 at medium
  effort**. At low effort, 7 of Sonnet's answers failed their citations.
- **Exploring tier: Claude Opus 5.5 at medium effort**, capped at 20 turns. These are the hard
  questions, and there are few of them.
- **Profile drafting: Claude Opus 5.5 at high effort.**
- **Parallel runs, driven by code, not a crowd of agents.** Esper knows the questions in advance and
  hands them out; a model orchestrating subagents would spend tokens on what a loop does, and give
  a different split on each run.

**Rules out.** Model output stored as facts or signals; Esper handling a credential or a sign-in;
an enrichment run with a shell, file or network tool, with any MCP server but Esper's read-only one,
or started from the audited repository; exploring every node by default.

## D18 — Running Esper: one home, many projects

**Decision.**

- **Install.** One package on npm, `esper-cli` (the name `esper` is taken), which provides the
  `esper` command. Docker is needed only for the precision steps
  ([D12](#d12--precision-scip-right-after-the-first-index-dataflow-later)).
- **One home, many projects.** Esper keeps everything in its home, `~/.esper/` (or `ESPER_HOME`):
  one folder per project, holding its database. A project is a name and a source.
- **Add a project** from the command line or the web interface:
  `esper add ~/code/budget` reads a local folder in place and never writes to it;
  `esper add https://github.com/honojs/hono` clones it into the project's folder (cloning runs none
  of the target's code). The project is named after the folder or the repository (`budget`,
  `hono`), or by `--name`.
- **Index one or more versions.** `esper index hono` indexes the current checkout;
  `esper index hono --ref v4.6.0` reads that tag from git without touching the checkout. A project
  holds several snapshots, such as the vulnerable and the fixed version of a framework. A checkout
  with uncommitted changes gives a snapshot of its files as they are, labelled with its `HEAD`
  commit and marked `dirty`.
- **Serve.** `esper serve` starts the local server ([D14](#d14--one-server-for-the-api-mcp-and-the-web-interface))
  and prints its address and token: the web interface lists the projects, their snapshots and
  their notes.
- **Connect an agent to one project.** `esper mcp hono` over stdio, with `--read-only` if needed, or
  the HTTP endpoint `/mcp/hono`. A connection sees a single project: its tools take no project
  argument, and an agent working on one target cannot read another's notes.

Every command that acts on a project takes its name first: `esper add`, `esper index`,
`esper advisories` ([D19](#d19--past-vulnerabilities-advisories-linked-to-the-code-they-touched)),
`esper enrich` ([D17](#d17--model-enrichment-claims-beside-the-facts)), `esper mcp`, and
`esper notes export` and `esper notes import`, notes to and from JSON Lines
([D9](#d9--storage-one-sqlite-database-per-project-outside-the-target)), which are not built yet;
`esper serve` and `esper list` take none. Each command and its options are in the
[command-line reference](/reference/command-line/).

The kind of target, application or framework
([D5](#d5--two-kinds-of-target-applications-and-the-frameworks-themselves)), is detected from the
profiles: each profile says how it recognises its target, by the manifest's module or package name
for the framework itself (`github.com/go-chi/chi/v5`, `hono`), and by a dependency on it for an
application. `--kind` overrides the detection, and a target that matches no profile is refused
([D11](#d11--indexing-rules)).

**Why.** An auditor works on several targets, and often on several versions of one, so projects and
snapshots are the unit of everything. Reading a local folder in place keeps the auditor's own
checkout as the source of truth. Scoping a connection to one project keeps agents, and the
untrusted text they may carry, from crossing between audits.

**Rules out.** One database for every project; a server that indexes whatever path a client sends.

## D19 — Past vulnerabilities: advisories linked to the code they touched

Where a vulnerability was fixed, the same defect often lives on next to it: in a sibling method,
another adapter, the same pattern elsewhere. And a share of a framework's advisories are bypasses of
an earlier fix. Knowing that a function was already fixed once, and how, tells a hunter where to
look first.

**Decision.**

- **Import the target's advisories from [OSV](https://osv.dev)**, which gathers the GitHub advisory
  database, the Go vulnerability database, PyPI, npm and others. The target's packages are read from
  its manifests (`go.mod`, `package.json`, `pyproject.toml`) and can be set with
  `esper add --package`. Advisories are fetched when a snapshot is indexed and refreshed with
  `esper advisories <project>`; this is the one network call Esper itself makes, and
  `esper index --offline` skips it.
- **Medium severity or more only.** An advisory is kept when its database rates it `MODERATE` or
  more, or, without a rating, when its CVSS base score is 4.0 or more. An entry without either takes
  the rating of its aliases: entries of the Go vulnerability database carry none, their GHSA alias
  does. An advisory still unrated after that is kept and marked `unrated`, rather than dropped. The
  import report counts the low ones it skipped: Hono has 52 advisories on OSV, 4 of them rated
  `LOW`.
- **Each advisory is an `advisory` node, linked by `affects` edges** to the code it concerns
  ([D6](#d6--the-graph-model)), each with how precise the link is:

  | Precision | Where the link comes from |
  |---|---|
  | `symbol` | the advisory names the function: entries of the Go database can list the affected symbols (chi's `RedirectSlashes`, `RealIP`), though not all do |
  | `fix-diff` | the advisory points to its fix commit, by a reference of type `FIX` or by any reference whose URL is a commit of the target's repository; the declarations its diff touches, read in the parent commit, are the ones linked. 41 of Hono's 52 advisories point to a commit this way, none with the `FIX` type |
  | `file` | only the file is known: the fix touches lines outside any declaration |

  An advisory with no symbol and no commit has its fix searched in the target's history
  (`git log --grep` with the advisory's identifiers). If none is found, it gets no `affects` edge
  and is marked `unlinked`, so that it is listed rather than lost. A model can propose a link for an
  unlinked advisory through the exploring tier
  ([D17](#d17--model-enrichment-claims-beside-the-facts)); its answer is a claim, never an `affects`
  edge.
- **The link follows the code across versions.** It is made on the version the fix changed, then
  carried to every snapshot by reference and fingerprint ([D7](#d7--stable-references-and-fingerprints)),
  like a note. On each snapshot the edge says whether the version is affected or fixed, from the
  advisory's ranges, and whether the node changed since the fix.
- **It feeds `fix-downstream`.** The signal is set on an entry point that reaches a node with an
  advisory, so that `esper_entrypoints` can list them and the auditor sees them first. Advisories
  are therefore linked before signals are computed.
- **Advisory text is data.** It comes from a third party, like the audited code, and is shown and
  passed on as such.

**Why.** The links are facts, not notes: they are imported from a source and can be rebuilt from it,
each cites the code it points at and, for `fix-diff`, the commit and hunk it comes from. Stating the
precision keeps a link from a symbol list apart from a guess from a filename. Low advisories are
mostly hardening and noise in a ranking meant to point at the code worth reading.

**Rules out.** Advisories written as notes; links proposed by a model stored as facts; scanning the
target's dependencies for known vulnerabilities, which is a dependency scanner's job.

## D20 — A reindex reads the whole target

This replaces the incremental reindex of [D11](#d11--indexing-rules), which said that a reindex
parses only the files whose hash changed.

**Decision.** Each index reads and parses every file of the target. A commit that is already
indexed, clean, by the same version of Esper with the same profiles and library data, is not
indexed again: `esper index` says which snapshot already holds it, and `--force` indexes it again.

**Why.**
- **Measured.** A full index takes 0.3 s for chi 5.3.2 (35 files) and 1.5 s for Wakapi (240 files),
  well below what would make anyone wait.
- **Not sound as stated.** What a file states depends on other files: a call is resolved from
  declarations elsewhere, a route's path from the routers it is mounted under, an entry's reads from
  everything it reaches. Reusing the facts of an unchanged file would keep facts that a change
  elsewhere made wrong. Doing it right means tracking those dependencies, a cost to pay only when a
  target makes indexing slow.
- **When to revisit.** When a target takes more than about 30 seconds to index, likely a framework
  the size of Next.js: parsing could then be cached per file hash, with the cross-file steps still
  run on the whole snapshot.

**Rules out.** Reusing facts from a previous snapshot for files that did not change.

## D21 — A declaration's fingerprint leaves its name out

This amends the fingerprint of [D7](#d7--stable-references-and-fingerprints), which hashed every
token of a node, the declaration's own name included.

**Decision.** A declaration's fingerprint leaves out the identifier that names it: `func Audit(…)`
and `func Record(…)` with the same parameters and body have the same fingerprint. Every other token
counts, the receiver of a method and a call of the function to itself included. A file's
fingerprint still covers the whole file.

**Why.**
- **What D7 promised.** The reference answers "is it the same node?" and the fingerprint "has its
  code changed?", so that "a note can move with a renamed function". With the name inside the
  fingerprint, a rename changes both, and a note on the function is `orphaned` rather than `moved`
  ([D8](#d8--notes)). Found while building the anchor states in M2.
- **Copies are told apart.** Leaving the name out gives functions with the same body the same
  fingerprint (chi's pass-through middleware, for one). An anchor moves only onto a node that was
  not already there with that code when the note was anchored, so a sibling with the same body is
  never taken for the renamed one ([notes](/reference/notes/#anchors-after-a-reindex)).

**Rules out.** Matching a renamed function by its name or position, which would move notes onto
code that only looks alike.

## D22 — Precision runs inside the index, when asked

This settles how the contract of [D12](#d12--precision-scip-right-after-the-first-index-dataflow-later)
runs for an analyzer that answers per snapshot, and what its output states. Built in M3, with
scip-go.

**Decision.**

- **When asked.** `esper index --precise`, or `precise` on `esper_index`, runs the analyzer that
  resolves the call edges of the snapshot's language: the one that answers per snapshot and provides
  `edges.resolve`. Without it, nothing changes: tree-sitter alone, and no Docker
  ([D18](#d18--running-esper-one-home-many-projects)).
- **Inside the index.** The analyzer runs after the target is read and before the call graph is
  built, so that what an entry point reads and signals follows the resolved edges, not the guesses.
  A precise index is a snapshot of its own: the analyzer, by its name, version and the hash of its
  folder, is part of what indexed it ([D20](#d20--a-reindex-reads-the-whole-target)), and the
  snapshot lists it (`analyzers`).
- **A refused file fails the index.** Nothing is stored, and the error names the first line that
  failed. The index never falls back to tree-sitter alone without saying so.
- **Places, not references.** An analyzer does not know Esper's references
  ([D7](#d7--stable-references-and-fingerprints)). It states that the name at a place refers to the
  function or method defined at another place, or to a symbol outside the snapshot, and which
  methods implement which interface methods. A place is a file, a line, a column in UTF-8 bytes,
  and the name found there. Esper checks that the name is at that place in the snapshot's file, and
  maps the place to a node with tree-sitter: the callee of a call, the name of a declaration. This is
  what every SCIP indexer gives, so scip-typescript and scip-python will need no new line type.
- **What it settles.** The callees of calls, of functions returned as values, of handlers and chain
  members that are the module's own, and of the calls a profile's reads name. Routers and adapters
  are still recognised by the names the profiles give them, as the syntax states them: a type
  checker names a method by the type that declares it, which is not always the one a profile
  lists. A call to a build variant (`sock_unix.go`, `sock_windows.go`) stays a guess to each, since
  the analyzer type-checks one platform.
- **Interfaces.** A call through a method of an interface of the module is resolved to each method of
  the module that the type checker says implements it, and the edge names the interface method
  (`data.interface`). The set is computed from types, not from names; which of them runs is a
  question for dataflow ([D12](#d12--precision-scip-right-after-the-first-index-dataflow-later)). A
  method of an interface outside the module stays a call to that external symbol, as before.
- **The tree the analyzer sees.** Every regular file of the commit, or of the folder (tracked and
  untracked, not ignored), not only the files Esper reads: a type checker needs `go.sum`, embedded
  files and vendored code. The files Esper read are written as it read them; links and submodules
  are left out. The analyzer is told which files are the snapshot's, and cites only those.
- **The container.** Built by Esper from `analyzers/<name>/Dockerfile`, its base image pinned by
  digest and its tool by version, and tagged by the hash of the folder. It runs twice: once to fetch
  the dependencies, with the network, into the analyzer's cache volume, kept between runs and shared
  by projects since Go checks every module against its checksums; once to analyze, with no network
  and the volume read-only. Both runs have the source read-only, a read-only root, no capability, no
  privilege escalation and a user that is not root, and only the output folder is writable. For Go,
  the image sets `GOTOOLCHAIN=local` (a `toolchain` line cannot download a Go), the module proxy only
  with `GOVCS=*:off` (no version control command), `-mod=readonly` and `CGO_ENABLED=0` (no C
  compiler). Type-checking compiles the target's packages but runs none of its code, and only the
  output file leaves the container.
- **Schema 4.** Snapshots gain their `analyzers`; a database of schema 3 is brought to 4 in place,
  since a column is only added. Facts and edges still take an analyzer as rows, with their source
  ([D6](#d6--the-graph-model)).

**Why.**

- **Measured on chi 5.3.2.** scip-go 0.2.9 names the callees of 582 of chi's 646 calls. Guessed edges
  fall from 30 of 540 to 1 of 618, a call through a package variable holding a function, and calls
  left without an edge from 106 to 28. The 40 entry points are the ones counted by hand. It takes
  about 4 seconds once the image is built.
- **Measured on Wakapi.** Guessed edges fall from 567 of 5515 to none of 6666, and calls without an
  edge from 1437 to 299. The 71 routes are the ones counted by hand; the signals that
  `POST /api/plugins/errors` reached through a wrong guess go. It takes about 20 seconds, most of it
  fetching the dependencies.
- **Not after the fact.** Rewriting the call edges of a stored snapshot would leave its entry
  points' reads and signals computed from the guesses, and a snapshot that changes after it is
  written.
- **Not by default.** The first run builds an image and fetches the dependencies, over the network;
  an index without Docker must still work.

**Rules out.** Editing a stored snapshot with an analyzer's output; a silent fallback when an
analyzer fails or its file is refused; analyzers that write Esper's references.

## D23 — A language is a module; the core names none

This settles how the second language of [D5](#d5--two-kinds-of-target-applications-and-the-frameworks-themselves)
joins the core built for Go in M1, and how the roadmap's M4 criterion, "nothing under
`packages/core` had to learn about TypeScript or Hono by name", is read. Built in M4.

**Decision.**

- **A language module** says, for one language: which files it reads (sources and manifests), which
  are tests, the modules a target declares and their dependencies (`go.mod`; each `package.json`),
  what its files import, and how its files are indexed with a profile. Go's is `go*.ts`,
  TypeScript's `ts*.ts`, each beside its queries and `library.yaml`
  ([D10](#d10--frameworks-as-profiles)). `languages.ts` lists them; it is the one place that does.
- **The shared machinery names neither a language nor a framework**: reading a target, detecting its
  profile, the home, the store, notes, the analyzer contract, and the entry points. What every
  language did the same way moved out of Go's module into `entries.ts`: routes and their chains
  become entry nodes, guards come from the profile, reads and signals follow the calls, and
  divergent guards are found among siblings. A language module hands it routes, the facts of its
  declarations, and, for a framework, which declarations are its surface.
- **One language per snapshot.** A target whose matching profiles are of two languages is refused,
  with the folder of each part to add as its own project
  ([D11](#d11--indexing-rules)).
- **Checked by a test.** `packages/core/test/shared.test.ts` reads the code of every shared file,
  comments left out, and fails on the name of a language or a framework.

**Why.** D10 put framework knowledge in profiles; the same split for languages is what makes the
next one (Python, D5) a module and a profile, as M4 set out to show. The entry-point rules are the
attack surface's own, not Go's: had they stayed in Go's module, TypeScript would have copied them,
and the two would have drifted.

**Rules out.** A language named in shared code; a snapshot read in two languages at once.

## D24 — TypeScript and JavaScript, as their syntax states them

How the TypeScript module reads a target, with the grammars of
[D3](#d3--one-parser-tree-sitter-in-webassembly) (`tree-sitter-typescript` 0.23.2 for `.ts` and
`.tsx`, `tree-sitter-javascript` 0.25.0 for `.js`, `.mjs`, `.cjs` and `.jsx`). Built in M4.

**Decision.**

- **References** ([D7](#d7--stable-references-and-fingerprints)) name a function by what holds it,
  since TypeScript declares most functions as values: `const helper = () => …` is `#helper`, a
  method `#Service.update`, a function an object holds `#actions.create`, a private method
  `#Hono.#dispatch`, `export default` `#default`. A function literal given to the call whose result
  a top-level name holds is named after the name, `#auth/fn1` for
  `const auth = createMiddleware(async (c, next) => …)`. Only a literal no name holds is anonymous
  (`#createApp/fn3`), and only an anonymous literal is a literal in the graph.
- **Exported** is what an `export` names, with what callers reach through it: the public methods of
  an exported class, the functions of an exported object, and the functions given to the call an
  exported name holds.
- **Imports** resolve within the target: relative paths, with `.js` naming its `.ts` source and a
  folder its index; the `paths` of the nearest `tsconfig.json` or `jsconfig.json`, through its
  `extends` within the target; and the target's own packages, by the name each `package.json`
  declares, through `exports`, `types`, `module` and `main`, a built file (`dist/index.js`) looked
  for as its source (`src/index.ts`). Anything else is outside the target, named by its specifier
  (`ext:hono/cors#cors`), Node's built-in modules always with `node:`.
- **Types are what the syntax states**: a type annotation; a class constructed with `new`; the
  result type a function declares, or the one expression it returns; a field, a getter's result,
  a constructor's parameter property; `Promise<T>` as what awaiting gives, `ReturnType<typeof f>`,
  and `x as T`. A function literal takes its parameters' types from where it sits: a variable
  annotated with a function type, a function whose result type is one, a parameter declared as
  one, or an interface's call signature. What the syntax does not state, a profile may: a
  handler's first parameter is the profile's context ([D25](#d25--hono-middleware-in-the-order-it-is-registered)).
- **Calls** are resolved from those types; guessed, with the reason, through an interface or an
  abstract class (each class of the target that implements it), a class field the class's own code
  assigns (`this.getPath = strict ? getPath : getPathNoStrict`), a function taken from an object by
  a computed key (`detectors[name](c)`), and a member no type names when the target has one member
  of that name, unless values of any type have it (`map`, `then`, which `library.yaml` lists). A
  getter of the target's own classes is called when its property is read.
- **Measured** on Hono v4.13.14, 238 files: 2016 call edges, 109 guessed (5.4 %), and 1716 calls
  without an edge, most of them methods of values from outside the target (`res.headers.get`,
  `[].map`). On Kaneo's API, 687 files: 9980 edges, 103 guessed, 5197 calls without one. Indexing
  takes about a second for Hono, three for Kaneo.

**Why.** An index that names functions by their declarations only would name none of Hono's
middleware, which are `const` arrows; references must survive the same edits as Go's. Resolving
imports through the target's own configuration is what makes `@/users` and `@app/db` internal, as
`go.mod` does for Go; nothing outside the target is read (D11). Typing what the syntax states, as
Go does, keeps the guesses few and each one said; the type checker's answer comes from an analyzer
([D26](#d26--scip-typescript-with-the-dependencies-the-lockfile-pins)).

**Rules out.** Reading `node_modules` or a configuration outside the target; running the
TypeScript compiler on the host.

## D25 — Hono: middleware in the order it is registered

The two Hono profiles of [D5](#d5--two-kinds-of-target-applications-and-the-frameworks-themselves),
and what the profile format had to say for them. Built in M4.

**Decision.**

- **Order.** A Hono router applies a middleware to the routes registered after it whose path its
  own matches: `app.use('/admin/*', auth)` guards `/admin/stats` registered after it, and no route
  registered before. A profile says so with `ordered`; `app.route('/users', users)` places the
  sub-app's registrations where it is mounted, and `basePath('/api')` registers on the same router
  under a prefix (`does: prefix`). A path pattern matches a route when every request to the route
  matches it: a parameter matches any segment, `*` the rest of the path or nothing.
- **What a route is.** `get`, `post`, `all`, `on([…], …)` and the rest, the middleware between the
  path and the handler (`args: [path, chain, handler]`), and `@hono/zod-openapi`'s
  `openapi(createRoute({ method, path, middleware }), handler)`, whose configuration object gives
  the method, the path, written with braces, and the chain (`config`, `through`). A router a
  function builds and returns is one per call: each `apiRouter()` is a router of its own.
- **What a handler receives.** Its first parameter, when its code states no type, is the profile's
  `context`, `hono#Context`; so is a function typed by one of the handler types the profile lists
  (`hono#MiddlewareHandler`). The reads of `c.req` are rules on that context, and
  `c.req.valid('json')` reads the body, `valid('param')` a path parameter (`by`). A destructured
  read is named by its properties: `const { id } = c.req.valid('param')` reads `path.id`.
- **Guards** are Hono's basic auth, bearer auth, JWT and JWK, CSRF, body limit, IP restriction, the
  validators and `hono-rate-limiter`; **sinks** of the framework (`c.redirect`, `raw`, `proxy`) and
  **mutations** of request state (`c.set`) are in the profile, beside the language's in
  `library.yaml`.
- **The framework itself.** Hono's request surface is each exported declaration, and each function
  that takes the request or the context, that reads the request through what it reaches. A type
  of the target is named by its package and its name, so that the framework's own `Context`,
  declared in `src/context.ts` of the package `hono`, is `hono#Context`, and the application
  profile's read rules apply to Hono's own middleware unchanged.
- **Measured.** Kaneo's API at v2.48.0: 211 routes, as counted by hand, every handler and chain
  member named. Hono v4.13.14: 108 entry points, as counted by hand, from CORS reading `Origin` to
  each adapter's `handle`.

**Why.** Kaneo registers its public routes, its webhooks among them, before `api.use("*", …)`
authenticates the rest: an index that applied every middleware to every route of a router, as is
right for chi, would show those webhooks as authenticated. Naming a framework's own types by its
package is what lets one set of rules serve both profiles, as `net-http` serves chi's.

**Rules out.** A route interpreter per framework; read rules written twice, once per mode.

## D26 — scip-typescript, with the dependencies the lockfile pins

The second analyzer on the contract of [D12](#d12--precision-scip-right-after-the-first-index-dataflow-later)
and [D22](#d22--precision-runs-inside-the-index-when-asked). Built in M4.

**Decision.**

- **The tool.** [scip-typescript](https://github.com/sourcegraph/scip-typescript) 0.5.2, its latest
  release (2026-10-22), with TypeScript 6.0.3, and pnpm 10.34.9 to install a target's
  dependencies, all pinned by the lockfile of `analyzers/scip-typescript/esper/` and installed
  without scripts, on Node 24.22.1, its image pinned by digest.
- **Fetching** reads the lockfile at the root of the snapshot's tree: `pnpm fetch` for
  `pnpm-lock.yaml`, `npm ci` for `package-lock.json` with the manifests of its workspace, from npm's
  registry whatever the target's `.npmrc` says, with scripts disabled and pnpm kept at its own
  version whatever `packageManager` names, into the analyzer's cache volume. What it writes is checked against the lockfile's
  integrity hashes.
- **Analyzing** copies the tree into the container's memory, installs from the cache without the
  network, the volume read-only, and indexes each TypeScript project that holds files of the
  snapshot, by its `tsconfig.json`; a `tsconfig` that extends one neither in the tree nor in an
  installed package is read without it. A target without a lockfile, such as a folder whose lockfile is in the repository above it,
  is analyzed without its dependencies.
- **What it states.** A reference for each name whose symbol the index defines in the snapshot or
  outside it, and an implementation for each method that implements an interface method of the
  snapshot. A name that refers to several symbols (a member of a union type) and a name renamed by
  an import are left out, since a place refers to one target and both places hold the same name
  (D22). Outside the snapshot, a symbol is named by its package and its names
  (`drizzle-orm#PgDatabase.select`), the runtime's own by `globalThis` and Node's by `node:`; where
  the syntax names the same call outside the target too, its name is kept, since it is the module
  the code imports and the one profiles and `library.yaml` name (`hono/cors#cors`).
- **Measured.** Hono v4.13.14: guessed edges fall from 109 of 2016 to 12 of 3268, calls without an
  edge from 1716 to 432, in about 12 seconds once its image and dependencies are there. Kaneo's
  API, without the dependencies of its repository: calls without an edge fall from 5197 to 3927.
  Both keep the entry points counted by hand.

**Why.** A type checker needs the target's dependencies to name what their calls are, and
installing them is where a target's code could run; a lockfile with integrity hashes, scripts off
and the network only while fetching is what D12 asked. The import name is kept for symbols outside
the target because SCIP names the package that declares a symbol, which is not always the module
the code imports it from.

**Rules out.** Installing with scripts, or from a registry the target names; an analysis that falls
back silently when an install fails (it fails the index, D22).

## D27 — A guarding chain member is known by the code that refuses

This amends how divergent guards compare chain members ([D6](#d6--the-graph-model)): a member that
can answer on its own was known by what it names.

**Decision.** A chain member that short-circuits is known by the declarations that refuse, the ones
it reaches that carry `short-circuit`, rather than by the function it names.
`workspaceAccess.fromTask()` and `workspaceAccess.fromProject()` build the same middleware, so a
route with one is not missing the other.

**Why.** Measured on Kaneo: comparing members by the factory they name flagged 48 of its 211 routes
as divergent, nearly all of them routes that check workspace access through another factory of the
same check. Compared by the code that refuses, 10 are, each lacking a check its siblings make: the
billing webhook, GitHub's application information, imports that take their project from the body.

**Rules out.** Two guards told apart by how they are written or which factory builds them.

## D28 — The server: a token kept in the home, events from the database

This settles how [D14](#d14--one-server-for-the-api-mcp-and-the-web-interface)'s server is reached
and how it stays current.

**Decision.**

- **A token kept in the home.** `esper serve` makes a random token once and keeps it in
  `$ESPER_HOME/token`, readable by its owner only. Agents send it as a bearer token to
  `/mcp/<project>`. The interface is opened at an address that carries it, and trades it for an
  `HttpOnly`, `SameSite=Strict` session cookie.
- **This machine only.** The server listens on `127.0.0.1`, and refuses a request whose `Host`
  names another host or whose `Origin` is not its own, port included, and a body not sent as
  JSON. The interface's page loads nothing from elsewhere; its fonts are bundled.
- **One connection per project.** The JSON API and the MCP endpoint of a project share one store
  and one cache of loaded snapshots. The API runs the MCP tools for everything they answer, so
  that both surfaces have the same bounds and refusals.
- **Events found in the database.** While someone listens, the server looks every half second, and
  at once after it writes, at each open project's newest snapshot and count of note revisions, and
  sends what is new as server-sent events. An index runs as a job whose progress and result are
  events too.
- **The MCP endpoint** is the SDK's `createMcpHandler`, one per project, serving the 2026-07-28
  revision and, statelessly, earlier clients.

**Why.**
- **A token that survives a restart.** An agent's MCP configuration names the token; one made at
  each start would break every configuration at each restart. A file readable by its owner only is
  as safe as the databases next to it.
- **A cookie, not a token in each request.** `EventSource` sends no header, and a token kept in the
  page's storage is readable by any script on it. An `HttpOnly`, `SameSite=Strict` cookie is sent
  only by the interface's own pages.
- **Host and Origin.** Listening on localhost does not stop a page elsewhere from reaching the
  server: DNS rebinding makes another name resolve to `127.0.0.1`. Checking `Host` and `Origin`
  closes that, as the MCP SDK advises for a local endpoint. The port counts too: a page another
  server on this machine serves is the same site for the browser, which sends it the cookie; its
  `Origin` names its own port, and a body it could send without a preflight is not JSON.
- **The database, not the process.** An agent on `esper mcp` writes from another process
  ([D18](#d18--running-esper-one-home-many-projects)); only the database sees every writer. Two
  counts per project, every half second, cost nothing measurable, and need no change to how notes
  are written.

**Rules out.** A token on the command line or in a URL left in the history; a server reachable from
another machine; events that only the server's own writes produce.

## D29 — The map: a group's shared code, drawn bounded

This adds a view to [D14](#d14--one-server-for-the-api-mcp-and-the-web-interface), whose overviews
were tables only.

**Decision.** Beside the tables, the entry points can be shown as a map: one group of them (a chain
group, a signal, a read, at most 100 entry points) around the edge, and in the middle the
declarations that at least a few of them call directly from their handlers, each sized by how many
do. A library symbol is drawn only when a sink fact names it as its callee, unless asked. The map
holds at most 40 shared nodes and says what it left out.

**Why.** The auditor asked for a view of bubbles linked to each other. A table says which routes
share a chain; it does not say which code many routes reach, which is where one flaw reaches many
routes. Bounded by a group and by what its handlers call directly, the map stays readable, unlike
the whole call graph D14 rules out. A sink fact names its callee, so the map marks the redirect and
not the `Sprintf` on the same line.

**Rules out.** A map of the whole graph; a library symbol drawn as a sink because it is called on a
sink's line.

## D30 — Advisories belong to the project, and are placed on each snapshot

This settles how [D19](#d19--past-vulnerabilities-advisories-linked-to-the-code-they-touched) is
stored and how a fix commit is read. D19 asked for advisories linked before signals are computed;
here they are linked once per project and placed on a snapshot each time it is read. Built in M6.

**Decision.**

- **The project's, not a snapshot's.** Advisories, their links, and their state on each snapshot
  are tables of the project's database, like notes ([D9](#d9--storage-one-sqlite-database-per-project-outside-the-target)).
  When a snapshot is read, each advisory becomes an `advisory` node, each link an `affects` edge
  placed on the snapshot's code, and `fix-downstream` a signal on the entry points that reach one
  ([D6](#d6--the-graph-model)). Stored snapshots are never rewritten: `esper advisories` refreshes
  every snapshot at once, and a snapshot indexed `--offline` still gets the advisories already
  fetched. Schema 5 adds the tables; a database of schema 3 or 4 is brought to 5 in place.
- **One advisory per alias group.** OSV returns the Go database's entry and GitHub's for one flaw;
  they are one advisory, known by the entry that says most about the code: one that names
  functions, then one with a `FIX` reference, then one its database rates. An advisory no entry
  rates takes the rating of up to five aliases fetched apart, then the base score of a CVSS 3
  vector, computed as the specification says. A CVSS 4 vector alone leaves it `unrated`.
- **Which link.** The functions an advisory names (`symbol`), found in each snapshot by name in the
  package's folder; otherwise each fix commit the repository holds, from a commit URL among the
  references or a git range (an abbreviated id only from a URL of one of the target's remotes,
  since another repository's short id could name an unrelated commit of the target); otherwise the commits of every branch and tag whose message names the
  advisory or an alias, at most five (`git log --all -F -i --grep`).
- **How a fix is read.** Its diff against its first parent, so that a merge commit is read as the
  change it brought. Only the source files the index reads count: a fix that touches tests and
  documentation alone links nothing. Each changed line of the parent is given to the innermost
  declaration that spans it; a file is the link only when none of its changed lines is in a
  declaration. Lines added between two declarations link nothing: they are new code, which the
  parent did not hold. Only the touched files are parsed, at the parent and at the fix: a
  declaration's reference and fingerprint depend on its own file alone. An advisory whose fix
  cannot be read is kept `unlinked`, with why, and the others are saved.
- **States computed once.** An advisory's state on a snapshot is computed when either is new, or
  when the advisory's entry changed; fetching again an unchanged advisory asks git nothing.
- **Placed by reference, then fingerprint.** A link keeps the node's reference and its fingerprints
  before and after the fix. On a snapshot, it goes to the node of that reference, else to a node of
  the same kind with either fingerprint (`movedFrom`), else nowhere: the advisory says how many
  links its snapshot does not hold. The edge says whether the node's code is as the fix left it,
  as it was before the fix, or changed since.
- **Affected or fixed.** From the advisory's version ranges, when the snapshot has a version: its
  ref, or a tag that names its commit, read as a semantic version (`folder/v1.2.3` for a module in a
  folder). Otherwise from the fix commits: `fixed` when the snapshot's commit holds one, `affected`
  when it holds none. `unaffected` is a version before the flaw came in; `unknown` is neither.
- **`fix-downstream`** is set on an entry point whose handler or chain reaches, through calls, a
  declaration an advisory affects, one fact per advisory with the declaration (`via`), the part
  (`handler`, `chain`) and whether a guessed call was on the way. A link to a file sets nothing: no
  declaration is known to be reached.
- **Measured** against hand-checked files in `profiles/<framework>/advisories/`, from OSV's answers
  as recorded on 2026-10-28, on each target's whole history, which `pnpm fetch-targets` fetches
  for these targets:
  - **chi** at v5.3.2: 8 entries, 6 advisories, none low. The four that name `RedirectSlashes` or
    `RealIP` are linked by symbol; GO-2025-3770 and GHSA-j6qf-3m9c-vwj3 by their fix commits. All 10 links are placed; five
    of chi's 40 entry points carry `fix-downstream`.
  - **Hono** at v4.13.14: 52 advisories, 4 rated low, as D19 says; of the 48 kept, 38 point to a
    commit of Hono (41 of the 52, none with the `FIX` type), 37 linked to declarations and 1 to a
    file. The 10 others name no commit and no commit names them: `unlinked`. All 48 are fixed at
    v4.13.14; 95 of their 108 links are placed, and 60 of the 108 entry points carry `fix-downstream`. Fetching
    and linking takes about 8 seconds.

**Why.**

- **A snapshot that does not change.** D22 refused to edit a stored snapshot with an analyzer's
  output; the same holds for advisories, which change on OSV long after a snapshot is indexed. Kept
  apart and placed when read, as notes are, a new advisory reaches every version at once.
- **The parent, read narrowly.** A declaration the fix changed is where the flaw was; a declaration
  the fix added is not, and a file a fix only added types to would link every advisory to its
  file. Measured on Hono: counting added lines linked GHSA-3vhc-576x-3qv4 to `jwa.ts` and
  `types.ts`, which only gained new types and error classes.

**Rules out.** Advisory rows written into a snapshot's tables; a link made from an added line, or
from a test file.

## D31 — Enrichment as built: questions, checks, and two providers

This settles what [D17](#d17--model-enrichment-claims-beside-the-facts) left open: which nodes are
asked about, what an answer is and how it is checked, when a claim is asked again, and how each
provider runs. Built in M6.

**Decision.**

- **The questions** ([claims](/reference/claims/)): `guard` for each chain member, handler and
  declaration a handler calls directly; `effects` for each declaration an entry point reaches that
  calls outside the target with no fact saying what the call does; `intent` for each chain member
  and handler; and, for an agent, `trust` for each entry point of a framework that reads a header,
  the host or the client address, and `applications` and `authentication` for an application's
  repository. Chain members come first. A question is `<kind>:<subject>`, the same on every
  snapshot.
- **One answer schema** for both tiers and both providers (`schemas/claims.schema.json`): per
  question, a value from a closed list or `insufficient-context`, a kind for a guard or a sink, a
  text where the question takes one, citations as file, line and identifier, and a reason.
- **The checks.** A value the question does not take, a guard or a sink without its kind, a missing
  text, no citation, or a citation whose file, line or identifier does not match the snapshot
  rejects the answer, which is stored as a rejected claim with the first thing that failed:
  `citation mux.go:5: the line does not hold "http.NewServeMux()"`. An answer to a question its
  call did not carry is not taken.
- **Asked again** when a node a claim rests on has another fingerprint (a claim that rests on no
  node, such as one about the repository answered without reading, rests on every file of its
  snapshot), when the questions'
  version (`promptVersion`) changes, or when its claim was rejected. An `insufficient-context`
  bounded answer makes the question due in the exploring tier; an exploring answer, of any value,
  settles it until its code changes.
- **What an exploring claim rests on.** Each tool call of the run: its node, the ends of a path, the
  file of a range of lines. `claude-code` reads them from the trace of Esper's server
  (`esper mcp --read-only --trace`), `anthropic-api` from its own tool calls.
- **Models.** Bounded questions on Claude Sonnet 5.5 at medium effort, exploring ones on Claude
  Opus 5.5 at medium effort, up to 20 turns; `--model` and `--effort` choose others. What each run
  used, tokens and cost at list prices, is reported with its claims.
- **`claude-code` runs**, from `$ESPER_HOME/enrich/<project>/`, three at once, ten questions per
  bounded call:
  - a bounded run with `--safe-mode`, no tool and no MCP server, and the instructions as its system
    prompt (`--system-prompt`);
  - an exploring run with `--setting-sources ""`, Esper's read-only server by `--mcp-config`, the
    six read-only tools by name in `--allowedTools`, and `dontAsk`;
  - a run whose output has no structured answer is retried once; a run that failed and says the
    plan's limit is reached stops the enrichment, and the questions not asked stay due (a run that
    answered is never read as a limit, though its answer may speak of a rate limit).
- **`anthropic-api` runs** through `@anthropic-ai/sdk` 1.3.0: bounded questions in one Message
  Batch, the instructions cached, the schema as `output_config.format`; exploring questions through
  the tool runner, with the six tools of `@esper/mcp` called on the project's connection. A rate
  limit or a refused key stops the run. It is tested against a transport that answers as the API
  does; no run on the API was made, since no key was at hand.
- **A package of its own**, `packages/enrich` (`@esper/enrich`), beside those of
  [D15](#d15--repository-layout-and-licence): the providers need both the core and the MCP tools,
  and only the command line loads them.
- **Over MCP**, `esper_enrich_next` hands out a due question with the same text a provider sends,
  `esper_claim_submit` checks and stores an answer with the agent's model, and `esper_claims` lists
  claims with whether each holds on the snapshot.

**Why.**

- **`--safe-mode` drops `--mcp-config`.** Measured with Claude Code 2.1.312 and a stub MCP server
  that logs what it is asked: under `--safe-mode --strict-mcp-config --mcp-config`, the server never
  starts and the run has no tool but its structured output; under `--setting-sources ""` it starts,
  lists its tool and is called, and the run lists no skill. A bounded run needs no server, so it
  takes the stricter `--safe-mode`; an exploring run takes `--setting-sources ""`. Each was one
  call on Claude Haiku 5.5.
- **A starting point, not the answer.** A first exploring run on Haiku, given only the question,
  answered without reading anything. A question about the repository now starts from its entry
  points and the middleware they share, and the instructions say to read before answering: the
  next run read four files through Esper's tools, and its claim rests on their fingerprints.
- **The literals' facts.** A chain member is often a factory whose check is in the function it
  returns (`RequireUser(strict)` returns the handler that reads `Authorization`): the question
  carries the facts of the literals a declaration defines, since its code holds them.

- **Measured on 2026-10-28**, through `claude-code` on the auditor's plan (`pnpm measure-claims`),
  against 41 guard questions answered by hand in `profiles/*/claims/`: 22 on chi v5.3.2, 4 of them
  guards, and 19 on Hono v4.13.14, 7 of them guards. Ten questions per call, five calls per model;
  tokens and cost as `claude -p` reports them, the cost at list prices, which on a plan is what its
  limits are measured against:

  | Model, effort | Right | False guards | Missed guards | Rejected by the checks | Output tokens | Cost |
  |---|---|---|---|---|---|---|
  | Claude Opus 5.5, low | 41 of 41 | 0 | 0 | 0 | 5,081 | $0.138 |
  | Claude Sonnet 5.5, low | 34 of 41 | 0 | 0 | 7 | | |
  | Claude Sonnet 5.5, medium | 41 of 41 | 0 | 0 | 0 | 4,982 | $0.068 |

  None answered `insufficient-context` or gave a wrong kind. At low effort, Sonnet took no
  non-guard for a guard and missed none, but 6 of its chi answers (`no` for `CleanPath`,
  `Compress`, `GetHead`, `Heartbeat`, `ClientIPFromXFF`, `URLParam`) cited no line, and one Hono
  answer (`compress`) cited a line without the identifier it named: 7 answers rejected, whose
  questions would be asked again. At medium effort it answered all 41 right, every answer cited,
  with as many output tokens as Opus at low effort and at half the cost. **The bounded tier runs on
  Claude Sonnet 5.5 at medium effort.** Each run of 22 or 19 questions took about 8 seconds; the
  input, the same for every model, was read from the cache.
- **The share that moves to the exploring tier is none.** Of 245 bounded answers (the 41 questions
  asked five times, on the three models and efforts above, two of them twice to measure their cost,
  and the first 40 questions due on Hono, 20 guards and 20 intents, on Opus 5.5: 39 accepted, one
  rejected for a citation), none was `insufficient-context`. The bounded tier is kept: it answers
  what it is asked. The questions measured are about chain members and handlers, whose code a call
  carries whole; the exploring tier is still where `trust`, `applications` and `authentication`
  go, and where a later measure of `effects` questions may send some.

**Rules out.** An answer stored without its checks; a claim that a changed node still counts; a
run started in the target, or with any MCP server but Esper's read-only one.

## D32 — Routes declared by files

The first framework whose routes are not calls ([D10](#d10--frameworks-as-profiles) foresaw "a
folder convention"): what the profile format says of a route tree, and how the TypeScript module
reads one. Built in M7.

**Decision.**

- **A profile's `files`** names the folder of the route tree (`src/routes`, from the root of each
  package that has one), how a folder's name is written (`brackets`: `[id]`, `[[optional]]`,
  `[...rest]`, `[id=matcher]`, an escaped character `[x+2e]`, and a `(group)` that takes no part in
  the path), and what each export of each file declares, by the file's name without its extension:
  a `route` with its method, `each` property of an exported object a route at the folder's path and
  a suffix (`?/{name}`, the property named `default` at the folder's own path), a `layout`, or, for
  the files of `hooks`, a chain member of every route.
- **A route's chain** is, in order: the hooks (each export, a call to a function `compose` lists
  seen through, `sequence(a, b)` being `a` then `b`), the matchers its parameters name, and, for a
  route whose export takes `layouts`, the layouts of its folder and of those above, outermost
  first. A module named `+page@name` resets to the layout of the folder above named so, `@` alone
  to the root's; a layout named so (`+layout@.server`) keeps its own place and drops the layouts
  between it and the one it names. What a function receives first is the profile's `context`, or the export's own
  (`receives`).
- **Siblings**, whose guards are compared ([D6](#d6--the-graph-model)), are the routes under the
  same nearest folder that holds a layout or is a route group.
- **One route per method and path of a folder**: two exports that serve the same request (a page's
  server `load` and its universal one) are one route whose handler is both; an endpoint beside a
  page (`+server` and `+page`) answers apart, its own route without the layouts.
- **Modules whose exports are built by calls the profile names** (`remote`, by the suffix of their
  name) are routes of their own, at a path the profile writes with the module's path and the
  export's name; the part the build derives is written as an expression, as for paths the index
  cannot read.
- **The shared core** learns the syntax of a route tree's folders (`normalisePattern`), as it knows
  the other path syntaxes, and globs of files (`surface.except`, D35); nothing in it names a
  framework.

**Why.** A route tree is still a profile's data: the names of the files, of their exports and what
each does differ from one framework to the next (Nuxt and Next.js write theirs otherwise), and a
module of the language reads them. SvelteKit runs a layout's `load` for the pages under it, never
for an endpoint, and after a form action rather than before it, so a layout is in front of a
page's `load` only: an action protected by its layout alone is not protected, and the divergent
guard rule now sees it. SvelteKit also starts the layouts' `load` and the page's together; a
layout's refusal decides the response, the page's `load` still runs, which the chain's order does
not say.

**Rules out.** A route interpreter per framework; layouts applied to every route of their folder;
a page whose server code is only in its component (`+page.svelte`), which Esper does not read, as
an entry point: what runs on the server for it is the hooks and its layouts, which are in front of
the routes that have a server file. A layout reset written only in a component's name
(`+page@.svelte`) is not seen.

## D33 — JavaScript typed by its comments, and types a profile states

This extends [D24](#d24--typescript-and-javascript-as-their-syntax-states-them) for code that states
its types where TypeScript reads them in JavaScript: SvelteKit is written so. Built in M7.

**Decision.**

- **Documentation comments are types in JavaScript files**: `@param {T} name` (a destructured
  parameter by its position), `@type {T}` on a declaration, a field, a parameter written in place
  or a cast `/** @type {T} */ (value)`, `@returns {T}`, `@typedef {T} Name` and
  `@import { A } from 'm'`. Each type is parsed by the TypeScript grammar and stands where an
  annotation would; `import('m').T` is the type a module exports.
- **A type of the target the index does not read**, such as one a declaration file (`.d.ts`)
  declares, is named by the package it belongs to (`@sveltejs/kit#RequestEvent`), as D25 names a
  framework's own types; `Pick<T, …>`, `Omit`, `Partial` and the like have the members of `T`, and
  `a ?? b` the type of `a` when it is known.
- **Members of types outside the target**, which the index cannot read, are stated by a profile's
  `members` (what `RequestEvent.request` is) and the language library's (better-auth's `auth.api`),
  and what functions outside it return by `returns`. A name destructured from a parameter has the
  type of the property it is taken by, and its reads start at that property:
  `({ locals }) => locals.user` reads what `event.locals.user` reads.
- **Imports** also resolve through the `imports` of the nearest `package.json` (`#lib/*`) and
  through the folders a profile maps a specifier to (`aliases`, `$lib`), which a framework
  configures outside the target's files.
- **Reads**: a chain item `[name]` is a property whose name is what is read (`params.id`,
  `headers['host']`), and a read is stated once per declaration, value and line. A method of an
  object literal a function defines is reached through that function, as its literals are.
- **The measures of D24 and D26 move**: on Hono v4.13.14, 2035 call edges, 106 guessed, 1697 calls
  without one (2016, 109 and 1716 before), and 9 guessed of 3277 with scip-typescript; on Kaneo's
  API, 10055 edges, 85 guessed, 5123 without one. The hand counts are unchanged.

**Why.** Without its comments SvelteKit's code states almost no type: no request would be found,
and none of its request surface. Stating the members of the framework's types once in its profile
is what lets the standard `Request`'s rules read `event.request`, as Hono's context reads
`c.req`.

**Rules out.** Reading `node_modules` or the declaration files a build generates (`./$types`).

## D34 — A check that refuses is a guard

This amends how guards are found ([D6](#d6--the-graph-model), [D27](#d27--a-guarding-chain-member-is-known-by-the-code-that-refuses))
for frameworks whose functions refuse by throwing or returning an error rather than by not calling
a next one. Built in M7.

**Decision.**

- **A check is a guard**: a function that, in a condition finding a value read from the request
  missing (`!locals.user`, `user == null` for a name that holds it), calls one of the profile's `refusals` (`error(401)`,
  `redirect(303, …)`, `fail(401)`) is a guard of the kind the profile's check rule gives:
  `{ check: context.user, kind: authn }`. A route takes the guards of its handler, its chain
  members and what they call, each cited where the check is.
- **A function given the request that calls a refusal in a condition answers on its own**
  (`short-circuit`), as a middleware that returns before calling the next one does: a layout's
  `load` that redirects without a session guards the pages under it, known by its code (D27).

**Why.** D6 counted "a call in the handler that returns an error response before the handler's
work" as a guard; SvelteKit's handlers check `locals.user` themselves, and an action without the
check its siblings make is what an auditor looks for. The kind comes from the profile, since a
value named `user` set by the hooks is the authenticated user by the framework's convention, not
by anything the code states.

**Rules out.** A guard kind guessed from a value's name by the index; a check on any request value
counted as an authentication; `if (locals.user) redirect(…)`, which sends a user already signed in
elsewhere, counted as a guard.

## D35 — SvelteKit: the server side, in both modes

The two SvelteKit profiles of [D5](#d5--two-kinds-of-target-applications-and-the-frameworks-themselves),
for SvelteKit 2 and 3 (3.1.0, the latest release on 2026-10-29). Built in M7.

**Decision.**

- **An application** is known by its server code importing `@sveltejs/kit`, `@sveltejs/kit/hooks`
  or `$app/server`, since SvelteKit is a development dependency of the applications built on it.
  Its routes are the files of `src/routes` (D32): each method `+server` exports and its
  `fallback`; the `load` of `+page.server` and of `+page` (a `GET` of the page, the layouts in
  front) and each action (a `POST` to `?/<name>`, no layout in front); `+layout.server` and
  `+layout` loads as layouts. The chain is `reroute` of `src/hooks`, `handle` of
  `src/hooks.server` with `sequence` seen through, then the matchers of `src/params/<name>`
  (SvelteKit 2) or of `src/params`' `defineParams` (SvelteKit 3). Remote functions (`*.remote.ts`,
  built by `query`, `form`, `command`, `prerender`) are routes at
  `/_app/remote/${hash(<module>)}/<name>`. `$lib` maps to `src/lib`; SvelteKit 3's `#lib` is the
  package's own import.
- **What it reads**: the event's `request` is a `Request`; its `params`, `locals`, `url`,
  `cookies.get` and `getClientAddress()`; `getRequestEvent()` gives the event. `locals.user` and
  `locals.session` checked against `error`, `redirect` or `fail` are `authn` guards (D34); `event.fetch`
  is a fetch sink and `redirect`'s location a redirect sink.
- **The framework itself** is `@sveltejs/kit` and its adapters, read as one target: each exported
  declaration, and each function that takes the request or the event, that reads the request,
  Node's request included (adapter-node, `@sveltejs/kit/node`, the Vite dev and preview servers).
  The code that runs in the browser builds the requests the server reads and is left out, by globs
  of files (`surface.except`).
- **Esper reads the server side**: `.ts` and `.js`, not the `.svelte` components, whose markup and
  scripts tree-sitter does not parse here.
- **Measured** on 2026-10-29: Budget at `cfce07b` (SvelteKit 3.1, better-auth, drizzle,
  adapter-bun), 24 routes; Kener v4.1.10 (SvelteKit 2.53, route groups, layouts, hooks in a
  `sequence`, adapter-node), 90 routes, one of them, `POST /manage/api`, without the layout's
  redirect its group's pages have; SvelteKit 3.1.0, 59 entry points, from `internal_respond`
  checking `Origin` and reading `x-sveltekit-pathname` to each adapter's `getClientAddress`
  reading `ADDRESS_HEADER` or `X-Forwarded-For`. Each matches its hand count, the applications
  also a script written apart from Esper.

**Why.** Budget, the auditor's own application, is SvelteKit 3; Kener exercises what Budget does
not (groups, layouts, a sequence of hooks). Code that runs in the browser reads a `Request` too,
the one it builds: counted, it would be half of SvelteKit's surface and none of the server's.

**Rules out.** Reading the components; counting the browser's code as the framework's request
surface.

## D36 — Python as its syntax states it

How the Python module reads a target, with `tree-sitter-python` 0.25.0
([D3](#d3--one-parser-tree-sitter-in-webassembly)), as Go's and TypeScript's do
([D23](#d23--a-language-is-a-module-the-core-names-none)). Built in M8.

**Decision.**

- **Files.** `.py` files, `pyproject.toml` and `requirements*.txt`. Tests (`test_*.py`, `*_test.py`,
  `conftest.py`, `tests.py`, the folders every language skips) are skipped, and so are a virtual
  environment's folders (`venv`, `site-packages`), `__pycache__`, FastAPI's documentation examples
  (`docs_src`), and migrations (`migrations`, `alembic`), which are not request code. A language
  module now says which folders it skips beside the shared ones (`skip`).
- **Modules.** A file's module is its path from the nearest folder above it that is not a package
  (no `__init__.py`): `src/space/api/rest.py` is `space.api.rest` in a `src` layout. Imports resolve
  through those names, relative ones (`from ..x import y`) from the file's package, through a
  package's `__init__.py` re-exports and `from m import *` (as `__all__` says); anything else is
  outside the target, named by the module the code imports and the name: `ext:fastapi#Depends`,
  `ext:subprocess#run`, a built-in `ext:builtins#open`.
- **Projects and their dependencies** come from `pyproject.toml`: PEP 621's `[project]` and its
  optional dependencies, PEP 735's `[dependency-groups]` (uv's), uv's `dev-dependencies` and
  Poetry's tables; and from `requirements*.txt`. A distribution is named as PEP 503 normalises it.
  A small TOML reader, written for what manifests hold, reads them; nothing is installed.
- **References** ([D7](#d7--stable-references-and-fingerprints)): a method is `#Class.method`, a
  function nested in another `#outer/inner`, a lambda a name holds by that name, any other
  `#outer/lambda2`. A declaration is exported when neither its name nor any part of its module
  starts with one underscore (`__call__` is public); a method when its class is.
- **Types are what the syntax states**: an annotation, `Annotated[T, …]`, `Optional[T]`, `T | None`
  and a string naming a class as `T`; `x = C()`; a function's return annotation, or the one value it
  returns, a generator's yield; a class's fields, from its body and from what its methods assign to
  `self.x`, and a property's result; a type alias of the target (`Scope = MutableMapping[…]`) as a
  type of its own, named by its module (`starlette.types#Scope`). What the syntax does not state, a
  profile may: the bases of types outside the target (`bases`) and their members.
- **Calls** are resolved from those types, a class's call to its `__init__`, `super().m()` to a
  base's method; guessed, with the reason, through an abstract method (each override in the
  target's subclasses) and on a value no syntax types when the target has one method of that name,
  unless values of the language's own types have it (`get`, `append`, Pydantic's `model_dump`),
  which `library.yaml` lists as `builtins`. A property runs when its attribute is read; a function
  given to a call runs when what it is given to calls it (`run_in_threadpool(self.debug_response,
  …)`), and a nested function or a lambda is called by the function that defines it.
- **Measured** on 2026-10-29: getspace's backend, 130 files, 1444 declarations, 5836 call edges,
  496 guessed (8.5 %, a third of them `workspace.transaction(…)` on a parameter its code does
  not type), 2342 calls without an edge; FastAPI 0.162.0, 74 files, 3294 edges, 7 guessed, 882
  without; Starlette 1.10.0, 36 files, 1420 edges, 14 guessed, 545 without. Indexing takes about
  6 seconds for getspace, under 2 for the frameworks.

**Why.** The same split as Go and TypeScript keeps the shared core free of Python, and a type
stated by an annotation is what Python code states more and more. A module named by its import path
is what lets `from fastapi import Request` and FastAPI's own `fastapi/requests.py` meet on one
symbol.

**Rules out.** Running Python to read a target, or reading a virtual environment.

## D37 — FastAPI: routes and dependencies as the chain

The FastAPI application profile of [D5](#d5--two-kinds-of-target-applications-and-the-frameworks-themselves),
with Starlette's under it, and what the profile format had to say for them. Built in M8.

**Decision.**

- **Routes** are declared by decorators (`@router.get(path)`, `api_route(path, methods=[…])`,
  `websocket`), by calls (`add_api_route`), and by route objects given as a list
  (`Route(path, endpoint, methods=[…])`, `WebSocketRoute`, `Mount(path, routes=[…])`), to a
  router's constructor or to `app.router.routes.extend(…)`, a list a function returns and a
  generator over a tuple of paths included. A method called as a decorator takes the function it
  decorates as its handler. A profile states a call's arguments by position and by keyword
  (`keywords: { prefix: path, dependencies: chain }`), the route objects it knows (`declares`), what
  a router's constructor takes (`construct`), and which of a router's attributes are itself
  (`app.router`). A websocket's method is `WEBSOCKET`. Starlette's `{rest:path}` is `{rest...}`.
- **Routers** are followed through names, imports, a function's parameters (what its callers pass)
  and results, as in Go and TypeScript. `include_router(r, prefix=…, dependencies=[…])` places a
  router's routes under the prefix, `mount(path, app)` an application under a path, and a mounted
  application that is no router of the target (FastMCP's) serves its subtree: `ANY /mcp/{rest...}`.
  A path from a setting is the setting's default (`API_V1_STR: str = "/api/v1"`).
- **The chain** is, in order: the middleware of the application and of those it is mounted in,
  outermost first (the last `add_middleware` or `@app.middleware("http")`, then the first, then the
  constructor's `middleware=[Middleware(…)]` in order, as Starlette builds its stack); then, for a
  route FastAPI declares, the dependencies of its routers, of the include and of its decorator,
  then those its parameters declare, each after the dependencies it declares itself. A dependency
  is a `Depends(x)` or `Security(x)` in a parameter's default or its `Annotated` metadata, through a
  type alias (`CurrentUser = Annotated[User, Depends(get_current_user)]`), a name that holds one
  (`session=auth`) or a call that returns one. It runs once per request, at its first place, as
  FastAPI caches it. A middleware class is its `dispatch` or its `__call__`, a function given the
  request first, a class outside the target its own name; a Starlette route has no dependencies.
- **Siblings**, whose guards are compared ([D6](#d6--the-graph-model)), are the routes of one router.
- **Measured** on 2026-10-29: getspace's backend at `d094115`, 107 routes (90 decorated, 16 OAuth
  routes as Starlette objects, the MCP mount); FastAPI's full-stack template at `f4bcfab`, 24 routes,
  through four prefixes, `Annotated` aliases and `dependencies=[…]`. Each matches its hand count and
  a script written apart from Esper, with Python's own parser.

**Why.** Prefixes and dependencies are where FastAPI's route extractors go wrong (D5): a route's
real path is the sum of its includes, and whether it is authenticated is decided by a dependency
two aliases away. FastAPI runs a dependency's own dependencies first, and Starlette wraps the
application's middleware around the router, so the chain follows that order.

**Rules out.** A route interpreter written for FastAPI; dependencies applied to Starlette's routes,
which FastAPI does not solve.

## D38 — What a parameter reads, and a dependency that refuses

How FastAPI's parameters become reads, and its dependencies guards
([D6](#d6--the-graph-model), [D34](#d34--a-check-that-refuses-is-a-guard)). Built in M8.

**Decision.**

- **Parameters** read the request by what they declare, in a handler or a dependency, as a profile's
  `parameters` says: a marker (`Query`, `Path`, `Header`, `Cookie`, `Body`, `Form`, `File`), in its
  default or its `Annotated` metadata, reads its kind, named by its `alias` or the parameter's name
  (a header's underscores as hyphens: `user_agent` reads `header.user-agent`); a Pydantic model or a
  SQLModel the body; an upload a form field; the request, a response, background tasks nothing.
  Any other parameter of a handler or a dependency reads a path parameter when the route's path names
  it, a query parameter otherwise. A marker reads wherever it is written, FastAPI's own
  `OAuth2PasswordRequestForm` included.
- **Guards** are FastAPI's security schemes (`OAuth2PasswordBearer`, `HTTPBearer`, `APIKeyHeader`
  and the rest, `authn`), unless built with `auto_error=False`, which lets every request through
  (`unless`; an entry's chain member says so with `passes`); and a dependency of a route that raises,
  in a condition, an exception with a status a profile's rule names: 401 for `authn`, 403 for
  `authz-role`. The status is the exception's (`HTTPException(status_code=401)`,
  `status.HTTP_403_FORBIDDEN`, an integer argument), or the one the application's exception handler
  answers it with (`@app.exception_handler(Unauthenticated)` returning a 401), as the profile's
  `exceptions` say a status is written and handlers are registered. A dependency that
  raises in a condition answers on its own (`short-circuit`), as a middleware that returns before
  `call_next` does.
- **`mass-assignment`** is set where a function that writes data spreads a model into a call
  (`Item(**body.model_dump())`) or validates one into another (`Item.model_validate(body)`,
  `item.sqlmodel_update(data)`); a model is a parameter typed by one, or a name that holds its dump.
  The methods that dump and bind models are listed in the language's `library.yaml` (`models`).

**Why.** A FastAPI handler reads the request through its signature more often than through
`request`, so parameters are where most reads are. Who is authenticated is decided by dependencies
that refuse; a status of 401 or 403 is what the code states about the refusal, and FastAPI applies
it. A guard only in the handler's body (`if item.owner_id != user.id: raise …`) is the handler's
own work, not a dependency, and is left to the claims of a model
([D17](#d17--model-enrichment-claims-beside-the-facts)).

**Rules out.** A guard kind read from a function's name; a security scheme that cannot refuse
counted as a guard.

## D39 — FastAPI and Starlette as two frameworks

The framework profiles of [D5](#d5--two-kinds-of-target-applications-and-the-frameworks-themselves)
for FastAPI and Starlette. Built in M8.

**Decision.**

- **Two targets.** FastAPI's request surface is in its repository (security schemes, the request
  handler, dependencies, routing, the docs); most of what reads the request is Starlette's, in
  another repository (the connection, forms and multipart, routing, CORS, trusted hosts, sessions,
  static files, `root_path`). Each is a framework target with its own profile and count; FastAPI's
  application rules are Starlette's plus its own, so that both read the same `Request`, and its
  security schemes are named the same in FastAPI's code as in an application's.
- **The surface** is each exported declaration that reaches a read, and each function that takes
  the request, a connection, a websocket or an ASGI scope (`handlers.types`). An ASGI scope is read
  by its keys: `scope["headers"]` is a header read, `scope["path"]` and `root_path` the path,
  `client` the client address, `query_string` the query; what the server sets (`type`, `asgi`,
  `http_version`, `extensions`) is not read from the client (`except`). `Headers(scope=…)` reads the
  headers, `Headers(raw=…)` does not (a call rule's `request` by keyword). Starlette's test client
  builds requests and is left out.
- **Not uvicorn's `ProxyHeadersMiddleware`.** It is the ASGI server's, which rewrites the scope's
  client address and scheme from `X-Forwarded-For` and `X-Forwarded-Proto` before the application
  sees it; neither FastAPI nor Starlette ship it. A server is a target of its own, for later.
- **Measured** on 2026-10-29 at the latest releases: FastAPI 0.162.0, 69 entry points; Starlette
  1.10.0, 68. A script written apart from Esper listed each function that reads the request
  directly; each is an entry point or reached by one.

**Why.** Counting Starlette inside FastAPI would need FastAPI's dependency installed in the target,
and a framework's surface is its own code. The keys of an ASGI scope are what the client sends, but
for those the server fills in.

**Rules out.** A request read counted for a scope's protocol type; the test client as surface.

## D40 — scip-python, wheels only, and no Python in the analysis

The third analyzer on the contract of [D12](#d12--precision-scip-right-after-the-first-index-dataflow-later)
and [D22](#d22--precision-runs-inside-the-index-when-asked). Built in M8.

**Decision.**

- **The tool.** [scip-python](https://github.com/sourcegraph/scip-python) 0.6.8, its latest release
  (2026-10-22, maintained by Sourcegraph), which runs Pyright; on Node 24.22.1, with Alpine's Python
  and uv 0.13.6 to install a target's dependencies, the images pinned by digest.
- **Fetching** reads the manifest at the root of the snapshot's tree: `uv.lock` (exported with uv,
  frozen), else a `requirements*.txt`, else a `pyproject.toml` whose dependencies uv resolves; from
  PyPI whatever the target configures, each requirement installed on its own as a **wheel only**
  (`--only-binary :all:`, `UV_NO_BUILD`), into a folder that is discarded, so that uv's cache, the
  analyzer's volume, holds them. A requirement without a wheel is left out and said. No build
  backend and no `setup.py` runs.
- **Analyzing** installs the wheels from the cache without the network, lists them for scip-python
  from their `RECORD` files, and runs it with no Python on its path, so that neither scip-python nor
  Pyright starts an interpreter, which would run a dependency's `.pth` files. Pyright reads the
  installed packages and the snapshot's `src` roots as extra paths.
- **What it states** is what scip-typescript's analysis states (D26): a reference for each name
  whose symbol is defined in the snapshot or outside it, named by its module
  (`fastapi.security.oauth2#OAuth2PasswordBearer.__call__`), the import's name kept where the
  syntax names the same symbol outside the target; and the methods that override another of the
  snapshot. A class called is its `__init__`, as the syntax reads it.
- **Measured** on 2026-10-29: getspace's backend, calls without an edge fall from 2342 to 1451 in
  about 30 seconds the first time; FastAPI 0.162.0 from 882 to 329, Starlette 1.10.0 from 545 to
  189. The entry points stay the ones counted by hand, but one of Starlette's,
  `BaseRoute.__call__`, which reached a read only through a guess the analyzer corrects.

**Why.** A wheel is unpacked, never built: it is how Python dependencies can be installed without
running any of their code, as D12 asks. A `.pth` file runs when an interpreter starts, so the
analysis starts none.

**Rules out.** Building a dependency from its source distribution; running `pip` or Python over the
installed packages.
