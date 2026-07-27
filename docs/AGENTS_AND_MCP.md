# Agents and MCP

Flow treats agents as first-class users. There is no separate "integration" surface: an agent authenticates with an API key that impersonates a real user, calls the same Durable Object mutations the UI calls, fires the same automations, and shows up in the same audit trail — with the key id recorded beside every action so you can always tell the human from their agent.

## The MCP server

One streamable-HTTP endpoint, served by the same Worker as everything else:

```
https://flow.example.com/mcp
Authorization: Bearer flow_<token>
```

The transport is **stateless**: a fresh `McpServer` and transport are built per request (required by the MCP SDK from 1.26 on, and also what keeps one caller's tools from closing over another caller's identity), no session id is issued or checked, and `POST` carries all JSON-RPC traffic — `GET` and `DELETE` return 405, since a stateless server has no SSE stream to open and no session to end. That's what lets any Worker isolate serve any MCP request with no per-session Durable Object.

### Connecting clients

Mint a key first (`POST /api/api-keys`, or Settings → API Keys in the UI — any member can mint one that acts as themselves; the token is shown once).

**Claude Code:**

```bash
claude mcp add --transport http flow https://flow.example.com/mcp \
  --header "Authorization: Bearer flow_..."
```

**Claude Desktop / any client configured by JSON:**

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

**ChatGPT and other streamable-HTTP-compatible clients:** point the connector at `https://flow.example.com/mcp` with the same `Authorization: Bearer flow_...` header. Any client that speaks MCP streamable HTTP with a static bearer header works — there's no OAuth dance.

**By hand** (note the spec requires clients to accept both content types, so omit the `Accept` header and you get a 406):

```bash
curl -sS -X POST https://flow.example.com/mcp \
  -H "Authorization: Bearer flow_..." \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## The impersonation model

An API key belongs to a user. Everything done with that key **is that user acting** — tasks the agent files show as their work, comments carry their name, automations attribute triggers to them — with `via: "mcp"` (or `"api"`) and the `apiKeyId` in every audit row. This is deliberate: agents inherit exactly the permissions their human already has (including per-space visibility), so there is no second permission system to configure or get wrong.

The audit log is the accountability layer:

```bash
curl -sS "https://flow.example.com/api/audit?apiKeyId=ak_..." \
  -H "Authorization: Bearer flow_..."
```

answers "what did this agent do", separately from what the human did themselves. Revoking a key (`DELETE /api/api-keys/:id`) takes effect on the next request.

Members can mint, list, and revoke keys that act as themselves. Minting a key that impersonates *someone else* is an escalation and requires owner/admin.

## The 15 tools

Tool names are declared in `MCP_TOOLS` in `packages/shared/src/api.ts` and asserted at server construction, so a drifted name fails loudly instead of quietly vanishing from `tools/list`.

| Tool | What it does |
|---|---|
| `flow_get_workspace_map` | The orientation call: every space, list, each list's valid status **names**, and members. `includeTags` adds tags in use (a full task scan, off by default); `format: "detailed"` adds per-list open-task counts and member emails/roles. |
| `flow_search_tasks` | Full-text search over title + description, plus filters: `listId`, `spaceId`, `status` (array of names), `assigneeId`, `tags`, `dueBefore`/`dueAfter`/`updatedAfter` (epoch ms), `includeClosed`. Pages by `cursor`. |
| `flow_get_task` | One task in full: description, subtasks, comments, attachments. Concise mode returns the 15 newest comments and reports how many it dropped in `commentsOmitted`. |
| `flow_list_my_work` | Open tasks assigned to you (or `assigneeId`), grouped `overdue` / `today` / `thisWeek` / `later` / `noDate`. |
| `flow_create_task` | One task, optionally with inline subtasks. |
| `flow_update_task` | Change fields on one task: absent leaves alone, `null` clears. Includes snooze (`snoozedUntil`, `blockedNote`). |
| `flow_move_task` | Another list and/or status, optional fractional position. |
| `flow_bulk_create_tasks` | Up to 200 creates, one ok/error result per item. |
| `flow_bulk_update_tasks` | Up to 200 updates, one ok/error result per `taskId`. |
| `flow_create_subtasks` | Up to 100 subtasks under one parent. |
| `flow_toggle_subtask` | Done / not done. |
| `flow_comment_on_task` | A markdown comment, authored as the key's user. |
| `flow_list_automations` | Rules with their triggers, conditions, and actions. |
| `flow_upsert_automation` | Create or **replace** a rule (owner/admin, same as REST). |
| `flow_get_audit_log` | Who changed what, filterable and pageable. |

Every mutation calls the same DO RPC method the matching REST route calls — there is no separate MCP write path to keep in sync, and automations fire identically regardless of caller.

### Conventions the tools follow

- **Statuses are names, never ids.** `"In Progress"`, matched case-insensitively within the task's own list. Results also come back carrying status, list, space, and assignee *names*, so an agent never needs a second lookup to read them.
- **Timestamps are epoch milliseconds**, everywhere.
- **Errors are the DO's own sentence**, returned as a tool error rather than a protocol failure: `Unknown status "Blocked" for list ls_x. Valid statuses (in order): "To Do" (open), "In Progress" (custom), "Done" (closed).` That sentence is what lets an agent fix its call instead of retrying it blind. Stacks are never returned.
- **Batches report per item** — one bad entry in a bulk call never loses the other 199 — and the server instructions steer agents toward the bulk tools over loops.
- **Paging is one convention:** every pageable tool takes `cursor` and returns `cursor`, `null` when exhausted. The value is opaque; hand it back unchanged.
- **Nothing deletes.** There is no MCP tool that removes a task, subtask, comment, or rule — an agent that can file work cannot quietly unfile it. Deletion is a human action in the UI or REST. "Closing" a task means moving it to its list's closed status by name; there is no done flag on a task.

### Annotations and structured output

Every tool carries an explicit `annotations` block, because a *missing* hint reads as "unknown" — a client deciding whether to auto-approve has to assume the worst of an unannotated tool. The six reads are `readOnlyHint: true`; writes are `readOnlyHint: false, destructiveHint: false`, with `idempotentHint: true` on the ones that set a value rather than append one. `flow_upsert_automation` is the single `destructiveHint: true` tool: passing an existing `id` replaces the rule wholesale — trigger, conditions, and actions — so a partial payload silently drops what it omits. `openWorldHint` is `false` everywhere; every tool talks to the one workspace DO and nothing else.

Every tool also declares an `outputSchema` and returns `structuredContent` alongside the serialized text block, validated by the SDK on every call — so clients get typed results, and a view function that drifts from its declared shape is a test failure, not a wire surprise.

### Response budgets

Reads default to the smaller answer, because context an agent spends on fields it didn't ask for is context it doesn't have for the work. `format: "detailed"` opts into everything:

| Tool | Concise (default) | Detailed adds |
|---|---|---|
| `flow_search_tasks` | id, title, status, list, assignee, dueDate, priority | listId, space, assigneeId, tags, updatedAt |
| `flow_list_my_work` | same rows, 50 per page | the full row shape |
| `flow_get_task` | 15 newest comments + `commentsOmitted` count | the whole thread |
| `flow_get_workspace_map` | ids, names, status names, members as `{id, name}` | per-list `openTasks`, member emails and roles |

## The REST API

Everything MCP does (and the things it deliberately doesn't, like deletes) is also plain REST under `/api/*`, authenticated with the same `flow_` bearer. The full reference with curl examples is [API.md](API.md); the one-paragraph version: resources are `spaces`, `lists`, `tasks` (+ `search`, `bulk`, `move`), `subtasks`, `comments`, `attachments` (streamed to/from R2, Range and ETag supported), `automations` (+ run log), `notifications/prefs`, `audit`, `api-keys`, `import`, and `inbound`. Errors are always `{"error": "<one readable sentence>"}` with a real status code, and validation failures flatten every Zod issue into that one line because agents parse strings, not nested issue trees.

## Inbound webhooks (`inb_` tokens)

Each list can expose a per-list intake endpoint so external systems (bug reporters, form tools, other automation platforms) can create tasks without holding a workspace credential:

```
POST https://flow.example.com/api/inbound/<listId>
Authorization: Bearer inb_...        # or ?token=inb_... when the sender can't set headers
```

The token is the **list's own**, minted by `PATCH /api/lists/:listId {"inboundToken":"rotate"}` (shown once, with the exact URL to paste). Scope is the point: a leaked intake token can only create tasks in that one list, and rotation is a single PATCH.

The native body shape is `{title, description?, status?, tags?, externalId?, externalUrl?}`. Anything else goes through a best-effort mapper that hunts for title/description/URL fields in common webhook shapes and appends unrecognized fields as a fenced JSON block in the description, so nothing from the source system is silently dropped. `externalId` is the idempotency key — it's recorded as an `ext:<id>` tag, and a repeat delivery returns the existing task with `200 {"created": false}` instead of a duplicate, which matters because most senders retry on non-2xx.

Inbound tasks are created as the user behind an API key named `gleap` or `gleap-inbound` if one exists, falling back to `OWNER_EMAIL`'s user, with `via: "webhook"` in the audit trail.

## Outbound webhooks (HMAC-signed)

Outbound delivery is an automation action: a rule with `{"kind": "call_webhook", "url": "...", "secret": "..."}` fires whenever its trigger matches, and delivery happens through the queue — never inline in the mutation. The POST carries:

```
Content-Type: application/json
User-Agent: flow-automations/1
X-Flow-Event: task.status_changed          # the delta-derived event name
X-Flow-Rule: ar_...                        # which rule fired
X-Flow-Signature: <hex>                    # only when the rule has a secret
```

`X-Flow-Signature` is the lowercase-hex **HMAC-SHA256 of the exact request body** under the rule's secret. Verify it before trusting the payload:

```js
const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
```

The body is a `WebhookPayload`: `{event, delta, task, workspace}` — the same delta envelope WebSocket clients receive, plus a full task snapshot when the entity is a task, plus your hostname for multi-consumer routing. Delivery has a 7-second timeout, retries up to 5 times on non-2xx, then dead-letters.

## Automations via API

Agents can read and write automation rules directly — `flow_list_automations` / `flow_upsert_automation` over MCP, or `GET/POST/PATCH/DELETE /api/automations` over REST (writes need owner/admin). A rule an agent creates ships `enabled: false` by default, so a human flips it on after review. The full trigger/condition/action vocabulary is in [AUTOMATIONS.md](AUTOMATIONS.md).

One behavioral note the server's own instructions hammer on: automations evaluate inline inside every mutation, for agents exactly as for humans. So an agent should never hand-apply what a rule already does — make the change, then re-read the task to see where the rules left it, and use `GET /api/automation-runs?taskId=...` to answer "why did this task change".
