# @flow/importer

One-shot migration of a ClickUp workspace into Flow. Runs locally under `tsx`,
never deploys, and never writes to ClickUp — every ClickUp call is a GET.

Three passes, each restartable, with JSON on disk between them so you can
inspect and diff what the next pass will do:

```
ClickUp v2  --extract-->  data/raw/*.json  --transform-->  data/flow/*.json  --load-->  Flow REST
```

## Auth

The ClickUp token is **not** in this repo. Set the `CLICKUP_TOKEN` environment
variable (a `pk_…` personal token), with `CLICKUP_BASE_URL` as an optional
override. Alternatively pass `--env-file <path>` pointing at a dotenv file that
defines `CLICKUP_TOKEN`. Resolution order is `process.env.CLICKUP_TOKEN`, then
the `--env-file` file, then a fatal error.

The Flow API key is passed per-run: `--key flow_xxx` or `FLOW_API_KEY`.

## Running it

```bash
cd apps/importer

# 1. Crawl ClickUp -> data/raw/
CLICKUP_TOKEN=pk_… pnpm --filter @flow/importer extract --team <team-id>

# 2. Raw -> Flow entities in data/flow/  (pure, offline, seconds)
pnpm --filter @flow/importer transform

# 3. Push to Flow. Rehearse first.
pnpm --filter @flow/importer load --api https://flow.example.com --key flow_xxx --dry-run
pnpm --filter @flow/importer load --api https://flow.example.com --key flow_xxx
```

`pnpm --filter @flow/importer test` runs the transform unit tests against the
synthetic ClickUp fixtures in `fixtures/`. `pnpm typecheck` at the repo root
must pass before any of this is considered done.

### Useful flags

| Flag | Pass | Effect |
| --- | --- | --- |
| `--data-dir <path>` | all | Where raw/ and flow/ live. Default `./data`. |
| `--scope-days <n>` | extract, transform | Recency window. Default 120. |
| `--team <id>` | extract | ClickUp team (workspace) id. Required unless `CLICKUP_TEAM_ID` is set. |
| `--env-file <path>` | extract | dotenv holding `CLICKUP_TOKEN`. |
| `--fresh` | extract | Ignore the checkpoint and start over. |
| `--max-pages <n>` | extract | Stop after N task pages. Use for smoke tests — it does **not** mark the task stage complete, so a later run resumes. |
| `--no-comments`, `--no-attachments` | extract, load | Skip those passes. |
| `--task-url-prefix <s>` | transform | What rewritten ClickUp links point at. Default `/t/`. |
| `--roles <path>` | transform | JSON file of email → `owner`/`admin`/`member` role overrides. Or set `FLOW_ROLE_OVERRIDES` to the same JSON. |
| `--no-strict` | transform | Write output even when rows fail zod validation (default is to refuse). |
| `--batch-size <n>` | load | Rows per POST. Default 200. |
| `--dry-run` | load | Log the requests, send nothing. |

## Pass 1 — extract

Order: identity → team + members → spaces (live and archived) → folders per
space (live and archived, so archived ones can be skipped downstream) →
folderless lists → `GET /list/{id}` per list → team tasks → per-task comments →
per-task attachment metadata.

- **`GET /list/{id}` is not optional.** It is the only endpoint that returns a
  list's *resolved* status set; lists routinely set `override_statuses: true`
  and differ from their space default.
- **Tasks** come from `GET /team/{team_id}/task` with
  `subtasks=true&include_closed=true&include_markdown_description=true`, 100
  per page, until `last_page: true`.
- **`include_markdown_description=true` matters.** Without it ClickUp returns
  only the formatting-stripped `description`, and every heading, bold run and
  link in the task bodies is silently lost.
- **Scope filter runs client-side**, because ClickUp cannot express
  "open OR (closed AND recent)" as one query: keep every task in a non-closed
  status, plus closed tasks whose `date_closed`/`date_done`/`date_updated`
  falls inside the window. Comments and attachments are fetched for in-scope
  tasks only, which cuts the crawl size substantially on a workspace with a
  long closed-task tail.
- **Attachment metadata only exists on `GET /task/{id}`** — the team task list
  omits it — so that is one extra request per in-scope task. Bytes are not
  downloaded here; only the source URL is recorded.
- **Comment paging is unusual.** `GET /task/{id}/comment` returns 25 at a time
  with no last-page flag; you pass the oldest comment you hold back as
  `start` (its date) + `start_id` (its id). The client stops on a short page,
  on a page that adds no new ids, or at a 200-page guard.
- **Rate limiting.** Token bucket sized from `X-RateLimit-Limit` (100/min on a
  typical personal token), steered by `X-RateLimit-Remaining`, sleeping until
  `X-RateLimit-Reset` (epoch **seconds**) when headroom drops under 8. A 429
  backs off to the reset instant, or exponentially if the header is missing.
- **Checkpointing.** `data/raw/checkpoint.json` records completed stages, the
  highest finished task page, and per-id sets for lists/comments/attachments.
  A crash or `^C` resumes; `--fresh` starts over. Every JSON write is
  temp-file-then-rename, so a kill never leaves half a document.

## Pass 2 — transform

Pure and offline: `data/raw/*.json` in, `data/flow/*.json` out, plus
`report.json` (counts, warnings, link-rewrite stats, skipped lists) and
`idmap.json`. Every row is validated against the `@flow/shared` zod schemas
before anything is written, and the pass refuses to write if any row fails.

### Ids are derived, not random

`sha256("flow:" + kind + ":" + clickupId)` rendered in a nanoid-style alphabet,
e.g. `tk_65CTTVQq7M2q`. So re-running `transform` produces byte-identical
output and re-running `load` is an upsert rather than a second copy of the
workspace. `idmap.json` persists the correspondence for link rewriting and for
grepping when something looks wrong — but because derivation is pure, losing
the file changes nothing. It also stores `importedAt`, which is reused across
runs so the synthesized `createdAt` on spaces and lists (ClickUp gives them
none) does not drift.

### Mapping

| ClickUp | Flow | Notes |
| --- | --- | --- |
| space | `Space` | `position` from array order. |
| folder | *(nothing)* | Collapsed into the list name. |
| list | `List` | Name becomes `"Folder / List"` only when the folder is real (not ClickUp's hidden wrapper), not archived, and has live lists. Lists in an archived folder are skipped, and so are their tasks. |
| list statuses | `Status[]` | Order and colour preserved. `open`→open, `closed`/`done`→closed, everything else→custom. |
| task | `Task` | `markdown_description` preferred; single assignee = first; priority names map straight across; tags flattened to names; `clickupId` set. |
| subtask (a ClickUp task with `parent`) | `Subtask` | Asana-style: `done` = its own status type is closed/done. Title, assignee, due date carried. Never also emitted as a `Task`. |
| comment | `Comment` | `comment_text`, falling back to the rich-text segments. |
| attachment | `AttachmentImport` | Metadata + ClickUp source URL for pass 3. |
| member / assignee / author | `User` | Members active; anyone appearing only as an assignee, creator or author is `deactivated: true` but still referenceable. |

`Status`/`List` invariants from the contract are enforced, not assumed: exactly
one `open` first and one `closed` last. Extra opens/closeds are demoted to
custom rather than dropped, and a missing end is synthesized ("To Do" / "Done")
so `statuses.min(2)` always holds. A clean live workspace never hits these
paths, so they are covered by constructed fixtures.

Roles are a policy decision, not derived from ClickUp: pass a JSON object of
email → role via `--roles <file>` or `FLOW_ROLE_OVERRIDES`. Without one, the
ClickUp team owner becomes Flow's owner and everyone else lands as `member`.

### Link rewriting

A second sweep over task descriptions and comment bodies turns
`https://app.clickup.com/t/<id>` (and the team-scoped
`…/t/<team>/<id>` form, with any trailing path or query) into
`/t/<flowId>`. Bare URLs and markdown link targets are both handled, since only
the URL text changes. Ids that resolve to nothing — out of scope, or deleted —
are **left as the original ClickUp link**, on the grounds that a working
external link beats a dead internal one. `report.json` lists them.

## Pass 3 — load

Posts `data/flow/*.json` in referential order: **users → spaces → lists →
tasks → subtasks → comments → attachments**. Accepted ids are appended to
`data/flow/loaded.json` after each batch, so an interrupted load resumes and
re-running is a no-op. Ids are recorded only after the server accepts a batch,
so a mid-batch crash re-sends rather than skips — harmless given upsert
semantics. A failing attachment is logged and skipped rather than aborting the
run; re-run `load` to retry it.

Import mode must not fire automations. That is a **server-side guarantee** of
the import routes (`actor.via = "import"`); this CLI only chooses those routes.

### Assumed endpoints

`src/flow-client.ts` is the only file that knows Flow's HTTP surface. These
shapes were assumed before `apps/api`'s REST README landed — **if the rest
agent named things differently, that one file is the only thing to change**:

- `POST /api/import/batch`, `Bearer <key>`, body
  `{ spaces?, lists?, users?, tasks?, subtasks?, comments? }` — arrays of
  fully-formed `@flow/shared` entities with ids included, upserted by id.
- `POST /api/import/attachments`, `Bearer <key>`, body
  `{ taskId, filename, mimeType, size, sourceUrl, uploadedBy, createdAt,
  clickupAttachmentId }` — Flow fetches the ClickUp URL itself and assigns the
  `Attachment` id and `r2Key`, so the bytes never round-trip through this
  machine.
- `GET /api/import/status` — optional pre-flight only.

## Fixtures and tests

`fixtures/` holds fully synthetic ClickUp v2 responses for a fictional "Acme
Web Studio" workspace, shaped after real API captures: 30 tasks covering every
quirk the transform has to survive (each tagged with a `_fixtureReason`), the
lists they live in, their spaces and folders, plus comments and attachments.
Constructed input in `test/fixtures.ts` covers the cases a clean workspace does
not contain — archived folders, multiple open/closed statuses, missing status
ends.

The tests in `test/transform.test.ts` cover status-type mapping, folder
collapsing, subtask done-mapping, link rewriting, single-assignee truncation,
the scope filter, user handling, determinism, and full-bundle referential
integrity.
