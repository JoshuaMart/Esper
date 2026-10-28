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
| [M1](#m1--the-core-on-go-and-chi) | The core, on Go and chi | chi and Wakapi pass their hand count | in progress |
| [M2](#m2--mcp-and-notes) | MCP and notes | an agent hunts chi over MCP and its notes survive a reindex | not started |
| [M3](#m3--scip-for-go) | SCIP for Go | the first analyzer runs through the contract; guessed edges drop | not started |
| [M4](#m4--typescript-and-hono) | TypeScript and Hono | Hono and Kaneo pass their hand count | not started |
| [M5](#m5--the-server-and-the-web-interface) | The server and the web interface | an audit can be followed and annotated in the browser | not started |
| [M6](#m6--enrichment-and-past-advisories) | Enrichment and past advisories | claims and advisory links measured on chi and Hono | not started |
| [M7](#m7--dataflow-on-demand) | Dataflow, on demand | a `flows` question answered by Joern, every step cited | not started |
| [Next](#after-that) | More frameworks | SvelteKit, Next.js, FastAPI, each a pair of profiles | |

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

## M3 — SCIP for Go

The analyzer contract ([D12](/decisions/#d12--precision-scip-right-after-the-first-index-dataflow-later)):
the manifest, the container with the source mounted read-only and dependencies fetched with scripts
disabled, the JSON Lines import with its validation, its schema written in `schemas/`. scip-go is
the first analyzer built on it.

**Done when**

- on chi 5.3.2, the share of guessed edges falls well below the one M1 measured with tree-sitter
  alone, and each edge it resolves names `scip-go` as its source;
- a file with one invalid line, or one citation that does not match the snapshot, is rejected whole.

## M4 — TypeScript and Hono

The TypeScript queries, imports resolved through the target's `tsconfig` paths, the two Hono
profiles, and scip-typescript through the contract from M3. This is the milestone that shows a
second language costs queries and profiles, not changes to the core.

**Done when** Hono, in framework mode, and [Kaneo](https://github.com/usekaneo/kaneo)'s API, a Hono
application, in application mode, match their hand count, recorded in `profiles/hono/counts/`, and nothing under `packages/core` had to learn about TypeScript or Hono by
name.

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

## M7 — Dataflow, on demand

Joern as a second analyzer behind the same contract: a question (this read, this sink) asked through
`esper_flow_request` or the interface, answered as `flows` edges with each step cited.

**Done when** Joern is added as an image and a manifest, with no change to the core, the store or the
interface, and a question on chi or Hono comes back with cited steps or an explicit "no flow found".

## After that

Each new framework is a pair of profiles measured against hand-counted targets, in the order of
[D5](/decisions/#d5--two-kinds-of-target-applications-and-the-frameworks-themselves): SvelteKit, then
Next.js, then Python with FastAPI, then Express, Nuxt and the others as targets ask for them.
