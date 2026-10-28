# Esper

An attack-surface graph of a codebase, for white-box vulnerability research. Where a request
enters, what guards it, what it reaches, computed from the code and annotated as the audit goes,
served to hunting agents over MCP and explorable in a web interface.

> Named after the Esper machine in *Blade Runner*, which Deckard uses to explore a photograph, zoom in
> and bring out what nobody had seen.

**Status: early development.** The documentation describes the target design.
[M1](docs/src/content/docs/roadmap.md#m1--the-core-on-go-and-chi) is done: Go applications on chi
or `net/http`, and chi itself, can be indexed from the command line. Next is
[M2](docs/src/content/docs/roadmap.md#m2--mcp-and-notes), MCP and notes.

## Documentation

- [How it works](docs/src/content/docs/how-it-works.md): from a folder of source code to an
  annotated attack-surface graph.
- [Decisions](docs/src/content/docs/decisions.md): the choices that shape Esper, with their reasons.
- [Roadmap](docs/src/content/docs/roadmap.md): the order it gets built in, and what makes each
  milestone done.
- [Sources](docs/src/content/docs/sources.md): the tools and research Esper builds on or departs from.

## Development

Node 24 or later and pnpm 10. No dependency runs an install script, and nothing is built: Node runs
the TypeScript sources directly.

```sh
pnpm install
pnpm check            # type-check and lint
pnpm test             # tests, with Node's own runner
pnpm esper --help     # the command line, from the sources: add, index, list
pnpm docs             # documentation on http://localhost:4321
```

## Licence

[Apache-2.0](LICENSE).
