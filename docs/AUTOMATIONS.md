# Automations

An automation rule is `trigger → conditions (AND) → actions (in order)`, scoped to one list or one whole space. Rules evaluate **inline in the Durable Object mutation turn** — the same turn that committed the change that tripped them — so their effects land in the same delta broadcast the client receives, and a task never flickers through an intermediate state. Outbound side effects (webhooks, email) are the exception: they're enqueued, never awaited inline, because a slow endpoint must not be able to slow a mutation.

The vocabulary lives in `packages/shared/src/automations.ts`; the engine in `packages/core/src/automation/`. The rule shape:

```json
{
  "name": "Notify on urgent bugs",
  "enabled": false,
  "scope": { "kind": "list", "listId": "ls_..." },
  "trigger": { "kind": "status_changed", "to": ["Triage"] },
  "conditions": [ { "kind": "priority_is", "priorities": ["urgent"] } ],
  "actions": [
    { "kind": "set_assignee", "userId": "us_..." },
    { "kind": "send_email", "to": ["{{task.assignee}}"],
      "subject": "Urgent: {{task.title}}",
      "body": "{{task.description}}\n\n{{task.url}}" }
  ]
}
```

Scope is `{"kind":"list","listId":...}` or `{"kind":"space","spaceId":...}` (all the space's lists). Rules ship `enabled: false` by default — you flip them on deliberately, one at a time, ideally with `EMAIL_DRY_RUN` still on.

## Triggers

| Trigger | Fires when | Parameters |
|---|---|---|
| `task_created` | A task is created in scope. | — |
| `status_changed` | A task's status changes. | `from` / `to`: arrays of status **names** (case-insensitive); empty or omitted means "any". Names, not ids, so one rule applies across lists sharing a status vocabulary. |
| `tag_added` | One of the named tags is added to a task. | `tags` (min 1) |
| `assignee_changed` | The assignee changes. | optional `toUserId` to fire only when it becomes that user |
| `all_subtasks_done` | The last open subtask on a task is checked off. | — |
| `due_date_approaching` | A task's due date is `daysBefore` days away. | `daysBefore` (0–60) |

`due_date_approaching` is the one trigger not driven by a mutation: a DO alarm sweep (`packages/core/src/automation/schedule.ts`) evaluates it on schedule, with a fired-set so the same rule doesn't re-fire for the same task every day.

## Conditions

All conditions must hold (AND). Each matches against the task **after** the triggering mutation:

| Condition | Holds when |
|---|---|
| `status_is` | The task's status name is one of `names`. |
| `has_tag` | The task carries one of `tags`. |
| `assignee_is` | The assignee is one of `userIds`. |
| `priority_is` | The priority is one of `priorities` (`urgent`/`high`/`normal`/`low`). |

## Actions

Actions run in order. The first six mutate the task **in the same turn**; the last two enqueue outbound I/O.

| Action | Effect | Parameters |
|---|---|---|
| `set_status` | Move the task to a status, by name. | `statusName` |
| `set_assignee` | Assign (or `null` to unassign). | `userId` |
| `set_priority` | Set priority (or `null` to clear). | `priority` |
| `add_tags` | Merge tags in, case-insensitively deduplicated; a no-op change emits nothing. | `tags` |
| `create_subtask` | Add a checklist step. | `title` (template), `assigneeId`, `dueInDays` (due date = now + n days) |
| `move_to_list` | Move the task to another list. | `listId` |
| `call_webhook` | Enqueue a POST of the standard event envelope + full task snapshot; optional HMAC-SHA256 signature in `X-Flow-Signature`. See [AGENTS_AND_MCP.md](AGENTS_AND_MCP.md#outbound-webhooks-hmac-signed). | `url`, `secret` |
| `send_email` | Enqueue an email; markdown body rendered to HTML. Subject and body are templates; `to` accepts addresses or `"{{task.assignee}}"`. | `to`, `subject`, `body` |

### Template strings

`create_subtask` titles and `send_email` subjects/bodies support:

```
{{task.title}}  {{task.status}}  {{task.url}}  {{task.assignee}}
{{task.dueDate}}  {{task.description}}  {{list.name}}  {{space.name}}
```

`{{task.url}}` is built from `APP_HOSTNAME`, so emailed links land on your deployment.

## The depth cap

Automation-applied mutations produce deltas, and those deltas are evaluated against the rules too — that's what lets "when status becomes Review, assign reviewer" and "when assignee changes, email them" compose without either rule knowing about the other. The cost of that composability is the possibility of loops, and the engine holds three lines against them:

1. Every automation-produced delta is stamped with its **depth**; an action at depth > `AUTOMATION_MAX_DEPTH` (5) is not applied, and the run log gets an explicit "depth cap" entry instead of the chain silently vanishing.
2. A hard fan-out cap of 5,000 evaluated deltas per turn backstops rule sets that explode wide rather than deep.
3. A rule that throws — bad status name, deleted target list, anything — is logged and **never fails the user's mutation**. The mutation that tripped the rule always commits.

Attribution stays honest through the chain: audit rows written under a rule carry `via: "automation"` and the `automationRuleId`, while `userId` still names whoever tripped the trigger.

## The run log

Every firing writes one `automation_runs` row with a result per action — and because a rule can never fail its triggering mutation, this log is the **only** failure signal an automation has. Read it via:

```bash
FLOW=https://flow.example.com
AUTH='Authorization: Bearer flow_...'

curl -sS -H "$AUTH" "$FLOW/api/automation-runs?limit=50"          # recent, all rules
curl -sS -H "$AUTH" "$FLOW/api/automation-runs?taskId=tk_..."     # "why did THIS task change"
curl -sS -H "$AUTH" "$FLOW/api/automations/ar_.../runs?limit=20"  # one rule's history
```

Each run records the trigger, the depth, and per-action `{action, ok, dryRun, detail}`:

```json
{ "id": 41823, "ruleId": "ar_...", "taskId": "tk_...",
  "trigger": "status_changed", "depth": 0, "at": 1785000000000,
  "results": [
    { "action": "set_assignee", "ok": true,  "dryRun": false, "detail": "assignee -> us_..." },
    { "action": "send_email",   "ok": true,  "dryRun": true,  "detail": "queued (EMAIL_DRY_RUN)" }
  ] }
```

`ok: false` with a `detail` is a failed action explaining itself; `dryRun: true` is the only place a suppressed email shows up. Both routes page newest-first with a keyset cursor (`?before=`).

## The email dry-run gate

`EMAIL_DRY_RUN` (a wrangler var, default `"true"`) applies to **all** email — automation `send_email` actions and system notifications alike — at the queue consumer, so it's one switch with no way for a code path to forget it. While on, every would-be send logs its full rendered content (`wrangler tail` shows `[EMAIL_DRY_RUN] would send: ...`) and the run log records `dryRun: true`. The intended rollout: build your rules, watch the dry-run logs until they say exactly what you'd want sent, then flip the var and redeploy. With dry-run off, a missing `SEND_EMAIL` binding fails loudly and retries rather than silently dropping mail.

## Seeding rules

For a scripted setup (or a migration), `packages/core/src/automation/seeds.ts` shows the pattern: define rules as data with obvious placeholder ids (`ls_SEED_...`), then bind them to real ids once the workspace exists (`bindSeedScopes`), every rule `enabled: false` so nothing fires until a human flips it. You can achieve the same from outside via the API — `POST /api/automations` per rule, or `flow_upsert_automation` from an agent — since `PATCH /api/automations/:ruleId` is an upsert against the path id and therefore idempotent to re-run.

Two worked examples:

```bash
# When every subtask is done, move the card to Review and tell the webhook.
curl -sS -X POST "$FLOW/api/automations" -H "$AUTH" -H 'Content-Type: application/json' -d '{
  "name": "Subtasks done -> Review",
  "enabled": false,
  "scope": { "kind": "list", "listId": "ls_..." },
  "trigger": { "kind": "all_subtasks_done" },
  "conditions": [],
  "actions": [
    { "kind": "set_status", "statusName": "Review" },
    { "kind": "call_webhook", "url": "https://hooks.example.com/flow", "secret": "whsec_..." }
  ]}'

# Three days before due, add a checklist step and nag the assignee.
curl -sS -X POST "$FLOW/api/automations" -H "$AUTH" -H 'Content-Type: application/json' -d '{
  "name": "Due-date nag",
  "enabled": false,
  "scope": { "kind": "space", "spaceId": "sp_..." },
  "trigger": { "kind": "due_date_approaching", "daysBefore": 3 },
  "conditions": [ { "kind": "priority_is", "priorities": ["urgent", "high"] } ],
  "actions": [
    { "kind": "create_subtask", "title": "Confirm {{task.title}} is on track", "dueInDays": 1 },
    { "kind": "send_email", "to": ["{{task.assignee}}"],
      "subject": "Due soon: {{task.title}}",
      "body": "**{{task.title}}** in {{list.name}} is due soon.\n\n{{task.url}}" }
  ]}'
```

## Automations vs. system notifications

Don't build rules for what the system already does: assigned-to-me, comment-on-my-task, and status-change emails are **system notifications**, always on per each recipient's own preferences (`PUT /api/notifications/prefs`), fired after the automation drain so a rule-driven reassign also notifies, and never sent to the person who made the change. Automations are for workflow — routing, statuses, subtask checklists, webhooks to external systems — not for "tell me about my own tasks".
