# REST API reference

Everything is under `/api/*` on your deployment, JSON in and out, timestamps in epoch milliseconds, ids as short prefixed strings (`sp_` space, `ls_` list, `tk_` task, `sb_` subtask, `cm_` comment, `at_` attachment, `us_` user, `ar_` automation rule, `ak_` API key).

All examples assume:

```bash
export FLOW=https://flow.example.com
export TOKEN=flow_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
alias flowcurl='curl -sS -H "Authorization: Bearer $TOKEN"'
```

**Auth.** Every route requires either a `flow_` bearer token or a Cloudflare Access JWT, except `GET /api/health` (public) and `POST /api/inbound/:listId` (authenticated per-list by its own `inb_` token). "Admin" below means the owner or admin role. Reads and writes are additionally filtered by [per-space visibility](ARCHITECTURE.md#per-space-visibility).

**Errors.** Always `{"error": "<one readable sentence>"}`. Validation failures are 422 with every Zod issue flattened into the one line. Domain errors keep the DO's own message (`Unknown status "Blocked" for list ls_x. Valid statuses (in order): ...`) — 404 when it names a missing entity, 422 otherwise. 401 no/bad credential, 403 authenticated but not permitted, 413 attachment over 100 MB, 416 unsatisfiable Range, 500 logged and never leaked.

---

## Health and identity

| Method + path | Auth | What |
|---|---|---|
| `GET /api/health` | none | Liveness: `{"ok":true,"service":"flow","ts":...}` |
| `GET /api/me` | any | The caller: `{user, via, apiKey}` — `apiKey` present on the bearer path |
| `GET /api/snapshot` | any | The whole board: spaces, lists, tasks (slimmed), subtasks, users, automation rules, and the current `seq` |
| `GET /api/users` | any | Members, for assignee pickers |

```bash
flowcurl $FLOW/api/me
flowcurl $FLOW/api/snapshot
```

`GET /api/snapshot` is for one-shot consumers (scripts, backups). Live clients connect to `/ws` and apply deltas — never poll this to refresh a board.

## Spaces

Writes and member routes require admin.

| Method + path | Auth | What |
|---|---|---|
| `GET /api/spaces` | any | All visible spaces |
| `GET /api/spaces/:spaceId` | any | One space + its lists |
| `POST /api/spaces` | admin | Create: `{name, color?}` |
| `PATCH /api/spaces/:spaceId` | admin | `{name?, color?, archived?, position?, visibility?}` |
| `DELETE /api/spaces/:spaceId` | admin | Delete (refused while it still has lists) |
| `GET /api/spaces/:spaceId/members` | any | `{spaceId, userIds}` |
| `PUT /api/spaces/:spaceId/members` | admin | Replace the membership wholesale: `{userIds}` |

```bash
flowcurl -X POST $FLOW/api/spaces -H 'Content-Type: application/json' \
  -d '{"name":"Marketing","color":"#7c5cff"}'

# Make it private, then say who's in it (PUT replaces the whole set)
flowcurl -X PATCH $FLOW/api/spaces/sp_abc123 \
  -H 'Content-Type: application/json' -d '{"visibility":"private"}'
flowcurl -X PUT $FLOW/api/spaces/sp_abc123/members \
  -H 'Content-Type: application/json' -d '{"userIds":["us_one","us_two"]}'
```

Visibility is `"workspace"` (default, everyone) or `"private"` (owners/admins + the member list). Flipping it, or editing membership, pushes `{"type":"resync"}` to the affected WebSocket clients.

## Lists

Writes require admin. Statuses live on the list: at least 2, exactly one `open` first and one `closed` last, `custom` between; omitting `statuses` on create gives **To Do → In Progress → Done**.

| Method + path | Auth | What |
|---|---|---|
| `GET /api/lists?spaceId=...` | any | Lists (optionally by space) |
| `GET /api/lists/:listId` | any | List + statuses + its tasks. Admins also get the plaintext `inboundToken`; members get the boolean `inboundEnabled` |
| `POST /api/lists` | admin | `{spaceId, name, statuses?}` |
| `PATCH /api/lists/:listId` | admin | `{name?, position?, archived?, spaceId?, statuses?, inboundToken?}` |
| `DELETE /api/lists/:listId` | admin | Delete (refused while it still has tasks) |

```bash
flowcurl -X POST $FLOW/api/lists -H 'Content-Type: application/json' \
  -d '{"spaceId":"sp_abc123","name":"Pipeline","statuses":[
        {"name":"Triage","color":"#8b949e","type":"open"},
        {"name":"Building","color":"#3b82f6","type":"custom"},
        {"name":"Shipped","color":"#22c55e","type":"closed"}]}'
```

**Inbound intake** is toggled through the same PATCH. `"rotate"` mints a fresh `inb_` token and returns it **once**, with the exact URL to paste into the source system; `null` disables intake. Everywhere else — snapshots, deltas, list reads by non-admins — the token is stripped at the source.

```bash
flowcurl -X PATCH $FLOW/api/lists/ls_def456 \
  -H 'Content-Type: application/json' -d '{"inboundToken":"rotate"}'
# {"list":{...},"inboundEnabled":true,"inboundToken":"inb_...",
#  "inboundUrl":"https://flow.example.com/api/inbound/ls_def456",
#  "warning":"This inbound token is shown only once."}
```

## Tasks

| Method + path | Auth | What |
|---|---|---|
| `GET /api/tasks` | any | Same handler as search below |
| `GET /api/tasks/:taskId` | any | Full detail: task + subtasks + comments + attachments |
| `POST /api/tasks` | any | Create (optionally with inline subtasks) → 201 |
| `PATCH /api/tasks/:taskId` | any | Partial update; absent leaves alone, `null` clears |
| `POST /api/tasks/:taskId/move` | any | `{listId?, status?, position?}` — omit `position` and the server picks |
| `DELETE /api/tasks/:taskId` | any | Delete |

```bash
flowcurl -X POST $FLOW/api/tasks -H 'Content-Type: application/json' \
  -d '{"listId":"ls_def456",
       "title":"Checkout fails on Safari",
       "description":"Spinner never resolves.\n\nRepro: **iOS 17**",
       "status":"Triage",
       "assigneeId":"us_abc",
       "priority":"urgent",
       "dueDate":1785000000000,
       "tags":["bug","safari"],
       "subtasks":[{"title":"Reproduce"},{"title":"Patch","assigneeId":"us_abc"}]}'

flowcurl -X PATCH $FLOW/api/tasks/tk_ghi789 -H 'Content-Type: application/json' \
  -d '{"status":"Building","priority":"high"}'

flowcurl -X POST $FLOW/api/tasks/tk_ghi789/move -H 'Content-Type: application/json' \
  -d '{"listId":"ls_other","status":"Triage","position":1.5}'
```

`status` is always a status **name**, matched case-insensitively; omitted on create, the task lands in the list's open status. Priorities: `urgent`, `high`, `normal`, `low`. Descriptions and comments are markdown, plain strings over the wire.

**Snooze.** `PATCH` also takes `snoozedUntil` (epoch ms; `null` wakes now) and `blockedNote` (≤200 chars). A snoozed task keeps its list, status, and position — it's just hidden from the board and parked at the bottom of My Work until the hourly sweep passes its wake time or anyone comments on it. Waking never changes the status.

```bash
flowcurl -X PATCH $FLOW/api/tasks/tk_ghi789 -H 'Content-Type: application/json' \
  -d '{"snoozedUntil":1785000000000,"blockedNote":"waiting on the revised quote"}'
```

## Search

`GET /api/tasks/search` (query params) and `POST /api/tasks/search` (JSON body — easier when the filter list gets long) are the same search: FTS over title + description plus filters. Array filters accept repeated params or comma-separated values.

| Filter | Type |
|---|---|
| `query` (alias `q`) | FTS string |
| `listId`, `spaceId`, `assigneeId` | id |
| `status` | array of status names |
| `tags` | array |
| `includeClosed` | boolean, default false |
| `dueBefore`, `dueAfter`, `updatedAfter` | epoch ms |
| `limit` | 1–200, default 50 |
| `cursor` | opaque; from the previous page |

```bash
flowcurl "$FLOW/api/tasks/search?query=safari&assigneeId=us_abc&limit=20"
flowcurl "$FLOW/api/tasks/search?listId=ls_def456&status=Triage&status=Building"
flowcurl "$FLOW/api/tasks/search?tags=bug,p1&includeClosed=true"

flowcurl -X POST $FLOW/api/tasks/search -H 'Content-Type: application/json' \
  -d '{"query":"checkout","tags":["bug"],"limit":100}'
# {"tasks":[...],"cursor":"...","total":137}
```

Returns concise `TaskRow` shapes, not full tasks; page with `cursor` until it's `null`.

## Bulk

Both forms report **per item**, so one bad entry never forces a blind retry of the whole batch. Up to 200 items.

| Method + path | Auth | What |
|---|---|---|
| `PATCH /api/tasks/bulk` | any | `{updates: [UpdateTaskInput, ...]}` |
| `POST /api/tasks/bulk` | any | `{tasks: [CreateTaskInput, ...]}` → 201 |

```bash
flowcurl -X PATCH $FLOW/api/tasks/bulk -H 'Content-Type: application/json' \
  -d '{"updates":[{"taskId":"tk_1","status":"Done"},{"taskId":"tk_2","assigneeId":null}]}'
# {"results":[{"taskId":"tk_1","ok":true,"error":null},
#             {"taskId":"tk_2","ok":false,"error":"no task tk_2"}]}
```

## Subtasks

Asana-style: done/not-done, optional assignee and due date, **no status pipeline**.

| Method + path | Auth | What |
|---|---|---|
| `POST /api/tasks/:taskId/subtasks` | any | One (`{title, assigneeId?, dueDate?}`) or a batch (`{subtasks: [...]}`, up to 100) → 201 |
| `PATCH /api/subtasks/:subtaskId` | any | `{done?, title?, assigneeId?, dueDate?}` |
| `DELETE /api/subtasks/:subtaskId` | any | Delete |

```bash
flowcurl -X POST $FLOW/api/tasks/tk_ghi789/subtasks -H 'Content-Type: application/json' \
  -d '{"subtasks":[{"title":"Reproduce"},{"title":"Patch"},{"title":"Verify"}]}'

flowcurl -X PATCH $FLOW/api/subtasks/sb_jkl012 \
  -H 'Content-Type: application/json' -d '{"done":true}'
```

## Comments

| Method + path | Auth | What |
|---|---|---|
| `GET /api/tasks/:taskId/comments` | any | The thread |
| `POST /api/tasks/:taskId/comments` | any | `{body}` (markdown, ≤20,000 chars) → 201 |
| `DELETE /api/comments/:commentId` | any | Delete |

## Attachments

Uploads are raw bytes streamed straight into R2 — nothing buffers in the Worker, so a 100 MB file never approaches the memory limit. `Content-Length` is required; 100 MB is a hard cap (413). Filename comes from `?filename=` or an `X-Filename` header.

| Method + path | Auth | What |
|---|---|---|
| `POST /api/tasks/:taskId/attachments?filename=...` | any | Upload body bytes → metadata row |
| `GET /api/tasks/:taskId/attachments` | any | Metadata list |
| `GET /api/tasks/:taskId/attachments/:attachmentId` | any | Download (streamed; `Range` and `If-None-Match`/ETag supported) |
| `GET /api/attachments/:attachmentId` | any | Same download, by id alone |
| `DELETE /api/attachments/:attachmentId` | any | Delete the row, then the R2 object |

```bash
flowcurl -X POST "$FLOW/api/tasks/tk_ghi789/attachments?filename=screenshot.png" \
  -H 'Content-Type: image/png' --data-binary @screenshot.png

flowcurl -o screenshot.png $FLOW/api/attachments/at_pqr678
flowcurl -H 'Range: bytes=0-1023' $FLOW/api/attachments/at_pqr678   # 206 + Content-Range
```

Single `bytes=` ranges (closed, open-ended, suffix) return 206 with an end past EOF clamped; a start at or past EOF is 416; multi-range requests get the whole object as a 200, which is a valid answer to any Range request.

## Automations

Reads open to members; writes admin. Rules ship `enabled: false`. Full vocabulary in [AUTOMATIONS.md](AUTOMATIONS.md).

| Method + path | Auth | What |
|---|---|---|
| `GET /api/automations` | any | All rules |
| `GET /api/automations/:ruleId` | any | One rule |
| `POST /api/automations` | admin | Create |
| `PATCH /api/automations/:ruleId` | admin | **Upsert against the path id** — send the whole rule, not a diff |
| `DELETE /api/automations/:ruleId` | admin | Delete |
| `GET /api/automation-runs?ruleId=&taskId=&limit=&before=` | any | Run log, newest first, keyset-paged |
| `GET /api/automations/:ruleId/runs` | any | One rule's history |

## Notification preferences

Self-only: both routes act on the caller's own prefs; there is no way to read or change another user's.

| Method + path | Auth | What |
|---|---|---|
| `GET /api/notifications/prefs` | any | `{userId, email, prefs}` — defaults returned before any write |
| `PUT /api/notifications/prefs` | any | Any subset of the booleans; returns the full merged set |

```bash
flowcurl -X PUT $FLOW/api/notifications/prefs -H 'Content-Type: application/json' \
  -d '{"status_change_on_my_task":true,"comment_on_my_task":false}'
```

Booleans: `assigned_to_me` (default on), `comment_on_my_task` (on), `status_change_on_my_task` (off), `mention` (on, reserved — mentions aren't parsed yet).

## Audit

| Method + path | Auth | What |
|---|---|---|
| `GET /api/audit` | any | Newest first; filters `entity`, `action` (e.g. `task.update`), `userId`, `apiKeyId`, `after`, `before`; page by passing the returned `cursor` back as `before` |

```bash
flowcurl "$FLOW/api/audit?apiKeyId=ak_vwx234"              # what did this agent do
flowcurl "$FLOW/api/audit?entity=tk_ghi789"                # one task's full history
flowcurl "$FLOW/api/audit?userId=us_abc&action=task.update"
```

Entries carry the full actor — `{userId, via, apiKeyId, automationRuleId}` — which is the point: a key impersonates a user, so the user id alone can't tell you whether a change came from the human or their agent.

## API keys

Self-serve for your own identity; impersonating another user is admin-only.

| Method + path | Member | Admin |
|---|---|---|
| `POST /api/api-keys` | `userId` absent or own id | any `userId` |
| `GET /api/api-keys` | own keys only | every key |
| `DELETE /api/api-keys/:apiKeyId` | own keys only | any key |

```bash
# The token is in this response and NOWHERE else, ever.
flowcurl -X POST $FLOW/api/api-keys -H 'Content-Type: application/json' \
  -d '{"name":"my-agent"}'
# {"apiKey":{"id":"ak_...","name":"my-agent","userId":"us_..."},
#  "token":"flow_...","warning":"This token is shown only once and cannot be recovered."}
```

## Import

Admin-only; used by `apps/importer`. Import upserts by id (then `clickupId`), fires no automations, emits no deltas, and truncates over-long titles instead of rejecting them — see [IMPORTING.md](IMPORTING.md).

| Method + path | Auth | What |
|---|---|---|
| `GET /api/import/status` | admin | Pre-flight |
| `POST /api/import/batch` | admin | `{users?, spaces?, lists?, tasks?, subtasks?, comments?}` — fully-formed entities with ids, upserted |
| `POST /api/import/attachments` | admin | `{taskId, filename, mimeType, size, sourceUrl, ...}` — the Worker fetches `sourceUrl` (https, ClickUp hosts only) and streams it into R2 |

## Inbound

| Method + path | Auth | What |
|---|---|---|
| `POST /api/inbound/:listId` | the list's `inb_` token (Bearer or `?token=`) | Create a task in that one list. `externalId` deduplicates: a repeat delivery returns the existing task with `200 {"created":false}` |

```bash
curl -sS -X POST "$FLOW/api/inbound/ls_def456" \
  -H "Authorization: Bearer inb_xxxxxxxx" -H 'Content-Type: application/json' \
  -d '{"title":"Login broken","description":"500 on submit","externalId":"rpt-88"}'
```

See [AGENTS_AND_MCP.md](AGENTS_AND_MCP.md#inbound-webhooks-inb_-tokens) for the payload mapping rules.

## WebSocket

`GET /ws` authenticates (bearer, Access JWT, or the `CF_Authorization` cookie — the browser path) and hands the upgrade straight to the Durable Object, which owns the socket so it can hibernate and broadcast without a hop.

```bash
websocat "wss://flow.example.com/ws" -H "Authorization: Bearer $TOKEN"
> {"type":"hello","sinceSeq":null}     # null => full snapshot
> {"type":"hello","sinceSeq":41823}    # replay since seq; snapshot if the gap is too big
> {"type":"ping"}                      # <= {"type":"pong"}
```

Server messages: `snapshot`, `deltas`, `resync` (reconnect fresh), `pong`. Protocol details in [ARCHITECTURE.md](ARCHITECTURE.md#the-delta-protocol).
