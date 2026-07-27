# Flow

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Agent-first project management you self-host on Cloudflare.** A drop-in replacement for the ClickUp/Asana/Linear slice most teams actually use — spaces, lists, boards, tasks, subtasks, comments, attachments, automations — built so that AI agents are first-class users, not an afterthought bolted onto a REST API.

One Cloudflare Worker serves the SPA, the REST API, an MCP server, and WebSockets. One Durable Object holds the entire workspace in SQLite. The Cloudflare free tier covers a small team: Workers, one DO, R2 for attachments, Queues for side effects. Your realistic monthly bill is $0–5, against $7–19 per seat per month for the SaaS tools it replaces.

## Why it exists

Task managers are slow, expensive per seat, and hostile to agents. Flow inverts all three:

- **Agent-first.** A built-in MCP server at `/mcp` exposes 15 tools with proper annotations and structured output. Every tool calls the same Durable Object RPC method the UI and REST routes call, so a task created by Claude fires exactly the automations a task created by a human does. API keys impersonate real users, and the audit trail records which key did what — you always know whether a change came from a person or their agent.
- **Fast in a way SaaS can't be.** The whole workspace lives in one Durable Object's SQLite, so reads are single-digit-millisecond, in-process queries — no network hop to a database. The client gets one snapshot, then applies deltas over a WebSocket forever; there is no "refetch the board" path anywhere in the codebase. Mutations are optimistic in the UI, and a localStorage boot cache paints the last known board before the bundle has even finished loading.
- **Yours.** Your tasks live in your Cloudflare account, in SQLite you can query, with an audit log of every mutation. No seat pricing, no data egress negotiation, no vendor deciding which API endpoints agents are allowed to use.

## Features

- **Boards** with per-list status pipelines (exactly one `open` status first, one `closed` last, custom statuses between), drag-and-drop with fractional positions, filters, and a command palette
- **Tasks** with markdown descriptions, single assignee, priority, due/start dates, tags, snooze ("waiting on…" with a wake time), and comments
- **Asana-style subtasks** — lightweight done/not-done checklist steps with optional assignee and due date, deliberately not miniature tasks with their own status pipeline
- **Real-time sync** — delta protocol with a monotonic `seq`, replay on reconnect, hibernating WebSockets so idle connections cost nothing
- **MCP server** — streamable HTTP at `/mcp`, 15 tools, structured output, per-tool annotations, error messages written so agents can self-correct
- **REST API** — the full surface, curl-friendly, with per-item results on bulk operations (up to 200 at a time)
- **Automations** — trigger → conditions → actions rules evaluated inline in the mutation turn (depth-capped at 5), with a per-run log; outbound webhooks (HMAC-signed) and email go through a queue
- **Email notifications** — assigned-to-me, comment-on-my-task, status changes, per-user preferences, sent via Cloudflare Email Sending with a dry-run gate that defaults to on
- **Inbound webhooks** — per-list `inb_` tokens so a bug tracker or form tool can create tasks in exactly one list, with idempotent delivery
- **Per-space visibility** — spaces are workspace-visible or private to a member list; snapshots, deltas, search results, and writes all enforce it
- **Audit log** — every mutation records who, via what (`ui`/`api`/`mcp`/`webhook`/`automation`/`import`), which API key, which automation rule, and the diff
- **ClickUp import** — a three-pass extract/transform/load pipeline with deterministic ids, so re-running is an upsert, not a duplicate workspace
- **Dark mode, keyboard layer, instant loads** — Preact + Signals SPA, ~no dependencies, boot cache, early WebSocket open from an inline script in `index.html`

## What it deliberately doesn't do

Flow replaces the slice of ClickUp a small team actually uses. The rest is left out on purpose, because each omission removes a permanent complexity tax:

- **No Gantt charts, timelines, or workload views.** Boards and a due-date-bucketed "My Work" view.
- **No time tracking.** Use a dedicated tool.
- **No custom fields.** Tags, priority, and dates cover the real cases; a custom-field engine would infect every query, form, and API shape.
- **No folders.** Spaces contain lists, full stop. The ClickUp importer collapses folders into list names (`"Folder / List"`).
- **No multi-assignee.** One assignee per task (in the reference migration only a couple of tasks had more than one).
- **No docs, whiteboards, chat, or goals.** It's a task manager.
- **One workspace per deployment.** The single-DO design trades multi-tenancy for speed and simplicity — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the honest limits.

## Architecture

```
                        ┌────────────────────────────────────────────────┐
  Cloudflare Access ──▶ │  Worker (Hono)                                 │
  (humans: SSO/OTP)     │   ├─ /            SPA (static assets)          │
                        │   ├─ /api/*       REST                        ─┼─┐
  Bearer flow_<token> ─▶│   ├─ /mcp         MCP server (streamable HTTP)─┼─┤
  (agents, scripts)     │   ├─ /ws          WebSocket upgrade ───────────┼─┤ RPC
                        │   └─ queue()      side-effects consumer        │ │
                        └───────┬──────────────────┬────────────────────-┘ │
                                │                  │                       ▼
                        ┌───────▼───────┐  ┌───────▼────────┐   ┌──────────────────────┐
                        │ R2            │  │ Queue          │   │ Workspace DO ("main")│
                        │ (attachments) │  │ (SIDE_EFFECTS: │   │  SQLite: all spaces, │
                        └───────────────┘  │  webhooks,     │   │  lists, tasks, seq   │
                                           │  email)        │   │  log, audit, rules   │
                                           └────────────────┘   │  + hibernating WS    │
                                                                └──────────────────────┘
```

Every mutation runs as one synchronous turn inside the DO: write rows, append one delta per entity change (monotonic `seq`), write an audit row, evaluate automations inline, then broadcast to sockets and enqueue outbound side effects. Full detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quickstart

Prerequisites: Node 20+, [pnpm](https://pnpm.io), a Cloudflare account, `wrangler` (installed as a dev dependency).

```bash
git clone https://github.com/joelborch/flow.git
cd flow
pnpm install
pnpm typecheck && pnpm test
```

Run it locally (auth bypassed via `.dev.vars`):

```bash
cp apps/api/wrangler.example.jsonc apps/api/wrangler.jsonc  # gitignored local config
cat > apps/api/.dev.vars <<'EOF'
DEV_NO_AUTH = "true"
EOF
pnpm --filter @flow/web dev    # Vite on :5173, proxies /api and /ws
pnpm --filter @flow/api dev    # Worker on :8787
```

First request signs you in as the seeded workspace owner (claimed by the `OWNER_EMAIL` in your config).

Deploy: create the R2 bucket and queues, copy `apps/api/wrangler.example.jsonc` to `apps/api/wrangler.jsonc` (gitignored) and edit it with your hostname and Cloudflare Access values, then:

```bash
cd apps/api
pnpm exec wrangler r2 bucket create flow-attachments
pnpm exec wrangler queues create flow-side-effects
pnpm exec wrangler queues create flow-dlq
pnpm deploy    # builds the SPA, deploys the Worker
```

The full runbook — custom domain, Cloudflare Access application setup, email sending, first-user bootstrap — is in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Connect an agent

Mint an API key (any member can mint one that acts as themselves), then:

```bash
claude mcp add --transport http flow https://flow.example.com/mcp \
  --header "Authorization: Bearer flow_..."
```

That's the whole integration. The agent gets workspace orientation, search, task CRUD, bulk operations, subtasks, comments, automations, and the audit log — with every action attributed to the key in the audit trail. Details, tool reference, and other clients in [docs/AGENTS_AND_MCP.md](docs/AGENTS_AND_MCP.md).

## Documentation

| Doc | What's in it |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The single-DO decision and its limits, the delta protocol, snapshot slimming, the automations engine, auth model, performance techniques |
| [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) | End-to-end deployment runbook: Cloudflare setup, Access, email, R2, Queues, bootstrap |
| [docs/AGENTS_AND_MCP.md](docs/AGENTS_AND_MCP.md) | MCP server, the 15 tools, API keys and impersonation, webhooks in and out |
| [docs/API.md](docs/API.md) | REST reference, every route with method, auth, and a curl example |
| [docs/AUTOMATIONS.md](docs/AUTOMATIONS.md) | The rule vocabulary: triggers, conditions, actions, templates, the run log |
| [docs/IMPORTING.md](docs/IMPORTING.md) | Migrating from ClickUp; where Asana/Trello extractors would go |
| [docs/COMPARISON.md](docs/COMPARISON.md) | Honest comparison vs ClickUp, Asana, Linear, and self-hosted options |

## Repository layout

```
apps/api        The Worker: Hono routes, MCP server, WebSocket handoff, queue consumer
apps/web        Preact + Signals SPA (Vite, Tailwind v4)
apps/importer   ClickUp → Flow migration CLI (extract / transform / load)
packages/shared The Zod contract: entities, mutation inputs, delta events, MCP tool names
packages/core   The Workspace Durable Object: SQLite schema, mutation turns, automations engine
```

`packages/shared` is the single source of truth for every shape that crosses a boundary. REST, MCP, the DO, and the web client all import from it; nothing redeclares its types.

## Contributing

PRs welcome. Ground rules: TypeScript strict everywhere, `pnpm typecheck` and `pnpm test` must pass, no new runtime dependencies without a strong reason (the whole app currently runs on hono, zod, preact, and @preact/signals), and contract changes go through `packages/shared`. Good first contributions: an Asana or Trello extractor for the importer ([docs/IMPORTING.md](docs/IMPORTING.md#future-work-asana-and-trello) shows exactly where it plugs in), and @-mention parsing (the notification preference already exists and is waiting for an emitter).

## License

[MIT](LICENSE)
