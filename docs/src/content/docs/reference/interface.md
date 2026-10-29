---
title: The web interface
description: The auditor's screens in the browser, what each shows, and how they stay current while agents write.
---

The interface is a React application in `apps/web`, built with Vite and served by
[`esper serve`](/reference/api/)
([D14](/decisions/#d14--one-server-for-the-api-mcp-and-the-web-interface)). It reads and writes
through the JSON API only. Its screens were designed in Claude Design on Wakapi and chi before it
was built; the advisories and claims of M6 were added in the same style.

Open it at the address `esper serve` prints: the token in it becomes a session for this browser,
and leaves the address.

## Screens

Every screen sits beside the same rail of projects, where the project shown is selected. A bar
above its screen holds its screens as tabs, which keep the snapshot being read as they lead from
one to the other, and that snapshot (on every screen but the overview, which reads the latest).

### The workspace: projects and a project's overview

`/` keeps every project in a rail on the left: its kind, its entry points, and its notes, or what
needs a look first (notes orphaned or stale, an index running). The project selected
(`/?project=<name>`, else the first) shows in full, under tabs that lead to its entry points, notes
and advisories:

- **its latest snapshot** in four figures: entry points, call edges (with the change since the
  snapshot before), files and notes, each opening where it is detailed;
- **what needs a look**: an index running, notes whose code changed or went away, advisories that
  affect this version; or, when there is none, that there is nothing to review;
- **its history**: the snapshots newest first, with version, commit, profiles and analyzers,
  counts and notes, and between two of them what their counts and tools say changed. Ticking two
  compares them: entry points added, removed and changed, and the notes whose anchor state
  changed (the last two at first);
- **how to connect an agent**: its `/mcp/<project>` address over HTTP, or `esper mcp` over stdio,
  each to copy;
- **its activity**: the notes last written, by you or an agent, as they arrive.

**Add project** asks for a folder or a git URL, a name and, optionally, the kind, then offers to
index it: a git ref or the folder as it is, a precise index in Docker, or an index of a commit
already indexed. The index runs on the server; the dialog shows its progress and then its counts,
skips and notes, as `esper index` prints them. It can be left to run in the background. **Index a
ref** indexes another version of the selected project; a project not indexed yet offers to index it.

### Entry points

`/p/<project>` lists the snapshot's entry points as tables, grouped by **chain**, **read** or
**signal**, or not grouped. Grouped by chain, the longest prefix that most chains share is shown
once, and each group is named by what follows it. A framework's entry points, which have no chain,
are grouped by signal unless asked otherwise.

- **Filters**: a part of the path, a method, a read (`header` for every header), a signal, and a
  guard kind the entry points lack. They are the filters of `esper_entrypoints`, and they stay in
  the address.
- **Facets**: the signals, reads and guard kinds of the entry points shown, with their counts; one
  click filters on it. When no profile names a guard the entry points call, the guards facet says
  so rather than showing nothing.
- **Map**: the same entry points as a [map](#map).

### An entry point and what it reaches

`/p/<project>/entry?node=<reference>` shows the entry point's handler, reads, signals and guards,
then, side by side:

- **What it reaches**, drawn left to right with ELK's layered layout and React Flow: the entry
  point, its chain folded into one card (or each member, in order, with **Chain members**), its
  handler, and what the handler calls, to a **depth** of 1 to 3 from the handler. A guessed call is
  dashed; a library symbol is grey; a node shows how many advisories, sinks, notes and claims it
  carries. Past ten
  callees of one node, the rest fold into a "+ N more" card; **show all** draws them, up to 300.
- **The code** of the node selected in the drawing (the handler at first), with each line a fact
  cites marked: **R** a read, **S** a sink, **G** a guard. A long declaration reads further on
  request. Clicking line numbers picks lines to cite.
- **Its notes**, below the code.

**Write a note** opens a drawer beside the code: the nodes it is about (the selected one, and
others found by name), its kind and status, its Markdown, the lines it cites (those picked in the
code), and its author, remembered in this browser and offered from the user the server runs as.

### Past advisories

`/p/<project>/advisories` lists the target's advisories
([D19](/decisions/#d19--past-vulnerabilities-advisories-linked-to-the-code-they-touched)) as the
snapshot being read stands against them, the most severe first. Each shows its severity, whether
this version is affected or fixed and why (its version, or the fix its commit holds), how it was
linked, and the nodes it affects here, each opening as its subgraph, with whether its code is as
the fix left it. **Details and references** shows the advisory's text, its package and its rating;
**On OSV** opens its page in a new tab. Filters: severity, whether this version is affected, and
the link's precision. **Fetch again** asks OSV and links the advisories on the server, as
`esper advisories` does, and says what came back. The text is a third party's, shown as text.

The advisories also show where they apply: on an entry point, **Past advisories reached** lists
the advisories whose fixed code it reaches (`fix-downstream`), with the declaration; in its
drawing, a node an advisory affects says so; beside the code, **Past advisories on this node**
gives each one's severity, state and fix.

### Claims by a model

What a model claimed ([claims](/reference/claims/)) is shown where it applies, always set apart
from the facts: dashed, and named **claimed**. On an entry point, **Guards claimed by a model**
lists the chain members and handlers a model claims are guards, beside the **Guards** the profiles
name, which a claim never changes. In the drawing, a node says how many claims hold on it; beside
the code, **Claimed by a model** gives each claim's answer, its reason, the lines it cites, the
model and the provider. Rejected claims are not shown; `esper_claims` lists them.

### Notes

`/p/<project>/notes` lists the project's notes placed on the snapshot being read, filtered by kind,
anchor state and author. A note shows its kind, status, anchors, text, citations and revisions,
and the code of its node as it is now.

- A **stale** note says that its code changed since it was written, and on which snapshot it was
  written; a **moved** one says where the code went; **Mark as reviewed** anchors it again on the
  code as it is, as `esper_note_update` does with the same anchors.
- An **orphaned** note says that nothing matches it, and stays.
- The status of a lead or a finding changes in place; **Edit** changes its kind, text and
  citations, as a new revision; **Delete** asks for a reason and records it.

A note's text is shown as text, its `code` spans set apart: nothing in it is rendered as markup,
since whoever wrote it may have read untrusted code ([D8](/decisions/#d8--notes)).

### Map

The map ([D29](/decisions/#d29--the-map-a-groups-shared-code-drawn-bounded)) draws one group of
entry points (a chain group, a signal, a read, or all of them, up to 100) with the code at least 2,
3, 5 or 10 of them call directly, as a graph laid out by forces: shared code settles among the
entry points that call it, each circle sized by how many do. Library symbols are left out, kept
only when a sink fact names them, or all kept. Nodes can be dragged, the wheel zooms and dragging the ground pans;
**Fit** shows it all again. Hovering a node lights its links; selecting one lists what it touches;
an entry point opens as its subgraph on a double click.

## Live

The interface listens to the server's [events](/reference/api/#events). Advisories fetched again
show at once. A note written by an agent,
over `/mcp/<project>` or `esper mcp` in another process, or in another tab, appears where it sits
without a reload, and a notice says who wrote it with a link to it; a new snapshot and an index's
progress show the same way. The foot of the rail says whether the interface is connected.

## Building and developing

```sh
pnpm web                         # builds apps/web into apps/web/dist, which esper serve serves
pnpm --filter @esper/web dev     # Vite on 127.0.0.1:5173, its /api passed to esper serve on 7300
```

Without a build, `esper serve` serves the API and MCP and says the interface is not built. In
development, open Vite's address with `?token=` and the server's token; Vite's proxy presents
itself to the server as the server's own origin.

## How it is made

- **Type and colour**: IBM Plex Sans and Mono, bundled with the interface; a warm neutral ground,
  one blue accent for actions and selection, and a colour per note kind and anchor state, always
  with a word and an icon beside it.
- **Controls** are the platform's: buttons, links that open in a new tab, `<dialog>` for the
  dialogs and the drawer, labels on every field. Every screen works from the keyboard, focus moves
  to a new view's heading, and the code is selectable.
- **Motion** is kept to dialogs, the drawer and notices entering, and a button's press, each under
  250 ms, and none under a reduced-motion preference. Switching views, filtering and selecting do
  not animate.
