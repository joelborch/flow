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

// Drive is the canonical location only after the monthly migration has
// uploaded and verified the file. The original R2 key stays on the row for
// audit and idempotent cleanup; `cleanup_pending` means the Drive link is live
// but the source object has not yet been confirmed absent.
const ATTACHMENT_DRIVE_STORAGE: string[] = [
  `ALTER TABLE attachments ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'r2'`,
  `ALTER TABLE attachments ADD COLUMN drive_file_id TEXT`,
  `ALTER TABLE attachments ADD COLUMN drive_web_view_link TEXT`,
  `ALTER TABLE attachments ADD COLUMN drive_destination TEXT`,
  `ALTER TABLE attachments ADD COLUMN migration_state TEXT NOT NULL DEFAULT 'r2'`,
  `CREATE INDEX idx_attachments_migration ON attachments (storage_provider, migration_state)`,
];

// Tiny key/value table for sync bookkeeping. Its one current row is the
// resync floor (see ./sync-floor.ts): delta-less mutations (importBatch,
// setSpaceMembers, setSpaceVisibility) invalidate delta replay, and the floor
// is what tells the hello handler to fall back to a full snapshot. IF NOT
// EXISTS so it is a no-op on an instance that already has the table.
// The space a delta belongs to, stamped at emit time. Replay filtering used
// to re-resolve each delta's space with live task/list/comment lookups, which
// return null once the row is deleted — and null was treated as "visible to
// everyone", so a reconnecting member could replay create-deltas (full row
// JSON) for rows that lived and died in a private space they cannot see.
// Nullable: rows written before this migration stay null and fall back to
// live resolution (see filterReplay in index.ts), failing closed for
// space-scoped entities when that also resolves nothing.
const CHANGES_SPACE_ID: string[] = [
  `ALTER TABLE changes ADD COLUMN space_id TEXT`,
];

const SYNC_META: string[] = [
  `CREATE TABLE IF NOT EXISTS sync_meta (
     key TEXT PRIMARY KEY,
     value INTEGER NOT NULL
   )`,
];

// R2 objects awaiting deletion after the row that named them (an `attachments`
// row) is already gone. deleteTask (and any future list/space cascade that
// drops attachments) writes the key here in the same turn it deletes the row,
// so the key survives even if the request never reaches the R2 delete: a
// route's waitUntil clears the row once the object is actually gone, and the
// daily backup job sweeps whatever is still here as a fallback.
const PENDING_OBJECT_DELETES: string[] = [
  `CREATE TABLE pending_object_deletes (
     r2_key TEXT PRIMARY KEY,
     enqueued_at INTEGER NOT NULL
   )`,
];

/**
 * Base schema first, then the automation engine's tables, then notifications.
 *
 * WARNING: migration ids are permanent once shipped — they are recorded
 * verbatim in `_migrations` on every live workspace. Renaming or removing an
 * id here does not "fix" it; it makes a workspace that already applied the
 * old id look like it never ran that migration (or, worse, look up to date
 * while skipping a genuinely new one — see needsMigration below). Two ids
 * below share the "core-0003" prefix (space-visibility and
 * notification-prefs) purely from numbering drift; they are intentionally
 * left alone rather than "fixed" because both are already recorded in prod.
 */
/**
 * Pre-0007 `changes` rows have no stored space_id, so filterReplay's
 * fail-closed fallback would withhold delete-deltas for already-deleted
 * entities from members even in spaces they can see. When this migration
 * first applies, index.ts bumps the resync floor to the then-current
 * MAX(seq): every client's next hello takes one full snapshot instead of
 * replaying the ambiguous rows.
 */
export const CHANGES_SPACE_ID_MIGRATION_ID = "core-0007-changes-space-id";

export const MIGRATIONS: readonly Migration[] = [
  { id: "core-0001-initial", statements: BASE_STATEMENTS },
  { id: "core-0002-audit-actor-columns", statements: AUDIT_ACTOR_COLUMNS },
  { id: "core-0003-space-visibility", statements: SPACE_VISIBILITY },
  ...AUTOMATION_MIGRATIONS,
  { id: "core-0003-notification-prefs", statements: NOTIFICATION_PREFS },
  { id: "core-0004-snooze", statements: SNOOZE },
  { id: "core-0005-attachment-drive-storage", statements: ATTACHMENT_DRIVE_STORAGE },
  { id: "core-0006-sync-meta", statements: SYNC_META },
  { id: CHANGES_SPACE_ID_MIGRATION_ID, statements: CHANGES_SPACE_ID },
  { id: "core-0008-pending-object-deletes", statements: PENDING_OBJECT_DELETES },
];

/**
 * The one cheap SELECT the constructor makes: a COUNT on a table with at most
 * a handful of rows. False on the hot path, so no blockConcurrencyWhile.
 *
 * Checks that every known migration id is present in `_migrations`, not just
 * that the counts line up — a COUNT comparison would let a renamed/removed
 * migration id silently mask a genuinely new one (count still >= length).
 */
export function needsMigration(sql: SqlStorage): boolean {
  try {
    const applied = new Set(
      sql.exec<{ id: string }>("SELECT id FROM _migrations").toArray().map((r) => r.id)
    );
    return MIGRATIONS.some((m) => !applied.has(m.id));
  } catch {
    return true; // _migrations does not exist yet
  }
}

/**
 * Wraps one migration's statements in an atomic transaction. In production
 * this is `(fn) => ctx.storage.transactionSync(fn)` — workerd rejects explicit
 * SAVEPOINT/BEGIN through `sql.exec` ("please use state.storage.transaction()
 * or transactionSync()"), so the DO's own transaction API is the ONLY way to
 * get atomicity there. `transactionSync<T>(closure: () => T): T` commits on
 * return and rolls back automatically when the closure throws (the exception
 * propagates to the caller). Tests run against node:sqlite, where explicit
 * savepoints ARE legal, and pass a savepoint-based wrapper instead.
 */
export type MigrationTxn = (fn: () => void) => void;

/** Returns the ids of migrations that were newly applied by this call. */
export function runMigrations(sql: SqlStorage, txn: MigrationTxn): string[] {
  sql.exec(`CREATE TABLE IF NOT EXISTS _migrations (
     id TEXT PRIMARY KEY,
     applied_at INTEGER NOT NULL
   )`);
  return applyMigrations(sql, MIGRATIONS, txn);
}

/**
 * Applies each not-yet-applied migration's statements and its `_migrations`
 * insert inside one `txn(...)` call. If any statement throws, the transaction
 * wrapper rolls back before the error propagates, so a mid-migration failure
 * (e.g. statement 3 of 5 ALTER TABLEs) leaves the schema exactly as it was
 * before that migration started — no partially-applied DDL, no `_migrations`
 * row for it. A retry after a code fix then applies the whole migration
 * cleanly instead of re-running already-committed statements into "duplicate
 * column name".
 *
 * Exported (in addition to runMigrations, its production entry point) so
 * tests can exercise the rollback behavior with a throwaway migration list
 * without touching the real schema. Returns the newly-applied migration ids
 * so the caller can run one-shot follow-ups (see the resync-floor bump for
 * CHANGES_SPACE_ID_MIGRATION_ID in index.ts).
 */
export function applyMigrations(
  sql: SqlStorage,
  migrations: readonly Migration[],
  txn: MigrationTxn
): string[] {
  const applied = new Set(
    sql.exec<{ id: string }>("SELECT id FROM _migrations").toArray().map((r) => r.id)
  );
  const newlyApplied: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    txn(() => {
      for (const stmt of m.statements) sql.exec(stmt);
      sql.exec("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)", m.id, Date.now());
    });
    newlyApplied.push(m.id);
  }
  return newlyApplied;
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

/**
 * Recurring maintenance jobs, ensured per kind rather than installed once: a
 * whole-table "is scheduled_jobs empty?" guard meant a workspace that already
 * had prune_changes + due_date_check would never pick up a job kind added
 * later (the backup job shipped exactly that way — dead code on every
 * existing workspace). Each seed now inserts only when no recurring row of
 * its kind exists, so existing rows — and their next `run_at` — are never
 * touched, and re-running this on every boot is a cheap idempotent no-op.
 * `every_ms IS NOT NULL` scopes the guard to recurring rows, so a pending
 * one-off of the same kind (scheduleJob) can't suppress the recurring seed.
 *
 * Returns how many jobs were inserted so the caller knows to re-arm the alarm.
 */
export function seedJobs(sql: SqlStorage, now = Date.now()): number {
  const DAY = 86_400_000;
  // Next occurrence of a fixed UTC hour.
  const next = (hourUtc: number): number => {
    const d = new Date(now);
    d.setUTCHours(hourUtc, 0, 0, 0);
    return d.getTime() <= now ? d.getTime() + DAY : d.getTime();
  };
  const jobs: Array<{ kind: string; runAt: number; everyMs: number }> = [
    // 09:00 UTC (~08:00 ET, before the workday).
    { kind: "prune_changes", runAt: next(9), everyMs: DAY },
    // Hourly: the engine's (rule, task, dueDate) fired-guard makes the sweep
    // idempotent, and hourly keeps a reminder from being up to a day late.
    { kind: "due_date_check", runAt: now + 3_600_000, everyMs: 3_600_000 },
    // Off-peak UTC hour, away from the 09:00 job above.
    { kind: "backup", runAt: next(5), everyMs: DAY },
  ];
  let inserted = 0;
  for (const job of jobs) {
    const { n } = sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM scheduled_jobs WHERE kind = ? AND every_ms IS NOT NULL",
        job.kind
      )
      .one();
    if (n > 0) continue;
    sql.exec(
      "INSERT INTO scheduled_jobs (run_at, kind, payload, every_ms, created_at) VALUES (?, ?, NULL, ?, ?)",
      job.runAt,
      job.kind,
      job.everyMs,
      now
    );
    inserted += 1;
  }
  return inserted;
}
