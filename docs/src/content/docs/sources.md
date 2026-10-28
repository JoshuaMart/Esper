---
title: Sources
description: The tools, papers and articles studied while scoping Esper, and what we take from each.
---

Each entry says what the source is and what Esper takes from it. Claims about a tool come from its
own documentation, not from measurements of ours.

## Code graphs and indexing

- **[tree-sitter](https://tree-sitter.github.io/tree-sitter/).** An incremental parser with grammars
  for most languages and a query language over the syntax tree. It is the backbone of the Forge
  indexer, and it will be Esper's: one parser and one graph format for every language, with what is
  language-specific held in queries.
- **[Code Property Graph](https://ieeexplore.ieee.org/document/6956589)** (Yamaguchi et al., IEEE S&P
  2014), implemented by [Joern](https://github.com/joernio/joern) and specified in
  [codepropertygraph](https://github.com/ShiftLeftSecurity/codepropertygraph). It merges the syntax
  tree, the control flow graph and the program dependence graph into one queryable graph. It shows
  how far a graph can go when it is built for analysis; Esper starts with the declarations and call
  edges, and leaves room for more layers.
- **[CodeQL](https://github.com/github/codeql).** It extracts a database from a build and answers
  dataflow queries over it. It is precise, but it needs a build and does not cover every language
  (PHP, for one). Esper does not try to replace it: a deep dataflow engine can feed the graph,
  rather than be the graph.
- **[Kythe](https://github.com/kythe/kythe)** (Google) and
  **[Glean](https://github.com/facebookincubator/Glean)** (Meta). Language-agnostic schemas of facts
  about code, built to answer cross-references at scale. Their lesson is the schema: the same node
  and edge kinds for every language, with each extractor targeting that schema.
- **[SCIP](https://github.com/scip-code/scip).** Sourcegraph's code intelligence protocol, the
  successor of LSIF, with human-readable symbol strings. It is a candidate for importing precise,
  compiler-backed references where a language has an indexer, and for naming symbols stably.
- **[stack-graphs](https://github.com/github/stack-graphs)** (GitHub, archived). Name resolution from
  tree-sitter, file by file, without building the project. It shows that resolution can be
  incremental and build-free. The repository is archived, so it is a reference, not a dependency.

## Graphs for agents

- **[GitNexus](https://github.com/abhigyanpatwari/GitNexus).** The closest project to Esper: it
  indexes a codebase into a knowledge graph of symbols, calls, dependencies and execution flows, and
  serves it through MCP tools (`query`, `context`, `impact`, `trace`), a CLI and a web graph
  explorer. Its licence is PolyForm Noncommercial, so its code cannot be reused here. What Esper
  adds is notes as a first-class part of the graph, and edges that say whether they are resolved or
  guessed.
- **[CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext)** and
  **[code-graph-rag](https://github.com/vitali87/code-graph-rag).** Both parse code with tree-sitter
  into a graph database and expose it to AI assistants. They confirm the shape (index, store, query
  over MCP) and show the cost of a separate database to run.
- **[Serena](https://github.com/oraios/serena).** An MCP toolkit that gives agents semantic retrieval
  and editing through language servers. A language server is precise but must run the project's
  toolchain; Esper reads the code without building it, and keeps a persistent graph rather than
  live queries.
- **[Aider's repository map](https://aider.chat/docs/repomap.html).** It extracts definitions and
  references with tree-sitter and ranks them on a graph to fit a token budget. It is the case for
  bounded answers: an agent needs the most relevant part of the graph, sized for its context.

## Visualisation

- **[Sourcetrail](https://github.com/CoatiSoftware/Sourcetrail)** (archived). An interactive source
  explorer that linked a graph view to the code view: click a node, see its code, and the reverse.
  It is the reference for the web interface: the graph and the code side by side, never one
  without the other.

## Security indexing

- **[ZeroPath](https://zeropath.com/blog/how-zeropath-works).** It builds an enriched call graph
  with tree-sitter (routes, methods, middleware, authentication checks) before any analysis. This
  is the meaning of "enriched" in Esper: the graph carries what matters about a node, not only that
  it exists.
- **[OpenAnt](https://github.com/knostic/OpenAnt)** (Knostic,
  [article](https://knostic.ai/blog/openant)). An LLM vulnerability scanner whose first two stages
  are pure static analysis: it extracts every function with its call graph (a "unit"), then keeps
  only the units reachable from an entry point. On OpenSSL, reachability alone takes 15,232 units
  down to 390, at no model cost. It is the case for a graph that answers reachability before any
  model reads the code. Its parsers are written per language rather than on one parser, which is
  what Esper avoids.

## Notes on code

- **[0](https://github.com/0sec-labs/0)** (0sec labs). An AI security harness with a web UI, a CLI
  and an MCP server, the same three surfaces as Esper. Its
  [Learning](https://docs.0.security/learning/) feature keeps lessons as source-linked notes about a
  codebase, and rechecks the hashes of the cited files before each use: a lesson on a changed file
  is left out. That is the question Esper's notes must answer, what happens to a note when the code
  under it changes, answered by exclusion; Esper aims to carry the note over to the node when the
  node has not changed.
