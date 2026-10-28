---
title: Sources
description: The tools, papers and articles studied while scoping Esper, and what we take from each.
---

Each source is read against one question: **does it tell how an attacker's request enters the
code, and where it goes?** Each entry says what the source is and what Esper takes from it. Claims
about a tool come from its own documentation and code, not from measurements of ours.

## Security indexing

- **[ZeroPath](https://zeropath.com/blog/how-zeropath-works).** It builds an enriched call graph
  with tree-sitter (routes, methods, middleware, authentication checks) before any analysis. This
  is the meaning of "enriched" in Esper: the graph carries what matters to an attacker about a node,
  not only that it exists.
- **[OpenAnt](https://github.com/knostic/OpenAnt)** (Knostic,
  [article](https://knostic.ai/blog/openant)). An LLM vulnerability scanner whose first two stages
  are pure static analysis: it extracts every function with its call graph (a "unit"), then keeps
  only the units reachable from an entry point. On OpenSSL, reachability alone takes 15,232 units
  down to 390, at no model cost. It is the case for a graph that answers reachability before any
  model reads the code. Its parsers are written per language rather than on one parser, which is
  what Esper avoids.
- **[Code Property Graph](https://ieeexplore.ieee.org/document/6956589)** (Yamaguchi et al., IEEE S&P
  2014), implemented by [Joern](https://github.com/joernio/joern) and specified in
  [codepropertygraph](https://github.com/ShiftLeftSecurity/codepropertygraph). Built for
  vulnerability discovery, it merges the syntax tree, the control flow graph and the program
  dependence graph into one queryable graph. It shows how far a graph can go; Esper starts with
  entry points and call edges, and leaves room for more layers.
- **[CodeQL](https://github.com/github/codeql).** It extracts a database from a build and answers
  dataflow queries: does this source reach this sink? It is precise, but it needs a build and does
  not cover every language (PHP, for one). Esper does not replace it: a deep dataflow engine can
  feed the graph, rather than be the graph.

## Code graphs for agents

None of these answers the attack-surface question on its own. GitNexus answers enough of it to be
the first thing to compare against.

| Project | What it brings | What is missing for an audit |
|---|---|---|
| **[GitNexus](https://github.com/abhigyanpatwari/GitNexus)** (TypeScript) | tree-sitter on 18 languages, indexed without a model. Route extractors for FastAPI (with router prefixes), Django, Gin/Echo, Nest, Next.js, Spring, Laravel and tRPC, middleware detection, and an opt-in taint layer (control flow, reaching definitions, source → sink). MCP tools, a CLI and a web graph explorer. | No chi, no SvelteKit. No record of what a handler reads from the request, no guards compared across sibling routes, no signals. Licensed PolyForm Noncommercial, so its code cannot be reused. |
| **[code-graph-rag](https://github.com/vitali87/code-graph-rag)** (Python, MIT) | tree-sitter, sharpened by compiler-grade frontends where available, into a graph stored in SQLite, Memgraph or Neo4j. | Questions go through a model that writes Cypher: one more model in the loop, and answers that depend on it. Nothing on routes or the request. |
| **[CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext)** (Python, MIT) | Calls, imports and inheritance on 23 languages, in a graph database, served over MCP. | Nothing about the web: no routes, no middleware, no reads. |
| **[Serena](https://github.com/oraios/serena)** (MCP over LSP, 40+ languages) | Real language servers: typed declarations and references. | It answers query by query and builds no graph or route in advance. It could settle the edges Esper can only guess: untyped receivers, homonyms. |

- **[Aider's repository map](https://aider.chat/docs/repomap.html).** It extracts definitions and
  references with tree-sitter and ranks them on a graph to fit a token budget. It is the case for
  bounded answers: an agent needs the most relevant part of the graph, sized for its context.

## Building blocks

- **[tree-sitter](https://tree-sitter.github.io/tree-sitter/).** An incremental parser with grammars
  for most languages and a query language over the syntax tree. One parser and one graph format for
  every language, with what is language-specific held in queries.
- **[Kythe](https://github.com/kythe/kythe)** (Google) and
  **[Glean](https://github.com/facebookincubator/Glean)** (Meta). Language-agnostic schemas of facts
  about code, built to answer cross-references at scale. Their lesson is the schema: the same node
  and edge kinds for every language, with each extractor targeting that schema.
- **[SCIP](https://github.com/scip-code/scip).** Sourcegraph's code intelligence protocol, the
  successor of LSIF, with human-readable symbol strings. A candidate for importing precise,
  compiler-backed references where a language has an indexer, and for naming symbols stably.
- **[stack-graphs](https://github.com/github/stack-graphs)** (GitHub, archived). Name resolution from
  tree-sitter, file by file, without building the project. It shows that resolution can be
  incremental and build-free. The repository is archived, so it is a reference, not a dependency.

## Notes on code

- **[0](https://github.com/0sec-labs/0)** (0sec labs). An AI security harness with a web UI, a CLI
  and an MCP server, the same three surfaces as Esper. Its
  [Learning](https://docs.0.security/learning/) feature keeps lessons as source-linked notes about a
  codebase (useful files, trust boundaries, testing approaches), and rechecks the hashes of the
  cited files before each use: a lesson on a changed file is left out. That is the question Esper's
  notes must answer, what happens to a note when the code under it changes; Esper keys notes on
  nodes rather than files, so a note survives a change elsewhere in its file.

## Visualisation

- **[Sourcetrail](https://github.com/CoatiSoftware/Sourcetrail)** (archived). An interactive source
  explorer that linked a graph view to the code view: click a node, see its code, and the reverse.
  It is the reference for the web interface: the graph and the code side by side, never one
  without the other.
