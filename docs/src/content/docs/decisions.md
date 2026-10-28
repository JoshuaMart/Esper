---
title: Decisions
description: The choices that shape Esper, each with its reasons and the alternatives it rules out.
---

Each decision says what is chosen, why, and what it rules out. A decision is **proposed** until it
is confirmed, and **settled** once it is; a settled decision changes only through a new entry that
says why. Versions and behaviours cited here were checked on 2026-10-28.

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
| [D11](#d11--indexing-rules) | Read only, refuse rather than return nothing, incremental | settled |
| [D12](#d12--precision-scip-right-after-the-first-index-dataflow-later) | Precision: SCIP right after the first index, dataflow later, one analyzer contract | settled |
| [D13](#d13--the-mcp-surface) | MCP SDK v2, bounded tools, a read-only mode | settled |
| [D14](#d14--one-server-for-the-api-mcp-and-the-web-interface) | One local server for the API, MCP and the web interface | settled |
| [D15](#d15--repository-layout-and-licence) | A pnpm monorepo, under Apache-2.0 | settled |
| [D16](#d16--measured-against-hand-counted-targets) | Each profile measured against hand-counted targets | settled |
| [D17](#d17--model-enrichment-claims-beside-the-facts) | Model enrichment: claims beside the facts, bounded first, exploring when needed | settled |
| [D18](#d18--running-esper-one-home-many-projects) | Running Esper: one home, many projects, one project per MCP connection | settled |
| [D19](#d19--past-vulnerabilities-advisories-linked-to-the-code-they-touched) | Past vulnerabilities: advisories of medium severity or more, linked to the code their fix touched | settled |

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
| `live-state` | the code reads or writes state that outlives the request: a package-level or module-level variable, a shared map or cache |
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
- The fingerprint is the SHA-256 of the node's tree-sitter tokens, comments and whitespace left out.
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
files): declarations, calls, imports, and the library calls that are sinks. What is specific to a
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
- **Incremental.** A reindex parses only the files whose hash changed.
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
   would rest on a guess, which is too much to wait for. M1 measures it again with Esper's own index.
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
Streamable HTTP for the rest. Tools:

| Tool | Answers | Writes |
|---|---|---|
| `esper_snapshots` | the project's snapshots: ref, commit, date, counts | |
| `esper_diff` | between two snapshots: entry points added, removed or changed, and notes whose anchor state changed | |
| `esper_index` | index a git ref of the connection's project, or reindex it; returns counts, skips and refusals | yes |
| `esper_entrypoints` | entry points, filtered by method, path, chain member, guard, read or signal | |
| `esper_node` | one node: its facts, its code excerpt, its notes, its past advisories, and how many claims it has | |
| `esper_advisories` | the target's advisories, filtered by severity, precision or link status, with the nodes each one affects ([D19](#d19--past-vulnerabilities-advisories-linked-to-the-code-they-touched)) | |
| `esper_callers`, `esper_callees` | one hop or more, up to a depth | |
| `esper_paths` | the paths from one node to another, up to a depth and a count | |
| `esper_search` | find a node by name, reference or `file:line` | |
| `esper_read` | a range of lines from a file of the snapshot, and nothing outside it | |
| `esper_notes` | list notes by node, kind, status, anchor state or author | |
| `esper_note_create`, `esper_note_update`, `esper_note_delete` | write notes | yes |
| `esper_claims` | the model claims on a node, apart from its facts ([D17](#d17--model-enrichment-claims-beside-the-facts)) | |
| `esper_enrich_next`, `esper_claim_submit` | hand out an enrichment question, and take its answer | `esper_claim_submit` |
| `esper_flows`, `esper_flow_request` | the `flows` edges of a node, and a dataflow question for an analyzer ([D12](#d12--precision-scip-right-after-the-first-index-dataflow-later)) | `esper_flow_request` |

Every tool that reads the graph takes an optional `snapshot`, and reads the latest one without it.
Every answer is bounded and says when it was cut. A node is named by its reference, a `file:line`,
or its name. A server started **read-only** exposes none of the tools marked as writing. Each tool's
input and output schemas, and its default bounds, are written in M2 ([roadmap](/roadmap/#m2--mcp-and-notes))
and published from the code.

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
packages/server        # @esper/server: HTTP API, MCP endpoint, static files
packages/cli           # esper-cli on npm: the `esper` command
apps/web               # @esper/web: the web interface
profiles/<framework>   # the two profiles, their fixtures and their hand counts
schemas/               # JSON Schemas: profile, analyzer import, claims
analyzers/<name>       # an analyzer's manifest and container image
docs/                  # this documentation
```

Every package but `esper-cli` is private to the workspace. `docs/` joins the workspace, so the
repository has one lockfile. One command-line entry point, `esper`
([D18](#d18--running-esper-one-home-many-projects)). Licence: **Apache-2.0**.

**Tooling**, set in M0:

- **pnpm 10**, pinned in `packageManager`; Node 24 or later in `engines`, and `.nvmrc` set to 24.
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
     `--setting-sources ""`. Which one is settled by a test in
     [M6](/roadmap/#m6--enrichment-and-past-advisories).
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

Every command that acts on a project takes its name first:

| Command | Does |
|---|---|
| `esper add <path or git URL>` | adds a project; `--name`, `--kind application\|framework`, `--package` |
| `esper index <project>` | indexes a snapshot; `--ref`, `--offline` (no advisory fetch) |
| `esper advisories <project>` | fetches and links the target's advisories again ([D19](#d19--past-vulnerabilities-advisories-linked-to-the-code-they-touched)) |
| `esper enrich <project>` | answers the enrichment questions ([D17](#d17--model-enrichment-claims-beside-the-facts)); `--provider claude-code\|anthropic-api`, `--tier` |
| `esper notes export <project>`, `esper notes import <project>` | notes to and from JSON Lines ([D9](#d9--storage-one-sqlite-database-per-project-outside-the-target)) |
| `esper mcp <project>` | the MCP server over stdio; `--read-only` |
| `esper serve` | the local server, for every project |
| `esper list` | the projects and their snapshots |

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
