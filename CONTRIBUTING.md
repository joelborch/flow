# Contributing to Flow

Thanks for helping build Flow — a fast, minimal, agent-first task manager that
runs entirely on Cloudflare. This doc covers the mechanics of contributing.
Architecture lives in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and if
you're a coding agent (or driving one), read [AGENTS.md](AGENTS.md) first —
it's the contract for how changes flow through this codebase.

## Dev environment

- **Node 20+** (22 recommended) and **pnpm 11** (`corepack enable` gives you
  the version pinned in `package.json`'s `packageManager` field).
- `pnpm install` at the repo root. The workspace covers `packages/*` and
  `apps/*`; everything imports `@flow/shared` and `@flow/core` by workspace
  reference, so there is no build step between packages during dev.
- `wrangler` is a dev dependency of `apps/api`; you don't need a global
  install. You only need `wrangler login` (a Cloudflare account) if you want
  to run `wrangler deploy --dry-run` or deploy a real instance — local dev
  runs entirely in `workerd` via `wrangler dev` with no account.

## Running locally

Two processes:

```sh
pnpm dev        # apps/api: wrangler dev on http://localhost:8787
pnpm dev:web    # apps/web: Vite on http://localhost:5173
```

The Vite dev server proxies `/api` and `/ws` to :8787 (see
`apps/web/vite.config.ts`), so you develop against http://localhost:5173 with
the real Worker, real Durable Object, and a real WebSocket behind it. For local
auth, set `DEV_NO_AUTH=true` in `apps/api/.dev.vars` — this resolves every
request to the configured owner email and exists only for local dev. See
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for a real deployment.

## Gates

Every PR must pass, in this order:

```sh
pnpm typecheck                  # tsc --noEmit in every package, strict mode
pnpm -r test                    # vitest across core, api, importer
pnpm --filter @flow/web build   # the web bundle must actually build
```

If you touched `apps/api` (routes, bindings, `wrangler.jsonc`), also run
`pnpm --filter @flow/api exec wrangler deploy --dry-run` to catch config and
bundling errors that typecheck can't see.

Tests are colocated with the code they test (`foo.ts` → `foo.test.ts`). New
behavior in `packages/core` or `apps/api` needs a test; the automation engine
has a `testkit.ts` in `packages/core/src/automation/` for building rule/task
fixtures, and the importer keeps sample ClickUp payloads in
`apps/importer/fixtures/`.

## Code style

- **Strict TypeScript, no exceptions.** No `any` escape hatches, no
  `@ts-ignore` without a comment explaining the compiler limitation.
- **Match the surrounding idiom.** Files in this repo have a consistent shape
  (Zod schema + inferred type pairs, Hono route modules, DO methods that
  return typed results). Extend the pattern you find; don't introduce a
  parallel one.
- **Comments state constraints, not narration.** A good comment explains why
  the code must be this way — an ordering requirement, a workerd quirk, a
  cap and what happens at the cap. Don't write comments that restate the line
  below them.
- **Minimal dependencies.** The allowed runtime deps are hono, zod, preact,
  @preact/signals, the MCP SDK, and similarly tiny single-purpose libraries.
  Anything new needs a justification in the PR description; "it saved me 30
  lines" is not one.
- No formatter config is enforced beyond what's in the repo — keep diffs
  limited to lines you actually changed.

## Commits and PRs

- Small, focused PRs. One behavior change per PR; refactors separate from
  features.
- Commit messages: imperative summary line ("Add due-date automation trigger"),
  body only when the *why* isn't obvious from the diff.
- PR description: what changed, why, which layers were touched
  (shared/core/api/web/mcp), and how you verified it beyond the gates.
- If your change touches `packages/shared` — the workspace contract — say so
  prominently and explain the compatibility story (see AGENTS.md for what
  "compatible" means here).

## Where to discuss first

Open a GitHub issue before building anything sizable: new entity types,
protocol changes, new automation triggers, anything touching auth. Small fixes
and additions that slot into existing extension points can go straight to a PR.

## Good first issues

The codebase has several deliberate extension seams that make good entry
points:

- **New automation actions or triggers** — `packages/shared/src/automations.ts`
  defines the discriminated unions, `packages/core/src/automation/` evaluates
  them; adding a kind is a well-worn path with existing tests to copy.
- **New importer sources** — `apps/importer` currently imports from ClickUp
  via an extract → transform → load pipeline with checkpoints; an Asana or
  Trello extractor that emits the same intermediate shape reuses transform and
  load for free.
- **New MCP tools** — if an agent workflow you run needs a capability the 15
  existing tools don't cover, propose it in an issue; tool names live in
  `packages/shared/src/api.ts` and implementations in `apps/api/src/mcp/`.
  See [docs/AGENTS_AND_MCP.md](docs/AGENTS_AND_MCP.md).
- Board UX polish in `apps/web` — keyboard navigation, filter chips, small
  interactions that don't change the data model.
