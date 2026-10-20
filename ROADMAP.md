# Roadmap

No dates on purpose: Flow is maintained alongside other work, and a date would be a guess. Each item says where the need comes from, so it can be checked against the repo. Want to help? The items marked as good first issues are a good place to start, and anything under Later deserves an issue to discuss the design first.

## Now

- **Docs catch-up.** A few docs fell behind recent changes: the MCP tool count, the runtime dependency list, the core package README, and the automation template fields. Open as good first issues.
- **Importer catch-up sync.** A `load --resend` flag so a cutover can re-send rows that changed in ClickUp after the first load without duplicating attachments. A good first issue.
- **Tests for small pure helpers.** Fractional ordering, the importer's rate limiter, and the web app's date formatters. Open as good first issues.

## Next

- **@-mentions.** The `mention` notification preference already exists and defaults on, but nothing parses mentions or emits the event yet (`packages/shared/src/notifications.ts`). This needs a parser, a delta or side-effect carrying the mention, and the email template.
- **Member management in the UI.** Today, users beyond the first owner go in through the admin import endpoint (`POST /api/import/batch` with a `users` array, per `docs/SELF_HOSTING.md`). Inviting, deactivating and changing roles from Settings would remove the last routine curl from setup.
- **Asana and Trello importers.** The importer's extract/transform/load seams are already documented in `docs/IMPORTING.md`; a new source needs its own extractor and transform mapping and reuses id derivation, validation and load unchanged.
- **MCP directory listings.** An official MCP Registry entry first, since other directories ingest from it. The open question is how to list a server that every team hosts at its own URL.
- **Handoff state notifications.** Today a requester hears about a `needs_input` question through the ordinary comment email. A notification for the state change itself would make the hand-back explicit.
- **Streamed backups.** The daily backup builds the whole NDJSON dump in memory before gzipping it (`runBackup` in `packages/core/src/index.ts`). Streaming it would raise the workspace size at which backups stop fitting.

## Later (open an issue to discuss first)

- **OAuth for the MCP server.** Clients and directories increasingly expect OAuth; Flow only supports static bearer keys, minted per user. Any OAuth design has to keep the current property that a key acts as one real user with an audit trail.
- **A guest or read-only role.** The permission model is members plus private spaces. Some teams need to show a client a board without making them a member.
- **Better mobile.** The app is responsive web only. An installable PWA with notifications is the likely step before anything native.
- **A per-user resync floor.** The workspace-wide floor in `packages/core/src/sync-floor.ts` sends a spurious snapshot to clients whose view didn't change. That's cheap today; it matters only if workspaces get much larger.

## Not planned

These are left out by design, and the reasons are in `README.md` and `docs/COMPARISON.md`. Each would add complexity to every query, form and API shape, so issues asking for them will be closed with a pointer to this list:

- Gantt charts, timelines and workload views
- Time tracking
- Custom fields
- Folders (spaces contain lists)
- Multiple assignees per task
- Docs, whiteboards, chat and goals
- More than one workspace per deployment
- A runtime other than Cloudflare Workers and Durable Objects
