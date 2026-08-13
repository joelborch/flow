import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  MIGRATIONS,
  type MigrationTxn,
  applyMigrations,
  needsMigration,
  runMigrations,
  seedJobs,
} from "./schema.js";

// ---------------------------------------------------------------------------
// A migration failure must not brick the workspace. applyMigrations wraps each
// migration's statements + its _migrations insert in one `txn(...)` call and
// lets the wrapper roll back on any throw — so a failure on e.g. statement 3
// of 5 leaves nothing committed and no _migrations row, and a retry after a
// code fix applies the whole migration cleanly instead of dying on "duplicate
// column name".
//
// The wrapper is a parameter because workerd REJECTS explicit SAVEPOINT/BEGIN
// through sql.exec ("please use state.storage.transaction() or
// transactionSync()"): production passes ctx.storage.transactionSync, and
// these tests pass a node:sqlite savepoint wrapper with the same
// throws-roll-back contract. A test below pins that applyMigrations never
// issues explicit transaction statements through sql.exec again.
//
// needsMigration also used to compare COUNT(*) against MIGRATIONS.length,
// so a renamed/removed migration id could make count >= length and silently
// skip a genuinely new migration. It now checks that every known id is
// actually present in the applied set.
// ---------------------------------------------------------------------------

function sqliteStorage(db: DatabaseSync, log?: string[]): SqlStorage {
  const exec = (query: string, ...params: unknown[]): unknown => {
    log?.push(query);
    const isRead = /^\s*SELECT/i.test(query);
    if (!isRead) {
      db.prepare(query).run(...(params as never[]));
      return { toArray: () => [], one: () => undefined };
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

/** node:sqlite stand-in for ctx.storage.transactionSync: throws roll back. */
function savepointTxn(db: DatabaseSync): MigrationTxn {
  return (fn) => {
    db.prepare("SAVEPOINT _txn").run();
    try {
      fn();
      db.prepare("RELEASE _txn").run();
    } catch (err) {
      db.prepare("ROLLBACK TO _txn").run();
      db.prepare("RELEASE _txn").run();
      throw err;
    }
  };
}

function freshDb(): { sql: SqlStorage; txn: MigrationTxn } {
  const db = new DatabaseSync(":memory:");
  const sql = sqliteStorage(db);
  const txn = savepointTxn(db);
  runMigrations(sql, txn); // creates _migrations and applies the real MIGRATIONS
  return { sql, txn };
}

function tableExists(sql: SqlStorage, name: string): boolean {
  const rows = sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name)
    .toArray();
  return rows.length > 0;
}

function migrationApplied(sql: SqlStorage, id: string): boolean {
  const rows = sql.exec<{ id: string }>("SELECT id FROM _migrations WHERE id = ?", id).toArray();
  return rows.length > 0;
}

describe("applyMigrations: partial-failure rollback", () => {
  it("a statement throwing leaves no partial schema and no _migrations row", () => {
    const { sql, txn } = freshDb();
    const broken = [
      {
        id: "test-0001-partial",
        statements: [
          "CREATE TABLE backup_test (x INTEGER)",
          "THIS IS NOT VALID SQL",
          "CREATE TABLE backup_test_2 (x INTEGER)",
        ],
      },
    ];

    expect(() => applyMigrations(sql, broken, txn)).toThrow();
    expect(tableExists(sql, "backup_test")).toBe(false);
    expect(tableExists(sql, "backup_test_2")).toBe(false);
    expect(migrationApplied(sql, "test-0001-partial")).toBe(false);
  });

  it("a corrected re-run of the same id applies cleanly afterward", () => {
    const { sql, txn } = freshDb();
    const broken = [
      {
        id: "test-0002-partial",
        statements: ["CREATE TABLE backup_test_3 (x INTEGER)", "NOT VALID SQL EITHER"],
      },
    ];
    expect(() => applyMigrations(sql, broken, txn)).toThrow();
    expect(tableExists(sql, "backup_test_3")).toBe(false);

    const fixed = [
      {
        id: "test-0002-partial",
        statements: ["CREATE TABLE backup_test_3 (x INTEGER)", "CREATE TABLE backup_test_4 (x INTEGER)"],
      },
    ];
    expect(() => applyMigrations(sql, fixed, txn)).not.toThrow();
    expect(tableExists(sql, "backup_test_3")).toBe(true);
    expect(tableExists(sql, "backup_test_4")).toBe(true);
    expect(migrationApplied(sql, "test-0002-partial")).toBe(true);
  });

  it("other already-applied migrations are untouched by a later failure", () => {
    const { sql, txn } = freshDb();
    const initialCount = sql
      .exec<{ id: string }>("SELECT id FROM _migrations")
      .toArray().length;
    expect(() =>
      applyMigrations(sql, [{ id: "test-0003-boom", statements: ["NOPE NOT SQL"] }], txn)
    ).toThrow();
    const afterCount = sql.exec<{ id: string }>("SELECT id FROM _migrations").toArray().length;
    expect(afterCount).toBe(initialCount);
  });

  it("returns the ids it newly applied, and only those", () => {
    const { sql, txn } = freshDb();
    const extra = [
      { id: "test-0004-a", statements: ["CREATE TABLE returned_a (x INTEGER)"] },
      { id: "test-0004-b", statements: ["CREATE TABLE returned_b (x INTEGER)"] },
    ];
    expect(applyMigrations(sql, extra, txn)).toEqual(["test-0004-a", "test-0004-b"]);
    // Second pass: everything already applied, nothing returned.
    expect(applyMigrations(sql, extra, txn)).toEqual([]);
  });

  it("never issues explicit SAVEPOINT/BEGIN through sql.exec (forbidden in the DO runtime)", () => {
    const db = new DatabaseSync(":memory:");
    const executed: string[] = [];
    const sql = sqliteStorage(db, executed);
    runMigrations(sql, savepointTxn(db));
    const explicit = executed.filter((q) =>
      /^\s*(SAVEPOINT|BEGIN|COMMIT|RELEASE|ROLLBACK)\b/i.test(q)
    );
    expect(explicit).toEqual([]);
  });
});

describe("needsMigration", () => {
  it("false immediately after a fresh migration run", () => {
    const { sql } = freshDb();
    expect(needsMigration(sql)).toBe(false);
  });

  it("true on a workspace that has never migrated", () => {
    const sql = sqliteStorage(new DatabaseSync(":memory:"));
    expect(needsMigration(sql)).toBe(true);
  });

  it("true when a known migration id is missing, even though the row count matches", () => {
    const { sql } = freshDb();
    const before = sql.exec<{ id: string }>("SELECT id FROM _migrations").toArray();
    expect(before.length).toBe(MIGRATIONS.length);

    // Simulate the exact bug this guards against: a migration id gets
    // renamed/removed in code, but the applied-ids table still holds the old
    // id from before the rename, plus a stand-in row keeping the count the
    // same as MIGRATIONS.length. The old COUNT(*) < length check would return
    // false here (count == length) even though a real MIGRATIONS id
    // ("core-0001-initial") is missing from the applied set.
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    if (!last) throw new Error("MIGRATIONS is unexpectedly empty");
    sql.exec("DELETE FROM _migrations WHERE id = ?", last.id);
    sql.exec("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)", "renamed-stand-in-id", Date.now());

    const after = sql.exec<{ id: string }>("SELECT id FROM _migrations").toArray();
    expect(after.length).toBe(MIGRATIONS.length); // counts match...
    expect(needsMigration(sql)).toBe(true); // ...but a real id is missing
  });
});

// ---------------------------------------------------------------------------
// seedJobs used to early-return when scheduled_jobs had ANY rows, so a job
// kind added later (the backup job) was never installed on a workspace that
// already had prune_changes + due_date_check. It now ensures each recurring
// kind individually and leaves existing rows — including their run_at —
// untouched.
// ---------------------------------------------------------------------------

describe("seedJobs", () => {
  function jobRows(sql: SqlStorage) {
    return sql
      .exec<{ kind: string; run_at: number; every_ms: number | null }>(
        "SELECT kind, run_at, every_ms FROM scheduled_jobs ORDER BY kind"
      )
      .toArray();
  }

  it("installs all recurring kinds on an empty table", () => {
    const { sql } = freshDb();
    expect(seedJobs(sql)).toBe(3);
    expect(jobRows(sql).map((r) => r.kind)).toEqual(["backup", "due_date_check", "prune_changes"]);
  });

  it("adds a missing kind to a workspace that already has the older jobs, preserving their run_at", () => {
    const { sql } = freshDb();
    const now = Date.now();
    // The pre-backup prod state: only the two original jobs, mid-schedule.
    sql.exec(
      "INSERT INTO scheduled_jobs (run_at, kind, payload, every_ms, created_at) VALUES (?, 'prune_changes', NULL, 86400000, ?)",
      1_111,
      now
    );
    sql.exec(
      "INSERT INTO scheduled_jobs (run_at, kind, payload, every_ms, created_at) VALUES (?, 'due_date_check', NULL, 3600000, ?)",
      2_222,
      now
    );

    expect(seedJobs(sql, now)).toBe(1); // only backup is missing

    const rows = jobRows(sql);
    expect(rows.map((r) => r.kind)).toEqual(["backup", "due_date_check", "prune_changes"]);
    // The existing rows' next runs are untouched.
    expect(rows.find((r) => r.kind === "prune_changes")?.run_at).toBe(1_111);
    expect(rows.find((r) => r.kind === "due_date_check")?.run_at).toBe(2_222);
  });

  it("is idempotent: a second pass inserts nothing", () => {
    const { sql } = freshDb();
    seedJobs(sql);
    expect(seedJobs(sql)).toBe(0);
    expect(jobRows(sql)).toHaveLength(3);
  });

  it("a pending one-off of the same kind does not suppress the recurring seed", () => {
    const { sql } = freshDb();
    const now = Date.now();
    // scheduleJob-style one-off: every_ms NULL.
    sql.exec(
      "INSERT INTO scheduled_jobs (run_at, kind, payload, every_ms, created_at) VALUES (?, 'backup', NULL, NULL, ?)",
      now + 60_000,
      now
    );
    expect(seedJobs(sql, now)).toBe(3); // all three recurring kinds still installed
    const recurring = jobRows(sql).filter((r) => r.every_ms !== null);
    expect(recurring.map((r) => r.kind).sort()).toEqual(["backup", "due_date_check", "prune_changes"]);
  });
});
