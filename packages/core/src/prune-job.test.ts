import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_RUNS_RETENTION, CHANGES_RETENTION } from "./index.js";

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
    const isRead = /^\s*SELECT/i.test(query);
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
