---
title: Claims
description: The questions a model is asked, the answers it may give, how each is checked, and how esper enrich runs them on the auditor's plan or an API key.
---

A model adds what parsing cannot see: a custom function that guards, what a call outside the target
does with data, a function's intent, where a framework trusts a request value, which applications a
repository holds and how each authenticates. Its answers are **claims**, kept apart from the facts
([D17](/decisions/#d17--model-enrichment-claims-beside-the-facts),
[D31](/decisions/#d31--enrichment-as-built-questions-checks-and-two-providers)). A claim never
sets a signal, and the index works without any. The source of truth is
`packages/core/src/claims.ts` for the questions and the checks, `packages/enrich` for the
providers.

## The questions

| Kind | Asked about | Tier | Values |
|---|---|---|---|
| `guard` | each chain member, each handler, and each declaration a handler calls directly | bounded | `yes` with a kind (`authn`, `authz-role`, `authz-owner`, `csrf`, `rate-limit`, `validation`), or `no` |
| `effects` | each declaration an entry point reaches that calls outside the target, where no fact says what the call does | bounded | `writes`, `reads`, `reads-and-writes`, `sink` with a kind (`query`, `path`, `process`, `fetch`, `template`, `redirect`), or `none` |
| `intent` | each chain member and handler | bounded | `stated`, with the intent in one line |
| `trust` | each entry point of a framework that reads a header, the host or the client address | exploring | `found`, with where, or `none` |
| `applications` | an application's repository | exploring | `found`, with the applications |
| `authentication` | an application's repository | exploring | `found`, with the procedure, or `none` |

A question is `<kind>:<subject>` (`guard:mw/auth.go#RequireUser`), the same on every snapshot.
Chain members are asked first, since a check there guards every route behind it. Every question also
takes `insufficient-context`: a bounded call that cannot answer says so, and the question moves to
the exploring tier.

- **Bounded.** One call, no tool. The question carries the node's code, numbered, the facts on it
  and on the function literals it defines, and the first line of each declaration it calls. Ten
  questions go in one call by default.
- **Exploring.** An agent that reads what it needs through Esper's read-only tools of the project
  (`esper_search`, `esper_node`, `esper_callers`, `esper_callees`, `esper_paths`, `esper_read`), and
  nothing else, up to 20 turns. A question about the repository starts from its entry points and
  the middleware they share.

The instructions every question shares, and the answer's JSON Schema
(`schemas/claims.schema.json`), are the same for both tiers and every provider.

## The checks

Each answer is checked before it is stored:

- its value is one its question takes, a guard or a sink names its kind, and a value that takes
  text has it;
- it cites at least one line, at most twenty, each as a file, a line and an identifier: the file
  must be one of the snapshot's, the line within it, and the line must hold the identifier, as
  written. A `no` or a `none` rests on what the code lacks, and cites the line that declares the
  node; the instructions say so, and the schema takes no answer without a citation.

An answer that fails is stored as a **rejected** claim, with what failed:
`citation mw/auth.go:12: the line does not hold "verifyToken"`. The citations of an
`insufficient-context` answer are not checked. An answer to a question the call did not carry is not taken.

## What a claim holds

| Field | What it is |
|---|---|
| `question`, `kind`, `subject`, `tier` | what was asked, about what, in which tier |
| `value`, `valueKind`, `text` | the answer: its value, the guard or sink kind, the text |
| `citations`, `reason` | the lines it rests on, and why, in one sentence |
| `status` | `accepted`, `rejected` or `insufficient`, and the `rejection` |
| `model`, `provider`, `promptVersion` | who answered, and with which questions |
| `fingerprints` | the fingerprint of each node it rests on: its subject, and every node an exploring run read |
| `reads` | for an exploring claim, each tool call and the node or file it named |
| `snapshot`, `author`, `createdAt` | where and when it was asked, and by whom |

A claim **holds** on a snapshot while every node it rests on is there with the same fingerprint, and
it was asked with the current questions. A question with a claim that holds is not asked again; a
rejected claim leaves its question due. Claims live in the project's database
([graph schema](/reference/graph/#tables)), apart from the snapshots and the notes.

## Running it

```sh
esper enrich chi --dry-run                 # the questions due, and how many calls they take
esper enrich chi                           # 40 bounded questions, on the auditor's Claude Code
esper enrich chi --tier exploring --limit 3
esper enrich chi --provider anthropic-api  # an API key, through the Batches API
```

| Option | |
|---|---|
| `--provider` | `claude-code` (default) or `anthropic-api` |
| `--tier` | `bounded` (default) or `exploring` |
| `--kind` | one kind of question |
| `--limit` | how many questions, 40 by default |
| `--model`, `--effort` | the model, as the provider names it, and its effort |
| `--snapshot` | the snapshot to ask about; the latest by default |
| `--dry-run` | lists the questions without asking them |

The bounded tier runs on Claude Sonnet 5.5 at medium effort, which answered the questions measured
as well as Opus 5.5, for half the cost, and the exploring tier on Claude Opus 5.5 at medium effort
([D31](/decisions/#d31--enrichment-as-built-questions-checks-and-two-providers)). `esper enrich`
says what a run used: its tokens, and their cost at list prices.
A run stops when the plan's or the API's limit is reached, and says so; the questions it did not
ask stay due.

### `claude-code`

The `claude` binary installed and signed in on the machine, run headless, a few at once, from
`$ESPER_HOME/enrich/<project>/`, never from the target:

```sh
# bounded: no tool, no MCP server, none of the auditor's customisations
claude -p --safe-mode --tools "" --strict-mcp-config \
  --model claude-sonnet-5-5 --effort medium --max-turns 1 --no-session-persistence \
  --output-format json --json-schema '<the schema>' --system-prompt '<the instructions>'

# exploring: only Esper's read-only server for the project
claude -p --setting-sources "" --tools "" --strict-mcp-config --mcp-config esper-readonly.json \
  --allowedTools mcp__esper__esper_search,mcp__esper__esper_node,… --permission-mode dontAsk \
  --model claude-opus-5-5 --effort medium --max-turns 20 --no-session-persistence \
  --output-format json --json-schema '<the schema>' --system-prompt '<the instructions>'
```

`esper-readonly.json` declares one server, `esper mcp <project> --read-only --trace <file>`, whose
trace gives the claim its reads. A run without a valid answer is retried once, then its questions
are left unanswered.

### `anthropic-api`

The Claude API through the official TypeScript SDK, with the key the SDK finds
(`ANTHROPIC_API_KEY`). Bounded questions go through the Message Batches API, at half price, the
instructions cached; exploring questions through the SDK's tool runner, with the same read-only
tools run in Esper's process.

## Over MCP

An agent already working on the target can answer the questions in its own session
([MCP tools](/reference/mcp/)): `esper_enrich_next` hands one out with its context,
`esper_claim_submit` checks the answer and stores it, and `esper_claims` lists the claims, with
whether each holds on the snapshot. `esper_node` says how many claims a node has.
