import type { Actor, AutomationRule } from "@flow/shared";
import { alarmLog } from "./alarm-observability.js";
import { automationContext } from "./automation-apply.js";
import { pruneDueFires, sweepDueDateAutomations } from "./automation/schedule.js";
import type { AutomationScheduleContext } from "./automation/types.js";
import {
  AUDIT_PRUNE_BATCH,
  AUDIT_PRUNE_MAX_BATCHES,
  AUDIT_RETENTION_DAYS,
  AUTOMATION_RUNS_RETENTION,
  BACKUP_RETENTION,
  BACKUP_STALE_MS,
  type BackupStatus,
  CHANGES_RETENTION,
  DAY_MS,
  type WorkspaceHost,
  safeJson,
  systemUserId,
} from "./db-helpers.js";
import type { JobRow } from "./rows.js";
import { type SnoozedRow, WAKE_SWEEP_LIMIT, wakeCandidates } from "./snooze.js";
import { applyTaskUpdate } from "./task-mutations.js";

// =========================================================================
// Alarm: one alarm multiplexes every scheduled job
// =========================================================================

export async function handleAlarm(
  host: WorkspaceHost,
  alarmInfo?: AlarmInvocationInfo
): Promise<void> {
  const alarmStartedAt = Date.now();
  const now = Date.now();
  // Oldest first, except the backup always goes last: it is the one job
  // heavy enough to kill the isolate (it holds every table in memory), so
  // everything else due in this alarm has already run if it does.
  const jobs = host.sql
    .exec<JobRow>(
      `SELECT id, run_at, kind, payload, every_ms FROM scheduled_jobs
       WHERE run_at <= ? ORDER BY kind = 'backup', run_at LIMIT 100`,
      now
    )
    .toArray();
  console.log(
    alarmLog({
      event: "flow.alarm.start",
      due_jobs: jobs.length,
      is_retry: alarmInfo?.isRetry ?? false,
      retry_count: alarmInfo?.retryCount ?? 0,
      scheduled_time: alarmInfo?.scheduledTime ?? now,
    })
  );

  let completed = 0;
  let failed = 0;
  for (const job of jobs) {
    // Claim the job BEFORE running it, and wait for that write to be
    // durable. A job that kills the isolate outright (OOM, CPU limit) never
    // reaches the catch below, so if the reschedule came after the await,
    // every alarm retry would pick the same job again and starve the rest.
    // Claimed first, a crash costs only that one run.
    claimJob(host.sql, job, now);
    await host.ctx.storage.sync();

    const jobStartedAt = Date.now();
    let result: Record<string, number> = { processed: 0 };
    let status = "ok";
    try {
      result = await runJob(host, job, now);
      completed += 1;
    } catch (err) {
      // Alarms retry; a poisoned job must not wedge the whole schedule.
      status = "error";
      failed += 1;
      console.error("scheduled job failed", job.kind, err);
    } finally {
      console.log(
        alarmLog({
          event: "flow.alarm.job",
          job_id: job.id,
          job_kind: job.kind,
          status,
          duration_ms: Math.max(0, Date.now() - jobStartedAt),
          ...result,
        })
      );
    }
  }

  host.armedAlarm = null;
  await host.armAlarm();
  console.log(
    alarmLog({
      event: "flow.alarm.finish",
      due_jobs: jobs.length,
      completed,
      failed,
      duration_ms: Math.max(0, Date.now() - alarmStartedAt),
    })
  );
}

/** Queue a one-off job; automations can use this via ctx.sql too. */
export function scheduleJob(
  host: WorkspaceHost,
  input: { runAt: number; kind: string; payload?: unknown; everyMs?: number }
): void {
  host.sql.exec(
    "INSERT INTO scheduled_jobs (run_at, kind, payload, every_ms, created_at) VALUES (?, ?, ?, ?, ?)",
    input.runAt,
    input.kind,
    input.payload === undefined ? null : JSON.stringify(input.payload),
    input.everyMs ?? null,
    Date.now()
  );
  host.ctx.waitUntil(host.armAlarm());
}

/** Manual trigger for the daily backup (admin route); same code path as the
 *  scheduled job, including the prune, the orphan sweep and the outcome
 *  recorded in `job_status`. */
export function runBackupNow(host: WorkspaceHost): Promise<Record<string, number>> {
  return runBackup(host, Date.now());
}

/**
 * The backup's last recorded outcome. `stale` compares against `now`, so it
 * also catches a backup that stopped running without ever reporting a
 * failure (an isolate killed mid-dump never reaches the catch). The error
 * text and object key are for admins; /api/health exposes only the times
 * and the flag.
 */
export function getBackupStatus(sql: SqlStorage, now: number = Date.now()): BackupStatus {
  const row = sql
    .exec<{
      last_success_at: number | null;
      last_success_detail: string | null;
      last_failure_at: number | null;
      last_failure_error: string | null;
    }>(
      `SELECT last_success_at, last_success_detail, last_failure_at, last_failure_error
       FROM job_status WHERE kind = 'backup'`
    )
    .toArray()[0];
  const lastSuccessAt = row?.last_success_at ?? null;
  const detail =
    row?.last_success_detail != null
      ? (safeJson(row.last_success_detail) as BackupStatus["lastSuccess"])
      : null;
  return {
    lastSuccessAt,
    lastSuccess: detail,
    lastFailureAt: row?.last_failure_at ?? null,
    lastFailureError: row?.last_failure_error ?? null,
    stale: lastSuccessAt === null || now - lastSuccessAt > BACKUP_STALE_MS,
  };
}

export async function armAlarm(host: WorkspaceHost): Promise<void> {
  const { next } = host.sql
    .exec<{ next: number | null }>("SELECT MIN(run_at) AS next FROM scheduled_jobs")
    .one();
  if (next === null) {
    host.armedAlarm = null;
    return;
  }
  if (host.armedAlarm === next) return;
  const current = await host.ctx.storage.getAlarm();
  if (current === null || current > next) await host.ctx.storage.setAlarm(next);
  host.armedAlarm = next;
}

/**
 * Take a due job off the schedule: a one-off is deleted, a recurring one is
 * advanced to its next slot. At-most-once per slot, whatever the outcome.
 */
function claimJob(sql: SqlStorage, job: JobRow, now: number): void {
  if (job.every_ms !== null && job.every_ms > 0) {
    let nextRun = job.run_at + job.every_ms;
    // Skip missed intervals rather than firing a backlog.
    while (nextRun <= now) nextRun += job.every_ms;
    sql.exec("UPDATE scheduled_jobs SET run_at = ? WHERE id = ?", nextRun, job.id);
  } else {
    sql.exec("DELETE FROM scheduled_jobs WHERE id = ?", job.id);
  }
}

export async function runJob(host: WorkspaceHost, job: JobRow, now: number): Promise<Record<string, number>> {
  switch (job.kind) {
    case "prune_changes": {
      const changes = pruneChanges(host);
      const runs = pruneAutomationRuns(host.sql);
      const audit = pruneAudit(host.sql, now);
      return {
        changes_pruned: changes,
        automation_runs_pruned: runs,
        audit_pruned: audit,
        processed: changes + runs + audit,
      };
    }
    case "backup":
      return runBackup(host, now);
    case "due_date_check": {
      // The hourly maintenance tick. It carries the snooze wake pass too —
      // piggybacking on the existing hourly job is simpler than a second
      // recurring job with its own schedule.
      const due = runDueDateCheck(host, now);
      const woken = runSnoozeWake(host, now);
      return {
        processed: due.firings.length + woken,
        rules_considered: due.rulesConsidered,
        candidates_inspected: due.candidatesInspected,
        firings: due.firings.length,
        woken,
      };
    }
    case "snooze_wake": {
      // Explicitly schedulable too, for a targeted catch-up.
      const woken = runSnoozeWake(host, now);
      return { processed: woken, woken };
    }
    default:
      console.error("unknown scheduled job kind", job.kind);
      return { processed: 0 };
  }
}

function pruneChanges(host: WorkspaceHost): number {
  const floor = host.maxSeq() - CHANGES_RETENTION;
  if (floor <= 0) return 0;
  return host.sql.exec("DELETE FROM changes WHERE seq <= ?", floor).rowsWritten;
}

function pruneAutomationRuns(sql: SqlStorage): number {
  const row = sql.exec("SELECT MAX(id) AS maxId FROM automation_runs").one() as { maxId: number | null } | undefined;
  const floor = (row?.maxId ?? 0) - AUTOMATION_RUNS_RETENTION;
  if (floor <= 0) return 0;
  return sql.exec("DELETE FROM automation_runs WHERE id <= ?", floor).rowsWritten;
}

/**
 * Deletes audit rows older than AUDIT_RETENTION_DAYS, oldest first, in
 * batches of AUDIT_PRUNE_BATCH and at most AUDIT_PRUNE_MAX_BATCHES per run.
 * The inner SELECT walks `idx_audit_at` and the outer DELETE is by rowid.
 * RETURNING gives an exact count; rowsWritten would include index writes.
 */
function pruneAudit(sql: SqlStorage, now: number): number {
  const cutoff = now - AUDIT_RETENTION_DAYS * DAY_MS;
  let deleted = 0;
  for (let batch = 0; batch < AUDIT_PRUNE_MAX_BATCHES; batch++) {
    const n = sql
      .exec(
        `DELETE FROM audit WHERE id IN (
           SELECT id FROM audit WHERE at < ? ORDER BY at LIMIT ?
         ) RETURNING id`,
        cutoff,
        AUDIT_PRUNE_BATCH
      )
      .toArray().length;
    deleted += n;
    if (n < AUDIT_PRUNE_BATCH) break;
  }
  return deleted;
}

/**
 * Dumps every user table to gzipped NDJSON in R2 (`backups/YYYY-MM-DD.ndjson.gz`,
 * one `{"table":...,"row":...}` line per row) and prunes to the newest 30
 * objects under `backups/`. The outcome lands in `job_status` either way: a
 * success once the object is in R2, a failure (then rethrown to alarm()'s
 * per-job catch) if the dump, the put, or the post-backup cleanup throws.
 * alarm() has already advanced the job to tomorrow before this runs.
 */
async function runBackup(host: WorkspaceHost, now: number): Promise<Record<string, number>> {
  let written: string | null = null;
  try {
    const tables = backupTableNames(host.sql);
    let rows = 0;
    const lines: string[] = [];
    for (const table of tables) {
      const tableRows = host.sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM ${table}`).toArray();
      for (const row of tableRows) {
        lines.push(JSON.stringify({ table, row }));
        rows += 1;
      }
    }
    const ndjson = lines.length > 0 ? lines.join("\n") + "\n" : "";
    const gz = await gzipText(ndjson);
    const key = `backups/${backupDateKey(now)}.ndjson.gz`;
    await host.env.ATTACHMENTS.put(key, gz);
    written = key;
    recordJobOutcome(host.sql, "backup", now, { success: { key, rows, bytes: gz.byteLength } });
    const pruned = await pruneOldBackups(host.env.ATTACHMENTS, BACKUP_RETENTION);
    const sweptDeletes = await sweepPendingObjectDeletes(host);
    return { processed: rows, tables: tables.length, bytes: gz.byteLength, pruned, sweptDeletes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordJobOutcome(host.sql, "backup", now, {
      failure:
        written === null ? message : `${written} was written, but post-backup cleanup failed: ${message}`,
    });
    throw err;
  }
}

/**
 * Upsert one job kind's row in `job_status`. Never throws: failing to
 * record an outcome must not turn a good backup into a failed job.
 */
function recordJobOutcome(
  sql: SqlStorage,
  kind: string,
  at: number,
  outcome: { success: Record<string, unknown> } | { failure: string }
): void {
  try {
    if ("success" in outcome) {
      sql.exec(
        `INSERT INTO job_status (kind, last_success_at, last_success_detail) VALUES (?, ?, ?)
         ON CONFLICT (kind) DO UPDATE SET
           last_success_at = excluded.last_success_at,
           last_success_detail = excluded.last_success_detail`,
        kind,
        at,
        JSON.stringify(outcome.success)
      );
    } else {
      sql.exec(
        `INSERT INTO job_status (kind, last_failure_at, last_failure_error) VALUES (?, ?, ?)
         ON CONFLICT (kind) DO UPDATE SET
           last_failure_at = excluded.last_failure_at,
           last_failure_error = excluded.last_failure_error`,
        kind,
        at,
        outcome.failure.slice(0, 2_000)
      );
    }
  } catch (err) {
    console.error("cannot record job outcome", kind, err);
  }
}

/**
 * Fallback for R2 objects whose delete route never got to its waitUntil
 * (Worker evicted, request aborted) or whose clear-RPC never landed:
 * anything still in pending_object_deletes gets swept here. Piggybacked on
 * the daily backup job rather than its own alarm kind, because backup is
 * already the DO's one recurring job that touches the ATTACHMENTS binding
 * and a bounded cleanup pass doesn't need its own schedule. Capped per run
 * so a large backlog can't turn a daily job into an unbounded one; any
 * remainder just waits for tomorrow's run.
 */
async function sweepPendingObjectDeletes(host: WorkspaceHost): Promise<number> {
  const rows = host.sql
    .exec<{ r2_key: string }>("SELECT r2_key FROM pending_object_deletes ORDER BY enqueued_at LIMIT 200")
    .toArray();
  if (rows.length === 0) return 0;
  const keys = rows.map((r) => r.r2_key);
  await host.env.ATTACHMENTS.delete(keys);
  for (const key of keys) {
    host.sql.exec("DELETE FROM pending_object_deletes WHERE r2_key = ?", key);
  }
  return keys.length;
}

/**
 * due_date_approaching has no delta to hang off — nothing mutates when a
 * deadline gets closer — so the engine's sweep drives it. Any actions it
 * takes run inside this turn, which means their deltas broadcast normally.
 */
function runDueDateCheck(
  host: WorkspaceHost,
  now: number
): ReturnType<typeof sweepDueDateAutomations> {
  const actor: Actor = {
    userId: systemUserId(host.sql),
    via: "automation",
    apiKeyId: null,
    automationRuleId: null,
  };
  return host.runTurn(actor, (t) => {
    const ctx: AutomationScheduleContext = {
      ...automationContext(host, t, 0),
      listTaskIdsDueBetween: (scope, fromMs, toMs) => listTaskIdsDueBetween(host.sql, scope, fromMs, toMs),
    };
    const result = sweepDueDateAutomations(ctx, now);
    if (result.firings.length > 0) {
      t.audit("automation.due_sweep", "workspace", {
        rulesConsidered: result.rulesConsidered,
        candidatesInspected: result.candidatesInspected,
        firings: result.firings.length,
      });
    }
    pruneDueFires(ctx, now);
    return result;
  });
}

/**
 * Time-based wake. Every task whose snooze has run out gets `snoozedUntil`
 * cleared through the ordinary update path, so each one produces a real
 * changed-fields delta and an audit row — clients un-hide the card from the
 * socket patch, exactly as if a person had pressed "Wake now".
 *
 * The actor follows the due-date sweep: the owner's user id with
 * `via: "automation"`, which is what the audit trail reads as "the system did
 * this, nobody asked for it".
 */
function runSnoozeWake(host: WorkspaceHost, now: number): number {
  const rows = host.sql
    .exec<SnoozedRow>(
      `SELECT id, snoozed_until FROM tasks
       WHERE snoozed_until IS NOT NULL ORDER BY snoozed_until LIMIT ?`,
      WAKE_SWEEP_LIMIT
    )
    .toArray();
  const woken = wakeCandidates(rows, now);
  if (woken.length === 0) return 0;

  const actor: Actor = {
    userId: systemUserId(host.sql),
    via: "automation",
    apiKeyId: null,
    automationRuleId: null,
  };
  host.runTurn(actor, (t) => {
    for (const taskId of woken) {
      try {
        applyTaskUpdate(host, t, { taskId, snoozedUntil: null }, "task.wake");
      } catch (err) {
        // One bad row must not strand the rest of the sweep asleep.
        console.error("snooze wake failed", taskId, err);
      }
    }
    t.audit("task.wake_sweep", "workspace", { woken: woken.length });
  });
  return woken.length;
}

function listTaskIdsDueBetween(
  sql: SqlStorage,
  scope: AutomationRule["scope"],
  fromMs: number,
  toMs: number
): string[] {
  const query =
    scope.kind === "list"
      ? `SELECT id FROM tasks
           WHERE list_id = ? AND closed_at IS NULL
             AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ?`
      : `SELECT t.id AS id FROM tasks t JOIN lists l ON l.id = t.list_id
           WHERE l.space_id = ? AND t.closed_at IS NULL
             AND t.due_date IS NOT NULL AND t.due_date >= ? AND t.due_date <= ?`;
  return sql
    .exec<{ id: string }>(query, scope.kind === "list" ? scope.listId : scope.spaceId, fromMs, toMs)
    .toArray()
    .map((r) => r.id);
}

// --- daily backup ------------------------------------------------------

/** Every user table backed up, discovered from sqlite_master so a future
 *  migration's new table is picked up without touching this file. Excludes
 *  the internal `_migrations` bookkeeping table and the tasks_fts virtual
 *  table + its shadow tables — full-text search is derived from `tasks` and
 *  rebuilds itself via triggers, so backing it up would only bloat the file. */
function backupTableNames(sql: SqlStorage): string[] {
  const rows = sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .toArray();
  // Leading-underscore names cover our _migrations bookkeeping AND the
  // runtime's internal _cf_KV table, which sqlite_master exposes in prod but
  // SELECTing from is prohibited (this used to kill every backup).
  return rows.map((r) => r.name).filter((name) => !name.startsWith("_") && !name.startsWith("tasks_fts"));
}

async function gzipText(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** UTC calendar date, e.g. "2026-08-13" — sortable, and stable regardless of
 *  what wall-clock hour the job happens to run in. */
function backupDateKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Keys are `backups/YYYY-MM-DD.ndjson.gz`, so lexicographic order is
 *  chronological order — no need to read object metadata to find the
 *  newest ones. Returns how many objects were deleted. */
async function pruneOldBackups(bucket: R2Bucket, keep: number): Promise<number> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listing = await bucket.list({ prefix: "backups/", cursor });
    for (const obj of listing.objects) keys.push(obj.key);
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor !== undefined);
  keys.sort();
  const toDelete = keys.slice(0, Math.max(0, keys.length - keep));
  if (toDelete.length > 0) await bucket.delete(toDelete);
  return toDelete.length;
}
