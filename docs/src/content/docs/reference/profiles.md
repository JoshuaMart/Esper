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
| `language` | the language of the code it reads: `go` or `typescript` (which reads JavaScript too) |
| `detect` | how the profile recognises its target: `dependency` for an application that requires the framework (a `go.mod` requirement; a `package.json` dependency, peer or optional), `module` for the framework itself (a module path; a package name), `import` for a file that imports a package |
| `request`, `response` | the request's type (`net/http#Request`, `globalThis#Request`), for the `chain` reads, and the type a handler writes to (`net/http#ResponseWriter`) |
| `context` | what a handler or a middleware receives first when its code states no type: `hono#Context` |
| `handlers.adapters` | conversions whose first argument is the handler (`net/http#HandlerFunc`, `hono/factory#createMiddleware`), seen through |
| `handlers.types` | types of functions that are handlers (`hono#MiddlewareHandler`): a function typed so receives the `context` first |
| `routers` | each kind of router: its types, the functions or classes that `create` one, the package functions that register on a `default` one, its `pattern` syntax, whether its middleware is `ordered` and its methods `chained`, and what each of its methods `does` |
| `files` | routes declared by the files of a route tree rather than by calls ([below](#routes-declared-by-files)) |
| `aliases` | import specifiers mapped to a folder of the package, configured outside the target: `$lib: src/lib` |
| `members` | the type of each property of a type outside the target, which the index cannot read: `"@sveltejs/kit#RequestEvent": { request: globalThis#Request }` |
| `returns` | what a function outside the target returns: `$app/server#getRequestEvent: "@sveltejs/kit#RequestEvent"` |
| `refusals` | calls that answer the request with a refusal, for the guards that are checks: `@sveltejs/kit#error` |
| `surface` | for a framework: `exported` makes each exported declaration that reaches a read of the request an entry point; `handlers` adds each function and method that takes the request (in Go, with a response writer; in TypeScript, or the context), exported or not; `except` leaves out files by globs (`**/src/runtime/client/**`), code that runs in the browser |
| `guards` | middleware that can refuse a request, by kind: `{ call: github.com/go-chi/chi/v5/middleware#BasicAuth, kind: authn }`; or a check, a function that refuses when a value read from the request is missing: `{ check: context.user, kind: authn }` |
| `reads` | what reads the request: a `chain` of fields and calls on it, or a `call` to a function given it |
| `mutations` | what changes request state that later code reads again, as `chain`s: `{ on: hono#Context, chain: set() }` |
| `sinks` | the framework's own sinks, by kind, as in a language's `library.yaml`: `redirect: [hono#Context.redirect]` |

In TypeScript, a symbol outside the target is written with the module the code imports it from
(`hono/cors#cors`, `@hono/zod-openapi#OpenAPIHono`), a global with `globalThis`, and a type of the
target with the name of its package: Hono's own `Context` is `hono#Context`, in Hono's code as in an
application's.

### What a router method does

| `does` | Arguments by default | Effect |
|---|---|---|
| `route` | `path`, `handler` | a route; `method` is the HTTP method, `ANY`, or `pattern` when the path carries it (`GET /items`) |
| `use` | the middleware | added to the router's chain, for all its routes |
| `with` | the middleware | a router with those added, for the routes declared on it |
| `group` | `callback` | the callback receives a router with the same prefix and its own chain |
| `subrouter` | `path`, `callback` | the callback receives a router mounted at the path |
| `mount` | `path`, `handler` | a router mounted at the path, or a handler serving the whole subtree |
| `prefix` | `path` | a router that registers on this one under the path (Hono's `basePath`) |

`args` overrides the arguments when a method takes them in another order: `Method` takes
`[method, path, handler]`. `chain` stands for every argument between those before it and the last
ones, middleware in front of the handler: Hono's `get` takes `[path, chain, handler]`. A `method` or
`path` argument may be a list (`on(['GET', 'POST'], …)`), one route for each. `config` stands for an
object whose properties `config` maps to roles, seen through the functions `through` lists:

```yaml
- name: openapi
  does: route
  args: [config, handler, other]
  config: { method: method, path: path, middleware: chain }
  through: ['@hono/zod-openapi#createRoute']
  pattern: braces
```

A router whose middleware is `ordered` applies a `use` to the routes registered after it, and only
to those its path matches when its first argument is one: `app.use('/admin/*', auth)`. A path
matches a route when every request to the route matches it: a parameter matches any segment, `*`
the rest of the path or nothing. Otherwise, as for chi, a `use` applies to every route of the
router. `chained` routers return themselves from their methods, so that `app.get(…).post(…)`
registers both.

### Path syntax

| `pattern` | Written | Normalised |
|---|---|---|
| `braces` | `/users/{id}`, `/users/{id:[0-9]+}`, `/static/*` | `/users/{id}`, `/static/{rest...}` |
| `servemux` | `GET /items/{id}`, `/files/`, `/`, `/{path...}`, `/{$}` | method `GET` and `/items/{id}`; `/files/{rest...}`; `/{rest...}`, since `/` serves every path no other pattern matches; `/` for `/{$}` |
| `colon` | `/users/:id`, `/:id{[0-9]+}`, `/:lang?`, `/files/*` | `/users/{id}`, `/{id}`, `/{lang}`, `/files/{rest...}` |
| `brackets` | the folders `(app)/items/[id=integer]`, `[[lang]]/files/[...path]`, `events/[MMMM]-[YYYY]`, `[x+2e]well-known` | `/items/{id}`, `/{lang}/files/{path...}`, `/events/{MMMM}-{YYYY}`, `/.well-known` |

Joined paths lose their trailing slash, but the root: `Mount("/api", r)` with `r.Get("/", …)` is
`/api`.

### Reads

A `chain` follows the request through fields and calls: `URL.Query().Get(name)` is the field `URL`,
a call to `Query`, then a call to `Get`, whose first argument names what is read.
- `(name)` marks that argument; `()` marks a call whose arguments do not matter.
- The longest chain that fits wins, so `URL.Query().Get(name)` is preferred to `URL.Query()`.
- The name is read when it is a string literal: `r.Header.Get("X-Forwarded-For")` is
  `header.X-Forwarded-For`.

`[name]` is a property whose name is what is read: `{ on: "@sveltejs/kit#RequestEvent", chain:
"params[name]", read: path }` makes `event.params.id`, `event.params['id']` and
`const { id } = event.params` read `path.id`. A name destructured from a parameter starts its chain
at the properties it is taken by: `({ params }) => params.id` reads what `event.params.id` reads.

A `call` names a function and the positions of the request and of the name:
`chi.URLParam(r, "id")` is `path.id`.

`by` names the kind of read by the string the `(name)` argument holds:
`{ on: hono#Context, chain: req.valid(name), read: body, by: { param: path, json: body } }` makes
`c.req.valid('param')` a read of the path. A read whose name the call does not give, destructured,
is named by its properties: `const { id } = c.req.param()` reads `path.id`, and
`const { method, url } = c.req` reads what `req.method` and `req.url` read.

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

## Hono

`profiles/hono/application.yaml` reads an application built on Hono
([D25](/decisions/#d25--hono-middleware-in-the-order-it-is-registered)):

- **Routers**: `new Hono()` (also from `hono/tiny` and `hono/quick`) and `@hono/zod-openapi`'s
  `OpenAPIHono`, followed through the module's own names, its imports and exports
  (`export default project`, then `api.route('/project', project)`), and the results of the
  functions that build one (`apiRouter()`), one router per call.
- **Routes**: `get`, `post`, `put`, `delete`, `patch`, `options`, `all` (`ANY`), `on([…], path, …)`,
  `openapi(createRoute({ method, path, middleware }), handler)`, `mount(path, handler)`; mounts with
  `route(path, app)` and `basePath(path)`. Middleware is ordered. A `use` whose path is a string the
  index cannot read (`` `${base}/*` ``) is kept as written and guards no route, rather than all of
  them; a router parameter that no call binds keeps its routes under `/${app}`, as in Go.
- **Handlers**: a function that a route or a middleware runs, and whose first parameter states no
  type, receives `hono#Context`; so does a function typed `MiddlewareHandler`. A handler built by a
  call the index cannot name (`upgradeWebSocket(async (c) => …)`) is the literal it is given, a
  guess with the reason.
- **Reads** of `c.req` (`param`, `query`, `queries`, `header`, `json`, `text`, `formData`,
  `parseBody`, `valid`, `path`, `url`, `method`, `raw`), of the context (`c.get`, `c.var`), of a
  `HonoRequest` and of the standard `Request`, and the helpers `getCookie`, `getSignedCookie`,
  `accepts` and each adapter's `getConnInfo`.
- **Guards**: basic auth, bearer auth, JWT and JWK (`authn`), CSRF (`csrf`), IP restriction
  (`authz-role`), body limit and the validators (`validation`), `hono-rate-limiter` (`rate-limit`).
- **Mutations** (`c.set`, a request's headers) and **sinks** (`c.redirect`, `raw` from `hono/html`,
  `proxy`).

`profiles/hono/framework.yaml` extends it for Hono itself, so that the same reads name what Hono's
own middleware reads, and makes its surface each exported declaration and each function that takes
the request or the context.

Measured on [Kaneo](https://github.com/usekaneo/kaneo)'s API at v2.48.0 (`apps/api`, 687 files): 211
routes, every handler and chain member named. Its public routes and webhooks are registered before
`api.use("*", …)` authenticates the rest, and are the routes without it. Measured on Hono v4.13.14:
108 entry points:
- **Middleware**, such as `cors`, which reads `Origin`, `Access-Control-Request-Headers` and the
  method, or `csrf`, which reads `Origin`, `Sec-Fetch-Site` and `Content-Type`.
- **Helpers**, such as `getCookie`, which reads the `Cookie` header, and `getPath`, the path of a
  `Request`.
- **`HonoRequest`'s accessors** and **`Hono.fetch`**, with `#dispatch`, its internal handler, which
  reads the path through the `getPath` field the constructor assigns.
- **Each adapter's `handle`**, which builds a `Request` from its platform's event and calls
  `app.fetch`.

What the index cannot read, the count records: `getConnInfo` on Bun, Deno, Lambda@Edge and Netlify
takes the client's address from the server or the platform, and `ipRestriction` from a function the
caller gives, neither of which a read rule names; `HonoRequest.json` and the other body readers read
the body through `raw[key]()`.

## Routes declared by files

A framework that declares routes by files says so in `files`
([D32](/decisions/#d32--routes-declared-by-files)):

```yaml
files:
  routes: src/routes            # from the root of each package that has it
  pattern: brackets
  modules:
    - name: +server             # the file, without its extension
      exports:
        - { name: GET, does: route, method: GET }
        - { name: fallback, does: route, method: ANY }
    - name: +page.server
      exports:
        - { name: load, does: route, method: GET, layouts: true }
        - { name: actions, does: each, method: POST, path: "?/{name}", default: default }
    - name: +layout.server
      exports:
        - { name: load, does: layout }
  hooks:                        # files of the package, in front of every route, in order
    - file: src/hooks.server
      exports:
        - { name: handle, does: use, receives: "@sveltejs/kit/hooks#Handle.input" }
  compose: ["@sveltejs/kit/hooks#sequence"]
  matchers:
    - { file: "src/params/{matcher}", name: match }
  remote:
    suffix: .remote
    path: "/_app/remote/${hash($file)}/$name"
    calls:
      - { call: "$app/server#query", method: GET }
```

| `does` | Effect |
|---|---|
| `route` | a route of the file's folder, with `method`; `layouts` puts the layouts of the folder and those above in front of it |
| `each` | a route for each property of the exported object, at the folder's path followed by `path` (`{name}` is the property), the property named `default` at the folder's own path |
| `layout` | a chain member of the routes in its folder and below that take `layouts`, outermost first |
| `use` | for a hook: a chain member of every route |

A route's chain is the hooks, then the matchers its parameters name, then its layouts. A call to a
function `compose` lists is seen through: `handle = sequence(a, b)` puts `a`, then `b`. A module
named `+page@name.server` resets to the layout of the folder above named `name`, `+page@` to the
root's; a layout named so keeps its place and drops the layouts between it and the one it names. What each function receives first is the profile's `context`, or the export's `receives`.
Two exports of a folder that serve the same method and path (a page's server `load` and its
universal one) are one route with both as its handler; an endpoint beside a page stays a route of
its own. The routes under the same nearest folder
that holds a layout or is a route group are siblings, whose guards are compared.

Modules whose name ends with `remote.suffix` are routes of their own, one for each export built by
one of `remote.calls`, its handler the last function given to the call; `$file` and `$name` in
`path` are the module's path and the export's name.

## SvelteKit

`profiles/sveltekit/application.yaml` reads an application built on SvelteKit 2 or 3
([D35](/decisions/#d35--sveltekit-the-server-side-in-both-modes)). It reads the server side, the
`.ts` and `.js` files, not the `.svelte` components:

- **Detection**: a target whose code imports `@sveltejs/kit`, `@sveltejs/kit/hooks` or
  `$app/server`, since applications list SvelteKit as a development dependency.
- **Routes**, from `src/routes`: each method `+server` exports and its `fallback` (`ANY`); the `load`
  of `+page.server` and `+page` (`GET`), with the layouts' `load` (`+layout.server`, `+layout`) in
  front; each action of `+page.server`'s `actions` (`POST /path?/name`, `default` at the page's
  path), with no layout in front, since actions run before any `load`; remote functions
  (`*.remote.ts`, built by `query`, `query.batch`, `query.live`, `prerender`, `form`, `command`).
- **The chain** of every route: `reroute` of `src/hooks`, then `handle` of `src/hooks.server`,
  `sequence(…)` seen through, then the parameter's matcher (`src/params/<name>`, or `src/params`'
  `defineParams` in SvelteKit 3).
- **Reads** of the event: `request` is the standard `Request`; `params` (`path`), `locals`
  (`context`), `url` (`query`, `path`, `host`), `cookies.get` (`cookie`), `getClientAddress()`
  (`remoteaddr`); `getRequestEvent()` gives the event. `$lib` is `src/lib`; SvelteKit 3's `#lib`
  is the package's own `imports`.
- **Guards**: `if (!locals.user)` or `if (!locals.session)` (not `if (locals.user)`) followed by `error`, `redirect` or
  `fail` is an `authn` check; a hook or a layout's `load` that refuses so answers on its own.
- **Sinks**: `redirect`'s location, `event.fetch`.

`profiles/sveltekit/framework.yaml` extends it for SvelteKit itself, `@sveltejs/kit` and its
adapters in one repository: it adds Node's request (`IncomingMessage`'s headers, URL, method and
socket) and what the server keeps for a request (`types#RequestStore`), and leaves out the code that
runs in the browser.

Measured on [Budget](https://github.com/JoshuaMart/Budget) at `cfce07b`, 46 files: 24 routes, each
behind `handle`, which checks `locals.user`. On [Kener](https://github.com/rajnandan1/kener)
v4.1.10, 329 files: 90 routes in seven route groups, behind `reroute` and a `sequence` of three
hooks; `POST /manage/api` is the one route of the `(manage)` group without the layout's redirect.
On SvelteKit 3.1.0, 274 files: 59 entry points:

- **The server**: `internal_respond` and its `resolve`, reading `Origin` for the CSRF check,
  `x-sveltekit-pathname` and `x-sveltekit-search` for remote functions, the `__data.json` suffix
  and the trailing-slash parameter; the actions (`x-sveltekit-action`), the error page
  (`x-sveltekit-error`), cookies, endpoints, the server's `fetch`, remote calls and forms.
- **Redirects**: `redirect` and `validate_redirect_location`, which compare a location with the
  origin of the request being served.
- **Remote functions' server side**: `command` checks the method, `form` and `prerender` read the
  URL.
- **Adapters**: adapter-node's `handler`, through `getClientAddress` reading `ADDRESS_HEADER` and
  `XFF_DEPTH`, and `get_origin` reading `PROTOCOL_HEADER`, `HOST_HEADER` and `PORT_HEADER`;
  adapter-bun's `get_client_address` and `get_origin`; adapter-vercel's `X-Forwarded-For`;
  `@sveltejs/kit/node`'s `getRequest`; the Vite dev and preview servers.

What the index cannot read, the count records: the request of adapter-cloudflare's worker and of
adapter-netlify's edge function is typed by a package outside the repository; `Server.respond`
calls the instance `configure` imports with `await import()`.

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
| Hono v4.13.14 | framework | 108 |
| Kaneo v2.48.0, `apps/api` | application | 211 |
| SvelteKit 3.1.0 | framework | 59 |
| Budget `cfce07b` | application | 24 |
| Kener v4.1.10 | application | 90 |

A count whose target is a folder of its repository says so (`dir: apps/api`): the target is read
from git in that folder.
