# Roadmap

No dates on purpose: Flow is maintained alongside other work, and a date would be a guess. Each item says where the need comes from, so it can be checked against the repo. Want to help? The items marked as good first issues are a good place to start, and anything under Later deserves an issue to discuss the design first.

## Now

- **Docs catch-up.** A few docs fell behind recent changes: the MCP tool count, the runtime dependency list, the core package README, and the automation template fields. Open as good first issues.
- **Tests for small pure helpers.** Fractional ordering and the web app's date formatters. Open as good first issues.

## Next

- **@-mentions.** The `mention` notification preference already exists and defaults on, but nothing parses mentions or emits the event yet (`packages/shared/src/notifications.ts`). This needs a parser, a delta or side-effect carrying the mention, and the email template.
- **Member management in the UI.** Inviting, deactivating and changing roles from Settings would remove manual DO setup for additional team members.
- **MCP directory listings.** An official MCP Registry entry first, since other directories ingest from it. The open question is how to list a server that every team hosts at its own URL.
- **Handoff state notifications.** Today a requester hears about a `needs_input` question through the ordinary comment email. A notification for the state change itself would make the hand-back explicit.
- **Streamed backups.** The daily backup builds the whole NDJSON dump in memory before gzipping it (`runBackup` in `packages/core/src/alarm.ts`). Streaming it would raise the workspace size at which backups stop fitting.

## Later (open an issue to discuss first)

- **Native OAuth without Cloudflare Access.** Flow supports static per-user bearer keys on `/mcp` and opt-in Cloudflare Access Managed OAuth on `/mcp/oauth`. Any built-in OAuth server for non-Access setups still has to keep the property that a credential acts as one real user with an audit trail.
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
