# Architecture

Flow is one Cloudflare Worker, one Durable Object, an R2 bucket, and a queue. This document explains why it's shaped that way, what that shape buys, and where it stops scaling.

## The single-DO decision

The entire workspace — every space, list, task, subtask, comment row, attachment record, user, API key, automation rule, the delta log, and the audit trail — lives in the SQLite storage of **one** Durable Object instance, named `"main"` (`WORKSPACE_NAME` in `apps/api/src/env.ts`). The DO is the only writer. REST routes, MCP tools, and the inbound webhook handler call its RPC methods (`WorkspaceRpc` in `packages/shared/src/api.ts`) and never touch SQL themselves.

**What this buys:**

- **Reads are in-process SQLite queries.** No network hop to a database, no connection pool, no N+1 amplification across a wire. A full board snapshot is a handful of indexed queries over local storage; a task detail read is single-digit milliseconds end to end.
- **Mutations are trivially serializable.** The DO is single-threaded, so a mutation turn runs start to finish with no interleaving. There are no transactions to reason about, no optimistic-concurrency retries, no distributed anything. The monotonic `seq` on the delta log falls out for free — it's the rowid of an append-only table.
- **WebSocket fan-out is local.** The DO holds the sockets (via the Hibernation API), so broadcasting a mutation's deltas is a loop over connections in the same process that just committed the write. No pub/sub infrastructure.
- **Operationally, there is nothing to run.** No Postgres to patch, no Redis to size, no migration orchestration beyond a versioned migration runner that executes in the DO constructor behind `blockConcurrencyWhile`.

**What it costs — the honest limits:**

- **One workspace per deployment.** The DO name is a constant. Multi-tenancy means deploying again (a few minutes of wrangler work), not adding a tenant row. That's fine for the intended use — a team self-hosting its own tool — and wrong for building a SaaS on top.
- **The whole workspace must fit in one SQLite database**, and every request for it lands on one DO instance in one location. Durable Objects handle this workload comfortably for a small team's task volume (the reference deployment imported a few thousand tasks and doesn't notice), but there is no sharding story. If you have fifty thousand active tasks and two hundred concurrent users, this is the wrong architecture, on purpose.
- **Single-threaded writes.** Throughput is bounded by one event loop. Again: correct trade for a team tool, wrong trade for a platform.

The snapshot payload has its own bound: closed tasks whose `closedAt` is older than 60 days (`SNAPSHOT_CLOSED_WINDOW_MS`) drop out of the board snapshot, along with their subtasks. They remain fully queryable via search with `includeClosed: true` — the snapshot is a working set, not an archive.

## The mutation turn

Every normal mutation runs as one synchronous turn (`runTurn` in `packages/core/src/index.ts`) with no `await` in the middle, so SQLite write-coalescing commits it atomically:

1. **Write the rows.**
2. **Append one `Delta` per entity change** to the `changes` table. `seq` is the rowid: monotonic, gap-free.
3. **Write one `audit` row** naming the actor (`userId`, `via`, `apiKeyId`, `automationRuleId`), the mutation name, and the diff.
4. **Evaluate automations inline** against every delta the turn produced — including deltas the automations themselves produce, each hop depth-stamped and capped at `AUTOMATION_MAX_DEPTH` (5). A rule that throws is logged and never fails the user's mutation.
5. **Drain system notifications** (assigned-to-me, comments, status changes) after the automation drain, so a rule that reassigns a task also notifies the new assignee.
6. **Flush:** broadcast `{type:"deltas"}` to every socket (filtered per connection by space visibility), then `waitUntil` the batch send to the SIDE_EFFECTS queue. Outbound I/O is never inline.

Task-returning mutations re-read the row after the automation drain (`runTaskTurn`), because a rule may have moved or restatused the task mid-turn — the caller gets the same final state the board shows, not the intermediate state the mutation itself wrote.

Import turns are **silent**: they emit no deltas, fire no automations, and send no notifications, which is what makes a bulk load of thousands of tasks safe.

## The delta protocol

The `changes` log is the spine of the whole system. One envelope (`Delta` in `packages/shared/src/events.ts`) serves three consumers:

- **live WebSocket broadcast** — clients apply patches; there is no "refetch the board" path anywhere,
- **replay on reconnect** — the client's `hello` carries the last seq it applied,
- **outbound webhooks** — the same delta rides inside the HMAC-signed `WebhookPayload`.

The shape: `{ seq, op: create|update|delete, entity, id, data, actorUserId, at }`. `create` carries the full object, `update` carries **changed fields only** (plus `updatedAt`), `delete` carries `null`. Two extras reach the automation engine but are never persisted or broadcast: `prev` (pre-mutation values for the touched keys, which is what makes `status_changed {from: [...]}` matchable) and `taskId` on child-entity deltas (so a subtask delta can be resolved to its space without a three-table join that a delete could no longer make).

**The handshake.** A client connects to `/ws` and sends `{type:"hello", sinceSeq}`:

- `sinceSeq: null` (fresh client) → the server replies with a full `snapshot` at the current seq.
- `sinceSeq: N` → the server replays every delta with `seq > N` as one `deltas` message… unless the gap exceeds `REPLAY_GAP_LIMIT` (5,000), the client claims a seq from the future, or the log has been pruned past N (a retention job keeps the newest 50,000 rows). In each of those cases the reply is a fresh `snapshot` instead — replaying an unbounded backlog would be slower than starting over.
- The server can also push `{type:"resync"}` unprompted, telling the client to reconnect fresh. This is the escape hatch for changes that can't be expressed as a patch: flipping a space private, or editing a private space's membership, leaves some clients holding a subtree they must forget and others missing rows they've never seen. Resync goes only to the non-admin connections whose view actually changed.

Everything — the hello snapshot, the replay, every broadcast — is filtered by the identity the socket was accepted with, so a member never receives a delta from a private space they can't see. The common case (no private spaces touched) stays the cheap path: one `JSON.stringify`, one send per socket.

## SnapshotTask slimming

The board snapshot doesn't ship full `Task` objects. `description` is by far the biggest column in the table and no board card renders it, so the snapshot projection (`SnapshotTask`) omits it — along with `clickupId`, `startDate`, `createdBy`, and `closedAt`, which are detail/audit fields with no board consumer — and ships a single `hasDescription` boolean instead, computed in SQL (`description != ''`). The detail panel's own `GET /api/tasks/:id` fills in the real text, and `hasDescription` lets the panel choose placeholder vs. loading spinner without waiting for that fetch.

Only the snapshot is slimmed. Deltas keep carrying full `Task` objects on create and the changed subset on update, so a client that has fetched a task's detail keeps an entry that upgrades to a complete `Task` in place — the two representations converge rather than fight.

## Client-side speed

Three techniques stack to make loads feel instant:

1. **Boot cache** (`apps/web/src/lib/boot-cache.ts`): the last snapshot plus its seq is persisted to localStorage. On reload the app paints the real board from cache immediately, and the socket's `hello` only has to replay the deltas since. The cache is versioned by a schema stamp and thrown away rather than migrated — it's a pure optimization the socket refills in one round trip.
2. **Early WebSocket** — an inline script in `index.html` opens the socket *before the JS bundle has finished downloading*, lifting the cached seq out of the localStorage record with a regex (which works because `seq` is deliberately serialized before `snapshot`). By the time the app boots, the replay is often already sitting in a buffer.
3. **Optimistic mutations** (`apps/web/src/store/mutations.ts`): the UI applies changes locally at once, then overwrites its optimistic copy with the authoritative entity every mutation RPC returns. Drag-and-drop uses CSS transforms and fractional positions, so a move touches one row, not a reindex of the column.

## Statuses and ordering

Statuses are per-list and ordered: exactly one `open` type first, exactly one `closed` last, any number of `custom` between. Mutation inputs reference statuses **by name, case-insensitively** — never by id — and an unresolvable name throws an error that lists every valid status with its type, because agents read these messages and self-correct. Moving a task to a `closed`-type status sets `closedAt`; moving away clears it.

Ordering within a column uses fractional positions: dropping a card between two neighbors assigns the midpoint, so a move writes one row. When gaps collapse below float precision, the column is rebalanced (`packages/core/src/position.ts`).

## The automations engine

Rules (`packages/shared/src/automations.ts`) are `trigger → conditions (AND) → actions (in order)`, scoped to a list or a whole space. Evaluation happens inline in the DO mutation turn: the engine (`packages/core/src/automation/engine.ts`) matches each delta against enabled rules, and matched actions re-enter the DO through `applyAction` **in the same turn**, so the client receives one coherent batch of deltas — trigger and consequences together.

Loop control is layered: every automation-produced delta is stamped with `depth`, actions past `AUTOMATION_MAX_DEPTH` (5) throw and get a clean "depth cap" run-log entry instead of silently dropping the chain, and a hard fan-out cap of 5,000 evaluated deltas per turn backstops pathological rule sets. Every firing writes an `automation_runs` row with a per-action result (`ok`, `dryRun`, `detail`) — since a rule can never fail the mutation that triggered it, this log is the only failure signal, and it's queryable per rule and per task.

The two outbound actions (`call_webhook`, `send_email`) never run inline: the engine enqueues them and the loop above never sees them. `due_date_approaching` triggers are driven by a DO alarm sweep (`packages/core/src/automation/schedule.ts`) rather than by a mutation, with a fired-set so a rule doesn't re-fire daily for the same task. The same alarm machinery wakes snoozed tasks hourly.

## Queue side effects

The SIDE_EFFECTS queue is the only place Flow talks to the outside world (`apps/api/src/side-effects/index.ts`). Two payload kinds:

- **`webhook`** — POSTed with a 7-second timeout, `content-type: application/json`, `x-flow-event` and `x-flow-rule` headers, and — when the rule carries a secret — an `X-Flow-Signature` header containing the lowercase-hex HMAC-SHA256 of the exact body. Non-2xx responses throw, so the message retries.
- **`email`** — rendered from markdown by a deliberately tiny renderer and sent through the Cloudflare Email Sending binding (`SEND_EMAIL`). `EMAIL_DRY_RUN` (default `"true"`) short-circuits the send and logs exactly what would have gone out; with dry-run off and no binding configured, the send fails loudly and retries rather than silently dropping mail.

Failures ack or retry **per message**, not per batch, so one dead webhook endpoint doesn't re-deliver its neighbors' email. After `max_retries: 5` a message lands in the `flow-dlq` dead-letter queue. An unparseable message is acked and dropped immediately — it will never become parseable, so burning retries on it is pure waste.

## The auth model

Two ways in, resolved in order by `apps/api/src/auth.ts`:

1. **`Authorization: Bearer flow_<token>`** — agents and scripts. The token is `flow_` + base64url of 32 CSPRNG bytes; only its SHA-256 hex is ever stored, and the plaintext is shown exactly once at mint time. The hash is resolved inside the DO (`resolveApiKey`), which also stamps `lastUsedAt`. A key **impersonates a real user**: mutations show as that person's, with the key id recorded beside them in the audit trail, which is the mechanism that keeps agents accountable without inventing a parallel permission system.
2. **Cloudflare Access JWT** — humans. Access sits in front of the Worker (Google SSO, email OTP, whatever your Access policy allows) and injects a signed JWT in `Cf-Access-Jwt-Assertion`. The Worker verifies it against the team's JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), checks `aud` against `ACCESS_AUD` and `iss` against the team domain, caches the key set for an hour, and refetches immediately on an unknown `kid` to ride out Cloudflare's key rotation. The `email` claim maps to a workspace user; a non-member gets 403, not 401.

**The cookie fallback** exists for one reason: browsers cannot attach headers to a WebSocket upgrade, and `/ws` sits on an Access *bypass* application (see the self-hosting doc), so no JWT header is injected there. But the `CF_Authorization` cookie set at login carries the same JWT for the whole domain, and verifying it is identical in strength to the header path — same JWKS, same AUD. The Worker then hands the resolved user id to the DO as an `X-Flow-User-Id` header, stripping any client-supplied copy first; the DO trusts it because the Worker is the only path to the DO.

Public exceptions: `GET /api/health` (liveness), and `POST /api/inbound/:listId`, which authenticates per-list against that list's own `inb_` token — so a leaked intake credential can only create tasks in one list, and rotating it is one PATCH.

`DEV_NO_AUTH=true` (in `.dev.vars` only, never in `wrangler.jsonc`) resolves every request to `OWNER_EMAIL`'s user for local development. It fails closed: anything other than the exact string `"true"` leaves auth fully enforced.

## Per-space visibility

A space is `"workspace"` (every member sees it — the default) or `"private"` (owners, admins, and the space's own member list). One rule, applied in three shapes: **reads filter** (snapshots, search results, and the workspace map simply omit invisible rows, including `total` counts so paging stays honest), **writes throw** (a descriptive "Space sp_x is private; ask an owner/admin for access" rather than a misleading 404), and **the broadcast drops** (each delta is resolved to its space, and per-connection filtering only kicks in when a private space was actually touched). Automations and import run as system actors and are exempt, so a rule scoped to a private space still fires.

## Where the contract lives

`packages/shared` is the single source of truth: entity schemas, mutation inputs, delta events, the WS protocol, MCP tool names, and the `WorkspaceRpc` interface, all in Zod. REST routes parse with it, MCP tool schemas derive from it, the DO types against it, and the web client imports it. There is exactly one definition of what a `Task` is, and drift between surfaces is a compile error rather than a production surprise.
