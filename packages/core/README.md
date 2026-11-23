# @flow/core — the Workspace Durable Object

One DO instance (name `"main"`) holds the entire workspace in SQLite and is the
**only writer**. REST, MCP, and inbound-webhook handlers call its RPC methods
and never touch SQL directly. Clients receive deltas over WebSocket instead of
re-fetching the board after mutations.

```ts
import { Workspace } from "@flow/core";
const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName("main"));
const task = await stub.createTask({ listId, title: "Ship it" }, actor);
```

## Files

| File | Role |
| --- | --- |
| `src/index.ts` | The `Workspace` DO: RPC surface, mutation turns, WS handlers, alarm |
| `src/schema.ts` | Tables, indexes, FTS5 triggers, migration runner (`core-0001..0017`), seed |
| `src/turn.ts` | `Turn`: one mutation = rows + deltas + audit, committed together |
| `src/rows.ts` | SQL row shapes and mappings to `@flow/shared` entities |
| `src/statuses.ts` | Per-list status semantics and case-insensitive name resolution |
| `src/position.ts` | Fractional ordering and column rebalancing |
| `src/search.ts` | FTS5 + filters + keyset pagination |
| `src/query.ts` | Read-only SQL query validation and `QUERY_VIEWS` execution |
| `src/sandbox-seed.ts` | SQL seeding helpers and rate budget for the public sandbox |
| `src/id.ts` | Prefixed nanoid-style ids (`crypto.getRandomValues`) |
| `src/visibility.ts` | Per-space permissions: who can see and write which spaces |
| `src/sync-floor.ts` | Resync floor forcing a snapshot after visibility-changing turns |
| `src/snooze.ts` | Snooze and wake semantics (hourly sweep, wake-on-comment) |
| `src/handoffs.ts` | Agent handoff state rules, turn holders, and close/reopen moves |
| `src/notifications.ts` | System email notifications: recipients, templates, prefs |
| `src/users.ts` | Assignee/waitingOn validation and lookup |
| `src/alarm-observability.ts` | Structured log records for the alarm/job runner |
| `src/email-intake.ts` | Email intake types, sender allowlist matching, Message-ID parsing |
| `src/side-effect-size.ts` | Fits side effects to Queues limits (128KB/msg, 256KB/100 batch) |
| `src/websocket-close.ts` | Maps peer close codes to legal Worker WebSocket close codes |
| `src/automation/` | Automation engine: triggers, conditions, templates, recurrence, sweeps |

## The mutation turn

Every mutation runs synchronously without yielding (`await`):

1. Write SQLite rows.
2. Append one `Delta` per entity change to `changes` (`seq` is monotonic rowid).
3. Write one `audit` row naming actor, action, and diff.
4. Evaluate automations inline via `applyAction` (depth capped at `AUTOMATION_MAX_DEPTH` = 5). Rule errors log and never fail the caller's mutation.
5. Broadcast `{ type: "deltas", deltas }` to hibernating WebSockets and `waitUntil` enqueue side effects to `SIDE_EFFECTS`.

`update` deltas carry changed fields plus `updatedAt`; `create` carries the full entity; `delete` carries `null`. `prev` and child `taskId` are passed to automations in memory without persisting to `changes`.

## Actors and permissions

Mutating methods take `actor: string | Actor` (a bare string expands to `via: "api"`). Pass the full `Actor` so `via` (`ui`, `api`, `mcp`, `webhook`, `automation`) and `apiKeyId` reach the audit trail.

Spaces default to `visibility: "workspace"` or can be set `"private"`. Owners and admins see everything; members see workspace-visible spaces plus private spaces they belong to in `space_members`.

- **Reads filter**: `getSnapshot`, `getWorkspaceMap`, `getTaskDetail(s)`, `searchTasks`, and `runQuery` drop or refuse rows outside the caller's visible spaces.
- **Writes throw**: Mutations check space access before writing (`Space sp_x is private; ask an owner/admin for access.`). System actors (`via: "automation"`) are exempt so automations still run.
- **Broadcasts filter**: Per-connection socket attachments store `userId`; deltas touching private spaces are filtered per socket, and visibility/role/space-move boundary crossings issue `{ type: "resync" }` after bumping the resync floor.
- **Privileged ops**: `setSpaceVisibility` and `setSpaceMembers` re-check the actor's stored owner/admin role inside the DO.

## Statuses, snapshot window, and handoffs

- **Statuses**: Ordered per list — one `open` first, one `closed` last, any number of `custom` between. Default: `To Do -> In Progress -> Done`. Moving into `closed` sets `closedAt` and clears `waitingOn`; moving out clears `closedAt`.
- **Snapshot window**: `getSnapshot()` omits closed tasks with `closedAt` older than 60 days (`SNAPSHOT_CLOSED_WINDOW_MS`); `searchTasks({ includeClosed: true })` queries all history.
- **Agent handoffs**: Tasks tagged `handoff` carrying `{ requestedBy, state, returnFormat, contextTaskIds, stateChangedAt }` (`requested` -> `working`/`needs_input`/`done`/`declined`). Moving a handoff's status or assignee updates `handoff.state` and `waitingOn` consistently.

## Email intake, snooze, and scheduled jobs

- **`ingestEmail`**: Routes inbound mail to a new task or a threaded comment (`References` match) in the same transaction as its `email_messages` dedupe row and hourly rate checks.
- **`createComment`** with `emailToRequester` queues an `email-reply` job (requiring `EMAIL_INTAKE_REPLY`, either UI caller or an API key with `canEmailRequesters`, never MCP); **`markEmailReply`** updates `emailStatus` (`sending` -> `sent` | `failed`).
- **`alarm()`**: Runs due `scheduled_jobs` (`due_date_check` hourly including `runSnoozeWake`, `prune_changes` daily at 09:00 UTC, `backup` daily at 05:00 UTC to R2 `backups/YYYY-MM-DD.ndjson.gz` keeping 30 days plus sweeping `pending_object_deletes`). Any comment on a snoozed task wakes it in the same turn.

## Schema, migrations, seed, and IDs

- Applied migration ids live in `_migrations` (`core-0001` through `core-0017`); `blockConcurrencyWhile` only runs when pending migrations exist. `tasks_fts` is kept in sync via triggers. Legacy storage columns `clickup_id` and `users.needs_email_update` remain in SQLite for live DO compatibility.
- Fresh workspaces seed one bootstrap owner row (`owner@placeholder.flow`); `claimOwner` lets the first matching `OWNER_EMAIL` sign-in claim it cleanly.
- IDs use 12 URL-safe chars from `crypto.getRandomValues` with entity prefixes: `tk_`, `ls_`, `sp_`, `st_`, `sb_`, `cm_`, `at_`, `us_`, `ar_`, `ak_`.
