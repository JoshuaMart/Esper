---
title: Notes
description: What a note holds, how it is revised and deleted, and where its anchors stand after a reindex.
---

Notes are what an audit produces ([D8](/decisions/#d8--notes)): leads, coverage, findings and
context, written by agents over MCP ([MCP tools](/reference/mcp/)) and, from M5, by people in the
web interface. They live in the project's database, apart from the snapshots
([graph schema](/reference/graph/#tables)), so that no reindex and no deleted snapshot takes one
with it. The source of truth is `packages/core/src/notes.ts`.

## What a note holds

| Field | What it is |
|---|---|
| `kind` | `lead`, `coverage`, `finding` or `context` |
| `status` | for a lead or a finding, below; none for coverage and context |
| `body` | Markdown, at most 20,000 characters |
| `citations` | `file:line` or `file:start-end`, each on a file of the snapshot and within its lines; at most 50 |
| `author` | an agent's name or a person's, at most 200 characters |
| `createdAt`, `updatedAt` | ISO 8601 dates |
| `anchors` | the nodes it is about, one to twenty, each with its reference, kind and fingerprint |
| `anchoredOn` | the snapshot the anchors were taken from |
| `revision` | how many revisions it has, its creation included |

| Kind | It says | Statuses, the first by default |
|---|---|---|
| `lead` | a hypothesis to check | `open`, `ruled-out`, `confirmed` |
| `coverage` | what was examined, from which angle, and what came out | none |
| `finding` | a confirmed issue | `open`, `reported`, `fixed` |
| `context` | anything else worth knowing | none |

A note that changes kind keeps its status when the new kind has it, and otherwise takes the new
kind's first one: a confirmed lead turned into a finding is an `open` finding.

## Revisions and deletion

Every change is a revision, and the earlier ones are kept: a revision records its action
(`create`, `update` or `delete`), who made it, when, and the note as it then was. A note keeps the
author who wrote it; each revision names the author of the change. A deletion is a revision too,
with its reason: the note is no longer listed, but `esper_notes` with `includeDeleted` shows it, and
it cannot be edited or deleted again.

## Anchors after a reindex

A note keeps, for each node it is anchored on, the node's reference, its kind and its
[fingerprint](/reference/graph/#conventions) in the snapshot the note was anchored on. On any
snapshot, each anchor is placed:

| On the snapshot | The anchor is | And it is on |
|---|---|---|
| a node with the same reference and the same fingerprint | `attached` | that node |
| a node with the same reference and another fingerprint | `stale`: its code changed, the note needs a review | that node |
| no node with that reference, and a node of the same kind with that fingerprint | `moved`: the code was renamed or moved to another file | that node |
| none of these | `orphaned`, and kept | nothing |

- **What counts as a move.** A node with the same code that was already there, under its own
  reference, when the note was anchored is a copy, not where the code went. Of several candidates,
  the one with the same name in another file is preferred, then one in the same file, then the
  first by reference.
- **Against the anchoring snapshot.** Each anchor is compared with the snapshot the note was
  anchored on, so a note's state on a snapshot depends on that snapshot alone, whatever was indexed
  in between or in which order.
- **The note's state** is the state of its least settled anchor: `attached`, then `moved`, then
  `stale`, then `orphaned`.
- **A review.** Editing a note with anchors takes them, and their fingerprints, from the snapshot
  being read. Giving the same anchors again is how a stale or moved note is marked as reviewed
  against the code as it now is.

A reindex never drops a note. `esper index` and `esper_index` say how the notes stand on the new
snapshot, `esper_notes` filters them by anchor state, and `esper_diff` lists the notes whose anchors
changed state or node between two snapshots.

Export to JSON Lines and import from it ([D9](/decisions/#d9--storage-one-sqlite-database-per-project-outside-the-target))
are not built yet.
