# @flow/api

The single Cloudflare Worker behind Flow. It serves the SPA, the REST API, the
MCP endpoint and the WebSocket upgrade, and it consumes the side-effects queue.
It holds no state of its own: every read and write goes through RPC on the
`Workspace` Durable Object (one instance, named `main`).

```
Cloudflare Access ──┐
                    ├─> Worker ──RPC──> Workspace DO (SQLite, sole writer)
Bearer flow_<token> ─┘        ├──R2───> ATTACHMENTS
                              └──Queue─> SIDE_EFFECTS
```

---

## Authentication

Two ways in, resolved by `src/auth.ts` in this order.

**1. `Authorization: Bearer flow_<token>` — agents, scripts, MCP.**
The token is sha256'd and looked up in the DO. A key impersonates a real user, so
mutations show up as that person's, with the key id recorded alongside in the
audit trail. `lastUsedAt` is bumped at most once per key per five minutes, from
`waitUntil`, so it never sits on the request's critical path.

**2. `Cf-Access-Jwt-Assertion` — humans.**
Cloudflare Access sits in front of the Worker and signs a JWT per request. It is
verified (RS256) against the team's JWKS at
`https://$ACCESS_TEAM_DOMAIN/cdn-cgi/access/certs`, checking `aud` against
`$ACCESS_AUD`, `iss` against the team domain, and `exp`/`nbf` with 60s of skew
allowance. The key set is cached in the isolate for an hour and refetched
immediately when a token presents an unknown `kid`, which is how Cloudflare's
periodic key rotation is handled. The `email` claim is mapped to a workspace user;
a non-member gets 403, not 401.

Everything under `/api/*` and `/mcp` requires one of the two. The exceptions:

| Path | Why it is open |
|---|---|
| `GET /api/health` | Liveness checks should not need a credential. |
| `POST /api/inbound/*` | Authenticated per-list against that list's own `inboundToken`. |

Roles: `owner`/`admin` are required for changing the workspace shape (spaces,
lists, automations) and for any api-key operation touching *another* user's key.
Every member can mint, list and revoke keys that act as themselves — see [API
keys](#api-keys). Task-level work is open to any member — inside the spaces that
member can see; see [Space visibility](#space-visibility).

### Local development

`DEV_NO_AUTH=true` resolves every request to `OWNER_EMAIL`'s user. It **fails
closed**: only the exact string `"true"` enables it, so an unset, empty or
misspelled value leaves auth fully enforced. It is deliberately absent from
`wrangler.jsonc` — put it in `.dev.vars`, which is gitignored:

```
# apps/api/.dev.vars
DEV_NO_AUTH = "true"
```

```bash
pnpm --filter @flow/api dev     # :8787
curl -s localhost:8787/api/me | jq   # no credential needed with DEV_NO_AUTH
```

Every example below assumes:

```bash
export FLOW=https://flow.example.com
export TOKEN=flow_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
alias flowcurl='curl -sS -H "Authorization: Bearer $TOKEN"'
```

---

## Errors

Every failure is `{"error": "<message>"}` with a real status code. Validation
failures return **422** with every Zod issue flattened into one line, because
agents read these strings and a nested error object is harder to act on:

```json
{ "error": "invalid request body: listId: Required; title: String must contain at least 1 character(s)" }
```

Domain errors thrown inside the Durable Object reach the caller with their
message intact. Messages that name a missing entity (`Task tk_x not found.`)
become **404**; the rest — unknown status names, "this list still has tasks",
unknown assignee ids — stay **422**.

| Status | Meaning |
|---|---|
| 400 | Malformed request — bad JSON, missing `Content-Length` on an upload. |
| 401 | No credential, or a bad/revoked one. |
| 403 | Authenticated but not permitted (non-member, deactivated, wrong role). |
| 404 | No such entity, or no route. Includes the DO's own "… not found." throws. |
| 413 | Attachment over the 100 MB cap. |
| 416 | Range request that starts at or past the end of the attachment. |
| 422 | Body or query params failed schema validation, or a domain rule refused the mutation. |
| 500 | Unexpected — logged with a stack trace, never leaked to the caller. |

---

## Routes

### Health and identity

```bash
curl -sS $FLOW/api/health
# {"ok":true,"service":"flow","ts":1785000000000}

flowcurl $FLOW/api/me
# {"user":{...},"via":"api","apiKey":{"id":"ak_...","name":"claude-mcp"}}

flowcurl $FLOW/api/snapshot     # whole board: spaces, lists, tasks, subtasks, users, rules
flowcurl $FLOW/api/users        # members, for assignee pickers
```

`GET /api/snapshot` is for one-shot consumers. UI clients should connect to `/ws`
and apply deltas instead — never poll this to refresh a board.

### Spaces

`POST`/`PATCH`/`DELETE` and the two member routes require owner or admin.

```bash
flowcurl $FLOW/api/spaces
flowcurl $FLOW/api/spaces/sp_abc123           # space + its lists

flowcurl -X POST $FLOW/api/spaces \
  -H 'Content-Type: application/json' \
  -d '{"name":"Marketing","color":"#7c5cff"}'

flowcurl -X PATCH $FLOW/api/spaces/sp_abc123 \
  -H 'Content-Type: application/json' \
  -d '{"name":"Growth","archived":false,"position":2}'

# Make it private, then say who is in it (PUT replaces the whole membership).
flowcurl -X PATCH $FLOW/api/spaces/sp_abc123 \
  -H 'Content-Type: application/json' -d '{"visibility":"private"}'

flowcurl -X PUT $FLOW/api/spaces/sp_abc123/members \
  -H 'Content-Type: application/json' \
  -d '{"userIds":["us_alice","us_bob"]}'

flowcurl $FLOW/api/spaces/sp_abc123/members
# {"spaceId":"sp_abc123","userIds":["us_alice","us_bob"]}

flowcurl -X DELETE $FLOW/api/spaces/sp_abc123
```

### Space visibility

Every space is `"workspace"` (the default, and what every existing space is) or
`"private"`. Owners and admins see all of them; a member sees the
workspace-visible ones plus the private ones they are a member of. Lists, tasks,
subtasks, comments and attachments inherit their space's decision — there is no
per-list override.

Reads are filtered rather than refused: `GET /api/snapshot`, `/api/spaces`,
`/api/spaces/:id`, `/api/lists`, `/api/tasks` and `/api/tasks/search` simply do
not contain rows from a space the caller cannot see, and a direct
`GET /api/spaces/:id` on one 404s like any other unknown id. Reads that name a
single task — `GET /api/tasks/:taskId`, its comments, its attachments — and every
write answer with 422 and the sentence

```
Space sp_abc123 is private; ask an owner/admin for access.
```

Automations and `POST /api/import/batch` run as system actors and are exempt, so
a rule scoped to a private space still fires for the member whose task tripped
it.

Flipping visibility, or changing a private space's membership, sends
`{"type":"resync"}` to the affected non-admin WebSocket connections: a client
that just lost access is holding a subtree it must forget, and one that just
gained access has never seen the rows, and neither is expressible as a patch.

### Lists

`inboundToken` is a credential, and the DO strips it at the source: every read
that returns a list — `getSnapshot()`, and therefore `GET /api/snapshot`,
`GET /api/spaces/:spaceId`, `GET /api/lists` and the WebSocket hello snapshot —
carries `inboundToken: null`, as does every list delta. `POST /api/lists`
returns it explicitly null for the same reason.

The plaintext reaches a caller in exactly two places: the once-only response to
`PATCH /api/lists/:listId {"inboundToken":"rotate"}`, and `GET
/api/lists/:listId` for owners and admins (which reads it through the DO's
admin-only `getListWithSecrets`). Non-admins get the boolean `inboundEnabled`
instead. Tokens are minted with an `inb_` prefix.

```bash
flowcurl "$FLOW/api/lists?spaceId=sp_abc123"
flowcurl $FLOW/api/lists/ls_def456            # list + statuses + its tasks

flowcurl -X POST $FLOW/api/lists \
  -H 'Content-Type: application/json' \
  -d '{"spaceId":"sp_abc123","name":"Bug Intake"}'

# Explicit status set (must start with one "open" and end with one "closed"):
flowcurl -X POST $FLOW/api/lists \
  -H 'Content-Type: application/json' \
  -d '{"spaceId":"sp_abc123","name":"Pipeline","statuses":[
        {"name":"Triage","color":"#8b949e","type":"open"},
        {"name":"Building","color":"#3b82f6","type":"custom"},
        {"name":"Shipped","color":"#22c55e","type":"closed"}]}'

flowcurl -X PATCH $FLOW/api/lists/ls_def456 \
  -H 'Content-Type: application/json' -d '{"name":"Bugs","position":3}'

# Move a list to a different space
flowcurl -X PATCH $FLOW/api/lists/ls_def456 \
  -H 'Content-Type: application/json' -d '{"spaceId":"sp_other"}'

flowcurl -X DELETE $FLOW/api/lists/ls_def456
```

Inbound intake is toggled through the same PATCH. `"rotate"` has the DO mint a
fresh token and returns it **once**, together with the URL to paste into the
source system; `null` disables intake. The token is generated inside the DO, so
the plaintext exists in one place and is written in the turn that records it.

```bash
flowcurl -X PATCH $FLOW/api/lists/ls_def456 \
  -H 'Content-Type: application/json' -d '{"inboundToken":"rotate"}'
# {"list":{...},"inboundEnabled":true,
#  "inboundToken":"...","inboundUrl":"https://flow.example.com/api/inbound/ls_def456",
#  "warning":"This inbound token is shown only once."}

flowcurl -X PATCH $FLOW/api/lists/ls_def456 \
  -H 'Content-Type: application/json' -d '{"inboundToken":null}'
```

### Tasks

```bash
flowcurl -X POST $FLOW/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"listId":"ls_def456",
       "title":"Checkout fails on Safari",
       "description":"Spinner never resolves.\n\nRepro: **iOS 17**",
       "status":"Triage",
       "assigneeId":"us_alice",
       "priority":"urgent",
       "dueDate":1785000000000,
       "tags":["bug","safari"],
       "subtasks":[{"title":"Reproduce"},{"title":"Patch","assigneeId":"us_alice"}]}'
```

`status` is a status **name**, matched case-insensitively; omit it and the task
lands in the list's open status. Timestamps are epoch milliseconds everywhere.

```bash
flowcurl $FLOW/api/tasks/tk_ghi789      # task + subtasks + comments + attachments

flowcurl -X PATCH $FLOW/api/tasks/tk_ghi789 \
  -H 'Content-Type: application/json' \
  -d '{"status":"Building","priority":"high","tags":["bug","safari","p1"]}'

# Move between lists and/or columns. Omit position and the server picks one.
flowcurl -X POST $FLOW/api/tasks/tk_ghi789/move \
  -H 'Content-Type: application/json' \
  -d '{"listId":"ls_other","status":"Triage","position":1.5}'

flowcurl -X DELETE $FLOW/api/tasks/tk_ghi789
```

`PATCH` accepts a `taskId` in the body, but the path always wins.

`PATCH` also takes `snoozedUntil` (epoch ms, or `null` to wake the task now) and
`blockedNote` (≤200 chars, or `null` to clear it) — the same `UpdateTaskInput`
the MCP `flow_update_task` tool uses, so no route-level change was needed:

```bash
# Park it until Monday morning, with a note about what it is waiting on.
flowcurl -X PATCH $FLOW/api/tasks/tk_ghi789 \
  -H 'Content-Type: application/json' \
  -d '{"snoozedUntil":1785000000000,"blockedNote":"the lab's revised quote"}'

flowcurl -X PATCH $FLOW/api/tasks/tk_ghi789 \
  -H 'Content-Type: application/json' -d '{"snoozedUntil":null}'   # wake now
```

A snoozed task is hidden from the board and dropped to a collapsed bucket in My
Work, but it is otherwise untouched: same list, same status, same position. It
wakes on its own when the hourly sweep passes its time, or the moment anyone
comments on it — and waking never changes the status.

### Search

`GET /api/tasks/search` and `GET /api/tasks` are the same handler. Array filters
(`status`, `tags`) accept either repeated params or a comma-separated list.

```bash
flowcurl "$FLOW/api/tasks/search?query=safari&assigneeId=us_alice&limit=20"
flowcurl "$FLOW/api/tasks/search?listId=ls_def456&status=Triage&status=Building"
flowcurl "$FLOW/api/tasks/search?tags=bug,p1&includeClosed=true"
flowcurl "$FLOW/api/tasks/search?spaceId=sp_abc123&dueBefore=1785000000000&updatedAfter=1784000000000"
```

Every filter, plus the `cursor` for paging, is also accepted as a POST body —
easier once the filter list gets long:

```bash
flowcurl -X POST $FLOW/api/tasks/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"checkout","tags":["bug"],"includeClosed":false,"limit":100}'
# {"tasks":[...],"cursor":"...","total":137}
```

Returns `TaskRow` shapes (not full tasks) — page with `cursor` until it is `null`.

### Bulk

Both bulk forms report **per item**, so one bad entry never forces a blind retry
of the whole batch. Up to 200 items.

```bash
# Bulk update
flowcurl -X PATCH $FLOW/api/tasks/bulk \
  -H 'Content-Type: application/json' \
  -d '{"updates":[{"taskId":"tk_1","status":"Done"},
                  {"taskId":"tk_2","assigneeId":null}]}'
# {"results":[{"taskId":"tk_1","ok":true,"error":null},
#             {"taskId":"tk_2","ok":false,"error":"no task tk_2"}]}

# Bulk create
flowcurl -X POST $FLOW/api/tasks/bulk \
  -H 'Content-Type: application/json' \
  -d '{"tasks":[{"listId":"ls_def456","title":"First"},
                {"listId":"ls_def456","title":"Second","priority":"low"}]}'
```

### Subtasks

Asana-style: done/not-done plus an optional assignee and due date. They carry no
status pipeline.

```bash
# One
flowcurl -X POST $FLOW/api/tasks/tk_ghi789/subtasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"Write the regression test","assigneeId":"us_alice"}'

# A batch (up to 100) — the form agents usually want
flowcurl -X POST $FLOW/api/tasks/tk_ghi789/subtasks \
  -H 'Content-Type: application/json' \
  -d '{"subtasks":[{"title":"Reproduce"},{"title":"Patch"},{"title":"Verify"}]}'

flowcurl -X PATCH $FLOW/api/subtasks/sb_jkl012 \
  -H 'Content-Type: application/json' -d '{"done":true}'

flowcurl -X DELETE $FLOW/api/subtasks/sb_jkl012
```

### Comments

Markdown bodies, plain strings over the wire.

```bash
flowcurl $FLOW/api/tasks/tk_ghi789/comments

flowcurl -X POST $FLOW/api/tasks/tk_ghi789/comments \
  -H 'Content-Type: application/json' \
  -d '{"body":"Reproduced on **iOS 17.4**. Patch in `#4192`."}'

flowcurl -X DELETE $FLOW/api/comments/cm_mno345
```

### Attachments

The upload body is the raw file bytes, streamed straight into R2 — nothing is
buffered in the Worker, so a 100 MB file does not go near the memory limit. R2
lands first and the metadata row second: a stray object is harmless garbage,
whereas a metadata row pointing at a missing object is a broken link, and a
failed metadata write cleans its object up.

`Content-Length` is required, and 100 MB (`104857600` bytes) is a hard cap.
The filename comes from `?filename=` or `X-Filename`, and is sanitised before it
reaches the R2 key `at/<taskId>/<attachmentId>/<filename>`.

```bash
flowcurl -X POST "$FLOW/api/tasks/tk_ghi789/attachments?filename=screenshot.png" \
  -H 'Content-Type: image/png' \
  --data-binary @screenshot.png
# {"id":"att_...","taskId":"tk_ghi789","filename":"screenshot.png","size":48210,...}

flowcurl $FLOW/api/tasks/tk_ghi789/attachments

# Download — streamed back with the stored content type. Supports Range and ETag.
# Task-scoped form; works against every DO read that exists today.
flowcurl -o screenshot.png $FLOW/api/tasks/tk_ghi789/attachments/at_pqr678
flowcurl -H 'Range: bytes=0-1023' $FLOW/api/tasks/tk_ghi789/attachments/at_pqr678
# 206, Content-Range: bytes 0-1023/48210

# By id alone. Equivalent.
flowcurl -o screenshot.png $FLOW/api/attachments/at_pqr678

flowcurl -X DELETE $FLOW/api/attachments/at_pqr678
```

Every download response carries `Accept-Ranges: bytes`. A single `bytes=` range
— closed (`0-99`), open-ended (`500-`) or suffix (`-100`) — comes back as a
**206** with `Content-Range` derived from what R2 actually returned; an end past
the last byte clamps rather than failing. A start at or past the end of the
object is a **416** with `Content-Range: bytes */<size>`. Multi-range requests
and non-`bytes` units are answered with the whole object (200), which is always
a valid response to a Range request. `If-None-Match` still short-circuits to a
304 before any of that.

### Automations

Reads are open to members; writes need owner or admin. Rules ship **disabled** —
`enabled` defaults to false; flip it once you have verified the rule does what
you expect.

```bash
flowcurl $FLOW/api/automations
flowcurl $FLOW/api/automations/ar_stu901

flowcurl -X POST $FLOW/api/automations \
  -H 'Content-Type: application/json' \
  -d '{"name":"Notify on urgent bugs",
       "enabled":false,
       "scope":{"kind":"list","listId":"ls_def456"},
       "trigger":{"kind":"status_changed","to":["Triage"]},
       "conditions":[{"kind":"priority_is","priorities":["urgent"]}],
       "actions":[
         {"kind":"set_assignee","userId":"us_alice"},
         {"kind":"send_email","to":["{{task.assignee}}"],
          "subject":"Urgent: {{task.title}}",
          "body":"{{task.description}}\n\n{{task.url}}"}]}'

# PATCH is an upsert against the path id.
flowcurl -X PATCH $FLOW/api/automations/ar_stu901 \
  -H 'Content-Type: application/json' \
  -d '{"name":"Notify on urgent bugs","enabled":true,
       "scope":{"kind":"list","listId":"ls_def456"},
       "trigger":{"kind":"status_changed","to":["Triage"]},
       "actions":[{"kind":"add_tags","tags":["triaged"]}]}'

flowcurl -X DELETE $FLOW/api/automations/ar_stu901
```

Side effects (`call_webhook`, `send_email`) are enqueued, never run inline, and
email honours `EMAIL_DRY_RUN` (default `"true"`: log, don't send).

#### Run log

Every firing writes one `automation_runs` row with a result per action. Reads
are open to members; both routes page newest-first with a keyset `cursor`, which
you pass back as `?before=`.

```bash
# Recent firings across every rule
flowcurl "$FLOW/api/automation-runs?limit=50"
flowcurl "$FLOW/api/automation-runs?limit=50&before=41800"   # next page
flowcurl "$FLOW/api/automation-runs?taskId=tk_ghi789"        # why did THIS task change

# One rule's history
flowcurl "$FLOW/api/automations/ar_stu901/runs?limit=20"
# {"ruleId":"ar_stu901","ruleName":"Notify on urgent bugs",
#  "runs":[{"id":41823,"ruleId":"ar_stu901","taskId":"tk_ghi789",
#           "trigger":"status_changed","depth":0,"at":1784999999000,
#           "results":[{"action":"set_assignee","ok":true,"dryRun":false,
#                       "detail":"assignee -> us_alice"},
#                      {"action":"send_email","ok":true,"dryRun":true,
#                       "detail":"queued to alice@… (EMAIL_DRY_RUN)"}]}],
#  "cursor":41800}
```

`results[].dryRun` is the only place a suppressed `EMAIL_DRY_RUN` send shows up,
and `ok:false` with a `detail` is where a failed action explains itself — an
automation never fails the mutation that triggered it, so this log is the only
signal. A run at the depth cap is logged too, as a single `"action":"*"` result.

Mutations applied by a rule are also attributed in the audit log: those rows
carry `via:"automation"` and `automationRuleId`, with `userId` still naming
whoever tripped the trigger.

### Notification preferences

Per-user email notifications are **system** notifications — always-on per the
recipient's preferences, distinct from automation rules. They fire inside the
mutation turn after a change commits and reuse the same `SIDE_EFFECTS` email
path, so `EMAIL_DRY_RUN` (default `true`) suppresses the actual send exactly as
it does for automations. You are never emailed about your own action, and the
import path (which emits no deltas) never triggers them.

Events, as per-user booleans:

- `assigned_to_me` (default **on**) — a task's assignee becomes you.
- `comment_on_my_task` (default **on**) — someone comments on a task you're
  assigned to or created.
- `status_change_on_my_task` (default **off**, to avoid noise) — such a task
  changes status.
- `mention` (default **on**) — reserved; mentions aren't parsed yet, so nothing
  emits it today.

Both routes are **self only**: they act on the calling user's own prefs, there
is no userId in the path, and there is no way to read or change another user's.
A missing stored row means "defaults", so a first `GET` returns the defaults
without a prior write. `email` is the address derived from your user record
(`null`, and unmailable, for an import placeholder). `PUT` accepts any subset of
the booleans and returns the full merged set.

```bash
flowcurl $FLOW/api/notifications/prefs
# {"userId":"us_alice","email":"alice@example.com",
#  "prefs":{"assigned_to_me":true,"comment_on_my_task":true,
#           "status_change_on_my_task":false,"mention":true}}

flowcurl -X PUT $FLOW/api/notifications/prefs \
  -H 'Content-Type: application/json' \
  -d '{"status_change_on_my_task":true,"comment_on_my_task":false}'
# returns the full merged prefs set
```

### Audit

```bash
flowcurl "$FLOW/api/audit?limit=50"
flowcurl "$FLOW/api/audit?apiKeyId=ak_vwx234"      # what did this key do
flowcurl "$FLOW/api/audit?userId=us_alice&action=task.update"
flowcurl "$FLOW/api/audit?entity=tk_ghi789"        # full history of one task
flowcurl "$FLOW/api/audit?after=1784000000000&before=1785000000000"
# {"entries":[{"id":41823,"actor":{"userId":"us_alice","via":"mcp","apiKeyId":"ak_vwx234",
#              "automationRuleId":null},"action":"task.update","entity":"tk_ghi789",
#              "diff":{"statusId":"st_done"},"at":1784999999000}],
#  "cursor":41800}
```

Page by passing the returned `cursor` back as `before`, until it is `null`.

`apiKeyId` is the reason the trail exists: a key impersonates a user, so the
user id alone cannot tell you whether a change came from a human or an agent.
`entity` and `before` are filtered inside the DO; `apiKeyId`, `userId`, `action`
and `after` are applied in the Worker over paged DO reads, so the page you get
back is correctly sized either way.

### API keys

Self-serve. A key that acts as *you* grants an agent exactly the access you
already have, so any member can mint one; a key that impersonates somebody else
is an escalation and stays owner/admin.

| Route | Member | Owner / admin |
|---|---|---|
| `POST /api/api-keys` | Allowed when `userId` is absent or their own id; 403 otherwise. | Any `userId`. |
| `GET /api/api-keys` | Only keys whose `userId` is their own. | Every key. |
| `DELETE /api/api-keys/:id` | Only keys whose `userId` is their own; 403 otherwise. | Any key. |

```bash
# Create. The token is in this response and NOWHERE else, ever.
# Omit userId and the key acts as you — that is the self-serve agent path.
flowcurl -X POST $FLOW/api/api-keys \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-agent"}'
# {"apiKey":{"id":"ak_vwx234","name":"my-agent","userId":"us_alice",...},
#  "token":"flow_Yk3...", "impersonates":{...},
#  "warning":"This token is shown only once and cannot be recovered."}

# Owner/admin only: mint a key that acts as someone else.
flowcurl -X POST $FLOW/api/api-keys \
  -H 'Content-Type: application/json' \
  -d '{"name":"claude-mcp","userId":"us_someone"}'

# List — hashes only, plus an 8-char fingerprint for matching against logs.
# A member sees only their own keys here.
flowcurl $FLOW/api/api-keys

# Revoke. The key is looked up first: an unknown id is a 404, and a key
# belonging to another user is a 403 with a sentence saying so.
flowcurl -X DELETE $FLOW/api/api-keys/ak_vwx234
```

`userId` defaults to the caller. The token is `flow_` + base64url of 32
CSPRNG bytes; only its sha256 is stored.

### Inbound webhooks

See [Gleap setup](#gleap-setup) below.

```bash
curl -sS -X POST "$FLOW/api/inbound/ls_def456" \
  -H "Authorization: Bearer inb_xxxxxxxx" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Login broken","description":"500 on submit","externalId":"gleap-88"}'
```

### Import

Admin-only, and used by `apps/importer` during the ClickUp migration.
`POST /api/import/batch` upserts by id-then-clickupId inside the DO, firing no
automations and no per-row deltas, so re-running a load is safe. Import is
deliberately more lenient than the interactive API: a title over the 500-char
cap is truncated to 2000 characters rather than rejected, because a migration
must not drop history.

`POST /api/import/attachments` has the Worker fetch `sourceUrl` and stream it
into R2. Because that makes the Worker issue a request on the caller's behalf,
`sourceUrl` must be **https** on a host ending in `.clickup.com` or
`.clickup-attachments.com`; anything else is a 400 naming the allowlist. The
filename is sanitised before it reaches the R2 key, exactly as on the
interactive upload path.

### MCP

See [MCP](#mcp-1) below.

### WebSocket

`GET /ws` authenticates and then hands the upgrade straight through to the DO —
the Worker does not terminate the socket, so the DO can use hibernation and
broadcast deltas without an extra hop. The resolved user id is passed as
`X-Flow-User-Id` (any client-supplied copy is stripped first), and the DO keeps
it on the connection: the hello snapshot, the replay and every subsequent
broadcast are filtered against that user's per-space permissions, so a delta
from a private space never reaches a socket that may not see it.

```bash
websocat "wss://flow.example.com/ws" -H "Authorization: Bearer $TOKEN"
> {"type":"hello","sinceSeq":null}      # null => server replies with a snapshot
> {"type":"hello","sinceSeq":41823}     # replay from a seq; "resync" if the gap is too big
> {"type":"ping"}
```

---

## Gleap setup

Point Gleap's outbound webhook at the target list:

```
POST https://flow.example.com/api/inbound/<listId>
Authorization: Bearer <that list's inboundToken>
Content-Type: application/json
```

Get `<listId>` and a fresh token from
`PATCH /api/lists/<listId> {"inboundToken":"rotate"}`, which returns both the
token and the exact URL. If Gleap's webhook configuration will not let you add a
header, the token is also accepted as a query param, which makes the whole
configuration a single pasteable URL:

```
https://flow.example.com/api/inbound/ls_def456?token=inb_xxxxxxxx
```

A per-list token rather than a workspace api key means a leaked Gleap credential
can only create tasks in that one list, and rotating it is one PATCH.

**Body mapping.** The route tries `InboundTaskInput` first. Anything else goes
through the best-effort mapper in `src/gleap.ts`, which:

- takes the **title** from `title`, `subject`, `name`, `summary` or `headline`,
  checking the top level and the nested `data`/`payload`/`formData` objects
  (Gleap puts the real content under `data`). No title at all falls back to the
  first line of the description, then to `"Untitled Gleap report"` — an unnamed
  report is still worth capturing.
- takes the **description** from `description`, `message`, `text`, `body`,
  `content`, `comment` or `details`.
- takes **externalUrl** from any key ending in `url`/`link`/`href` whose value
  parses as an http(s) URL — `shareURL`, `dashboardURL` and friends — and links
  it in the body as `[View in Gleap](…)`.
- tags the task `gleap` plus the report `type` (`bug`, `crash`, …) and any
  `tags`/`labels` array.
- appends **every remaining field** as a key-sorted fenced JSON block, so the
  session, device, reporter and custom form data survive verbatim. Nothing from
  the report is silently dropped.
- deliberately does **not** map a status: Gleap's own state vocabulary has
  nothing to do with the target list's statuses, and guessing would fail the
  create. Inbound tasks land in the list's open status.

**Idempotency.** `externalId` (or `shareToken`/`bugId`/`ticketId`/`id`) is
recorded as an `ext:<externalId>` tag. A repeat delivery returns the existing
task with `200 {"created":false,"deduplicatedBy":"…"}` instead of creating a
duplicate — which matters, because Gleap retries on any non-2xx. The `task` in
that response is the same full Task shape the 201 carries, so a sender does not
have to branch on whether its delivery was the first.

**Attribution.** Inbound tasks are created as the user behind the api key named
`gleap` (or `gleap-inbound`), falling back to `OWNER_EMAIL`'s user, with
`via: "webhook"` in the audit trail.

---

## MCP

```
https://flow.example.com/mcp
Authorization: Bearer flow_<key>
```

One streamable-HTTP endpoint, authenticated with the same `flow_` api key as
everything else — the key impersonates a real user, so tasks an agent files show
up as that person's work with the key id beside them in the audit trail. Mint one
with `POST /api/api-keys` (any member can mint one that acts as themselves), then:

```bash
claude mcp add --transport http flow https://flow.example.com/mcp \
  --header "Authorization: Bearer flow_..."
```

The equivalent JSON, for clients configured by file rather than by CLI:

```json
{
  "mcpServers": {
    "flow": {
      "type": "http",
      "url": "https://flow.example.com/mcp",
      "headers": { "Authorization": "Bearer flow_..." }
    }
  }
}
```

By hand — note that the streamable-HTTP spec requires the client to accept both
content types on every POST, so a request without the `Accept` header gets a 406:

```bash
flowcurl -X POST $FLOW/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Tools

Fifteen, named in `MCP_TOOLS` in `@flow/shared` — the list is asserted at server
construction, so a name that drifts from the contract fails loudly instead of
quietly disappearing from `tools/list`.

| Tool | What it does |
|---|---|
| `flow_get_workspace_map` | Spaces, lists, each list's valid status names, members, tags in use. The orientation call. |
| `flow_search_tasks` | FTS over title + description plus every filter `SearchTasksInput` defines; pages by `cursor`. |
| `flow_get_task` | One task in full, with its subtasks, comments and attachments. |
| `flow_list_my_work` | Your open tasks (or `assigneeId`'s), grouped `overdue` / `today` / `thisWeek` / `later` / `noDate`. |
| `flow_create_task` | One task, optionally with inline subtasks. |
| `flow_update_task` | Change fields on one task; absent leaves alone, `null` clears. |
| `flow_move_task` | Another list and/or status, with an optional fractional position. |
| `flow_bulk_create_tasks` | Up to 200 creates, one ok/error result per item. |
| `flow_bulk_update_tasks` | Up to 200 updates, one ok/error result per `taskId`. |
| `flow_create_subtasks` | Up to 100 subtasks under one parent. |
| `flow_toggle_subtask` | Done / not done. |
| `flow_comment_on_task` | A markdown comment, authored as the key's user. |
| `flow_list_automations` | Rules with their triggers, conditions and actions. |
| `flow_upsert_automation` | Create or replace a rule. Owner/admin only, same as the REST route. |
| `flow_get_audit_log` | Who changed what, filterable and pageable. |

Every mutation calls the same DO RPC method the matching REST route calls, so a
task created over MCP fires exactly the automations a task created in the UI
does. There is no separate MCP write path to keep in sync.

### Conventions the tools follow

- **Statuses are names, never ids.** `"In Progress"`, matched
  case-insensitively within the task's own list. `flow_get_workspace_map` is how
  an agent learns the valid ones, and results come back carrying status, list,
  space and assignee *names* so a second lookup is never needed to read them.
- **Timestamps are epoch milliseconds**, as everywhere else in the API.
- **Errors are the DO's own sentence**, returned as an MCP tool error rather
  than a protocol failure: `Unknown status "Blocked" for list ls_x. Valid
  statuses (in order): "To Do" (open), "In Progress" (custom), "Done"
  (closed).` That is what lets an agent fix its own call instead of retrying it
  blind. Stacks are never returned.
- **Batches report per item.** One bad entry in a bulk call never loses the
  other 199.
- **Paging is one convention.** Every pageable tool — `flow_search_tasks`,
  `flow_list_my_work`, `flow_get_audit_log` — takes `cursor` and returns
  `cursor`, `null` once the result set is exhausted. The value is opaque: hand
  it back unchanged. `flow_get_audit_log` still accepts `before`, the older name
  for the same keyset value, so anything already paging by it keeps working;
  `cursor` wins if both are sent.
- **Nothing deletes.** There is no MCP tool that removes a task, subtask,
  comment or automation rule, deliberately — an agent that can file work cannot
  quietly unfile it. Closing a task means moving it to its list's closed status
  *by name*.

### Response budgets

Reads default to the smaller answer, because context spent on fields an agent
did not ask for is context it does not have for the work.

| Tool | Concise (default) | `format: "detailed"` |
|---|---|---|
| `flow_search_tasks` | `id, title, status, list, assignee, dueDate, priority` per row | adds `listId`, `space`, `assigneeId`, `tags`, `updatedAt` |
| `flow_list_my_work` | same rows, 50 of them, `cursor` for the rest | the full row shape |
| `flow_get_task` | the 15 newest comments, plus `commentsOmitted` and a note | the whole thread |
| `flow_get_workspace_map` | ids, names, status names, members as `{id, name}` | adds per-list `openTasks` and member emails and roles |

`flow_get_workspace_map` also has `includeTags`, **off by default**: distinct
tags in use can only be derived by scanning every task row, and it is the one
part of the map that is not cheap. Ask for it when you need to match an existing
tag, not as a matter of routine.

### Annotations and structured output

Every tool carries an explicit `annotations` block — a *missing* hint reads as
"unknown", not as "safe", so a client deciding whether to auto-approve a call has
to assume the worst of an unannotated tool. The six reads are `readOnlyHint:
true`; the writes are `readOnlyHint: false, destructiveHint: false`, with
`idempotentHint: true` on the four that set a value rather than append one
(`flow_update_task`, `flow_move_task`, `flow_toggle_subtask`,
`flow_upsert_automation`). `flow_upsert_automation` is additionally
`destructiveHint: true`: passing an existing `id` replaces that rule wholesale
rather than patching it. `openWorldHint` is `false` everywhere — every tool talks
to the one workspace DO and nothing else.

Every tool also declares an `outputSchema` (`mcp/schemas-out.ts`) and returns
`structuredContent` alongside the serialized text block, so a client can read a
typed result instead of re-parsing JSON out of a string. The SDK validates that
payload against the declared schema on every call, which makes a view function
that drifts from its declared shape a test failure rather than a surprise on the
wire. Tool *errors* are exempt from that validation and still come back as
`isError` with the DO's sentence.

### Transport

Stateless streamable HTTP. A fresh `McpServer` and transport are built per
request — required by the MCP SDK from 1.26 on, and here it is also what keeps
one caller's tools from closing over another caller's identity. No session id is
issued or checked, and there is no MCP state anywhere, which is what lets any
isolate serve any request without a Durable Object of its own.

`POST` carries all JSON-RPC traffic. `GET` and `DELETE` return **405**: a `GET`
would open the spec's optional server-to-client SSE stream, which a stateless
server never writes to and which would sit open against the Worker's request
timeout, and `DELETE` only ends a session, of which there are none.

---

## Configuration

The deploy config is not committed: copy `wrangler.example.jsonc` to
`wrangler.jsonc` (which is gitignored) and fill in your own hostname, route and
Access values before deploying.

```bash
cd apps/api
cp wrangler.example.jsonc wrangler.jsonc
# edit wrangler.jsonc: routes, APP_HOSTNAME, ACCESS_TEAM_DOMAIN, ACCESS_AUD, OWNER_EMAIL
```

`wrangler.jsonc` vars:

| Var | Purpose |
|---|---|
| `EMAIL_DRY_RUN` | `"true"` (default) makes `send_email` actions log instead of send. |
| `APP_HOSTNAME` | Public hostname; used in webhook envelopes and inbound URLs. |
| `ACCESS_TEAM_DOMAIN` | Your Access team domain (`your-team.cloudflareaccess.com`); the JWKS host. |
| `ACCESS_AUD` | AUD tag of the Access application protecting the app — copy it from the app's settings in the Zero Trust dashboard. |
| `OWNER_EMAIL` | Fallback identity for dev auth and for inbound with no `gleap` key. |
| `EMAIL_FROM` | Sender address for outbound email; must be sendable under your Email Sending setup. |
| `EMAIL_FROM_NAME` | Sender display name for outbound email. |
| `DEV_NO_AUTH` | Not set in `wrangler.jsonc`. `"true"` in `.dev.vars` only. |

Bindings: `WORKSPACE` (DO), `ATTACHMENTS` (R2), `SIDE_EFFECTS` (Queue),
`ASSETS` (SPA).

---

## Layout

```
src/
  index.ts            mounts everything; queue handler; error + 404 handlers
  env.ts              Env, AppEnv, AuthContext, WORKSPACE_NAME, WS_USER_HEADER
  auth.ts             the two auth paths, role gates, inbound actor resolution
  access-jwt.ts       Access JWT verification, JWKS fetch + cache
  tokens.ts           token minting, sha256 hashing, bearer parsing  (pure)
  gleap.ts            inbound payload mapper                        (pure)
  do.ts               WorkspaceApi — the RPC surface + the typed stub accessor
  errors.ts           ApiError, Zod issue flattening, {error} responses
  routes/             me, spaces, lists, tasks, attachments,
                      automations, audit, api-keys, inbound, ws
  mcp/index.ts        the /mcp handler: server + transport per request
  mcp/tools.ts        the 15 tools, each a wrapper over one DO RPC call
  mcp/schemas.ts      tool inputs, built from the shared contract schemas
  mcp/schemas-out.ts  tool outputSchemas; views.ts infers its types from these
  mcp/context.ts      per-request identity + memoised id -> name index
  mcp/views.ts        result shaping — ids to names                   (pure)
  mcp/work.ts         due-date bucketing for flow_list_my_work        (pure)
  side-effects/       owned by the automations agent
```

`src/do.ts` is worth reading first if you are touching the DO: it is the full
list of RPC methods this Worker calls, typed, in one place, plus the few lookups
composed in the Worker because the DO has no single-purpose method for them
(user by email/id, api key by name, task by external id, the extra audit
filters). Those are one RPC each over small collections; if the workspace ever
outgrows that, they become DO methods and no call site here changes.

## Tests

```bash
pnpm --filter @flow/api test
pnpm --filter @flow/api typecheck
```

Coverage is the pure logic — the Gleap mapper (`gleap.test.ts`), token hashing
plus Access claim validation (`tokens.test.ts`), and the MCP layer's tool input
schemas, due-date bucketing and name resolution (`mcp/schemas.test.ts`,
`mcp/work.test.ts`). REST route handlers are thin wrappers over DO RPC and are
covered by the DO's own tests.

`mcp/server.test.ts` goes over the JSON-RPC wire with the DO stubbed, which is
what catches the failures schema unit tests cannot: a Zod shape that will not
convert to JSON Schema, a tool name that drifts from `MCP_TOOLS`, a handshake
the SDK rejects, an error that reaches the caller as a stack, or a mutation
audited as anything other than `via: "mcp"`.
