# AGENTS.md — working on the Flow codebase

Flow is agent-first in two senses. This file covers the first: **coding agents
making changes to this repo**. The second — AI agents using a running Flow
instance as a tool via MCP and API keys — is documented in
[docs/AGENTS_AND_MCP.md](docs/AGENTS_AND_MCP.md).

## Mission

Flow is a self-hosted ClickUp/Asana replacement that runs entirely on
Cloudflare: one Worker serving the SPA, REST API, MCP server, and WebSockets;
one Durable Object holding the whole workspace in SQLite; R2 for attachments;
Queues for outbound side effects. It is deliberately small — one workspace per
deployment, a handful of entity types, ~5 runtime dependencies — and it stays
fast because every architectural rule below protects either correctness
(single writer, ordered deltas) or latency (no refetch, optimistic UI). Your
job when changing it is to keep both.

## Repo layout

| Path | Package | What lives there |
| --- | --- | --- |
| `packages/shared` | `@flow/shared` | **The contract.** Zod schemas for every entity, mutation input, delta event, WS message, webhook payload, notification, automation rule; the `MCP_TOOLS` name list; the `WorkspaceRpc` interface; the `LIMITS` size caps. Depends only on zod. |
| `packages/core` | `@flow/core` | The `Workspace` Durable Object: SQLite schema, all mutations, delta log, WS fanout, fractional positioning, search, visibility filtering, snooze, notifications, and the automation engine (`src/automation/`). Most unit tests live here. |
| `apps/api` | `@flow/api` | The Hono Worker: auth (Cloudflare Access JWT + `flow_` bearer keys), REST routes in `src/routes/`, MCP server at `/mcp` in `src/mcp/`, WS upgrade at `/ws`, queue consumer for webhooks/email in `src/side-effects/`, `wrangler.jsonc`. Serves the built web app as static assets. |
| `apps/web` | `@flow/web` | Preact + `@preact/signals` + Tailwind v4 SPA. `src/store/` holds the signal state, delta application, optimistic mutations, and the WS client; `src/board/`, `src/task/`, `src/shell/`, `src/settings/` are UI. |
| `apps/importer` | `@flow/importer` | Local-only (tsx, never deployed) extract → transform → load pipeline for migrating from ClickUp, with checkpoints and fixtures. |

Dependency direction is strict: `shared` ← `core` ← `api`, and `shared` ←
`web` / `importer`. Nothing imports upward.

## Ground rules

These are load-bearing. Each one exists because breaking it breaks something
users feel.

- **`packages/shared` is the single source of truth.** Every shape that
  crosses a boundary — HTTP body, WS frame, DO RPC argument, MCP tool result,
  webhook payload — is a Zod schema there, with the TS type inferred from it.
  Import from it; never redeclare or hand-roll a parallel type. When two
  layers each define "what a Task is", they drift, and the drift shows up as a
  runtime bug the compiler was built to prevent. If the contract genuinely
  needs to change, make the **smallest compatible change** (add an optional
  field, extend an enum) and call it out prominently in your PR — a breaking
  contract change touches every layer at once and needs a human decision.
- **The Durable Object is the only writer.** One workspace, one DO instance.
  REST routes and MCP tools call its `WorkspaceRpc` methods and never touch
  SQL. This is what makes the delta log trustworthy: with a single-threaded
  writer, "monotonic seq" is a fact, not a hope, and every consumer (WS
  clients, webhooks, audit) sees the same total order of mutations. A second
  write path — a route that opens SQL, a queue consumer that mutates state —
  silently forks that order.
- **Every mutation appends a Delta; clients patch, never refetch.** The DO
  broadcasts each committed delta to WS clients; a reconnecting client sends
  its last-seen seq and replays the gap (or gets told to resync from a fresh
  snapshot when the gap is too old). Do not add any "refetch the board" path —
  not as a fallback, not "just for this feature". The moment one exists, bugs
  in delta application get papered over by refetching instead of fixed, the UI
  gets slow, and the one mechanism that keeps every client consistent stops
  being exercised.
- **Automations evaluate inline in the DO mutation turn** (recursion capped at
  `AUTOMATION_MAX_DEPTH` = 5), so a rule's state changes commit atomically
  with the mutation that triggered them and ride the same delta broadcast.
  **Outbound side effects (webhooks, email) never run inline** — they are
  enqueued to the `SIDE_EFFECTS` queue and executed by the queue consumer with
  retries and a DLQ, because a slow or failing third-party endpoint must not
  block or roll back a board mutation. Email additionally respects
  `EMAIL_DRY_RUN` (default true): log what would send, send nothing.
- **Subtasks are Asana-style**: done/not-done plus optional assignee and due
  date. They do not have statuses, and nothing should be added that assumes
  they do — that distinction is what keeps the board model (statuses belong to
  lists, tasks sit in status columns) simple.
- **API keys impersonate a real user.** There are no service accounts; a
  `flow_` key acts as the user who owns it, and the audit trail records both
  the user and the key id. Any new endpoint or tool must go through the
  existing auth middleware so this attribution holds.
- **Strict TypeScript everywhere; minimal dependencies.** Allowed runtime
  deps: hono, zod, preact, @preact/signals, the MCP SDK, and comparably tiny
  single-purpose libraries. Every new dependency is code nobody in this repo
  reviewed running in the request path.
- **UI stays fast by construction**: optimistic mutations (apply locally,
  reconcile on the echo delta), CSS transforms for drag, no full-board
  re-renders. Signals make surgical updates cheap — a change that subscribes a
  large component tree to a whole-board signal defeats the point.

## Standard workflow

1. **Read the relevant part of `packages/shared` first.** The contract tells
   you what shapes exist, what the mutation inputs allow, and what the delta
   for your change will look like — before you've read a line of
   implementation.
2. **Find the existing seam.** Almost every feature slots into an existing
   pattern: a new route module in `apps/api/src/routes/`, a new action kind in
   the automation unions, a new DO method on `WorkspaceRpc`. Extend the
   pattern; don't build beside it.
3. **Make the smallest change that satisfies the contract**, keeping the
   dependency direction (`shared` → `core` → `api`, `shared` → `web`).
4. **Run the gates** (below) before reporting done. Typecheck failures in a
   package you didn't touch usually mean you broke the contract for a
   downstream consumer — that's the system working.

## Required validation

```sh
pnpm install                       # once, at repo root
pnpm typecheck                     # every package, strict — must be clean
pnpm -r test                       # vitest: core, api, importer
pnpm --filter @flow/web build      # the SPA must build, not just typecheck
```

And when you touched `apps/api` (routes, env, bindings, `wrangler.jsonc`):

```sh
pnpm --filter @flow/api exec wrangler deploy --dry-run
```

The dry run catches bundling and binding errors (bad import graphs, missing
bindings, workerd-incompatible code) that `tsc` cannot. It does not deploy and
does not require write access to any Cloudflare account.

## Never do

- **Commit secrets or real configuration values** — API keys, Access AUD tags,
  account IDs, real hostnames or emails. `wrangler.jsonc` and docs use
  placeholders (`flow.example.com`, `you@example.com`); keep it that way.
  Local values belong in `.dev.vars`, which is gitignored.
- **Weaken the delta protocol** — no skipped seqs, no mutations that commit
  without appending a delta, no delta emitted for state that didn't commit.
- **Add a board-refetch path** in the web client, for any reason (see ground
  rules for why).
- **Touch SQL outside `packages/core`**, or add a second writer of any kind.
- **Run side effects inline** in a DO mutation — everything outbound goes
  through the queue.
- **Add a runtime dependency without a written justification** in the PR.
- **Redeclare shared types** locally "for convenience".
- **Deploy.** `wrangler deploy` against a real account is an operator action,
  never part of an agent's task. Dry-run only.

## Adding a feature end-to-end

The layer order below is also the review order; skipping a layer is how
contract drift starts. For a feature with a new entity field, mutation, or
event:

1. **`packages/shared`** — add or extend the Zod schema(s): the entity field,
   the mutation input, the delta shape if a new entity kind is involved, a
   `LIMITS` cap if the field is free text. Extend `WorkspaceRpc` if there's a
   new method, and `MCP_TOOLS` if step 5 applies.
2. **`packages/core`** — implement the DO method (or extend an existing one):
   validate against the shared schema, mutate SQLite, append the delta,
   evaluate automations if the mutation can trigger them. Add a colocated
   `*.test.ts`.
3. **`apps/api`** — add the REST route in `src/routes/` as a thin wrapper:
   parse with the shared schema, call the RPC method, map errors through the
   existing `ApiError` machinery. Route tests live next to the route.
4. **`apps/web`** — extend the store (`src/store/state.ts` for shape,
   `apply.ts` for the delta patch, `mutations.ts` for the optimistic call),
   then the UI. If the delta patch is wrong, the board will drift from the
   server — this file is not optional.
5. **MCP tool, if agent-relevant** — when the capability is something an AI
   agent using Flow would want (most task/board operations are), add the tool
   name to `MCP_TOOLS` in shared, the input schema in `apps/api/src/mcp/schemas.ts`,
   the output schema in `schemas-out.ts`, and the implementation in `tools.ts`
   as a thin wrapper over the *same* RPC method the REST route calls — never a
   parallel implementation, so MCP-created tasks fire exactly the automations
   UI-created tasks do. Set the tool annotations explicitly (read-only /
   idempotent / destructive); a missing hint reads as "unknown" to clients.
6. **Tests at each layer** — core behavior in `packages/core`, route parsing
   and auth in `apps/api/src/routes/*.test.ts`, MCP schema round-trips in
   `apps/api/src/mcp/*.test.ts`.

## Test conventions

- **vitest everywhere**, colocated: `foo.ts` → `foo.test.ts` in the same
  directory. No separate `__tests__` trees except `apps/importer/test/`.
- The automation engine ships a fixture builder in
  `packages/core/src/automation/testkit.ts` — use it instead of hand-building
  rule/task objects.
- Importer tests run against recorded ClickUp payloads in
  `apps/importer/fixtures/`; new importer sources should add equivalent
  fixtures rather than hitting live APIs in tests.
- Tests assert behavior through the public surface (RPC methods, routes,
  schemas), not by inspecting SQLite rows, so refactors of storage internals
  don't churn the suite.

## PR expectations

- One behavior change per PR; keep refactors separate.
- The description names the layers touched (shared / core / api / web / mcp /
  importer), states whether the shared contract changed and why the change is
  compatible, and lists the validation commands you ran.
- If you couldn't run a gate (e.g., no network for `pnpm install`), say so
  explicitly rather than implying green.
- Flag anything you noticed but deliberately didn't fix — a reviewer deciding
  "out of scope" beats a reviewer discovering it later.
