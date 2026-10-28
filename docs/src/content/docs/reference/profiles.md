---
title: Profiles
description: The format of a framework profile, and how Esper reads routes, chains and request reads from it.
---

A profile is what Esper knows about one framework, written as data
([D10](/decisions/#d10--frameworks-as-profiles)). Each framework has an `application` and a
`framework` profile, in `profiles/<framework>/<kind>.yaml`.

A profile is validated against `schemas/profile.schema.json` before any is used. A profile that
breaks the schema, extends an unknown profile, or extends itself is refused, with the file and
where it fails.

## The shape

```yaml
name: chi
kind: application            # or framework
language: go
extends: [net-http]          # its request type, adapters, routers and reads apply too
detect:
  dependency: [github.com/go-chi/chi/v5]   # an application requiring it
routers:
  - types: [github.com/go-chi/chi/v5#Router, github.com/go-chi/chi/v5#Mux]
    create: [github.com/go-chi/chi/v5#NewRouter]
    pattern: braces
    methods:
      - { name: Get, does: route, method: GET }
      - { name: Method, does: route, args: [method, path, handler] }
      - { name: Use, does: use }
      - { name: With, does: with }
      - { name: Group, does: group }
      - { name: Route, does: subrouter }
      - { name: Mount, does: mount }
reads:
  - { call: github.com/go-chi/chi/v5#URLParam, request: 0, name: 1, read: path }
```

Symbols are written `<import path>#<symbol>`.

| Field | What it says |
|---|---|
| `detect` | how the profile recognises its target: `dependency` for an application that requires the framework, `module` for the framework itself, `import` for a file that imports a package |
| `request`, `response` | the request's type (`net/http#Request`), for the `chain` reads, and the type a handler writes to (`net/http#ResponseWriter`) |
| `handlers.adapters` | conversions whose first argument is the handler (`net/http#HandlerFunc`), seen through |
| `routers` | each kind of router: its types, the functions that `create` one, the package functions that register on a `default` one, its `pattern` syntax, and what each of its methods `does` |
| `surface` | for a framework: `exported` makes each exported function and method that reaches a read of the request an entry point; `handlers` adds each function and method that takes a response writer and the request, exported or not |
| `guards` | middleware that can refuse a request, by kind: `{ call: github.com/go-chi/chi/v5/middleware#BasicAuth, kind: authn }` |
| `reads` | what reads the request: a `chain` of fields and calls on it, or a `call` to a function given it |

### What a router method does

| `does` | Arguments by default | Effect |
|---|---|---|
| `route` | `path`, `handler` | a route; `method` is the HTTP method, `ANY`, or `pattern` when the path carries it (`GET /items`) |
| `use` | the middleware | added to the router's chain, for all its routes |
| `with` | the middleware | a router with those added, for the routes declared on it |
| `group` | `callback` | the callback receives a router with the same prefix and its own chain |
| `subrouter` | `path`, `callback` | the callback receives a router mounted at the path |
| `mount` | `path`, `handler` | a router mounted at the path, or a handler serving the whole subtree |

`args` overrides the arguments when a method takes them in another order: `Method` takes
`[method, path, handler]`.

### Path syntax

| `pattern` | Written | Normalised |
|---|---|---|
| `braces` | `/users/{id}`, `/users/{id:[0-9]+}`, `/static/*` | `/users/{id}`, `/static/{rest...}` |
| `servemux` | `GET /items/{id}`, `/files/`, `/{path...}`, `/{$}` | method `GET` and `/items/{id}`; `/files/{rest...}` |

Joined paths lose their trailing slash, but the root: `Mount("/api", r)` with `r.Get("/", …)` is
`/api`.

### Reads

A `chain` follows the request through fields and calls: `URL.Query().Get(name)` is the field `URL`,
a call to `Query`, then a call to `Get`, whose first argument names what is read.
- `(name)` marks that argument; `()` marks a call whose arguments do not matter.
- The longest chain that fits wins, so `URL.Query().Get(name)` is preferred to `URL.Query()`.
- The name is read when it is a string literal: `r.Header.Get("X-Forwarded-For")` is
  `header.X-Forwarded-For`.

A `call` names a function and the positions of the request and of the name:
`chi.URLParam(r, "id")` is `path.id`.

## A framework's request surface

A framework has no routes of its own ([D5](/decisions/#d5--two-kinds-of-target-applications-and-the-frameworks-themselves)).
Its `framework` profile says what its entry points are instead:

```yaml
name: chi
kind: framework
language: go
extends: [net-http]        # an application profile, for the request type and its reads
detect:
  module: [github.com/go-chi/chi/v5]
surface:
  exported: true
  handlers: true
```

Each entry point is `entry:<reference>`. It has a `handles` edge to its declaration, and the reads
and signals of what it reaches. A read's name is resolved through constants and package variables,
and through the functions that `library.yaml` says return their argument normalised:
`var xRealIP = http.CanonicalHeaderKey("X-Real-IP")` makes `r.Header.Get(xRealIP)` read
`header.X-Real-IP`.

Measured on chi 5.3.2: 40 entry points, the same 40 as its hand count.
- **Middleware**, such as `middleware.RealIP`, which reads `header.True-Client-IP`,
  `header.X-Forwarded-For` and `header.X-Real-IP` and rewrites the request's `RemoteAddr`
  (`retained-mutation`).
- **Accessors of the request's context**, such as `chi.URLParam` and `middleware.GetReqID`, which
  read values through `ctx.Value`.
- **The router's own handlers**: `Mux.ServeHTTP`, `Mux.routeHTTP`, reached only through a handler
  the router builds at run time, and `Mux.Mount` and `Mux.Route`, whose mount handler shifts the
  path for the subrouter.

## How routes are read

The router values a profile describes are followed through the code, not only within the
function that creates them:
- variables, including `r.With(…)`;
- the callbacks of `Group` and `Route`;
- arguments: `users.RegisterRoutes(api)` binds the method's `chi.Router` parameter to `api`;
- results: `r.Mount("/api", apiRouter())` mounts what `apiRouter` builds and returns.

Each route then gets the full path of the routers above it, and the chain of each, in order.

When the index cannot read something, it keeps the route and says what it could not read:
- **A path that is not a string literal or a constant** is written as the expression:
  `/api/${route.Pattern}`.
- **A router parameter that no call binds**, for instance because the method is called through an
  interface, keeps what is mounted on it under `/${router}`, the parameter's name. Without this,
  its routes would wrongly appear at the root.
- **A handler that is a method of a value the index cannot type**, such as `fs.ServeHTTP` where
  `fs := http.FileServer(…)`, is named by the call that built the value: `ext:net/http#FileServer`.

Measured on [Wakapi](https://github.com/muety/wakapi) at `aba6a44`, 240 files: 71 routes, every
handler named, matching its hand count with two limits the count records:
- **`GET /${router}/leaderboard`.** Its handler is chosen by a generic helper
  (`condition.Ternary[bool, routes.Handler](…)`), so the router it registers on is not bound; the
  real path is `/leaderboard`.
- **`OPTIONS /api/${route.Pattern}`.** It stands for one route per pattern that `r.Routes()`
  returns at run time. chi's tree is shared with the parent router there, so which patterns depends
  on the order the handlers register in.

The five `/debug/pprof` routes come from `import _ "net/http/pprof"`, which registers on the
default mux; `net-http`'s `registers` lists what such imports add.

## Hand counts

Each profile is measured against targets counted by hand ([D16](/decisions/#d16--measured-against-hand-counted-targets)),
in `profiles/<framework>/counts/<target>@<commit>.yaml`: the target, the commit, how it was
counted, and each entry point with its citation. `pnpm fetch-targets` fetches each target at its
commit into `$ESPER_TARGETS`, and the tests then index it and compare: no entry point missing,
none invented. CI does both.

| Target | Mode | Entry points |
|---|---|---|
| chi 5.3.2 | framework | 40 |
| Wakapi `aba6a44` | application | 71, two of them with what the index could not read |
