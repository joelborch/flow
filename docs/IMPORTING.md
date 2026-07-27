# Importing from ClickUp

`apps/importer` is a local CLI that migrates a ClickUp workspace into Flow. It runs under `tsx` on your machine, never deploys anywhere, and never writes to ClickUp — every ClickUp call is a GET. It was built for a real cutover (thousands of tasks, a dozen lists with divergent status sets, years of comments), so the quirks it handles are quirks that actually happen.

## The three-pass pipeline

```
ClickUp v2  --extract-->  data/raw/*.json  --transform-->  data/flow/*.json  --load-->  Flow REST
```

Each pass is independently restartable, with JSON on disk between them, so you can inspect and diff exactly what the next pass will do before it does it. That structure is not incidental — a migration you can't rehearse is a migration you get one shot at.

```bash
cd apps/importer

# Auth: a ClickUp personal token (pk_...) via env or a dotenv file
export CLICKUP_TOKEN=pk_...          # or --env-file path/to/.env

# 1. Crawl ClickUp -> data/raw/   (rate-limited; ~25 min for a few thousand tasks)
pnpm --filter @flow/importer extract --team <TEAM_ID>

# 2. Raw -> Flow entities in data/flow/   (pure, offline, seconds)
pnpm --filter @flow/importer transform

# 3. Push to Flow. Rehearse first.
pnpm --filter @flow/importer load --api https://flow.example.com --key flow_... --dry-run
pnpm --filter @flow/importer load --api https://flow.example.com --key flow_...
```

Useful flags: `--data-dir` (where raw/ and flow/ live), `--scope-days <n>` (recency window, default 120), `--fresh` (ignore the extract checkpoint), `--max-pages <n>` (smoke tests), `--no-comments` / `--no-attachments`, `--no-strict` (write transform output even when rows fail Zod validation — default is to refuse), `--batch-size` (load rows per POST, default 200), `--dry-run`.

## Pass 1 — extract

Crawl order: identity → team + members → spaces (live and archived) → folders per space → folderless lists → `GET /list/{id}` per list → team tasks → per-task comments → per-task attachment metadata. The non-obvious parts:

- **`GET /list/{id}` per list is not optional.** It's the only endpoint that returns a list's *resolved* status set — lists with `override_statuses: true` differ from their space default, and in the reference workspace many did.
- **`include_markdown_description=true` matters.** Without it ClickUp returns only the formatting-stripped description, and every heading, bold run, and link in your task bodies is silently lost.
- **The scope filter runs client-side**, because ClickUp can't express "open OR (closed AND recent)" as one query: keep every task in a non-closed status, plus closed tasks touched inside the window. Comments and attachments are then fetched for in-scope tasks only, which is what keeps the crawl at thousands of requests instead of tens of thousands.
- **Attachment metadata only exists on `GET /task/{id}`** — the team task list omits it — so that's one extra request per in-scope task. Bytes are not downloaded here; only the source URL is recorded, for pass 3.
- **Comment paging is unusual**: 25 at a time with no last-page flag, cursored by the oldest comment's date + id. The client stops on a short page, a page adding no new ids, or a 200-page guard.
- **Rate limiting** is a token bucket sized from `X-RateLimit-Limit`, steered by `X-RateLimit-Remaining`, sleeping until `X-RateLimit-Reset` when headroom drops under 8; a 429 backs off to the reset instant.
- **Checkpointing**: `data/raw/checkpoint.json` records completed stages, the highest finished task page, and per-id sets for lists/comments/attachments, so a crash or `^C` resumes where it stopped. Every JSON write is temp-file-then-rename, so a kill never leaves half a document.

## Pass 2 — transform

Pure and offline: `data/raw/*.json` in, `data/flow/*.json` out, plus `report.json` (counts, warnings, link-rewrite stats, skipped lists) and `idmap.json`. Every row is validated against the `@flow/shared` Zod schemas before anything is written, and by default the pass refuses to write if any row fails.

### Deterministic ids — the key design decision

Flow ids for imported entities are **derived, not random**: `sha256("flow:" + kind + ":" + clickupId)` rendered in a nanoid-style alphabet, e.g. `tk_65CTTVQq7M2q`. So re-running `transform` produces byte-identical output, and re-running `load` is an **upsert**, not a second copy of the workspace. `idmap.json` persists the correspondence for link rewriting and debugging, but because derivation is pure, losing the file changes nothing. It also stores `importedAt`, reused across runs so synthesized `createdAt` values don't drift.

### What maps to what

| ClickUp | Flow | Notes |
|---|---|---|
| space | `Space` | Position from array order. |
| folder | *(nothing)* | **Collapsed into the list name** — Flow has no folders. A list inside a real, live folder becomes `"Folder / List"`. Lists in archived folders are skipped, and so are their tasks. |
| list | `List` | With its resolved, per-list status set. |
| list statuses | `Status[]` | Order and color preserved. `open`→open, `closed`/`done`→closed, everything else→custom. Invariants are enforced, not assumed: extra opens/closeds are demoted to custom, a missing end is synthesized ("To Do"/"Done"), so every list satisfies the contract. |
| task | `Task` | `markdown_description` preferred; single assignee = the first; priority names map straight across; tags flattened to names; `clickupId` recorded for provenance and link resolution. |
| subtask (a task with `parent`) | `Subtask` | Asana-style: `done` = its own status type is closed/done. Title, assignee, due date carried. Never also emitted as a `Task`. |
| comment | `Comment` | `comment_text`, falling back to rich-text segments. |
| attachment | attachment import record | Metadata + ClickUp source URL, consumed by pass 3. |
| member / assignee / author | `User` | Members active; anyone appearing *only* as an assignee, creator, or author becomes `deactivated: true` but stays referenceable, so history keeps its names. |

### Link rewriting

A second sweep over descriptions and comment bodies rewrites `https://app.clickup.com/t/<id>` links (both URL forms, bare and markdown-target) to `/t/<flowId>`. Ids that resolve to nothing — out of scope, or deleted — are left as the original ClickUp link, on the grounds that a working external link beats a dead internal one; `report.json` lists them.

## Pass 3 — load

Posts `data/flow/*.json` in referential order: **users → spaces → lists → tasks → subtasks → comments → attachments**, in batches (default 200) against two admin-only endpoints:

- `POST /api/import/batch` — arrays of fully-formed entities *with ids included*, upserted by id (then by `clickupId`) inside the DO.
- `POST /api/import/attachments` — `{taskId, filename, mimeType, size, sourceUrl, ...}`; the **Worker fetches the ClickUp URL itself and streams it into R2**, so attachment bytes never round-trip through your machine. `sourceUrl` must be https on a `.clickup.com` / `.clickup-attachments.com` host — the Worker refuses to be a generic fetch proxy.

Accepted ids are appended to `data/flow/loaded.json` after each accepted batch, so an interrupted load resumes and a re-run is a no-op; a mid-batch crash re-sends rather than skips, which is harmless given upsert semantics. A failing attachment is logged and skipped rather than aborting the run — re-run `load` to retry it.

Three server-side guarantees make re-running safe, and they're guarantees of the import routes (`actor.via = "import"`), not of this CLI: import turns fire **no automations**, emit **no deltas** (so no notification email storm either), and are **more lenient** than the interactive API — a title over the 500-char cap is truncated at 2,000 characters rather than rejected, because a migration must not drop a task.

## Testing your changes

`pnpm --filter @flow/importer test` runs ~60 transform tests against synthetic fixtures in `fixtures/` shaped exactly like real ClickUp v2 responses (hand-picked to cover every quirk: status-type mapping, folder collapsing, subtask done-mapping, link rewriting, single-assignee truncation, scope filtering, determinism, full-bundle referential integrity), plus synthetic fixtures for cases a live workspace won't contain.

## Future work: Asana and Trello

The pipeline was built to make source systems pluggable, and the seams are clean:

- **`src/extract.ts` + `src/clickup.ts` + `src/clickup-types.ts`** are the only files that know ClickUp's API. An Asana or Trello extractor is a sibling: crawl the source into `data/raw/*.json` in whatever shape the source natively uses, with its own checkpointing.
- **`src/transform.ts`** maps raw shapes to `@flow/shared` entities. A new source needs its own mapping (Asana: projects→lists, sections→statuses, real subtasks→`Subtask`; Trello: boards→lists, board lists→statuses, checklists→subtasks) but reuses everything downstream — id derivation (`src/idmap.ts`, just change the hash namespace, e.g. `"flow:asana:" + gid`), status invariant enforcement, Zod validation, and `report.json`.
- **`src/load.ts` + `src/flow-client.ts` need zero changes.** They speak Flow's import API and don't care where the entities came from. Same for the server side.

If you want to contribute one, start by capturing a handful of real API responses as fixtures, write the transform against them test-first (the ClickUp transform tests are the template), and keep the extractor read-only against the source. Open an issue first if you want the id-namespace and CLI-flag conventions agreed before you build.
