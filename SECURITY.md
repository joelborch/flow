# Security Policy

## Supported versions

Flow does not cut long-lived release branches. Security fixes land on `main`;
self-hosters are expected to track `main` and redeploy. If you are running an
older commit, update before reporting behavior as a vulnerability — it may
already be fixed.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
private vulnerability reporting on this repository:
**Security tab → Report a vulnerability** (or
`https://github.com/joelborch/flow/security/advisories/new`). You'll get an
acknowledgment, and a fix or a mitigation plan before anything is disclosed
publicly.

Include what you can: the endpoint or code path, a reproduction, and what an
attacker gains. Reports against a self-hosted deployment's *configuration*
(e.g., someone forgot to put Cloudflare Access in front of their instance) are
appreciated as hardening suggestions but aren't vulnerabilities in Flow itself.

## Trust boundary

Knowing what Flow considers authenticated helps you scope a report:

- **The browser app** is authenticated by Cloudflare Access. The Worker
  verifies the Access JWT (issuer = your Access team domain, audience = your
  Access app's AUD tag) on every `/api/*`, `/mcp`, and `/ws` request. Flow has
  no password store of its own — identity is the verified email in the JWT.
- **API keys** (`flow_` bearer tokens) impersonate a real workspace user. Only
  the SHA-256 of a key is stored; the plaintext is shown once at creation.
  Every mutation made with a key is attributed to that user in the audit trail
  along with the key id.
- **Inbound webhooks** (`/api/inbound/*`) bypass Access and authenticate
  per-list with the list's own bearer token. A leaked token lets an outsider
  create tasks in exactly one list, nothing more.
- **Outbound webhooks** are signed with HMAC-SHA256 over the request body when
  the automation carries a secret. Receivers should verify the signature
  header before trusting a payload.
- `/api/health` is deliberately public (no data, just liveness).

Anything that lets a request cross one of these lines without the matching
credential — reading tasks without a valid Access JWT or key, writing to a
list without its inbound token, seeing a `private` space you're not a member
of — is in scope and we want to hear about it.

## Hardening guidance for self-hosters

- **Keep the Access bypass path-scoped.** If you configure a Cloudflare Access
  bypass policy so inbound webhooks can reach the Worker, scope it to
  `/api/inbound/*` only. A domain-wide bypass turns your whole instance
  public, and the app-level auth is designed to sit *behind* Access, not
  replace it.
- **Rotate API keys** when a machine or agent that held one is
  decommissioned, and delete keys for deactivated users. Keys act as the user;
  treat them like passwords.
- **Leave `EMAIL_DRY_RUN` on (the default) until your sending domain's DNS is
  verified.** Dry-run logs what an email automation *would* send instead of
  sending it, which prevents both bounced mail and accidentally emailing real
  people from a half-configured instance.
- **Never set `DEV_NO_AUTH` in production.** It resolves every request to the
  owner identity and exists only for local `wrangler dev` via `.dev.vars`.
- Give outbound-webhook automations a secret and verify the HMAC on the
  receiving end; an unsigned webhook endpoint will accept forged events from
  anyone who learns its URL.
