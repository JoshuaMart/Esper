---
title: The graph schema
description: How a snapshot is stored, and the conventions every node, edge and fact follows.
---

The model is the one of [D6](/decisions/#d6--the-graph-model); this page is how it is stored and
built. The source of truth is the code: `packages/core/src/graph.ts` for the model,
`packages/core/src/store.ts` for the tables.

## Tables

One database per project ([D9](/decisions/#d9--storage-one-sqlite-database-per-project-outside-the-target)),
schema version **1**, recorded in `meta`. A database of another version is refused rather than
read.

| Table | One row per | Columns |
|---|---|---|
| `snapshots` | indexed version of the target | `id`, `ref` (the git ref asked for), `commit_sha`, `dirty`, `created_at`, `schema_version`, `profiles` (JSON list) |
| `files` | file read | `path`, `hash` (SHA-256 of its content), `language` |
| `skips` | folder or file skipped | `path`, `reason` |
| `nodes` | node | `ref`, `kind`, `name`, `file`, `start_line`, `end_line`, `fingerprint`, `data` (JSON) |
| `edges` | edge | `kind`, `from_ref`, `to_ref`, `file`, `line`, `source`, `data` (JSON) |
| `facts` | fact on a node | `node_ref`, `kind`, `value`, `file`, `line`, `source`, `data` (JSON) |

Every row but `meta`'s carries its `snapshot_id`, and deleting a snapshot deletes its rows. An edge
or a fact without a `file` and a `line` cannot be stored: the columns are `NOT NULL`.

## Conventions

- **Paths** are relative to the target's root, with `/`. **Lines** are 1-based.
- **Order.** A snapshot is written in canonical order: files, skips and nodes by path or
  reference, edges by kind, ends and citation, facts by node, kind, value and citation. The same code
  gives the same rows, whatever order its files were read in.
- **Sources.** `tree-sitter` for what the language's queries extract, `tree-sitter:<profile>` for
  what a profile extracts, `<analyzer>@<version>` for an analyzer's import, `osv` and `git` for
  advisories.
- **Calls.** `data.resolution` is `resolved` or `guessed`; a guessed edge has `data.reason`. A call
  whose callee the index cannot name gets no edge, and is counted as unresolved in the index result.
- **Function literals.** A literal is a `decl`, and the function that defines it has a `calls` edge
  to it, with `data.literal`: a handler built inside a middleware runs when the middleware's result
  is called, so it is reachable from the middleware.
- **Externals.** A package is `ext:<import path>`, a symbol of it `ext:<import path>#<symbol>`, and
  a method of one of its types `ext:<import path>#<Type>.<method>`.

## Go

What the Go extraction states, from syntax alone:

| Construct | Becomes |
|---|---|
| `func F()` | `decl` `path#F` |
| `func (s *Server) Routes()` | `decl` `path#Server.Routes` |
| two `func init()` in one file | `path#init`, `path#init~2` |
| `func(…) {…}` inside `F` | `decl` `path#F/fn1`, called by `path#F` |
| `var h = func(…) {…}` | `decl` `path#h` |
| `import "example.com/shop/store"` (module path from `go.mod`) | `imports` edges to each file of `store/` |
| `import "net/http"` | an `imports` edge to `ext:net/http` |

A call `x.m()` is **resolved** when the syntax states the type of `x`, following Go's scopes: the
nearest declaration of `x` wins, so a variable declared in a `range`, a type switch or an inner
block hides an outer one even when its own type is unknown. The type can be stated as:
- a parameter, a named result or a receiver;
- a `var x T`;
- `x := T{…}` or `&T{…}`;
- the result type declared by the function or method `x` was assigned from, by position in
  `a, err := f()`;
- a field of a struct of the module.

A method of a type outside the module is named by its import path
(`ext:net/http#Request.FormValue`). A value that comes from outside the module but whose type is not
stated has none of the module's methods, so it gets no edge. Otherwise, when exactly one method of
the module has that name, the call is **guessed** to be it, with the reason.

A package of the module is known by the name its `package` clause declares, and a local variable
that shadows an imported package's name is the variable. When two files of one package declare the
same name, as build variants do (`sock_unix.go`, `sock_windows.go`), a call to it is a guess to each,
whatever order the files are read in.

Measured on chi 5.3.2, its 35 non-test files:
- 256 declarations;
- 537 call edges, of which 27 are guessed (5.0 %), mostly calls through an interface;
- 109 calls left without an edge, mostly to methods of values from the standard library whose type
  is not stated.

The tree-sitter prototype cited in [D12](/decisions/#d12--precision-scip-right-after-the-first-index-dataflow-later)
guessed 262 of 486.

## Entry points

An application's routes, read with its profile ([Profiles](/reference/profiles/)):

| What | Stored as |
|---|---|
| a route | an `entry` node `route:<METHOD> <path>`, at the line that registers it; `data` keeps the pattern as written, the handler's text, and what could not be resolved |
| its method and path | `method` and `path` facts |
| its handler | `handles` edges to each declaration or external the handler names |
| its chain | `chain` edges, with `data.position` from the outermost middleware |
| a read | a `read` fact on the declaration that makes it, `header.X-Forwarded-For` or `body` |
| what an entry reads | a `read` fact on the entry for each read its handler or its chain reaches through resolved calls, with `data.via` (the declaration) and `data.from` (`handler` or `chain`) |

Two routes with the same method and path take an ordinal, `route:GET /x~2`. An entry's fingerprint
covers its method, path, handler and chain, and the fingerprints of the declarations they name.
