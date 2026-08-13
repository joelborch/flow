import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./schema.js";
import { REPLAY_GAP_LIMIT, bumpResyncFloor, needsSnapshot, resyncFloor } from "./sync-floor.js";

// ---------------------------------------------------------------------------
// The resync floor exists because three mutations — importBatch,
// setSpaceMembers, setSpaceVisibility — change board state without writing to
// the `changes` log. A client offline at that moment reconnects with an old
// sinceSeq, sees no seq gap, replays deltas only, and never learns about the
// change (the real-world symptom: a freshly imported space missing from the
// sidebar, then entrenched by the boot cache). needsSnapshot is the hello
// handler's decision, pure; the floor read/bump run against real SQLite via
// node:sqlite, through the actual production migrations, so the sync_meta DDL
// and the upsert are exercised for real.
// ---------------------------------------------------------------------------

/**
 * Adapter: node:sqlite's DatabaseSync speaking just enough of the DO's
 * SqlStorage interface (exec → { toArray, one }) for schema.ts and
 * sync-floor.ts. Same idea as visibility.test.ts's stub, but backed by a real
 * database so DDL, ON CONFLICT and persistence are the genuine article.
 */
function sqliteStorage(db: DatabaseSync): SqlStorage {
  const exec = (query: string, ...params: unknown[]): unknown => {
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

// No failure paths here, so a plain invoke stands in for transactionSync.
const txn = (fn: () => void): void => fn();

function freshDb(): SqlStorage {
  const sql = sqliteStorage(new DatabaseSync(":memory:"));
  runMigrations(sql, txn);
  return sql;
}

describe("resyncFloor / bumpResyncFloor", () => {
  it("reads 0 on a fresh workspace that never had a delta-less mutation", () => {
    expect(resyncFloor(freshDb())).toBe(0);
  });

  it("stores the bumped seq and reads it back", () => {
    const sql = freshDb();
    bumpResyncFloor(sql, 42);
    expect(resyncFloor(sql)).toBe(42);
  });

  it("only ever raises the floor — a lower bump cannot reopen replay", () => {
    const sql = freshDb();
    bumpResyncFloor(sql, 42);
    bumpResyncFloor(sql, 7);
    expect(resyncFloor(sql)).toBe(42);
    bumpResyncFloor(sql, 100);
    expect(resyncFloor(sql)).toBe(100);
  });

  it("persists in SQLite, not memory — a rehydrated DO sees the same floor", () => {
    // Two independent SqlStorage wrappers over one database stand in for the
    // DO being evicted and re-instantiated over the same storage.
    const db = new DatabaseSync(":memory:");
    runMigrations(sqliteStorage(db), txn);
    bumpResyncFloor(sqliteStorage(db), 42);
    expect(resyncFloor(sqliteStorage(db))).toBe(42);
  });

  it("survives the migration runner re-running (redeploy over live storage)", () => {
    const db = new DatabaseSync(":memory:");
    const sql = sqliteStorage(db);
    runMigrations(sql, txn);
    bumpResyncFloor(sql, 42);
    runMigrations(sql, txn); // idempotent: CREATE IF NOT EXISTS + applied-id set
    expect(resyncFloor(sql)).toBe(42);
  });
});

describe("needsSnapshot", () => {
  const base = { maxSeq: 100, minSeq: 1, floor: 0, gapLimit: REPLAY_GAP_LIMIT };

  it("replays a normal reconnect with no floor in play", () => {
    expect(needsSnapshot({ ...base, sinceSeq: 90 })).toBe(false);
    expect(needsSnapshot({ ...base, sinceSeq: 100 })).toBe(false);
  });

  it("snapshots when sinceSeq predates the floor — the import case", () => {
    // importBatch at maxSeq 100 sets floor 100 and writes zero deltas: a
    // client holding any pre-import seq must get the snapshot, because a
    // replay would deliver nothing and silently skip the imported rows.
    expect(needsSnapshot({ ...base, sinceSeq: 90, floor: 100 })).toBe(true);
  });

  it("snapshots even at sinceSeq == floor — seq did not advance, so an offline client is indistinguishable from a caught-up one", () => {
    expect(needsSnapshot({ ...base, sinceSeq: 100, floor: 100 })).toBe(true);
  });

  it("replays again once real deltas land past the floor", () => {
    expect(needsSnapshot({ ...base, maxSeq: 105, sinceSeq: 101, floor: 100 })).toBe(false);
  });

  it("keeps the pre-existing snapshot triggers: ahead of log, gap limit, pruned tail", () => {
    expect(needsSnapshot({ ...base, sinceSeq: 101 })).toBe(true); // ahead
    expect(
      needsSnapshot({ ...base, maxSeq: REPLAY_GAP_LIMIT + 10, sinceSeq: 1 })
    ).toBe(true); // gap
    expect(needsSnapshot({ ...base, minSeq: 50, sinceSeq: 40 })).toBe(true); // pruned
    expect(needsSnapshot({ ...base, minSeq: 50, sinceSeq: 49 })).toBe(false); // tail intact
  });

  it("treats a fresh floor of 0 as inert for any real sinceSeq", () => {
    expect(needsSnapshot({ ...base, sinceSeq: 1, minSeq: null })).toBe(false);
  });
});
