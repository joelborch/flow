# Changelog

## 0.2.0 (2026-10-20)

The first tagged release. It covers everything since the initial publish in July 2026. Migrations `core-0009` through `core-0014` run automatically the first time the Durable Object starts on the new code, and every new column is nullable or defaulted, so existing workspaces need no manual steps.

### Try it

- **Deploy to Cloudflare button.** The committed root `wrangler.jsonc` deploys Flow to a `*.workers.dev` address with its Durable Object, R2 bucket and queues. Until Cloudflare Access is set up, the app shows the remaining steps instead of failing, and the public `GET /api/setup` reports whether sign-in is configured.
- **Read-only demo build.** `pnpm build:demo` builds the SPA as a static site on sample data that needs no server, and `pnpm deploy:demo` hosts it as an assets-only Worker. `?embed` hides the demo badge.

### Added

- **Agent handoffs** (`core-0013`). One person's agent files a request for a teammate's agent as a task with a state (requested → working / needs_input → done / declined). It's available over MCP (`flow_request_handoff`, `flow_list_handoffs`, `flow_reply_handoff`) and REST, and the task panel shows a handoff strip. Comments now record `via`, so agent-written replies are labelled.
- **Email intake** (`core-0012`). Each list can take tickets at `<alias>@EMAIL_INTAKE_DOMAIN` from allowlisted senders:
  - replies in the thread become comments
  - sender authenticity comes from Cloudflare's own authentication results
  - authenticated senders can get an optional acknowledgement
  - rate limits apply per sender and per intake
  - it's managed in Settings → Inbound
- **Email replies** (`core-0014`). A comment posted with `emailToRequester` is emailed to the sender who opened the ticket, in their thread, and the task records "Emailed to …". It's API-only, for keys an owner or admin allowed (`PATCH /api/api-keys/:id`), and never available over MCP.
- **`set_due_date` automation action**, with a time-of-day cutoff in a given time zone and an optional business-days rule.
- **Subtask notes** (`core-0009`): a plain-text note on each subtask.
- **My Work** now includes your own subtasks, plus an "assigned out" rail for work you delegated. It's backed by assignment attribution (`core-0010`).
- **Clickable URL titles.** A task whose title is a link gets an open-link icon.
- **Backups**:
  - outcomes are recorded (`core-0011`)
  - `/api/health` reports staleness
  - `GET`/`POST /api/admin/backup` shows status and runs a backup on demand

### Fixed

- **Daily backups never succeeded:** the runtime's internal `_cf_KV` table can't be read, and the backup job tried to export it.
- **Security:** `GET /ws` now checks the request `Origin` before accepting an Access-cookie handshake.
- **Security:**
  - attachments are served as downloads unless they're safe raster images
  - cookie-authenticated mutations must be same-origin
- **Security:** Message-ID and reply-subject parsing no longer slow down on crafted input (both were quadratic).
- An empty subtask `PATCH` no longer unchecks a completed subtask.
- The web store no longer inserts half-empty rows for update deltas about unknown ids.
- Moving work across spaces, or changing a role, resyncs the affected sockets.
- `status_changed` no longer fires on a cross-list move that keeps the status name.
- Side effects are fitted to the Queues 128KB message limit instead of being dropped.
- `automation_runs` and `audit` are pruned.
- The importer retries rows that failed instead of recording them as loaded.

### Dependencies

- wrangler 4.151, with patched sharp.
- source-map-js pinned to 1.2.2.
- Patched hono, the MCP SDK, prosemirror-view and proxy-addr.
- vitest 5.
