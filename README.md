# Esper

An attack-surface graph of a codebase, for white-box vulnerability research. Where a request
enters, what guards it, what it reaches, computed from the code and annotated as the audit goes,
served to hunting agents over MCP and explorable in a web interface.

> Named after the Esper machine in *Blade Runner*, which Deckard uses to explore a photograph, zoom in
> and bring out what nobody had seen.

**Status: design stage.** The documentation describes the target design; there is no code yet.

## Documentation

- [How it works](docs/src/content/docs/how-it-works.md): from a folder of source code to an
  annotated attack-surface graph.
- [Decisions](docs/src/content/docs/decisions.md): the choices that shape Esper, with their reasons.
- [Roadmap](docs/src/content/docs/roadmap.md): the order it gets built in, and what makes each
  milestone done.
- [Sources](docs/src/content/docs/sources.md): the tools and research Esper builds on or departs from.

To read it locally:

```sh
cd docs && pnpm install && pnpm dev    # documentation on http://localhost:4321
```
