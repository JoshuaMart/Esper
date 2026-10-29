# Esper

An attack-surface graph of a codebase, for white-box vulnerability research. Where a request
enters, what guards it, what it reaches, computed from the code and annotated as the audit goes,
served to hunting agents over MCP and explorable in a web interface.

> Named after the Esper machine in *Blade Runner*, which Deckard uses to explore a photograph, zoom in
> and bring out what nobody had seen.

**Status: early development.**
[M6](docs/src/content/docs/roadmap.md#m6--enrichment-and-past-advisories) is done: Go applications
on chi or `net/http` and chi itself, and TypeScript applications on Hono and Hono itself, can be
indexed, with their call edges resolved by scip-go or scip-typescript in Docker on request, their
past advisories from OSV linked to the code their fixes touched (`esper advisories`), and a model's
claims about what parsing cannot see kept apart from the facts (`esper enrich`, on the auditor's
Claude Code or an API key). All of it is served to agents over MCP (`esper mcp <project>`, or HTTP),
and followed and annotated in a web interface (`esper serve`), where an agent's notes appear as it
writes them. Next is [M7](docs/src/content/docs/roadmap.md#m7--dataflow-on-demand), dataflow on
demand.

## Documentation

- [How it works](docs/src/content/docs/how-it-works.md): from a folder of source code to an
  annotated attack-surface graph.
- [Decisions](docs/src/content/docs/decisions.md): the choices that shape Esper, with their reasons.
- [Roadmap](docs/src/content/docs/roadmap.md): the order it gets built in, and what makes each
  milestone done.
- [Sources](docs/src/content/docs/sources.md): the tools and research Esper builds on or departs from.

Reference, under [`docs/src/content/docs/reference/`](docs/src/content/docs/reference/):
[command line](docs/src/content/docs/reference/command-line.md),
[graph schema](docs/src/content/docs/reference/graph.md),
[profiles](docs/src/content/docs/reference/profiles.md),
[MCP tools](docs/src/content/docs/reference/mcp.md),
[server and API](docs/src/content/docs/reference/api.md),
[web interface](docs/src/content/docs/reference/interface.md),
[notes](docs/src/content/docs/reference/notes.md),
[claims](docs/src/content/docs/reference/claims.md),
[analyzers](docs/src/content/docs/reference/analyzers.md).

## Quick start

From the repository, with Node 24 or later and pnpm 10, and Docker for `--precise`:

```sh
pnpm install
pnpm web                                     # builds the web interface esper serve serves

pnpm esper add https://github.com/go-chi/chi # or a folder, read in place and never written
pnpm esper index chi --ref v5.3.2            # entry points, call edges, reads, signals, advisories
pnpm esper index chi --ref v5.3.2 --precise  # the same, with the call edges resolved in Docker
pnpm esper list                              # the projects and their snapshots

pnpm esper serve                             # the interface, its API and MCP on 127.0.0.1:7300

pnpm esper enrich chi --dry-run              # the questions a model would be asked, and the calls
pnpm esper enrich chi --kind guard --limit 20 # ask them on your Claude Code: claims, not facts
```

A URL is cloned into `~/.esper/projects/<name>/checkout/`; a path is read where it is. Each index
is a snapshot of its own, and prints what it found
([command line](docs/src/content/docs/reference/command-line.md)). `esper serve` prints the
interface's address with its token: open it to follow the entry points, what each reaches and its
code, and to write notes ([interface](docs/src/content/docs/reference/interface.md)). Agents
connect over MCP, to `esper mcp <project>` or to `/mcp/<project>` on the server
([MCP tools](docs/src/content/docs/reference/mcp.md)). `esper enrich` asks a model what parsing
cannot see, such as which of the target's own functions are guards, on the signed-in `claude` or an
API key, at the cost of that plan or key: its answers are claims, checked against the lines they cite and
shown apart from the facts ([claims](docs/src/content/docs/reference/claims.md)).

To connect Claude Code to a project, from the repository:

```sh
claude mcp add esper -- node "$PWD/packages/cli/src/main.ts" mcp chi --read-only
```

`esper` is not on npm yet: outside the repository, Node runs it by its path
([running `esper`](docs/src/content/docs/reference/command-line.md#running-esper)). After pulling a
new version, start `esper serve` again and run `pnpm web` again.

## Development

Node 24 or later and pnpm 10. No dependency runs an install script, and nothing is built: Node runs
the TypeScript sources directly. Docker is needed only for `esper index --precise` and its tests,
which are skipped without it.

```sh
pnpm install
pnpm check            # type-check and lint
pnpm test             # tests, with Node's own runner
pnpm esper --help     # the command line, from the sources
pnpm docs             # documentation on http://localhost:4321
```

## Licence

[Apache-2.0](LICENSE).
