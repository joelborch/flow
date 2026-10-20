import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIT_PRUNE_BATCH,
  AUDIT_PRUNE_MAX_BATCHES,
  AUDIT_RETENTION_DAYS,
  AUTOMATION_RUNS_RETENTION,
  CHANGES_RETENTION,
} from "./index.js";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

function sqliteStorage(db: DatabaseSync): SqlStorage {
  const exec = (query: string, ...params: unknown[]): unknown => {
    const isRead = /^\s*SELECT/i.test(query) || /RETURNING/i.test(query);
    if (!isRead) {
      const result = db.prepare(query).run(...(params as never[])) as { changes?: number | bigint };
      return { toArray: () => [], one: () => undefined, rowsWritten: Number(result.changes ?? 0) };
    }
    const rows = db.prepare(query).all(...(params as never[]));
    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) throw new Error(`expected 1 row, got ${rows.length}`);
        return rows[0];
      },
    };
  };
  return { exec } as unknown as SqlStorage;
}

function fakeCtx(db: DatabaseSync): DurableObjectState {
  return {
    id: { toString: () => "do_test" },
    storage: {
      sql: sqliteStorage(db),
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      transactionSync: <T,>(fn: () => T): T => {
        db.prepare("SAVEPOINT _txn").run();
        try {
          const result = fn();
          db.prepare("RELEASE _txn").run();
          return result;
        } catch (err) {
          db.prepare("ROLLBACK TO _txn").run();
          db.prepare("RELEASE _txn").run();
          throw err;
        }
      },
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T> | T): Promise<T> => fn(),
    waitUntil: () => undefined,
    getWebSockets: () => [],
    acceptWebSocket: () => undefined,
  } as unknown as DurableObjectState;
}

async function freshWorkspace() {
  const { Workspace } = await import("./index.js");
  const db = new DatabaseSync(":memory:");
  const ctx = fakeCtx(db);
  const env = { ATTACHMENTS: {} } as never;
  return { ws: new Workspace(ctx, env), db };
}

describe("prune_changes job", () => {
  let ws: Awaited<ReturnType<typeof freshWorkspace>>["ws"];
  let db: DatabaseSync;

  beforeEach(async () => {
    ({ ws, db } = await freshWorkspace());
  });

  it("does not prune automation_runs when row count is below AUTOMATION_RUNS_RETENTION", async () => {
    db.prepare("BEGIN TRANSACTION").run();
    const insert = db.prepare(
      "INSERT INTO automation_runs (rule_id, task_id, trigger, results, depth, at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (let i = 1; i <= 50; i++) {
      insert.run("ar_test", "ta_test", "task_created", "[]", 0, Date.now());
    }
    db.prepare("COMMIT").run();

    const countBefore = db.prepare("SELECT COUNT(*) as c FROM automation_runs").all()[0] as { c: number };
    expect(countBefore.c).toBe(50);

    const now = Date.now();
    const result = await (ws as unknown as { runJob(job: unknown, now: number): Promise<Record<string, number>> }).runJob(
      { id: 1, run_at: now, kind: "prune_changes", payload: null, every_ms: 86_400_000 },
      now
    );

    expect(result).toEqual({
      changes_pruned: 0,
      automation_runs_pruned: 0,
      audit_pruned: 0,
      processed: 0,
    });

    const countAfter = db.prepare("SELECT COUNT(*) as c FROM automation_runs").all()[0] as { c: number };
    expect(countAfter.c).toBe(50);
  });

  it("prunes oldest automation_runs exceeding AUTOMATION_RUNS_RETENTION and retains newest", async () => {
    const totalRows = AUTOMATION_RUNS_RETENTION + 30; // 20,030 rows
    db.prepare("BEGIN TRANSACTION").run();
    const insert = db.prepare(
      "INSERT INTO automation_runs (id, rule_id, task_id, trigger, results, depth, at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    for (let i = 1; i <= totalRows; i++) {
      insert.run(i, "ar_test", "ta_test", "task_created", "[]", 0, 1000 + i);
    }
    db.prepare("COMMIT").run();

    const countBefore = db.prepare("SELECT COUNT(*) as c FROM automation_runs").all()[0] as { c: number };
    expect(countBefore.c).toBe(totalRows);

    const now = Date.now();
    const result = await (ws as unknown as { runJob(job: unknown, now: number): Promise<Record<string, number>> }).runJob(
      { id: 1, run_at: now, kind: "prune_changes", payload: null, every_ms: 86_400_000 },
      now
    );

    expect(result).toEqual({
      changes_pruned: 0,
      automation_runs_pruned: 30,
      audit_pruned: 0,
      processed: 30,
    });

    const countAfter = db.prepare("SELECT COUNT(*) as c FROM automation_runs").all()[0] as { c: number };
    expect(countAfter.c).toBe(AUTOMATION_RUNS_RETENTION);

    const minRow = db.prepare("SELECT MIN(id) as minId, MAX(id) as maxId FROM automation_runs").all()[0] as {
      minId: number;
      maxId: number;
    };
    // Oldest 30 rows (ids 1..30) deleted; ids 31..20030 remain
    expect(minRow.minId).toBe(31);
    expect(minRow.maxId).toBe(totalRows);
  });

  it("prunes both changes and automation_runs when both exceed their respective retention limits", async () => {
    const totalChanges = CHANGES_RETENTION + 15; // 50,015
    const totalRuns = AUTOMATION_RUNS_RETENTION + 25; // 20,025

    db.prepare("BEGIN TRANSACTION").run();
    const insertChange = db.prepare(
      "INSERT INTO changes (seq, op, entity, entity_id, data, actor_user_id, at, space_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (let i = 1; i <= totalChanges; i++) {
      insertChange.run(i, "create", "task", `ta_${i}`, "{}", "us_test", 1000 + i, "sp_test");
    }

    const insertRun = db.prepare(
      "INSERT INTO automation_runs (id, rule_id, task_id, trigger, results, depth, at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    for (let i = 1; i <= totalRuns; i++) {
      insertRun.run(i, "ar_test", `ta_${i}`, "task_created", "[]", 0, 1000 + i);
    }
    db.prepare("COMMIT").run();

    const now = Date.now();
    const result = await (ws as unknown as { runJob(job: unknown, now: number): Promise<Record<string, number>> }).runJob(
      { id: 1, run_at: now, kind: "prune_changes", payload: null, every_ms: 86_400_000 },
      now
    );

    expect(result).toEqual({
      changes_pruned: 15,
      automation_runs_pruned: 25,
      audit_pruned: 0,
      processed: 40,
    });

    const changesRemaining = db.prepare("SELECT MIN(seq) as minSeq, MAX(seq) as maxSeq, COUNT(*) as c FROM changes").all()[0] as {
      minSeq: number;
      maxSeq: number;
      c: number;
    };
    expect(changesRemaining.c).toBe(CHANGES_RETENTION);
    expect(changesRemaining.minSeq).toBe(16);
    expect(changesRemaining.maxSeq).toBe(totalChanges);

    const runsRemaining = db.prepare("SELECT MIN(id) as minId, MAX(id) as maxId, COUNT(*) as c FROM automation_runs").all()[0] as {
      minId: number;
      maxId: number;
      c: number;
    };
    expect(runsRemaining.c).toBe(AUTOMATION_RUNS_RETENTION);
    expect(runsRemaining.minId).toBe(26);
    expect(runsRemaining.maxId).toBe(totalRuns);
  });
});

describe("prune_changes job: audit retention", () => {
  const DAY = 86_400_000;
  const NOW = Date.UTC(2026, 8, 24, 9, 0, 0);
  const CUTOFF = NOW - AUDIT_RETENTION_DAYS * DAY;
  let ws: Awaited<ReturnType<typeof freshWorkspace>>["ws"];
  let db: DatabaseSync;

  beforeEach(async () => {
    ({ ws, db } = await freshWorkspace());
  });

  const insertAudit = (ats: number[]) => {
    db.prepare("BEGIN TRANSACTION").run();
    const insert = db.prepare(
      "INSERT INTO audit (actor, action, entity, diff, at) VALUES ('{}', 'task.update', 'tk_1', NULL, ?)"
    );
    for (const at of ats) insert.run(at);
    db.prepare("COMMIT").run();
  };
  const runPrune = () =>
    (ws as unknown as { runJob(job: unknown, now: number): Promise<Record<string, number>> }).runJob(
      { id: 1, run_at: NOW, kind: "prune_changes", payload: null, every_ms: DAY },
      NOW
    );
  const auditAts = () =>
    (db.prepare("SELECT at FROM audit ORDER BY at").all() as Array<{ at: number }>).map((r) => r.at);

  it("deletes audit rows older than AUDIT_RETENTION_DAYS and keeps the rest", async () => {
    const baseline = auditAts().length; // workspace setup may audit a few rows at NOW-ish
    insertAudit([CUTOFF - 10 * DAY, CUTOFF - 1, CUTOFF, CUTOFF + 1, NOW - DAY]);

    const result = await runPrune();

    expect(result.audit_pruned).toBe(2);
    expect(result.processed).toBe(2);
    const left = auditAts();
    expect(left).toHaveLength(baseline + 3);
    expect(left.every((at) => at >= CUTOFF)).toBe(true);
  });

  it("stops at AUDIT_PRUNE_MAX_BATCHES batches per run, oldest first, and finishes the backlog next run", async () => {
    const backlog = AUDIT_PRUNE_BATCH * AUDIT_PRUNE_MAX_BATCHES + 7;
    insertAudit(Array.from({ length: backlog }, (_, i) => CUTOFF - DAY - backlog + i));

    const first = await runPrune();
    expect(first.audit_pruned).toBe(AUDIT_PRUNE_BATCH * AUDIT_PRUNE_MAX_BATCHES);
    // The 7 survivors are the newest of the backlog.
    const oldest = auditAts()[0];
    expect(oldest).toBe(CUTOFF - DAY - 7);

    const second = await runPrune();
    expect(second.audit_pruned).toBe(7);
    expect(auditAts().every((at) => at >= CUTOFF)).toBe(true);
  });

  it("reads the expired range through idx_audit_at rather than scanning the table", () => {
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN DELETE FROM audit WHERE id IN (SELECT id FROM audit WHERE at < ? ORDER BY at LIMIT ?)"
      )
      .all(CUTOFF, AUDIT_PRUNE_BATCH) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toMatch(/idx_audit_at/);
    expect(details).not.toMatch(/SCAN audit(?! USING)/);
  });
});
