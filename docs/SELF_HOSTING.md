# Self-hosting Flow

The complete runbook: from an empty Cloudflare account to a deployed workspace with SSO, agents connected over MCP, and email notifications. Budget an hour the first time; most of it is Cloudflare dashboard clicking, not code.

Everything below uses placeholder values — substitute your own:

| Placeholder | Meaning |
|---|---|
| `flow.example.com` | The hostname you'll serve Flow on |
| `your-team.cloudflareaccess.com` | Your Cloudflare Zero Trust team domain |
| `<ACCESS_AUD>` | The 64-char hex AUD tag of your Access application |
| `you@example.com` | The workspace owner's email |

## Prerequisites

- A Cloudflare account with a **zone** (domain) on it. The free plan is enough: Workers, Durable Objects (SQLite-backed DOs are on the free tier), R2, Queues, and Cloudflare Access (free for up to 50 users) all work without a paid plan. R2 needs a card on file even at $0 usage.
- Node 20+, [pnpm](https://pnpm.io).
- `wrangler` — installed as a dev dependency, so `pnpm install` provides it. Authenticate once with `pnpm exec wrangler login`.

```bash
git clone https://github.com/joelborch/flow.git
cd flow
pnpm install
pnpm typecheck && pnpm test   # everything should pass before you touch config
```

## 1. Bootstrap your users

Flow has no signup flow — Cloudflare Access authenticates an email, and that email must map to an existing workspace user or the request gets a 403. You don't have to touch code for this: a fresh workspace seeds one placeholder owner, and the first time the email you set as `OWNER_EMAIL` in `wrangler.jsonc` authenticates (through Access, or `DEV_NO_AUTH` locally), it automatically claims that seeded owner — same user, your address. So bootstrap is just: set `OWNER_EMAIL`, deploy, sign in.

Additional users go in through the import endpoint once you're in (`POST /api/import/batch` with a `users` array, admin-only; see [API.md](API.md#import)):

```bash
curl -X POST https://flow.example.com/api/import/batch \
  -H "Authorization: Bearer flow_EXAMPLEKEY" \
  -H "Content-Type: application/json" \
  -d '{"users":[{"email":"teammate@example.com","name":"Teammate","role":"member"}]}'
```

Roles: `owner` and `admin` can change the workspace shape (spaces, lists, automations), manage other users' API keys, and read inbound tokens; `member` can do all task-level work. Access must also allow the same emails through its own policy (step 4) — Flow's user table and the Access allow-list are two separate doors.

## 2. Configure the Worker

All deployment configuration lives in `apps/api/wrangler.jsonc` — start by copying the shipped template: `cp apps/api/wrangler.example.jsonc apps/api/wrangler.jsonc` (the copy is gitignored, so your real values never end up in a commit). Set the route, hostname, and Access values to yours:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "flow",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "routes": [
    { "pattern": "flow.example.com", "custom_domain": true }
  ],
  "assets": {
    "directory": "../web/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    // API/MCP/WS routes must always hit the Worker, never the SPA shell.
    "run_worker_first": ["/api/*", "/mcp", "/mcp/*", "/ws"]
  },
  "durable_objects": {
    "bindings": [{ "name": "WORKSPACE", "class_name": "Workspace" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["Workspace"] }
  ],
  "send_email": [{ "name": "SEND_EMAIL" }],
  "r2_buckets": [
    { "binding": "ATTACHMENTS", "bucket_name": "flow-attachments" }
  ],
  "queues": {
    "producers": [{ "binding": "SIDE_EFFECTS", "queue": "flow-side-effects" }],
    "consumers": [{ "queue": "flow-side-effects", "max_retries": 5, "dead_letter_queue": "flow-dlq" }]
  },
  "vars": {
    "EMAIL_DRY_RUN": "true",
    "APP_HOSTNAME": "flow.example.com",
    "ACCESS_TEAM_DOMAIN": "your-team.cloudflareaccess.com",
    "ACCESS_AUD": "<ACCESS_AUD>",
    "OWNER_EMAIL": "you@example.com"
  },
  "observability": { "enabled": true }
}
```

Notes on the vars:

- `EMAIL_DRY_RUN` — leave `"true"` until email sending is set up (step 6). While true, every email logs its full content instead of sending.
- `APP_HOSTNAME` — used to build task URLs in webhook payloads, notification emails, and `{{task.url}}` templates.
- `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` — filled in during step 4. You can deploy before Access exists; the API will just reject every browser request until it's wired up.
- `OWNER_EMAIL` — the fallback identity: local dev auth resolves to this user, and inbound webhooks with no dedicated API key act as this user.
- `DEV_NO_AUTH` is deliberately **not** in this file. Put it in `apps/api/.dev.vars` (gitignored) for local development only — it fails closed, so anything other than the exact string `"true"` leaves auth enforced.

The sender address is config too — set the `EMAIL_FROM` / `EMAIL_FROM_NAME` vars in `wrangler.jsonc` (defaults: `flow@mail.example.com` / `Flow`).

## 3. Create the storage primitives

```bash
cd apps/api
pnpm exec wrangler r2 bucket create flow-attachments
pnpm exec wrangler queues create flow-side-effects
pnpm exec wrangler queues create flow-dlq
```

The Durable Object needs nothing pre-created — the `migrations` block in `wrangler.jsonc` registers the SQLite-backed `Workspace` class on first deploy, and its internal schema migrations run automatically in the DO constructor.

## 4. Deploy

```bash
cd ../..           # repo root
pnpm deploy        # builds apps/web with Vite, then wrangler deploy from apps/api
```

Because `routes` uses `"custom_domain": true`, wrangler creates the `flow.example.com` DNS record and certificate on your zone automatically. Verify liveness (this endpoint is public by design, so uptime checks don't need a credential):

```bash
curl -s https://flow.example.com/api/health
# {"ok":true,"service":"flow","ts":...}
```

Every other route should now return 401 — auth is enforced, and nothing can get in until Access exists.

## 5. Cloudflare Access

Flow expects **two** Access applications on the same hostname: an *allow* app that authenticates humans, and a *bypass* app that lets non-browser traffic (API keys, MCP clients, WebSocket upgrades, static assets) through to the Worker, which does its own bearer-token auth. Order matters — Access evaluates the most specific path first, and the bypass app's paths must win over the allow app's catch-all.

In the [Zero Trust dashboard](https://one.dash.cloudflare.com) → **Access → Applications**:

**App 1 — the bypass app.** Add a self-hosted application named e.g. `flow-api-bypass`, with these paths on `flow.example.com`:

```
flow.example.com/api/*
flow.example.com/mcp
flow.example.com/mcp/*
flow.example.com/ws
flow.example.com/assets/*
```

Give it a single policy with action **Bypass**, include **Everyone**. This is safe because the Worker rejects anything on `/api/*` and `/mcp` without a valid credential (`flow_` bearer or Access JWT), `/ws` authenticates via the `CF_Authorization` cookie, and `/assets/*` is just the fingerprinted JS/CSS — bypassing assets is what lets the SPA shell load fast and lets the login redirect not eat your bundle requests.

**App 2 — the allow app.** Add a second self-hosted application named e.g. `flow`, on the bare hostname:

```
flow.example.com
```

Policy: action **Allow**, include your team — an email domain rule (`Emails ending in @example.com`), a Google Workspace integration, specific emails, whatever fits. Access's free identity options include Google SSO and one-time PIN over email, so you don't need an IdP subscription. Set session duration to taste (e.g. 1 week); the `CF_Authorization` cookie this app sets is also what authenticates WebSocket upgrades.

**Copy the AUD.** Open the allow app's **Overview** tab and copy the *Application Audience (AUD) Tag* — a 64-char hex string. Put it in `wrangler.jsonc` as `ACCESS_AUD`, set `ACCESS_TEAM_DOMAIN` to your team domain (visible under Zero Trust → Settings → Custom Pages, it looks like `your-team.cloudflareaccess.com`), and redeploy:

```bash
pnpm deploy
```

Now visit `https://flow.example.com` in a browser: Access should challenge you, and after login you should land on your board as the seeded owner. Remember: Access authenticating you is necessary but not sufficient — your email must also exist as a workspace user (step 1), or you'll get `403 you@example.com is not a member of this workspace`.

## 6. Email sending

Flow sends notification and automation email through [Cloudflare Email Sending](https://developers.cloudflare.com/email-routing/email-sending/) via the `SEND_EMAIL` binding already declared in `wrangler.jsonc`. Until you finish this step, leave `EMAIL_DRY_RUN` at `"true"` — mail logs instead of sending, and nothing breaks.

1. In the Cloudflare dashboard, onboard a **sending subdomain** on your zone (e.g. `mail.example.com`) under Email → Email Sending. Cloudflare provisions the DKIM/SPF records on your zone for you.
2. Make sure the `EMAIL_FROM` var in `wrangler.jsonc` is an address on that subdomain (e.g. `flow@mail.example.com`).
3. Flip `EMAIL_DRY_RUN` to `"false"` in `wrangler.jsonc` and redeploy.

If dry-run is off but the binding or onboarding is missing, sends fail loudly and retry through the queue (landing in `flow-dlq` after 5 attempts) rather than silently dropping mail — check `wrangler tail` if notifications aren't arriving.

Notification defaults per user: assigned-to-me **on**, comment-on-my-task **on**, status-change **off** (it's the noisiest signal, so users opt in), mention **on** (reserved — mention parsing isn't implemented yet). Users manage their own via the UI or `PUT /api/notifications/prefs`. Nobody is ever emailed about their own action.

## 7. Mint API keys for agents

Any member can mint a key that acts as themselves; minting a key that impersonates someone else requires owner/admin. In a logged-in browser session (the Access cookie authenticates this curl if you run it from the browser's devtools, or just use the Settings → API Keys UI):

```bash
curl -sS -X POST https://flow.example.com/api/api-keys \
  -H "Cf-Access-Jwt-Assertion: <jwt>" \
  -H 'Content-Type: application/json' \
  -d '{"name":"claude-mcp"}'
# {"apiKey":{"id":"ak_...","name":"claude-mcp",...},
#  "token":"flow_...",
#  "warning":"This token is shown only once and cannot be recovered."}
```

The token is `flow_` + base64url of 32 CSPRNG bytes; only its SHA-256 is stored, so it genuinely cannot be recovered — losing it means minting a new one. Connect an agent:

```bash
claude mcp add --transport http flow https://flow.example.com/mcp \
  --header "Authorization: Bearer flow_..."
```

See [AGENTS_AND_MCP.md](AGENTS_AND_MCP.md) for other clients and the full tool reference.

## 8. Import from ClickUp (optional)

If you're migrating, run the importer now, before the team starts creating tasks — see [IMPORTING.md](IMPORTING.md). The import is idempotent, fires no automations, and streams attachments server-side into R2.

## Local development

```bash
cat > apps/api/.dev.vars <<'EOF'
DEV_NO_AUTH = "true"
EOF

pnpm --filter @flow/api dev    # Worker on :8787 (local DO, local R2/queue simulation)
pnpm --filter @flow/web dev    # Vite on :5173, proxies /api and /ws to :8787
```

With `DEV_NO_AUTH=true`, every request resolves to `OWNER_EMAIL`'s user:

```bash
curl -s localhost:8787/api/me | jq
```

## Operations notes

- **Backups.** The workspace is one SQLite database inside a Durable Object; Cloudflare's [point-in-time recovery](https://developers.cloudflare.com/durable-objects/api/sql-storage/) covers SQLite-backed DOs. For belt-and-braces, `GET /api/snapshot` plus the audit log gives you an application-level export you can cron from anywhere with an API key.
- **Logs.** `observability.enabled` is on, so `pnpm exec wrangler tail` from `apps/api` streams structured logs — including `[EMAIL_DRY_RUN] would send:` blocks and automation failures.
- **Retention.** The delta log keeps its newest 50,000 rows (pruned daily); a reconnect older than that gets a fresh snapshot instead of a replay. The audit log is not pruned.
- **The DLQ.** Messages that fail 5 deliveries land in `flow-dlq`. Nothing consumes it by default; check it when a webhook endpoint has been down.
