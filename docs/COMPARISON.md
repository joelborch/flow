# Flow vs. the alternatives

An honest comparison. Flow wins on cost, speed, data ownership, and agent access; the SaaS incumbents win on breadth, polish, mobile, and having a support department. If your team needs Gantt charts, time tracking, or five hundred users, close this tab — Flow is deliberately not that.

## The table

|  | Flow | ClickUp | Asana | Linear | Self-hosted (Vikunja / Focalboard / Plane) |
|---|---|---|---|---|---|
| **Cost, 10 people** | ~$0–5/mo (Cloudflare free tier covers small teams; R2/Queues pennies) | ~$70–190/mo | ~$110–250/mo | ~$80–140/mo | $5–20/mo VPS + your ops time |
| **Where the data lives** | Your Cloudflare account, one SQLite DB you can export | Their cloud | Their cloud | Their cloud | Your server |
| **Agent access** | Built-in MCP server, 15 annotated tools; keys impersonate users; audit trail separates human from agent | REST + emerging MCP integrations, rate-limited (~100 req/min), agent actions look like user actions | REST, OAuth ceremony, no first-class agent identity | Good GraphQL API, MCP via integrations | REST APIs of varying quality, no MCP, DIY |
| **Speed** | Single-digit-ms DO reads, snapshot+delta sync, optimistic UI, boot cache — no spinners after first load | Noticeably heavy | Moderate | Fast (the bar Flow aims at) | Varies; usually fine |
| **Realtime sync** | WebSocket deltas, replay on reconnect | Yes | Yes | Yes | Sometimes polling |
| **Automations** | Trigger/condition/action rules, inline, HMAC webhooks, run log | Extensive | Extensive | Good | Limited |
| **Import path** | ClickUp importer included; Asana/Trello are contributor-shaped work | — | — | Importers from others | Varies |
| **Gantt / timeline / workload** | **No, by design** | Yes | Yes | Some | Some |
| **Time tracking** | **No** | Yes | Via add-ons | No (native philosophy match) | Some |
| **Custom fields** | **No** | Yes | Yes | Limited/opinionated | Some |
| **Mobile apps** | Responsive web only | Native | Native | Native | Varies |
| **Users at comfort** | A team (one workspace, one DO) | Thousands | Thousands | Thousands | Hundreds |
| **Support** | You, and GitHub issues | Support org | Support org | Support org | Community |
| **License** | MIT | Proprietary | Proprietary | Proprietary | Mostly open source |

Prices are ballpark list prices for paid tiers and drift; the point is the shape — per-seat forever versus approximately zero.

## Against ClickUp

ClickUp's pitch is "everything app": docs, whiteboards, goals, chat, time tracking, dashboards, fifteen views over the same tasks. The cost of that breadth is weight — deeply nested settings, slow loads, and a data model (spaces → folders → lists → tasks → subtasks with statuses → checklists, plus custom fields on everything) where the same concept exists at three levels and every team uses a different subset. Flow is the extraction of the subset a small team actually used, measured from a real export: boards, statuses per list, assignee, due dates, tags, comments, attachments, automations. Folders got collapsed into list names; multi-assignee turned out to be a handful of tasks out of thousands; subtask status pipelines collapsed to checkboxes without loss.

Choose ClickUp if you genuinely use its breadth — docs-in-tasks, dashboards, forms, time estimates rolled up a hierarchy. Choose Flow if you mostly moved cards between columns and paid per seat for the rest, and want your agent working the board through MCP instead of scraping a rate-limited REST API. The importer ([IMPORTING.md](IMPORTING.md)) makes the exit concrete rather than aspirational.

## Against Asana

Asana is the most polished pure task manager of the three, and its subtask model — lightweight steps inside a task, not recursive mini-projects — is the one Flow copied on purpose. What you're paying Asana for is polish, mobile apps, portfolio/goal layers, and an enterprise trust surface (SSO, admin controls, compliance). What you give up is cost (it's the most expensive per seat here), data custody, and agent ergonomics: the API is fine for scripts but there's no impersonation-with-audit model, so automation acts as either a service account or a person, indistinguishably. If your team lives in Asana's mobile apps, Flow's responsive web UI is a real downgrade — that's probably the single most honest reason to stay.

## Against Linear

Linear is the closest in spirit: opinionated, fast, keyboard-driven, allergic to configurability. If you're a software team doing issue tracking with cycles, triage, projects, and GitHub integration, Linear is excellent and its sync engine is the standard Flow's snapshot+delta protocol imitates. Flow makes a different trade: it's general project management rather than software-issue-shaped (Linear without "issues", "cycles", and Git semantics), it's yours (Linear is cloud-only — there is no self-host at any price), and agent access doesn't route through a third party's API terms and rate limits. If the license cost doesn't bother you and you want cycles and Git integration, pick Linear. If you want Linear's feel for the non-engineering half of the company, on your own infrastructure, that's Flow's lane.

## Against other self-hosted options

Vikunja, Focalboard, Plane, Taiga, OpenProject and friends share Flow's data-ownership story, so the comparison is architecture and agent access. They ship as containers — app server plus Postgres/MySQL, sometimes Redis — which means a VPS to patch, a database to back up, TLS to renew, and monitoring to own; competent, well-trodden, and a permanent line item of your attention. Flow's runtime is Cloudflare-managed: no server, no database process, no certificate, backups via the platform plus an API-level snapshot, and global TLS/edge for free. The trade is real, though — you're coupled to Cloudflare and to Durable Object semantics, whereas a Docker Compose stack runs on any box on earth, air-gapped if you like. If "no third-party cloud at all" is the requirement, Flow is disqualified by design.

On agent access, none of them ship an MCP server, tool annotations, structured output, or an impersonation-plus-audit model; their REST APIs range from decent (Vikunja) to partial. Flow was built agent-first rather than agent-eventually, and that's the clearest daylight between it and the rest of the self-hosted field.

## What SaaS does better, period

Being honest about the other side of the ledger, since it's the list you should read before migrating a team:

- **Mobile.** Native apps with push notifications beat a responsive web page, and Flow only has the web page.
- **Breadth.** Gantt, workload, time tracking, forms, docs, goals, dashboards — Flow's answer to each is "no", and for some teams one of those is load-bearing.
- **Scale and multi-tenancy.** One workspace, one Durable Object, one team. SaaS runs org hierarchies with thousands of seats and cross-team rollups.
- **Somebody else's pager.** When ClickUp is down, it's their incident. When your Flow deployment misbehaves, the runbook ([SELF_HOSTING.md](SELF_HOSTING.md)) is good, but the on-call is you.
- **Ecosystem.** Zapier/Make connectors, Slack apps, SSO catalogs, template galleries. Flow gives you webhooks in both directions and an MCP server, which composes further but arrives batteries-not-included.
- **Guest and client access.** SaaS tools have mature guest roles; Flow's model is members, with private spaces as the only visibility boundary.

## The bottom line

Flow is the right call when a small team wants ClickUp/Asana's core loop — boards, tasks, comments, automations — at effectively zero marginal cost, with the data in their own account and agents as first-class, audited users. It's the wrong call for mobile-first teams, for anyone whose workflow depends on the features it deliberately omits, and for orgs that need a vendor to hold the pager.
