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

export async function handleAlarm(
  host: WorkspaceHost,
  alarmInfo?: AlarmInvocationInfo
): Promise<void> {
  const alarmStartedAt = Date.now();
  const now = Date.now();
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
    claimJob(host.sql, job, now);
    await host.ctx.storage.sync();

    const jobStartedAt = Date.now();
    let result: Record<string, number> = { processed: 0 };
    let status = "ok";
    try {
      result = await runJob(host, job, now);
      completed += 1;
    } catch (err) {
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

export function runBackupNow(host: WorkspaceHost): Promise<Record<string, number>> {
  return runBackup(host, Date.now());
}

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

function claimJob(sql: SqlStorage, job: JobRow, now: number): void {
  if (job.every_ms !== null && job.every_ms > 0) {
    let nextRun = job.run_at + job.every_ms;
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

function backupTableNames(sql: SqlStorage): string[] {
  const rows = sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .toArray();
  return rows.map((r) => r.name).filter((name) => !name.startsWith("_") && !name.startsWith("tasks_fts"));
}

async function gzipText(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

function backupDateKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

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
