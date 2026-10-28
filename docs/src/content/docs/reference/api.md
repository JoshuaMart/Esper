---
title: The server and its API
description: What esper serve listens on, how a request proves it may, the JSON API the web interface uses, and the events it sends.
---

`esper serve` starts one process on `127.0.0.1` for every project of Esper's home
([D14](/decisions/#d14--one-server-for-the-api-mcp-and-the-web-interface),
[D28](/decisions/#d28--the-server-a-token-kept-in-the-home-events-from-the-database)):

| Path | Serves |
|---|---|
| `/` and any path outside `/api` and `/mcp` | the [web interface](/reference/interface/) |
| `/api/…` | the JSON API below, for the interface |
| `/mcp/<project>` | the [MCP tools](/reference/mcp/) of one project, over Streamable HTTP |

```text
esper serve on http://127.0.0.1:7300
  interface    http://127.0.0.1:7300/?token=Qm9v…
  MCP          http://127.0.0.1:7300/mcp/<project>, with Authorization: Bearer <token>
  token        Qm9v…  (kept in ~/.esper/token)
```

The source of truth is `packages/server/src`: `app.ts` for the server, `api.ts` for the routes,
`graph.ts` for the two drawings.

## Who may ask

- **Localhost only.** The server listens on `127.0.0.1`, and refuses with `403` a request whose
  `Host` is not `localhost`, `127.0.0.1` or `[::1]`, and one whose `Origin` is not the server's own,
  port included: a web page elsewhere cannot reach it, even through a name it makes resolve to this
  machine, nor can a page another server on this machine serves, which the browser counts as the
  same site.
- **JSON, said so.** A request with a body sends it as `application/json`, or is refused with `415`:
  a page cannot send that without asking the browser first.
- **A token.** Every request to `/api` and `/mcp` carries the server's token, or is refused with
  `401`. The token is made once and kept in `$ESPER_HOME/token`, readable by its owner only, so that
  an agent's configuration survives a restart; deleting the file makes a new one at the next start.
  - An agent sends it as `Authorization: Bearer <token>`.
  - The interface is opened at the address `esper serve` prints, whose `?token=` it trades at once
    for a session cookie (`POST /api/session`), and removes from the address and the history. The
    cookie is `HttpOnly` and `SameSite=Strict`: no other site's page sends it.
- **The interface's files** need no token: they hold no data. They are served with a content
  security policy that lets them load nothing from elsewhere, and its fonts come with it.

## Conventions

- Every route that the MCP surface also answers runs the same tool, with the same inputs, bounds,
  cuts and refusals ([MCP tools](/reference/mcp/#conventions)): the API is the tools over HTTP, plus
  what drawing needs.
- Query parameters that are numbers (`snapshot`, `limit`, `offset`, `depth`, `id`, …) or flags
  (`includeDeleted`, `chain`) are read as such; anything else is refused with `400`.
- A refusal answers `{ "error": "…" }` with `400`, `404` for a project, snapshot, node, note or
  file that does not exist, `409` for an index already running on the project, `415` for a body
  that is not JSON. A failure of the server
  answers `500` and is written to its log.

## Routes

| Method and path | Does | Same as |
|---|---|---|
| `GET /api/info` | Esper's name and version, and the name of the user the server runs as, which the interface offers as a note's author | |
| `POST /api/session` | sets the session cookie, for a request that carries the token | |
| `GET /api/projects` | each project: its source, its kind (forced, or the one its profiles detected), how many snapshots it has, and its latest with counts and notes by anchor state | |
| `POST /api/projects` | adds a project: `{ source, name?, kind? }`, a folder (`~/` is the home directory) or a git URL, as `esper add` does | |
| `GET /api/projects/:p/snapshots` | the project's snapshots | `esper_snapshots` |
| `GET /api/projects/:p/diff?from&to` | what changed between two snapshots | `esper_diff` |
| `POST /api/projects/:p/index` | starts indexing `{ ref?, force?, precise? }`, and answers `202` with the job at once | `esper_index` |
| `GET /api/jobs` | the index jobs, running and the last twenty finished, with their messages and results | |
| `GET /api/projects/:p/entrypoints` | the entry points, filtered; up to 500 by default | `esper_entrypoints` |
| `GET /api/projects/:p/node?node` | one node, its facts, code and notes | `esper_node` |
| `GET /api/projects/:p/read?file&startLine&endLine` | lines of a file of the snapshot | `esper_read` |
| `GET /api/projects/:p/search?query` | nodes by name, reference or `file:line` | `esper_search` |
| `GET /api/projects/:p/paths?from&to` or `&fact&value` | paths to a node, or to any node carrying a fact | `esper_paths` |
| `GET /api/projects/:p/subgraph?node&depth&limit&chain` | what a node reaches, to draw: below | |
| `POST /api/projects/:p/map` | the code a group of entry points shares, to draw: below | |
| `GET /api/projects/:p/notes` | the notes, placed on the snapshot | `esper_notes` |
| `POST /api/projects/:p/notes` | writes a note | `esper_note_create` |
| `PATCH /api/projects/:p/notes/:id` | edits a note, as a new revision | `esper_note_update` |
| `DELETE /api/projects/:p/notes/:id` | deletes a note, with `{ author, reason? }` | `esper_note_delete` |
| `GET /api/events` | what changes, as server-sent events: below | |

An index runs one at a time per project. A precise index sends the analyzer's progress as
messages of its job.

### A subgraph

What one node reaches, breadth first, for the interface to draw
([D14](/decisions/#d14--one-server-for-the-api-mcp-and-the-web-interface)). From an entry point,
depth 1 holds its chain, each member with its `chain` position, and its handler; what the handler
calls comes after. A chain member's own calls are followed only with `chain=true`, since every
route behind it shares them.

| Input | |
|---|---|
| `node` | the node to start from: a reference, a `file:line` or a name |
| `snapshot` | the snapshot; the latest without it |
| `depth` | hops from the node, 1 to 4; default 2 |
| `limit` | nodes drawn, the start left out, 1 to 300; default 60 |
| `chain` | also follow what chain members call; default `false` |

The answer has `nodes` (each with its kind, name, place, depth, how many sinks and distinct reads
it carries, its signals and its live notes), `edges` (every `calls`, `handles`, `chain` or `flows`
edge between two drawn nodes, with its citation and whether it was guessed), `total` (how many
nodes the walk found), and `truncated` and `cut` when `limit` left some out.

### A map

The code a group of entry points shares
([D29](/decisions/#d29--the-map-a-groups-shared-code-drawn-bounded)): `{ entries, min?, library?,
snapshot? }`, up to 100 entry points by reference. For each, the direct callees of its handlers;
those that at least `min` of the entries call (3 by default) are kept, the most shared first, up to
40. A library symbol is kept as `library` says: `sinks` (the default) keeps those a sink fact names
as its callee, `all` keeps every one, `none` none. Each shared node lists the entries that call it.

### Events

`GET /api/events` is a stream of server-sent events for every project. It opens with `ready`,
sends a comment every 15 seconds while nothing happens, and then:

| Event | Sent when | Data |
|---|---|---|
| `note` | a note is written, edited or deleted | `project`, `id`, `revision`, `action` (`create`, `update`, `delete`), `author`, `at`, `kind` |
| `snapshot` | a snapshot is added | `project`, `id` |
| `job` | an index job starts, says what it does, ends or fails | `project`, `id`, `state`, and `message`, `result` or `error` |

After a reconnection, the interface loads everything again and reads `/api/jobs`, since events
sent while the stream was down are lost. Notes and snapshots are found in each open project's database, every half second while someone
listens, and at once after this server writes: an agent writing through `/mcp/<project>`, through
the API, or through `esper mcp` in another process is heard the same way.
