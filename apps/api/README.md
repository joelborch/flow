# @flow/api

Single Cloudflare Worker serving the SPA, REST API, MCP endpoint (`/mcp`),
WebSocket upgrades (`/ws`), inbound webhooks/email, and the `SIDE_EFFECTS`
queue consumer. Every read and write goes through RPC on the `Workspace`
Durable Object (instance `"main"`).

```
Cloudflare Access ──┐
                    ├─> Worker ──RPC──> Workspace DO (SQLite, sole writer)
Bearer flow_<token> ─┘        ├──R2───> ATTACHMENTS
                              └──Queue─> SIDE_EFFECTS
```

Full REST examples live in [docs/API.md](../../docs/API.md) and MCP tool/OAuth
documentation lives in [docs/AGENTS_AND_MCP.md](../../docs/AGENTS_AND_MCP.md).

## Authentication & local development

Routes under `/api/*` and `/mcp` accept either `Authorization: Bearer flow_<token>`
(agents, scripts, MCP; SHA-256 hashed and resolved in the DO) or
`Cf-Access-Jwt-Assertion` (humans verified against Access JWKS). Exceptions:
`GET /api/health` (public) and `POST /api/inbound/:listId` (per-list `inboundToken`).

For local dev, create gitignored `apps/api/.dev.vars`:

```
DEV_NO_AUTH = "true"
```

`DEV_NO_AUTH` fails closed unless literally `"true"`, resolving requests to `OWNER_EMAIL`.

```bash
pnpm --filter @flow/api dev     # :8787
curl -s localhost:8787/api/me | jq
```

## Errors

All failures return `{"error": "<message>"}`:
- `400` malformed JSON or missing upload `Content-Length`
- `401` missing, bad, or revoked credential
- `403` authenticated but not permitted (non-member, deactivated, wrong role, disallowed email reply)
- `404` unknown route or DO `"… not found."` error
- `413` / `416` attachment over cap or unsatisfiable byte range
- `422` Zod validation errors or DO domain rule refusals
- `429` query or sandbox write rate limit exceeded
- `500` unexpected internal failure

## Gleap setup & screenshots

Point Gleap outbound webhooks at `POST /api/inbound/<listId>` with `Authorization: Bearer <inboundToken>` (or `?token=...`). Known Gleap ticket payloads map to clean `Description` / `Info` / `Metadata` tasks tagged `gleap` + `ext:<ticketId>` with delayed screenshot reconciliation queued using `GLEAP_PROJECT_TOKENS_JSON`. Unknown project IDs or unallowed `GLEAP_ATTACHMENT_HOSTS` fail closed.

Store `GLEAP_PROJECT_TOKENS_JSON` as an encrypted **Worker secret** (not a plain config var) inside **your own Cloudflare account using your own gitignored `apps/api/wrangler.jsonc`** (or in local gitignored `apps/api/.dev.vars` during dev):

```bash
pnpm --filter @flow/api exec wrangler secret put GLEAP_PROJECT_TOKENS_JSON --config wrangler.jsonc
```

## Configuration

Copy `apps/api/wrangler.example.jsonc` to gitignored `apps/api/wrangler.jsonc` (see [docs/SELF_HOSTING.md](../../docs/SELF_HOSTING.md)).

| Var / Secret | Kind | Purpose |
| --- | --- | --- |
| `APP_HOSTNAME` | Var | Public hostname used in webhook payloads and notification links |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | Var | Cloudflare Access team domain and audience tag |
| `OWNER_EMAIL` | Var | Fallback bootstrap owner for Access first-login and `DEV_NO_AUTH` |
| `EMAIL_DRY_RUN` | Var | `"true"` logs outbound automation email instead of sending |
| `EMAIL_FROM`, `EMAIL_FROM_NAME`, `EMAIL_BRAND_NAME`, `EMAIL_REQUESTER_FROM_NAME` | Var | Outbound mail identity and HTML branding |
| `EMAIL_INTAKE_DOMAIN`, `EMAIL_INTAKE_REPLY` | Var | Inbound Mail Routing domain and reply-to-requester toggle |
| `GLEAP_ATTACHMENT_HOSTS` | Var | Allowed screenshot hosts |
| `GLEAP_PROJECT_TOKENS_JSON` | Secret | Encrypted per-project API token JSON map (`wrangler secret put`) |

Bindings: `WORKSPACE` (DO), `ATTACHMENTS` (R2), `SIDE_EFFECTS` (Queue), `ASSETS` (SPA).

## Layout

```
src/
  index.ts            Worker entrypoint, Hono router, queue & email() handlers
  env.ts              Env, AppEnv, AuthContext, WORKSPACE_NAME, WS_USER_HEADER
  auth.ts             Bearer + Access auth, role gates, inbound actor resolution
  access-jwt.ts       Access JWT verification, JWKS fetch + cache
  tokens.ts           Token minting, SHA-256 hashing, bearer parsing
  gleap.ts            Inbound Gleap & generic payload mapper
  gleap-screenshot.ts Delayed ticket lookup & safe R2 screenshot attachment
  email-intake.ts     Inbound Cloudflare Email handler, MIME parser, threading
  email-thread.ts     SMTP threading headers and outbound email helpers
  do.ts               Derived WorkspaceApi type + RPC error-mapping stub proxy
  errors.ts           ApiError, Zod issue formatting, HTTP error mapper
  sandbox.ts          Sandbox Worker wrapper (public demo host)
  sandbox-core.ts     Sandbox seeding & rate/body guards
  routes/             admin, api-keys, attachments, audit, automations,
                      email-intake, handoffs, inbound, lists, me, notifications,
                      query, spaces, tasks, ws, testkit
  mcp/                /mcp handler, OAuth/tool registration, schemas, views, work
  side-effects/       Queue consumer: webhook & email delivery, retries, DLQ
```

## Tests

```bash
pnpm --filter @flow/api test
pnpm --filter @flow/api typecheck
```
