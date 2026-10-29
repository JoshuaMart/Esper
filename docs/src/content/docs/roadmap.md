---
title: Roadmap
description: The order Esper is built in, and what has to be true for each milestone to count as done.
---

The [decisions](/decisions/) say what Esper is; this page says in which order it gets built. Each
milestone ends on a check that can be run, not on a feature list: most of them are the rule of
[D16](/decisions/#d16--measured-against-hand-counted-targets), a real target whose entry points were
counted by hand, with none missing and none invented.

| # | Milestone | Done when | Status |
|---|---|---|---|
| [M0](#m0--the-workspace) | The workspace | the workspace type-checks, lints and tests in CI | done |
| [M1](#m1--the-core-on-go-and-chi) | The core, on Go and chi | chi and Wakapi pass their hand count | done |
| [M2](#m2--mcp-and-notes) | MCP and notes | an agent hunts chi over MCP and its notes survive a reindex | done |
| [M3](#m3--scip-for-go) | SCIP for Go | the first analyzer runs through the contract; guessed edges drop | done |
| [M4](#m4--typescript-and-hono) | TypeScript and Hono | Hono and Kaneo pass their hand count | done |
| [M5](#m5--the-server-and-the-web-interface) | The server and the web interface | an audit can be followed and annotated in the browser | done |
| [M6](#m6--enrichment-and-past-advisories) | Enrichment and past advisories | claims and advisory links measured on chi and Hono | done |
| [M7](#m7--sveltekit) | SvelteKit | SvelteKit and a SvelteKit application pass their hand count | done |
| [M8](#m8--python-and-fastapi) | Python and FastAPI | FastAPI and a FastAPI application pass their hand count | not started |
| [M9](#m9--dataflow-on-demand) | Dataflow, on demand | a `flows` question answered by Joern, every step cited | not started |
| [Next](#after-that) | More frameworks | Next.js, TanStack Start, each a pair of profiles | |

The agent comes before the interface: Esper is used first by hunting agents, and every milestone up
to M4 can be checked over MCP and the command line.

## M0 — The workspace

The pnpm workspace of [D15](/decisions/#d15--repository-layout-and-licence), with its tooling:
pnpm 10, Node 24 and later, TypeScript stripped by Node and checked by `tsc --noEmit`
([D4](/decisions/#d4--typescript-on-node-24-and-later)), `node --test`, Biome, GitHub Actions, and
the Apache-2.0 licence. The packages exist, empty but wired to each other, `docs/` joins the
workspace, and `web-tree-sitter` loads the Go grammar from its official package
([D3](/decisions/#d3--one-parser-tree-sitter-in-webassembly)).

**Done when**

- a clean clone runs `pnpm install` without running any dependency script;
- `pnpm check` (type-check, lint) and `pnpm test` pass in CI on Node 24 and 26;
- a test parses a Go file into a tree;
- `esper --version` runs from the sources, without a build.

## M1 — The core, on Go and chi

Everything the index needs, on one language and one framework:

- the graph model and its schema, with the `source` field and the empty `flows` edge from the start
  ([D6](/decisions/#d6--the-graph-model));
- references and fingerprints ([D7](/decisions/#d7--stable-references-and-fingerprints));
- the SQLite store, one database per project in Esper's home
  ([D9](/decisions/#d9--storage-one-sqlite-database-per-project-outside-the-target));
- the profile format and its validation, and the Go queries
  ([D10](/decisions/#d10--frameworks-as-profiles));
- the indexing rules: skips recorded, refusals with a reason, a commit not indexed twice
  ([D11](/decisions/#d11--indexing-rules), [D20](/decisions/#d20--a-reindex-reads-the-whole-target));
- the two chi profiles, application and framework, over `net/http`
  ([D5](/decisions/#d5--two-kinds-of-target-applications-and-the-frameworks-themselves));
- the commands `esper add`, `esper index` and `esper list`
  ([D18](/decisions/#d18--running-esper-one-home-many-projects));
- the plain `net/http` application profile, for `http.ServeMux`;
- the schemas the milestone depends on, written in `schemas/` and published in these pages: the
  profile format, and the SQLite schema of the graph.

**Done when**

- chi 5.3.2, in framework mode, and [Wakapi](https://github.com/muety/wakapi), a chi application,
  in application mode, match their hand count, recorded in `profiles/chi/counts/`: no entry point
  missing, none invented;
- each index reports its share of resolved edges, measured on chi 5.3.2 against the 262 guessed
  edges out of 486 that the decisions cite: 30 of 540;
- indexing the same commit twice gives the same snapshot;
- a target without a matching profile is refused, with its reason.

## M2 — MCP and notes

The MCP server over stdio, with the tools that read the graph and write notes
([D13](/decisions/#d13--the-mcp-surface)), the read-only mode, and notes with their kinds, revisions
and anchors ([D8](/decisions/#d8--notes)). The command is `esper mcp <project>`. The milestone
writes each tool's input and output schemas and default bounds, and the tools to list and compare
snapshots (`esper_snapshots`, `esper_diff`).

**Done when**

- an agent, given only the MCP server, lists chi's entry points by read and signal, follows a path
  to a guard, and writes a lead and a coverage note;
- after a reindex on another version, every note has an anchor state, `attached`, `stale`, `moved`
  or `orphaned`, none is lost, and `esper_diff` lists the notes whose state changed;
- every answer is bounded and says when it was cut;
- a read-only connection exposes no write tool.

Each is a test: chi 5.3.2 hunted over stdio through `esper mcp` (`packages/cli/test/mcp.test.ts`),
a chi application reindexed on a second version with a changed, a renamed and a removed function
(`packages/mcp/test/tools.test.ts`), and the anchor rules on their own
(`packages/core/test/notes.test.ts`). The tools, their schemas and bounds are in the
[MCP reference](/reference/mcp/), the notes in [Notes](/reference/notes/).

## M3 — SCIP for Go

The analyzer contract ([D12](/decisions/#d12--precision-scip-right-after-the-first-index-dataflow-later)):
the manifest, the container with the source mounted read-only and dependencies fetched with scripts
disabled, the JSON Lines import with its validation, its schema written in `schemas/`. scip-go is
the first analyzer built on it.

**Done when**

- on chi 5.3.2, the share of guessed edges falls well below the one M1 measured with tree-sitter
  alone, and each edge it resolves names `scip-go` as its source;
- a file with one invalid line, or one citation that does not match the snapshot, is rejected whole.

Each is a test. scip-go 0.2.9 runs in Docker on chi 5.3.2, where guessed edges fall from 30 of 540
to 1 of 618 and every edge not already resolved the same way names `scip-go@0.2.9`, and on Wakapi,
where they fall from 567 to none, both keeping the entry points counted by hand
(`packages/core/test/scip-go.test.ts`). The refusals, line by line and place by place, are in
`packages/core/test/analyzer.test.ts`. Precision runs inside the index when asked,
`esper index --precise` or `precise` on `esper_index`
([D22](/decisions/#d22--precision-runs-inside-the-index-when-asked)). The contract, the import format
and scip-go are in the [analyzers reference](/reference/analyzers/), the schemas in
`schemas/analyzer.schema.json` and `schemas/analysis.schema.json`.

## M4 — TypeScript and Hono

The TypeScript queries, imports resolved through the target's `tsconfig` paths, the two Hono
profiles, and scip-typescript through the contract from M3. This is the milestone that shows a
second language costs queries and profiles, not changes to the core.

**Done when** Hono, in framework mode, and [Kaneo](https://github.com/usekaneo/kaneo)'s API, a Hono
application, in application mode, match their hand count, recorded in `profiles/hono/counts/`, and
nothing under `packages/core` had to learn about TypeScript or Hono by name.

The criterion's last part is read as: the shared machinery (reading a target, detecting its profile,
the home, the store, notes, the analyzer contract, the entry points and signals as rules) names no
language and no framework. A language module of its own, as `go*.ts` is for Go, is expected
([D23](/decisions/#d23--a-language-is-a-module-the-core-names-none)).

Each is a test:

- **Hono v4.13.14**, in framework mode: 108 entry points, the same as its hand count, from CORS
  reading `Origin` to each adapter's `handle` (`profiles/hono/counts/hono@bac5c4a8bcd7.yaml`).
- **Kaneo's API** at v2.48.0 (`apps/api`), in application mode: 211 routes, the same as its hand
  count, which a script written apart from Esper listed too, every handler and chain member named,
  and each route's middleware the one registered before it
  ([D25](/decisions/#d25--hono-middleware-in-the-order-it-is-registered)). Both run in
  `packages/core/test/counts.test.ts`, fetched by `pnpm fetch-targets` in CI.
- **No name in the core**: `packages/core/test/shared.test.ts` fails on a language or a framework
  named in the code of a shared file. Go's entry-point rules moved to the shared `entries.ts`, and
  the Go counts still hold.
- **scip-typescript 0.5.2** runs in Docker on both
  ([D26](/decisions/#d26--scip-typescript-with-the-dependencies-the-lockfile-pins)): on Hono, with
  its dependencies, guessed edges fell from 109 of 2016 to 12 of 3268; on Kaneo's API, without the
  dependencies of its repository, calls without an edge fell from 5197 to 3927; both keep the entry
  points counted by hand (`packages/core/test/scip-typescript.test.ts`). Since M7, whose types
  resolve a few more calls, the test measures Hono at 106 of 2035 then 9 of 3277, and Kaneo's API
  at 5123 then 3861.

The module and the profiles are in [D24](/decisions/#d24--typescript-and-javascript-as-their-syntax-states-them)
and [D25](/decisions/#d25--hono-middleware-in-the-order-it-is-registered), the
[graph schema](/reference/graph/#typescript), [profiles](/reference/profiles/#hono) and
[analyzers](/reference/analyzers/#scip-typescript) references.

## M5 — The server and the web interface

The Hono server with the JSON API, MCP over Streamable HTTP and the static interface
([D14](/decisions/#d14--one-server-for-the-api-mcp-and-the-web-interface)), started by
`esper serve`. The interface is designed with Claude Design:

- projects and snapshots;
- entry points grouped by chain, read and signal;
- a bounded subgraph from an entry point, with the code beside it;
- notes where they sit.

**Done when** an auditor can add a project, index it, follow an entry point to what it reaches and
write a note, all from the browser, and a note written by an agent shows in the interface without a
reload.

It is done:

- **Designed first**, in Claude Design, on Wakapi and chi as indexed, with notes written over MCP:
  projects and snapshots, entry points grouped by chain, read and signal, a subgraph beside its
  code, notes and their anchor states, adding and indexing a project, writing a note, and a map of
  the code a group of entry points shares, which the auditor asked for while reviewing the design
  ([D29](/decisions/#d29--the-map-a-groups-shared-code-drawn-bounded)).
- **Checked in a browser** on `esper serve`: Hono added from its folder and indexed at v4.13.14 from
  the interface, with its 108 entry points; on Wakapi, `GET /oidc/{provider}/callback` followed to
  its handler and what it calls, a line of its code cited in a lead written from the interface; a
  lead written by an agent over `/mcp/wakapi` shown with its author while the page stayed open; on
  chi, the two notes stale since v5.2.1 reviewed against the code as it is now.
- **Tested**: `packages/server/test/server.test.ts` adds, indexes, follows and annotates a project
  through the API, checks the token, `Host` and `Origin`, and hears on the event stream a note
  written over MCP and one written from another process; `graph.test.ts` checks both drawings;
  `packages/cli/test/main.test.ts` starts `esper serve`.

The server is [D28](/decisions/#d28--the-server-a-token-kept-in-the-home-events-from-the-database),
with the [API](/reference/api/) and [interface](/reference/interface/) references.

## M6 — Enrichment and past advisories

- **Enrichment** ([D17](/decisions/#d17--model-enrichment-claims-beside-the-facts)): the two tiers,
  `esper enrich`, the `claude-code` provider and then `anthropic-api`, the citation checks, claims kept apart from
  facts and asked again only when a fingerprint changes.
- **Past advisories** ([D19](/decisions/#d19--past-vulnerabilities-advisories-linked-to-the-code-they-touched)):
  the OSV import with its severity filter, `esper advisories`, `affects` edges with their precision, and the
  `fix-downstream` signal.

**Done when**

- **Model choice.** On a fixed set of chi and Hono questions answered by hand, the bounded tier's
  claims are scored on Opus 5.5 at low effort and on Sonnet 5.5; the default model is the cheaper
  one if it scores the same.
- **Exploring share.** The share of questions that move to the exploring tier is measured; if it
  is high, the bounded tier is dropped.
- **Session restrictions.** A test settles whether `--safe-mode` keeps `--mcp-config`, and so which
  option strips the auditor's customisations from an enrichment run.
- **Citations.** Every rejected claim names the citation that failed.
- **Advisory links on chi.** The advisories that list symbols (`RedirectSlashes`, `RealIP`) are
  linked with `symbol` precision; the others through their fix commit, or listed as `unlinked`.
- **Advisory links on Hono.** Its medium-and-up advisories are counted by precision. Each link is
  checked by hand on a sample.

It is done. Enrichment ([D31](/decisions/#d31--enrichment-as-built-questions-checks-and-two-providers),
[claims](/reference/claims/)):

- **Model choice.** On 41 guard questions answered by hand on chi and Hono
  (`profiles/*/claims/`), Claude Opus 5.5 at low effort answered all 41 right, for $0.138 at list
  prices; Claude Sonnet 5.5 at low effort took no non-guard for a guard, but 7 of its answers cited
  no line, or a wrong one, and were rejected; at medium effort it answered all 41 right, with as
  many tokens as Opus, for $0.068. It scores the same and costs half: the bounded tier runs on
  Sonnet 5.5 at medium effort.
- **Exploring share.** None of 245 bounded answers was `insufficient-context`: the bounded tier is
  kept.
- **Session restrictions.** `--safe-mode` drops `--mcp-config`, measured with Claude Code 2.1.312
  and a server that logs what it is asked: bounded runs take `--safe-mode`, exploring runs
  `--setting-sources ""`, which keeps Esper's server and none of the auditor's settings.
  `packages/enrich/test/enrich.test.ts` checks the arguments of both runs, and where they start.
- **Citations.** Every rejected claim names the citation that failed
  (`packages/core/test/claims.test.ts`, and over MCP in `packages/mcp/test/tools.test.ts`).

`claude-code` was run on the auditor's plan; `anthropic-api` is tested against a transport that
answers as the API does, without a live run, since no key was at hand. The questions answered by
hand are checked against their snapshots in `packages/core/test/claim-sets.test.ts`;
`pnpm measure-claims` measures a model on them.

Past advisories ([D30](/decisions/#d30--advisories-belong-to-the-project-and-are-placed-on-each-snapshot)),
each criterion a test, from OSV's answers recorded on 2026-10-28
(`packages/core/test/fixtures/osv/`) on each target's whole history:

- **Advisory links on chi.** At v5.3.2, the four advisories that name `RedirectSlashes` or `RealIP`
  are linked by symbol, GO-2025-3770 and GHSA-j6qf-3m9c-vwj3 through their fix commits, none
  unlinked (`profiles/chi/advisories/chi@38939062c5df.yaml`).
- **Advisory links on Hono.** At v4.13.14, 52 advisories, 4 low left out; of the 48 kept, 37 are
  linked by `fix-diff`, 1 by `file`, and 10 are `unlinked`. Seven links, one per advisory, were
  checked by hand against the advisory and its fix's diff, as the file says
  (`profiles/hono/advisories/hono@bac5c4a8bcd7.yaml`).

Both run in `packages/core/test/advisory-counts.test.ts`; the rules on a repository built for the
test, across three versions, in `packages/core/test/advisories.test.ts`.

## M7 — SvelteKit

The third framework, and the first whose routes are not calls: a SvelteKit application declares
them by its files (`src/routes/**/+server.ts`, the `load` functions and `actions` of
`+page.server.ts` and `+layout.server.ts`), and its middleware in `src/hooks.server.ts` (`handle`,
composed with `sequence`). Its two profiles, and what the profile format and the TypeScript module
need to read routes from the file tree, with no framework named in the shared core
([D23](/decisions/#d23--a-language-is-a-module-the-core-names-none)). It comes before dataflow
because the auditor's own targets are SvelteKit applications.

**Done when** SvelteKit, in framework mode, and a SvelteKit application, in application mode, match
their hand count, recorded in `profiles/sveltekit/counts/`, and the Go and Hono counts still hold.

It is done, on SvelteKit 3.1.0, the latest release
([D32](/decisions/#d32--routes-declared-by-files) to [D35](/decisions/#d35--sveltekit-the-server-side-in-both-modes)):

- **Routes from the file tree.** The profile format gained `files`: the route tree, what each
  export of each file declares, the hooks and the function that composes them, the matchers and
  the layouts, and modules whose exports are routes of their own (remote functions). The
  TypeScript module reads it (`ts-files.ts`); the shared core learned the syntax of a tree's
  folders (`[id]`, `[[x]]`, `[...rest]`, `[id=matcher]`, `(group)`) and globs, and names no
  framework (`packages/core/test/shared.test.ts`).
- **SvelteKit 3.1.0**, in framework mode: 59 entry points, the same as its hand count, from
  `internal_respond` checking `Origin` and reading `x-sveltekit-pathname` to each adapter's
  `getClientAddress` reading `ADDRESS_HEADER` or `X-Forwarded-For`
  (`profiles/sveltekit/counts/kit@73bf98cabea2.yaml`). Its code is JavaScript typed by its
  documentation comments, which the index now reads as types
  ([D33](/decisions/#d33--javascript-typed-by-its-comments-and-types-a-profile-states)); its
  browser code is left out.
- **[Budget](https://github.com/JoshuaMart/Budget)** at `cfce07b` (SvelteKit 3.1, Svelte 5,
  better-auth, drizzle, adapter-bun): 24 routes, behind `handle`, which checks `locals.user`;
  `pnpm esper index budget` indexes it. **[Kener](https://github.com/rajnandan1/kener)** v4.1.10
  (SvelteKit 2.53, adapter-node), for the route groups, layouts and a `sequence` of hooks Budget
  does not have: 90 routes, of which `POST /manage/api`, a `+server.ts` its group's layout does not
  cover, is flagged `divergent-guard`. Both match their hand count and a script written apart
  from Esper, route for route and line for line.
- **Guards as checks**: `if (!locals.user) error(401)` makes its function an `authn` guard, and a
  hook or a layout's `load` that refuses so answers on its own
  ([D34](/decisions/#d34--a-check-that-refuses-is-a-guard)); `packages/core/test/sveltekit.test.ts`
  checks an action without the check its siblings make, and a page reset past its group's layout.
- **scip-typescript** runs on Budget with its dependencies: calls without an edge fall from 337 to
  60, the 24 routes unchanged.
- **The Go and Hono counts still hold**: all seven counts run in `packages/core/test/counts.test.ts`.

## M8 — Python and FastAPI

The third language: Python as a module of its own, as Go and TypeScript are
([D23](/decisions/#d23--a-language-is-a-module-the-core-names-none)), with what its syntax states
(imports, classes and methods, decorators, type annotations), and FastAPI's two profiles: routes
declared by decorators, `APIRouter` prefixes and `include_router`, dependencies (`Depends`,
`Security`) as the chain and the guards, and reads from the path, query, headers, cookies, body and
the Pydantic models they are parsed into. A typed indexer for Python joins the analyzers if one fits
the contract. It comes before dataflow because the auditor's targets have FastAPI backends.

**Done when** FastAPI, in framework mode, and a FastAPI application, in application mode, match
their hand count, recorded in `profiles/fastapi/counts/`, and the Go, Hono and SvelteKit counts
still hold.

## M9 — Dataflow, on demand

Joern as a second analyzer behind the same contract: a question (this read, this sink) asked through
`esper_flow_request` or the interface, answered as `flows` edges with each step cited.

**Done when** Joern is added as an image and a manifest, with no change to the core, the store or the
interface, and a question on chi or Hono comes back with cited steps or an explicit "no flow found".

## After that

Each new framework is a pair of profiles measured against hand-counted targets, in the order of
[D5](/decisions/#d5--two-kinds-of-target-applications-and-the-frameworks-themselves): Next.js, then TanStack Start, then Express, Nuxt and the others as targets ask for them.
