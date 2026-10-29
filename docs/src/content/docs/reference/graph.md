---
title: The graph schema
description: How a snapshot is stored, and the conventions every node, edge and fact follows.
---

The model is the one of [D6](/decisions/#d6--the-graph-model); this page is how it is stored and
built. The source of truth is the code: `packages/core/src/graph.ts` for the model,
`packages/core/src/store.ts` for the tables.

## Tables

One database per project ([D9](/decisions/#d9--storage-one-sqlite-database-per-project-outside-the-target)),
schema version **5**, recorded in `meta`. A database of schema 3 or 4 is brought to 5 in place,
since 4 only added the `analyzers` of each snapshot and 5 only adds tables, for advisories and
claims; a database of another
version is refused rather than read.

| Table | One row per | Columns |
|---|---|---|
| `snapshots` | indexed version of the target | `id`, `ref` (the git ref asked for), `commit_sha`, `dirty`, `created_at`, `schema_version`, `profiles` (JSON list), `indexer` (what indexed it, hashed), `analyzers` (JSON list, such as `["scip-go@0.2.9"]`) |
| `files` | file read | `path`, `hash` (SHA-256 of its content), `language` |
| `skips` | folder or file skipped | `path`, `reason` |
| `nodes` | node | `ref`, `kind`, `name`, `file`, `start_line`, `end_line`, `fingerprint`, `data` (JSON) |
| `edges` | edge | `kind`, `from_ref`, `to_ref`, `file`, `line`, `source`, `data` (JSON) |
| `facts` | fact on a node | `node_ref`, `kind`, `value`, `file`, `line`, `source`, `data` (JSON) |
| `contents` | file text | `hash`, as in `files`, and `text` |

Every row of these but `contents`' carries its `snapshot_id`, and deleting a snapshot deletes its
rows. An edge or a fact without a `file` and a `line` cannot be stored: the columns are `NOT NULL`.
The text of each file read is stored once, by its hash, for the snapshots that hold it: code is read
back from the snapshot (`esper_read`, a node's excerpt), never from the target, whose checkout may
have changed since.

[Notes](/reference/notes/) have their own tables, which no snapshot owns:

| Table | One row per | Columns |
|---|---|---|
| `notes` | note, as it now is | `id`, `kind`, `status`, `body`, `citations` (JSON list), `author`, `created_at`, `updated_at`, `revision`, `snapshot_id` (the snapshot it is anchored on), `deleted_at`, `deleted_by`, `deleted_reason` |
| `note_anchors` | anchor of a note | `note_id`, `position`, `ref`, `kind`, `fingerprint` |
| `note_revisions` | revision of a note | `note_id`, `revision`, `action` (`create`, `update`, `delete`), `author`, `at`, `content` (the note then, as JSON) |

[Advisories](/reference/command-line/#past-advisories) are the project's too
([D30](/decisions/#d30--advisories-belong-to-the-project-and-are-placed-on-each-snapshot)):

| Table | One row per | Columns |
|---|---|---|
| `advisories` | advisory kept from the last fetch | `id` (its OSV identifier), `aliases`, `summary`, `details`, `severity`, `rating`, `published`, `modified`, `package`, `ranges`, `symbols`, `refs`, `status` (`linked`, `unlinked`), `how`, `fixes` (the fix commits), `links` (JSON list), `fetched_at` |
| `advisory_states` | advisory and snapshot | `advisory_id`, `snapshot_id`, `state` (`affected`, `fixed`, `unaffected`, `unknown`), `how` |
| `advisory_fetches` | fetch from OSV | `id`, `at`, `packages`, `advisories` (kept), `low` (left out) |

[Claims](/reference/claims/) by a model are the project's too, apart from the facts
([D17](/decisions/#d17--model-enrichment-claims-beside-the-facts)):

| Table | One row per | Columns |
|---|---|---|
| `claims` | answer a model gave | `id`, `question`, `kind`, `subject`, `tier`, `value`, `value_kind`, `text`, `citations` (JSON list), `reason`, `status` (`accepted`, `rejected`, `insufficient`), `rejection`, `model`, `provider`, `prompt_version`, `fingerprints` (the nodes it rests on), `reads`, `snapshot_id` (where it was asked), `author`, `created_at` |

A link holds its precision (`symbol`, `fix-diff`, `file`), the node's reference where the fix
changed it (for a symbol, its name and folder), the fix commit, the changed line of the parent
(`hunk`), the node's fingerprints before and after the fix, and its source.

### Advisories on a snapshot

When a snapshot is read, each advisory is a node `osv:<id>` of kind `advisory`, whose `data` holds
its summary, severity, aliases, status and its `state` on the snapshot. Each link is an `affects`
edge from it, placed on the node of the same reference, else on a node of the same kind with its
code from before or after the fix (`data.movedFrom`). The edge cites the node's first line, and its
`data` holds `precision`, `state`, `fix`, `hunk`, and `code`: `as-fixed`, `as-before-fix` or
`changed`. An entry point whose handler or chain reaches an affected declaration through calls gets
a `fix-downstream` signal for each advisory, with `data.advisory`, `data.via`, `data.from` and
`data.guessed`. None of these rows is stored with the snapshot.

## Conventions

- **Paths** are relative to the target's root, with `/`. **Lines** are 1-based.
- **Fingerprints** are the SHA-256 of a node's tree-sitter tokens, comments left out
  ([D7](/decisions/#d7--stable-references-and-fingerprints)). A declaration's own name is left out
  too, so that a function renamed without other change keeps its fingerprint
  ([D21](/decisions/#d21--a-declarations-fingerprint-leaves-its-name-out)); a file's covers the
  whole file.
- **Order.** A snapshot is written in canonical order: files, skips and nodes by path or
  reference, edges by kind, ends and citation, facts by node, kind, value and citation. The same code
  gives the same rows, whatever order its files were read in.
- **Sources.** `tree-sitter` for what the language's queries extract, `tree-sitter:<profile>` for
  what a profile extracts, `<analyzer>@<version>` for an analyzer's import (`scip-go@0.2.9`), `osv`
  and `git` for advisories.
- **Calls.** `data.resolution` is `resolved` or `guessed`; a guessed edge has `data.reason`. A call
  whose callee the index cannot name gets no edge, and is counted as unresolved in the index result.
  A call through a method of an interface of the module, resolved by an analyzer, has
  `data.interface` (`Routes.Match`) on its edge to each method that implements it
  ([analyzers](/reference/analyzers/)).
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

Two more edges come from values rather than calls:
- **A function that returns a function value** reaches it: `return compressor.Handler` is a
  `calls` edge with `data.reference`, as a middleware factory reaches the handler it builds. A
  function stored for later, as a router stores its handlers, is not reached this way.
- **A call to a package variable holding a function** is a guess to what the package assigns it:
  `DefaultLogger(next)`, where `init` sets `DefaultLogger = RequestLogger(…)`, is guessed to call
  `RequestLogger`.

A package of the module is known by the name its `package` clause declares, and a local variable
that shadows an imported package's name is the variable. When two files of one package declare the
same name, as build variants do (`sock_unix.go`, `sock_windows.go`), a call to it is a guess to each,
whatever order the files are read in.

Measured on chi 5.3.2, its 35 non-test files:
- 256 declarations;
- 540 call edges, of which 30 are guessed (5.6 %), mostly calls through an interface;
- 106 calls left without an edge, mostly to methods of values from the standard library whose type
  is not stated.

The tree-sitter prototype cited in [D12](/decisions/#d12--precision-scip-right-after-the-first-index-dataflow-later)
guessed 262 of 486. With scip-go (`esper index --precise`), 1 of 618 is guessed and 28 calls are left
without an edge ([analyzers](/reference/analyzers/#scip-go)).

## TypeScript

What the TypeScript and JavaScript extraction states, from syntax alone
([D24](/decisions/#d24--typescript-and-javascript-as-their-syntax-states-them)):

| Construct | Becomes |
|---|---|
| `function f()`, `const f = () => …` | `decl` `path#f` |
| `class Service { update() {} }` | `decl` `path#Service`, and `path#Service.update` |
| `#dispatch()`, a private method | `decl` `path#Hono.#dispatch` |
| `const actions = { create() {} }` | `decl` `path#actions.create` |
| `export default async (c) => …` | `decl` `path#default` |
| `const auth = createMiddleware(async (c, next) => …)` | `decl` `path#auth/fn1`, exported with `auth` |
| `(c) => …` inside `createApp`, held by no name | `decl` `path#createApp/fn1`, a literal, called by `path#createApp` |
| `import { find } from '@app/db'` (a package of the target) | `imports` edges to the file its entry point is |
| `import { cors } from 'hono/cors'` | an `imports` edge to `ext:hono/cors` |

In a JavaScript file, the types its documentation comments state are read as TypeScript's
annotations ([D33](/decisions/#d33--javascript-typed-by-its-comments-and-types-a-profile-states)):

| Comment | Types |
|---|---|
| `/** @param {Request} request */` before a function | its parameter `request`; a destructured one by its position |
| `/** @type {import('@sveltejs/kit').RequestEvent} */ const event = …` | the variable |
| `(/** @type {Request} */ r) => …` | the parameter written after it |
| `/** @type {T} */ (value)` | the expression, a cast |
| `/** @returns {T} */` | what the function returns |
| `/** @typedef {T} Name */`, `/** @import { A } from 'm' */` | a type alias, an import |

A type the target declares where the index does not read it, a declaration file (`.d.ts`), is named
by its package: `@sveltejs/kit#RequestEvent` in SvelteKit's own code, as outside it.

A declaration is `exported` (`data.exported`) when an `export` names it, with the public methods of
an exported class, the functions of an exported object, and the functions given to the call an
exported name holds. Imports resolve through relative paths (`./find.js` is `find.ts`), the `paths`
of the nearest `tsconfig.json` or `jsconfig.json`, the `imports` of the nearest `package.json`
(`#lib/*`), the folders a profile maps a specifier to (`$lib`), and the target's own packages by
their name and `exports`; Node's built-in modules are `ext:node:<module>`, the runtime's globals
`ext:globalThis`. Only `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` files are
read: not declaration files, and not the components of a framework such as Svelte's `.svelte`.

A call `x.m()` is **resolved** when the syntax states the type of `x`: an annotation, `new C()`, the
result type a function declares or the one expression it returns, a field, a getter's result, a
constructor's parameter property, `Promise<T>` once awaited, `ReturnType<typeof f>`, `Pick<T, …>`
and the like, `x as T`, `a ?? b` as `a`. A name destructured from a parameter or a value has the
type of the property it is taken by, as a profile states the members of types outside the target
(`members`). A function literal's parameters take their types from a function type that the variable holding it,
the function returning it, or the parameter it is passed to declares; a handler's first parameter,
when nothing states it, is the profile's context ([profiles](/reference/profiles/#hono)). A getter
of the target's own classes is called when its property is read (`data.getter`). Calls are
**guessed**, with the reason:

- through an interface or an abstract class: each class of the target that implements it;
- through a class field the class's own code assigns (`getPath is assigned …`);
- through a computed key of an object of functions (`detectors[name] is one of the functions
  detectors holds`);
- on a value no syntax types, when the target has one member of that name, unless values of any type
  have it (`map`, `then`, `get`), which `library.yaml` lists as `builtins`.

A literal, and a method of an object literal, are called by the function that defines them:
`{ getClientAddress() { … } }` passed to the server is reached from where it is written.

`library.yaml` also states the runtime's `globals`, what functions outside the target return
(`drizzle()` gives a `NodePgDatabase`, `betterAuth()` an `Auth`, a `Proxy` the type of what it
wraps), the members of those types (`Auth.api`), and the sinks and data calls of common libraries.

Measured on Hono v4.13.14, 238 files, Kaneo's API at v2.48.0, 687 files, SvelteKit 3.1.0, 274
files, Kener v4.1.10, 329 files, and Budget at `cfce07b`, 46 files:

| | Hono | Kaneo's API | SvelteKit | Kener | Budget |
|---|---|---|---|---|---|
| declarations | 1392 | 3059 | 2608 | 1781 | 207 |
| call edges | 2035, 106 guessed (5.2 %) | 10055, 85 guessed (0.8 %) | 5749, 62 guessed (1.1 %) | 4015, 4 guessed | 554, none guessed |
| calls without an edge | 1697 | 5123 | 2967 | 4027 | 337 |
| with scip-typescript | 9 guessed of 3277, 423 without an edge | 85 guessed of 11317, 3861 without an edge | | | 831 edges, 60 without one |

Hono's and Kaneo's measures are those since M7, whose types (destructured parameters, `??`,
methods of object literals) resolve a few more calls than M4 did.

Most calls left without an edge are methods of values from outside the target whose type the
syntax does not state (`res.headers.get`, a query builder's `.where`), as for Go.

## Python

What the Python extraction states, from syntax alone
([D36](/decisions/#d36--python-as-its-syntax-states-it)):

| Construct | Becomes |
|---|---|
| `def f()` | `decl` `path#f` |
| `class Service:` with `def update(self)` | `decl` `path#Service`, and `path#Service.update` |
| `def inner()` inside `create_routes` | `decl` `path#create_routes/inner`, called by `path#create_routes` |
| `key = lambda r: …` | `decl` `path#key` |
| `lambda r: …` inside `f`, held by no name | `decl` `path#f/lambda1`, a literal, called by `path#f` |
| `@property def headers(self)` | `decl` `path#HTTPConnection.headers`, called where `.headers` is read |
| `from shop.routers import items_router` (a module of the target) | an `imports` edge to `src/shop/routers/__init__.py` |
| `from fastapi import Depends` | an `imports` edge to `ext:fastapi` |

A file's module is its path from the nearest folder above it without an `__init__.py`:
`src/space/api/rest.py` is `space.api.rest`, and the file node's `data.module` says so. Imports
resolve through those names, relative imports from the file's package, a package's `__init__.py`
re-exports and `from m import *` (as `__all__` says). A name outside the target is named by the
module the code imports and the name (`ext:fastapi#Depends`, `ext:os.path#join`, a built-in
`ext:builtins#open`), or by the module a profile says re-exports it (`fastapi#Request` is
`starlette.requests#Request`). A declaration is `exported` when neither its name nor a part of its
module starts with one underscore; a method when its class is.

A call `x.m()` is **resolved** when the syntax states the type of `x`: an annotation (`Annotated[T,
…]`, `Optional[T]` and `T | None` as `T`, a string naming a class), `x = C()`, the return annotation
of the function `x` comes from or the one value it returns, a class's field (from its body, or what
its methods assign to `self.x`), a property's result, a module-level type alias of the target as a
type of its own (`starlette.types#Scope`). A class called runs its `__init__`, `super().m()` a
base's method, a method missing from a class of the target a base's outside it
(`ext:pydantic#BaseModel.model_dump`). Calls are **guessed**, with the reason, through an abstract
method (each override in a subclass of the target), and on a value no syntax types when the target
has one method of that name, unless values of Python's own types have it (`get`, `append`,
`model_dump`), which `library.yaml` lists as `builtins`.

Three more edges come from values rather than calls: a nested function or a lambda is called by the
function that defines it; a function returned (`return admitted`) by the function that returns it;
and a function given to a call (`run_in_threadpool(self.debug_response, request, exc)`) by the
function that gives it, each with `data.reference` or `data.literal`.

Measured on getspace's backend at `d094115`, 130 files, FastAPI 0.162.0, 74 files, and Starlette
1.10.0, 36 files:

| | getspace's backend | FastAPI | Starlette |
|---|---|---|---|
| declarations | 1444 | 715 | 642 |
| call edges | 5836, 496 guessed (8.5 %) | 3294, 7 guessed | 1420, 14 guessed |
| calls without an edge | 2342 | 882 | 545 |
| with scip-python | 1451 without an edge | 329 without an edge | 189 without an edge |

A third of getspace's guesses are `workspace.transaction(…)`, on a parameter its code does not
type, which the target defines once. Most calls left without an edge are methods of values from
outside the target whose type the syntax does not state, as for Go and TypeScript.

## Entry points

An application's routes, read with its profile ([Profiles](/reference/profiles/)):

| What | Stored as |
|---|---|
| a route | an `entry` node `route:<METHOD> <path>` (a websocket's method is `WEBSOCKET`), at the line that registers it, a decorator's for a decorated function; `data` keeps the pattern as written, the handler's text, and what could not be resolved |
| its method and path | `method` and `path` facts |
| its handler | `handles` edges to each declaration or external the handler names |
| its chain | `chain` edges, with `data.position` from the outermost middleware |
| a read | a `read` fact on the declaration that makes it, `header.X-Forwarded-For` or `body` |
| what an entry reads | a `read` fact on the entry for each read its handler or its chain reaches through resolved calls, with `data.via` (the declaration) and `data.from` (`handler` or `chain`) |

Two routes with the same method and path take an ordinal, `route:GET /x~2`. An entry's fingerprint
covers its method, path, handler and chain, and the fingerprints of the declarations they name.

## Guards, sinks and signals

What the facts say, and where they come from:

| Fact | On | From |
|---|---|---|
| `guard` | an entry | a chain member that a profile's `guards` names, with its kind; or a check its handler, a chain member or what they call makes, with `data.check` and `data.via` |
| `guard` | a declaration | a check: a condition on a value read from the request, then one of the profile's `refusals` (`if (!locals.user) error(401)`), with the kind of the profile's check rule ([D34](/decisions/#d34--a-check-that-refuses-is-a-guard)); or a dependency of a route that raises, in a condition, an exception with a status the profile's rule names (`raise HTTPException(401)`), with `data.status` ([D38](/decisions/#d38--what-a-parameter-reads-and-a-dependency-that-refuses)) |
| `sink` | the declaration that makes the call | a call that the language's `library.yaml` lists as a sink, when the argument it interprets is not a literal: `db.Query("… " + id)` is a sink, `db.Query("… = ?", id)` is not |
| `signal` | a declaration | the rules of [D6](/decisions/#d6--the-graph-model), each at the line that triggers it |
| `signal` | an entry | the signals of what its handler, or its chain, reaches through calls, with `data.via` and `data.from`; `sink-reachable` for a sink, with `data.sink` |

- **Reachability.** An entry's signals follow resolved and guessed calls. A signal reached only
  through a guessed call has `data.guessed`.
- **Interfaces.** A call on a value whose type is an interface of the module is guessed to be the
  method of each type of the module that has all of the interface's methods, with the reason
  (`HeartbeatRepository implements IHeartbeatRepository`).
- **Short-circuit.** A middleware short-circuits when it passes the request on in one place
  (`next.ServeHTTP(w, r)`, or `next(w, r)` for a handler function it was given) and, inside a
  condition, returns from a block that does not.
- **Short-circuit**, in TypeScript: a middleware, a function whose first parameter is the request
  or the context, as stated or as the profile gives it, that passes the request on, calling a
  function it was given after it (`next()`), and that returns or throws, inside a condition, from a
  block that does not; or a function given the request, or something destructured from it, that
  calls one of the profile's `refusals` inside a condition (a layout's `load` that redirects).
- **Divergent guards.** Siblings are the routes declared on the same router, seen through `With`
  and `Group`, or, for a route tree, the routes under the same nearest folder that holds a layout or
  is a route group, when there are at least three. An entry is divergent when it lacks a guard kind, or a
  short-circuiting chain member, that more than half of its siblings have; `data.missing` names
  them. A short-circuiting member is known by the declarations that refuse, the ones it reaches
  that carry `short-circuit`, so that two factories of the same check are one guard
  ([D27](/decisions/#d27--a-guarding-chain-member-is-known-by-the-code-that-refuses)).
- **Library data.** `library.yaml` also states the types whose methods return themselves
  (`gorm.DB`, so `db.Where(…).First(…)` keeps its type), and the first result type of common
  constructors outside the module (`json.NewDecoder` gives a `Decoder`).

Measured on Wakapi at `aba6a44`, the 71 routes carry:
- `short-circuit`: 39, from its authentication middleware;
- `sink-reachable`: 26, mostly redirects and template output;
- `retained-mutation`: 11;
- `data-read` and `data-write`: 4 each, through repositories behind interfaces;
- `live-state`: 45, almost all from a template reload on the development path, which writes a
  package variable during a request. Lazily created singletons (`if x == nil { x = … }`, or
  `if x != nil { return x }` before it) do not count.
- `divergent-guard`: 5, the public routes of `/api` (`GET /api/health`, the captcha, the shields
  badge, …), which lack the authentication middleware most of their 28 siblings have. Wakapi
  applies its other guards to whole subrouters.

Measured on Kaneo's API at v2.48.0, the 211 routes carry `short-circuit` 209 times, from its
authentication and access middleware, `retained-mutation` 211 (`c.set` in the middleware every
route has), `data-read` 117, `data-write` 83, `request-key` 21, `mass-assignment` 8,
`sink-reachable` 18, and `divergent-guard` 10, routes that lack a check their siblings make, such as
the billing webhook. Kaneo uses none of Hono's own guards: its checks are its own middleware.

Measured on Budget at `cfce07b`, the 24 routes carry `authn` 24 times, from the check of
`locals.user` in its `handle`, `short-circuit` and `retained-mutation` 24 (the same hook),
`data-write` 16 and `data-read` 12 through drizzle and better-auth. On Kener v4.1.10, the 90 routes
carry `short-circuit` 90 times, from its CSRF and API-key hooks, `sink-reachable` 13,
`live-state` 25, and `divergent-guard` once: `POST /manage/api`, a `+server.ts` of the `(manage)`
group, which the layout's redirect does not cover.
