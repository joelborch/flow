# @flow/core — the Workspace Durable Object

One DO instance (name `"main"`) holds the entire workspace in SQLite and is the
**only writer**. REST, MCP and inbound-webhook handlers call its RPC methods and
never touch SQL. Clients receive patches over a WebSocket and never re-fetch the
board after a mutation.

```ts
import { Workspace } from "@flow/core";
const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName("main"));
const task = await stub.createTask({ listId, title: "Ship it" }, actor);
```

## Files

| File | Role |
| --- | --- |
| `src/index.ts` | The `Workspace` DO: RPC surface, mutation turns, WS handlers, alarm |
| `src/schema.ts` | Tables, indexes, FTS triggers, the migration runner, seed |
| `src/turn.ts` | `Turn`: one mutation = rows + deltas + audit, committed together |
| `src/rows.ts` | SQL row shapes and their mappings to `@flow/shared` entities |
| `src/statuses.ts` | Per-list status semantics and name resolution |
| `src/position.ts` | Fractional ordering and column rebalancing |
| `src/search.ts` | FTS5 + filters + keyset pagination |
| `src/import.ts` | `ImportBatch` shapes (not in `@flow/shared` — see below) |
| `src/id.ts` | Prefixed nanoid-style ids, no dependency |
| `src/automation/` | **Owned by the automations agent.** Do not edit from here |

## The mutation turn

Every normal mutation is a single synchronous run with no `await` in the middle,
so SQLite write-coalescing commits it atomically:

1. Write the rows.
2. Append **one `Delta` per entity change** to `changes` (`seq` is the rowid, so
   it is monotonic and gap-free).
3. Write one `audit` row naming the actor, the mutation and the diff.
4. Call `evaluateAutomations` once per delta. Automation actions re-enter
   through `applyAction` **in the same turn**, so their deltas ride along in the
   same broadcast. Each hop is depth-stamped and the engine caps the chain at
   `AUTOMATION_MAX_DEPTH` (5). A rule that throws is logged and never fails the
   user's mutation.
5. Broadcast `{ type: "deltas", deltas }` to every hibernating socket, then
   `waitUntil` the SIDE_EFFECTS queue sends. Outbound I/O is never inline.

`update` deltas carry **changed fields only** (plus `updatedAt`); `create`
carries the full object; `delete` carries `null`. Every mutation RPC returns the
full authoritative entity — clients overwrite their optimistic copy with it.

Two extras reach the automation engine but are never persisted or sent to
clients: `prev` (pre-mutation values for the keys the patch touched, which is
what makes `status_changed { from: [...] }` matchable) and `taskId` on deltas
for child entities.

## Actors

Mutating methods take `actor: string | Actor`. A bare string is treated as
`{ userId, via: "api", apiKeyId: null, automationRuleId: null }`. Pass the full
`Actor` so `via` and the API key id land in the audit trail — API keys
impersonate a real user, and the key id is how you tell them apart.

## Status semantics

Statuses are per-list and ordered: exactly one of type `open` first, exactly one
`closed` last, any number of `custom` between. `CreateListInput` without
`statuses` gets **To Do → In Progress → Done**.

Mutation inputs reference a status **by name, case-insensitively**. Unresolvable
names throw listing every valid status with its type, because agents read these
messages:

```
Unknown status "In Review" for list ls_abc. Valid statuses (in order):
"To Do" (open), "In Progress" (custom), "Done" (closed).
```

Moving to a `closed`-type status sets `closedAt`; moving away clears it. Names
are unique per list, case-insensitively — enforced in code, with a unique index
as a backstop.

## Snapshot size

`getSnapshot()` omits closed tasks whose `closedAt` is more than **60 days** old,
and their subtasks. Those rows stay fully queryable through
`searchTasks({ includeClosed: true })` — the snapshot is a working-set payload,
not an archive. Comments and attachments are never in the snapshot; they load
per task via `getTaskDetail` / `listComments` / `listAttachments`.

## RPC surface

Implements `WorkspaceRpc` from `@flow/shared`, widened to typed returns and a
`string | Actor` actor.

**Reads** — `getSnapshot`, `getWorkspaceMap`, `getTaskDetail`, `searchTasks`,
`listUsers`, `listUsersNeedingEmail`, `getUserByEmail`, `listSubtasks`,
`listComments`, `listAttachments`, `getAttachment`, `listAutomations`,
`listAutomationRuns`, `getAuditLog`.

**Identity** — `resolveApiKey(tokenHash)` (bearer hot path: skips revoked keys,
stamps `lastUsedAt`, no delta), `listApiKeys`, `createApiKey`, `revokeApiKey`,
`upsertUser`, `getListByInboundToken`.

**Tasks** — `createTask` (with inline subtasks), `updateTask`, `moveTask`,
`bulkUpdate`, `deleteTask`.

**Subtasks** — `createSubtask`, `updateSubtask`, `toggleSubtask`,
`deleteSubtask`. Asana-style: done/not-done plus optional assignee and due date,
no status pipeline.

**Comments / attachments** — `createComment`, `deleteComment`,
`createAttachment`, `deleteAttachment`. R2 upload happens in the api Worker;
the DO stores metadata only. `createAttachment` honours a caller-supplied `id`
(the Worker mints it first because the R2 key embeds it), and
`deleteAttachment` returns the `r2Key` so the caller can delete the object.

**Spaces / lists** — `createSpace`, `updateSpace`, `deleteSpace`, `createList`,
`updateList`, `deleteList`, `setListStatuses`, `setListInboundToken`.

**Per-space permissions** — `setSpaceVisibility`, `setSpaceMembers`,
`listSpaceMembers`, `visibleSpaceIds`. See below.

**Automations** — `upsertAutomation`, `deleteAutomation`.

**Import** — `importBatch`. **Jobs** — `scheduleJob`.

### Notable behaviours

- **`searchTasks`** — FTS5 over title + description (tokens quoted and
  prefix-matched, so user punctuation is inert), plus list/space/status/
  assignee/tag/due/updated filters. Sorted by `(updatedAt DESC, id DESC)` rather
  than relevance, because that ordering is stable under concurrent writes, which
  is what makes the opaque cursor safe. Returns `{ tasks, cursor, total }`.
- **`moveTask`** — pass `position` for a client-computed midpoint. Omit it and
  the DO renumbers the target column if any adjacent pair has collapsed below
  `1e-6`, then appends; either way the returned `Task` carries the final
  position. A cross-list move re-resolves the status in the target list by name,
  falling back to that list's open status.
- **`bulkUpdate`** — up to 200 updates in one turn with per-item
  `{ taskId, ok, error }`. One bad row never rolls back the good ones.
- **`deleteTask`** — cascades subtasks, comments and attachments. Emits delete
  deltas for the task and its subtasks (both are in the snapshot); comments and
  attachments need none since they load lazily.
- **`deleteSpace` / `deleteList`** — refuse while children exist, naming the
  count and suggesting `archived: true` instead. `setListStatuses` refuses to
  drop a status that still holds tasks, listing which and how many.

## Per-space permissions

A space is `visibility: "workspace"` (the default, and what every existing space
is) or `"private"`. Owners and admins see every space; a member sees the
workspace-visible ones plus the private ones they are in (`space_members`).
Everything under a space — lists, tasks, subtasks, comments, attachments —
inherits that decision; there is no per-list override. The rule itself lives in
`src/visibility.ts` as `canSeeSpace`, and the three enforcement shapes all call
it rather than re-deriving it.

**Reads filter.** `getSnapshot(forUserId?)`, `getWorkspaceMap(forUserId?)` and
`searchTasks(input, actor?)` take the caller's identity and drop what it may not
see — `searchTasks` filters before `COUNT`, so `total` never teases rows the
caller cannot open. `getTaskDetail(taskId, forUserId?)` throws instead. Omitting
the id returns the unfiltered workspace and is for internal callers only.

**Writes throw.** Every task, list, subtask, comment and attachment mutation
resolves its entity to a space first and throws
`Space sp_x is private; ask an owner/admin for access.` when the actor cannot
see it. `moveTask` checks both ends, so a task can be neither dragged out of a
hidden space nor smuggled into one. Actors with `via: "automation"` or
`"import"` are system actors and exempt — a rule scoped to a private space must
still fire for the member whose task tripped it.

**Broadcasts drop per connection.** See the WebSocket section.

`setSpaceVisibility` and `setSpaceMembers` are owner/admin-only, checked inside
the DO against the actor's stored role as well as on the route: they decide who
can see what, so the sole writer does not take the caller's word for it. Going
private auto-adds the space's creator (`spaces.created_by`, storage-only), or the
acting admin for an imported space that has no recorded creator.

## importBatch

```ts
import type { ImportBatch, ImportResult } from "@flow/core";
```

These shapes are **not** in `@flow/shared` — `importBatch` isn't part of
`WorkspaceRpc`, so rather than widen the shared contract from inside
`packages/core` they live in `src/import.ts` and are re-exported.

Identity per row is `id` first (the ClickUp importer mints Flow ids during
transform and POSTs fully-formed entities), then `clickupId`. Supplying both
keeps a replay idempotent whichever key the caller reasons about. Parents may be
referenced by Flow id or ClickUp id; `spaces` and their `lists` can arrive in the
same batch because the running id map is consulted first.

Import mode is deliberately unlike every other path: **automations never run,
nothing is appended to `changes`, and nothing is broadcast per row.** One `audit`
row summarises the batch and one `{ type: "resync" }` frame goes out at the end
so connected clients pull a fresh snapshot. Per-row failures are collected in
`result.errors` and the rest of the batch still commits.

## WebSocket protocol

Upgrade at `/ws` on the DO's `fetch`, via the Hibernation API. The api Worker
authenticates first and forwards the user id as the `X-Flow-User-Id` header
(`?userId=us_…` still works for a direct-to-DO caller); the DO does not
re-authenticate. That id is stored per connection with `serializeAttachment`, so
the DO can hibernate between messages without dropping sockets — and so every
broadcast knows whose permissions to apply.

Deltas are filtered per connection. Each delta is stamped at emit time with the
space it belongs to (`user` and `automation_rule` deltas belong to none and go
to everyone); delete call sites pass the space explicitly, because by the time
the delta is emitted the row it would have been resolved through is gone. At
broadcast, a turn that touched no private space is sent as one payload to every
socket exactly as before; otherwise each socket gets only the deltas its user
may see, with the visible-space lookup memoised per user for the call. Replay
after a reconnect is filtered the same way, and skipped entirely when the
workspace has no private spaces.

Client → server (`ClientMsg`):

| Message | Server reply |
| --- | --- |
| `{ type: "hello", sinceSeq: null }` | `{ type: "snapshot", snapshot }` |
| `{ type: "hello", sinceSeq: n }` | `{ type: "deltas", deltas }` — every delta with `seq > n` |
| `{ type: "ping" }` | `{ type: "pong" }` |

`hello` falls back to a full snapshot when `sinceSeq` is `null`, ahead of the
server, more than **5,000** behind (`REPLAY_GAP_LIMIT`), or older than the
oldest surviving row after a prune. Malformed frames are ignored. After the
catch-up a client lives on broadcasts alone.

`{ type: "resync" }` means "your delta stream is intentionally incomplete, pull
a snapshot". It is sent after `importBatch` (to everyone), and after
`setSpaceVisibility` or a private space's `setSpaceMembers` (to the affected
non-admin connections only — a client that just lost access holds a subtree it
must forget, and one that just gained access has never seen the rows, and
neither is expressible as a patch).

## Alarm and scheduled jobs

A DO gets one alarm, so `scheduled_jobs` multiplexes it. `alarm()` drains rows
with `run_at <= now` (100 at a time), re-inserts recurring ones (`every_ms`,
skipping missed intervals rather than firing a backlog) and re-arms to the next
`run_at`. A job that throws is logged and dropped rather than wedging the
schedule, since alarms retry.

| Kind | Cadence | Work |
| --- | --- | --- |
| `due_date_check` | hourly | `sweepDueDateAutomations` — fires `due_date_approaching` rules; the engine's `(rule, task, dueDate)` guard makes it idempotent — **and** the snooze wake pass below |
| `prune_changes` | daily, 09:00 UTC | Keep the last 50,000 `changes` rows |

`scheduleJob({ runAt, kind, payload?, everyMs? })` adds more.

## Snooze and waiting-on

A task carries `snoozedUntil` (epoch ms, nullable) and `blockedNote` (≤200
chars, nullable). Both are ordinary `UpdateTaskInput` fields — null clears them,
and they ride the normal changed-fields delta, so no client needs a special
path. A snoozed task is still open, still in its column and still at its
position; it is simply hidden from the board and parked at the bottom of My
Work. **Waking never changes the status**, and never clears `blockedNote`.

Two things wake a task, and both go through `applyTaskUpdate` so each produces a
real delta and an audit row (`task.wake`):

1. **The clock.** The hourly `due_date_check` tick also runs `runSnoozeWake`,
   which reads up to `WAKE_SWEEP_LIMIT` (500) snoozed rows oldest-first and
   clears every one whose `snoozed_until <= now`. Actor is the owner's user id
   with `via: "automation"`, matching the due-date sweep, plus one
   `task.wake_sweep` audit row per pass. It rides the existing job rather than a
   new recurring one because `seedJobs` only fires on an empty
   `scheduled_jobs` table — a workspace that already exists would never pick a
   newly-seeded job up. A `snooze_wake` job kind exists for a targeted catch-up.
2. **Activity.** Any comment on a snoozed task clears the snooze **in the same
   turn** (Linear's rule), so the comment delta and the wake delta commit and
   broadcast together.

The selection logic lives in `src/snooze.ts` as pure functions
(`wakeCandidates`, `isSnoozed`, `wakesOnComment`), which is what `snooze.test.ts`
exercises.

## Schema and migrations

Applied ids live in `_migrations`. The constructor does exactly **one** SELECT —
a `COUNT(*)` against the number of known migrations — and returns immediately
when the schema is current, so `blockConcurrencyWhile` only runs for a genuinely
out-of-date instance. `PRAGMA user_version` is unavailable in DO SQLite, hence
the table.

Tables: `users`, `spaces`, `lists`, `statuses`, `tasks`, `subtasks`, `comments`,
`attachments`, `space_members`, `api_keys`, `automation_rules`,
`automation_runs`, `automation_due_fires`, `changes`, `audit`, `scheduled_jobs`,
`tasks_fts`.

`core-0004-snooze` adds `tasks.snoozed_until` (INTEGER) and `tasks.blocked_note`
(TEXT), both nullable with no default, plus a partial index on
`snoozed_until IS NOT NULL` for the wake sweep. SQLite's `ALTER TABLE` has no
`IF NOT EXISTS`, so the only guard against re-running it is the runner's applied
-id set — which is why it needs its own id rather than being folded into an
existing migration.

`core-0003-space-visibility` adds `spaces.visibility` (default `'workspace'`, so
nothing needs backfilling), `spaces.created_by`, and `space_members`
(`(space_id, user_id)` primary key, plus an index on `user_id` for the
"which spaces can this person see" query).

Indexes are on `tasks(listId, statusId, position)`, `tasks(assigneeId)`,
`tasks(dueDate)`, `tasks(closedAt)`, `tasks(updatedAt)`, plus per-parent indexes
on children and partial unique indexes on every `clickup_id`. `changes.seq` is an
`INTEGER PRIMARY KEY` — the rowid — so range reads and `ORDER BY seq` already use
the primary key and no extra index is warranted.

`tasks_fts` is an FTS5 table over `title` + `description`, kept in sync by three
triggers on `tasks` (insert / delete / update of those two columns). It is keyed
by `task_id` rather than using external content, which costs a little storage and
removes a coupling to the tasks rowid.

Two storage-only columns are not part of the shared contract: `clickup_id` on
spaces/lists/tasks/subtasks/comments/users (import idempotency and resolving old
ClickUp links) and `users.needs_email_update`, which flags placeholder emails —
read it with `listUsersNeedingEmail()`.

`audit` also carries denormalized `actor_user_id` and `api_key_id` columns so
`getAuditLog` can filter by user, key, action or entity as one indexed query.

## Seed

On a workspace whose `users` table is empty, a single bootstrap user is created
and nothing else — no spaces, no lists; imports or the UI create those.

| Name | Email | Role |
| --- | --- | --- |
| Workspace Owner | owner@placeholder.flow | owner |

The seed is static SQL with no access to env, so the owner starts with a
placeholder address flagged `needs_email_update`. After deploying, set
`OWNER_EMAIL`, sign in through Access (or `DEV_NO_AUTH=true` locally), and set
the real address with `upsertUser`, which clears the flag once the address is
no longer `@placeholder.flow`. Notifications are skipped for placeholder
emails, so nothing is sent until then.

## IDs

`id("tk_")` → `tk_Kf3aQ8xZ1mLp`. 12 chars from a 64-symbol URL-safe alphabet
(≈72 bits) via `crypto.getRandomValues`; the 64-symbol alphabet means `byte & 63`
is unbiased. Prefixes: `tk_` task, `ls_` list, `sp_` space, `st_` status, `sb_`
subtask, `cm_` comment, `at_` attachment, `us_` user, `ar_` automation rule,
`ak_` api key.
