# Flow

A fast, minimal, agent-first task manager (self-hosted ClickUp/Asana
replacement). Everything runs on Cloudflare: one Worker (`apps/api`) serving
the SPA, REST, MCP at `/mcp`, and WebSockets at `/ws`; one Durable Object
(`packages/core`) holding the entire workspace in SQLite; R2 for attachments;
Queues for outbound side effects. Full agent contract: `AGENTS.md`.

## Ground rules

- **`packages/shared` is the contract.** All entity shapes, mutation inputs,
  delta events, WS protocol, `LIMITS`, and MCP tool names live there as Zod
  schemas with inferred types. Import from it; never redeclare its types. If
  the contract must change, make the smallest compatible change and flag it
  prominently.
- One workspace, one DO instance. **The DO is the only writer**; REST/MCP
  handlers call its RPC methods (`WorkspaceRpc`) and never touch SQL.
- Every mutation appends a Delta with a monotonic seq; WS clients receive
  patches and replay on reconnect. **Never build a "refetch the board" path.**
- Automations evaluate inline in the DO mutation turn (depth cap 5). Outbound
  side effects (webhook/email) go through the `SIDE_EFFECTS` queue, never
  inline. Email respects `EMAIL_DRY_RUN` (default true): log, don't send.
- Subtasks are Asana-style: done/not-done + optional assignee/dueDate. They do
  NOT have statuses.
- API keys (`flow_` bearer tokens) impersonate a real user; the audit trail
  records the key id.
- TypeScript strict everywhere. pnpm workspaces. No new runtime deps without a
  strong reason (allowed: hono, zod, preact, @preact/signals, the MCP SDK, or
  similarly tiny libraries).
- UI: clean, minimal, Linear-ish. Tailwind v4. Fast: optimistic mutations,
  CSS transforms for drag, no full-board re-renders.
- Never commit secrets or real config values; placeholders only
  (`flow.example.com`, `you@example.com`). Local values go in
  `apps/api/.dev.vars`.

## Layout

- `packages/shared` — the Zod contract (depends only on zod)
- `packages/core` — Workspace Durable Object + automation engine; most tests
- `apps/api` — Hono Worker: auth, routes, MCP, WS, queue consumer, wrangler.jsonc
- `apps/web` — Preact + @preact/signals + Tailwind v4 SPA; store in `src/store`
- `apps/importer` — local-only ClickUp ETL (tsx, never deployed)

## Commands

- `pnpm install` at repo root
- `pnpm typecheck` — all packages must pass before you report done
- `pnpm -r test` — vitest across core, api, importer
- `pnpm --filter @flow/web build` — SPA must build
- `pnpm dev` — local Worker on :8787; `pnpm dev:web` — Vite on :5173
  (proxies /api and /ws)
- `pnpm --filter @flow/api exec wrangler deploy --dry-run` — after any
  apps/api change; validates bundling/bindings without deploying. Never run a
  real `wrangler deploy` unless the user explicitly asks.
