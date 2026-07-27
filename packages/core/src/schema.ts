import { AUTOMATION_MIGRATIONS, type Migration } from "./automation/migrations.js";
import { id } from "./id.js";

// ---------------------------------------------------------------------------
// SQLite schema + forward-only migrations.
//
// Applied ids live in `_migrations`. The constructor does exactly ONE SELECT
// against it (see `needsMigration`) — a COUNT compared against the number of
// known migrations — and returns immediately when the schema is up to date, so
// waking the DO stays cheap.
//
// Each migration is a list of individual statements: DO's `sql.exec` is
// happiest with one statement per call, and CREATE TRIGGER bodies contain
// their own semicolons.
//
// The automation engine owns `automation_rules`, `automation_runs` and
// `automation_due_fires`; its migrations are appended after the base set.
// ---------------------------------------------------------------------------

const BASE_STATEMENTS: string[] = [
  // --- users -------------------------------------------------------------
  // `needs_email_update` and `clickup_id` are storage-only columns (not part
  // of the shared User contract): the first flags placeholder emails from the
  // ClickUp import, the second keeps importBatch idempotent.
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL,
     name TEXT NOT NULL,
     role TEXT NOT NULL,
     deactivated INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     needs_email_update INTEGER NOT NULL DEFAULT 0,
     clickup_id TEXT
   )`,
  `CREATE UNIQUE INDEX idx_users_email ON users (lower(email))`,
  `CREATE UNIQUE INDEX idx_users_clickup ON users (clickup_id) WHERE clickup_id IS NOT NULL`,

  // --- spaces ------------------------------------------------------------
  `CREATE TABLE spaces (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     color TEXT,
     position REAL NOT NULL,
     archived INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     clickup_id TEXT
   )`,
  `CREATE UNIQUE INDEX idx_spaces_clickup ON spaces (clickup_id) WHERE clickup_id IS NOT NULL`,

  // --- lists + statuses --------------------------------------------------
  `CREATE TABLE lists (
     id TEXT PRIMARY KEY,
     space_id TEXT NOT NULL,
     name TEXT NOT NULL,
     position REAL NOT NULL,
     archived INTEGER NOT NULL DEFAULT 0,
     inbound_token TEXT,
     created_at INTEGER NOT NULL,
     clickup_id TEXT
   )`,
  `CREATE INDEX idx_lists_space ON lists (space_id, position)`,
  `CREATE UNIQUE INDEX idx_lists_clickup ON lists (clickup_id) WHERE clickup_id IS NOT NULL`,
  `CREATE UNIQUE INDEX idx_lists_inbound ON lists (inbound_token) WHERE inbound_token IS NOT NULL`,

  // Statuses are per-list and ordered. Name uniqueness within a list is
  // enforced in code first, so callers get a descriptive error rather than a
  // constraint code; idx_statuses_name (migration 0002) is the backstop.
  `CREATE TABLE statuses (
     id TEXT PRIMARY KEY,
     list_id TEXT NOT NULL,
     name TEXT NOT NULL,
     color TEXT NOT NULL,
     type TEXT NOT NULL,
     position REAL NOT NULL
   )`,
  `CREATE INDEX idx_statuses_list ON statuses (list_id, position)`,

  // --- tasks -------------------------------------------------------------
  // `tags` is the JSON array returned over the wire; `tags_text` is a
  // lowercased `|a|b|` denormalization so tag filters are a plain LIKE and
  // never depend on the JSON1 extension.
  `CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     list_id TEXT NOT NULL,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     status_id TEXT NOT NULL,
     assignee_id TEXT,
     priority TEXT,
     due_date INTEGER,
     start_date INTEGER,
     tags TEXT NOT NULL DEFAULT '[]',
     tags_text TEXT NOT NULL DEFAULT '|',
     position REAL NOT NULL,
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     closed_at INTEGER,
     clickup_id TEXT
   )`,
  `CREATE INDEX idx_tasks_list_status ON tasks (list_id, status_id, position)`,
  `CREATE INDEX idx_tasks_assignee ON tasks (assignee_id)`,
  `CREATE INDEX idx_tasks_due ON tasks (due_date)`,
  `CREATE INDEX idx_tasks_closed ON tasks (closed_at)`,
  `CREATE INDEX idx_tasks_updated ON tasks (updated_at)`,
  `CREATE UNIQUE INDEX idx_tasks_clickup ON tasks (clickup_id) WHERE clickup_id IS NOT NULL`,

  // --- subtasks / comments / attachments ---------------------------------
  `CREATE TABLE subtasks (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     title TEXT NOT NULL,
     done INTEGER NOT NULL DEFAULT 0,
     assignee_id TEXT,
     due_date INTEGER,
     position REAL NOT NULL,
     created_at INTEGER NOT NULL,
     clickup_id TEXT
   )`,
  `CREATE INDEX idx_subtasks_task ON subtasks (task_id, position)`,
  `CREATE UNIQUE INDEX idx_subtasks_clickup ON subtasks (clickup_id) WHERE clickup_id IS NOT NULL`,

  `CREATE TABLE comments (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     author_id TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     clickup_id TEXT
   )`,
  `CREATE INDEX idx_comments_task ON comments (task_id, created_at)`,
  `CREATE UNIQUE INDEX idx_comments_clickup ON comments (clickup_id) WHERE clickup_id IS NOT NULL`,

  `CREATE TABLE attachments (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     filename TEXT NOT NULL,
     r2_key TEXT NOT NULL,
     size INTEGER NOT NULL,
     mime_type TEXT NOT NULL,
     uploaded_by TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX idx_attachments_task ON attachments (task_id, created_at)`,

  // --- api keys ----------------------------------------------------------
  // Only the sha256 hex of the bearer token is ever stored.
  `CREATE TABLE api_keys (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     name TEXT NOT NULL,
     token_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER,
     revoked_at INTEGER
   )`,
  `CREATE UNIQUE INDEX idx_api_keys_hash ON api_keys (token_hash)`,
  `CREATE INDEX idx_api_keys_user ON api_keys (user_id)`,

  // --- automations -------------------------------------------------------
  // Read by the automation engine, which selects exactly these columns:
  // id, name, enabled, scope, trigger, conditions, actions, created_at,
  // updated_at — with scope/trigger/conditions/actions as JSON TEXT. The
  // scope_kind/scope_id/trigger_kind extras are ours, for cheap filtering.
  // Keep this shape stable; ./automation/migrations.ts deliberately does not
  // duplicate it.
  `CREATE TABLE automation_rules (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 0,
     scope TEXT NOT NULL,
     scope_kind TEXT NOT NULL,
     scope_id TEXT NOT NULL,
     trigger TEXT NOT NULL,
     trigger_kind TEXT NOT NULL,
     conditions TEXT NOT NULL DEFAULT '[]',
     actions TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX idx_rules_lookup ON automation_rules (enabled, created_at)`,
  `CREATE INDEX idx_rules_scope ON automation_rules (scope_kind, scope_id)`,

  // Written by the engine's writeRunLog().
  `CREATE TABLE automation_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     rule_id TEXT NOT NULL,
     task_id TEXT NOT NULL,
     trigger TEXT NOT NULL,
     results TEXT NOT NULL,
     depth INTEGER NOT NULL DEFAULT 0,
     at INTEGER NOT NULL
   )`,
  `CREATE INDEX idx_runs_rule ON automation_runs (rule_id, at)`,
  `CREATE INDEX idx_runs_task ON automation_runs (task_id, at)`,

  // --- delta log ---------------------------------------------------------
  // `seq` is an INTEGER PRIMARY KEY, i.e. the rowid: reads by seq range and
  // ORDER BY seq already use the primary key, so no extra index on it.
  `CREATE TABLE changes (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     op TEXT NOT NULL,
     entity TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     data TEXT,
     actor_user_id TEXT NOT NULL,
     at INTEGER NOT NULL
   )`,
  `CREATE INDEX idx_changes_entity ON changes (entity, entity_id, seq)`,

  // --- audit -------------------------------------------------------------
  `CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     entity TEXT NOT NULL,
     diff TEXT,
     at INTEGER NOT NULL
   )`,
  `CREATE INDEX idx_audit_at ON audit (at)`,
  `CREATE INDEX idx_audit_entity ON audit (entity, at)`,

  // --- scheduled jobs (multiplexed behind the single DO alarm) -----------
  // `every_ms` non-null makes a job recurring: it is re-inserted after running.
  `CREATE TABLE scheduled_jobs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     payload TEXT,
     every_ms INTEGER,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX idx_jobs_run_at ON scheduled_jobs (run_at)`,

  // --- full-text search over task title + description --------------------
  // Standalone (not external-content) FTS table keyed by task id; the
  // triggers below are the only thing that writes it.
  `CREATE VIRTUAL TABLE tasks_fts USING fts5(
     task_id UNINDEXED, title, description, tokenize = 'unicode61'
   )`,
  `CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
     INSERT INTO tasks_fts (task_id, title, description)
     VALUES (new.id, new.title, new.description);
   END`,
  `CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
     DELETE FROM tasks_fts WHERE task_id = old.id;
   END`,
  `CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, description ON tasks BEGIN
     DELETE FROM tasks_fts WHERE task_id = old.id;
     INSERT INTO tasks_fts (task_id, title, description)
     VALUES (new.id, new.title, new.description);
   END`,
];

// Denormalized actor columns so getAuditLog can filter by user or API key
// without JSON extraction on every row. `actor` stays the full record.
const AUDIT_ACTOR_COLUMNS: string[] = [
  `ALTER TABLE audit ADD COLUMN actor_user_id TEXT`,
  `ALTER TABLE audit ADD COLUMN api_key_id TEXT`,
  `CREATE INDEX idx_audit_actor ON audit (actor_user_id, at)`,
  `CREATE INDEX idx_audit_api_key ON audit (api_key_id, at)`,
  `CREATE INDEX idx_audit_action ON audit (action, at)`,
  // Backstop for the invariant every write path already enforces in code:
  // status names are unique per list, case-insensitively. Clients resolve
  // name -> id locally, so a duplicate would misroute tasks.
  `CREATE UNIQUE INDEX idx_statuses_name ON statuses (list_id, lower(name))`,
];

// Per-space permissions. `visibility` defaults to 'workspace', so every space
// that already exists stays visible to everyone and nothing needs backfilling.
// `created_by` is storage-only (not part of the shared Space contract): it is
// who gets auto-added as a member when a space is flipped to private, and it is
// NULL for spaces created before this migration or by the ClickUp import.
const SPACE_VISIBILITY: string[] = [
  `ALTER TABLE spaces ADD COLUMN visibility TEXT NOT NULL DEFAULT 'workspace'`,
  `ALTER TABLE spaces ADD COLUMN created_by TEXT`,
  // Membership only means anything for private spaces; rows on a
  // workspace-visible space are harmless and survive a flip back to private.
  `CREATE TABLE space_members (
     space_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (space_id, user_id)
   )`,
  `CREATE INDEX idx_space_members_user ON space_members (user_id)`,
];

// Per-user email-notification preferences (see packages/shared/notifications).
// One row per user, prefs as a JSON blob of the NotificationPref booleans; a
// missing row means "defaults", so reads never require a prior write. IF NOT
// EXISTS so it is a no-op on an instance that already has the table.
const NOTIFICATION_PREFS: string[] = [
  `CREATE TABLE IF NOT EXISTS notification_prefs (
     user_id TEXT PRIMARY KEY,
     prefs TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
];

// Snooze / waiting-on. Both columns are nullable with no default, so every
// existing task reads back as "not snoozed, no note" and nothing needs
// backfilling. SQLite's ALTER TABLE has no IF NOT EXISTS, so the guard against
// running these twice is the migration runner's applied-id set — which is also
// why this needs its own id rather than being folded into an existing one.
const SNOOZE: string[] = [
  `ALTER TABLE tasks ADD COLUMN snoozed_until INTEGER`,
  `ALTER TABLE tasks ADD COLUMN blocked_note TEXT`,
  // The hourly wake sweep reads snoozed rows oldest-first; partial so the index
  // only ever holds the handful of tasks that are actually parked.
  `CREATE INDEX idx_tasks_snoozed ON tasks (snoozed_until) WHERE snoozed_until IS NOT NULL`,
];

/** Base schema first, then the automation engine's tables, then notifications. */
export const MIGRATIONS: readonly Migration[] = [
  { id: "core-0001-initial", statements: BASE_STATEMENTS },
  { id: "core-0002-audit-actor-columns", statements: AUDIT_ACTOR_COLUMNS },
  { id: "core-0003-space-visibility", statements: SPACE_VISIBILITY },
  ...AUTOMATION_MIGRATIONS,
  { id: "core-0003-notification-prefs", statements: NOTIFICATION_PREFS },
  { id: "core-0004-snooze", statements: SNOOZE },
];

/**
 * The one cheap SELECT the constructor makes: a COUNT on a table with at most
 * a handful of rows. False on the hot path, so no blockConcurrencyWhile.
 */
export function needsMigration(sql: SqlStorage): boolean {
  try {
    const { n } = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM _migrations").one();
    return n < MIGRATIONS.length;
  } catch {
    return true; // _migrations does not exist yet
  }
}

export function runMigrations(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS _migrations (
     id TEXT PRIMARY KEY,
     applied_at INTEGER NOT NULL
   )`);
  const applied = new Set(
    sql.exec<{ id: string }>("SELECT id FROM _migrations").toArray().map((r) => r.id)
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    for (const stmt of m.statements) sql.exec(stmt);
    sql.exec("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)", m.id, Date.now());
  }
}

// ---------------------------------------------------------------------------
// Seed. Runs after migrations and only when `users` is empty. One bootstrap
// owner, no spaces and no lists — imports or the UI create those.
//
// The seed is static SQL (no env access here), so the owner gets a placeholder
// email flagged `needs_email_update`. Bootstrap is automatic: the first time
// the configured OWNER_EMAIL authenticates (Access, or DEV_NO_AUTH locally),
// the API's resolveMemberEmail lets it claim this seeded row via claimOwner —
// same user id, real email, flag cleared. Notifications are skipped for
// placeholder emails, so nothing is sent until the address is real.
// ---------------------------------------------------------------------------

export const PLACEHOLDER_EMAIL_DOMAIN = "placeholder.flow";

export function seedIfEmpty(sql: SqlStorage, now = Date.now()): void {
  const { n } = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM users").one();
  if (n > 0) return;

  sql.exec(
    `INSERT INTO users (id, email, name, role, deactivated, created_at, needs_email_update)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    id("us_"),
    `owner@${PLACEHOLDER_EMAIL_DOMAIN}`,
    "Workspace Owner",
    "owner",
    now,
    1
  );
}

/** Recurring maintenance jobs, installed once. */
export function seedJobs(sql: SqlStorage, now = Date.now()): void {
  const { n } = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM scheduled_jobs").one();
  if (n > 0) return;
  const DAY = 86_400_000;
  // Next 09:00 UTC and next 13:00 UTC (~08:00 ET, before the workday).
  const next = (hourUtc: number): number => {
    const d = new Date(now);
    d.setUTCHours(hourUtc, 0, 0, 0);
    return d.getTime() <= now ? d.getTime() + DAY : d.getTime();
  };
  sql.exec(
    "INSERT INTO scheduled_jobs (run_at, kind, payload, every_ms, created_at) VALUES (?, ?, NULL, ?, ?)",
    next(9),
    "prune_changes",
    DAY,
    now
  );
  // Hourly: the engine's (rule, task, dueDate) fired-guard makes the sweep
  // idempotent, and hourly keeps a reminder from being up to a day late.
  sql.exec(
    "INSERT INTO scheduled_jobs (run_at, kind, payload, every_ms, created_at) VALUES (?, ?, NULL, ?, ?)",
    now + 3_600_000,
    "due_date_check",
    3_600_000,
    now
  );
}
