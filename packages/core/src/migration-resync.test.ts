import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  CHANGES_SPACE_ID_MIGRATION_ID,
  MIGRATIONS,
  type MigrationTxn,
  applyMigrations,
} from "./schema.js";
import { resyncFloor } from "./sync-floor.js";

// ---------------------------------------------------------------------------
// `changes` rows written before core-0007-changes-space-id have no stored
// space_id. filterReplay's fail-closed fallback maps such a row to an
// unresolved-space sentinel when the entity no longer exists, so a member
// replaying across the migration boundary would silently lose delete-deltas
// for entities in spaces they CAN see — ghost rows on their board. The remedy:
// when core-0007 first applies, the constructor bumps the resync floor to the
// then-current MAX(seq), so every client's next hello answers with one full
// snapshot instead of replaying the ambiguous rows.
//
// Same real-Workspace-over-node:sqlite harness as import-batch.test.ts.
// ---------------------------------------------------------------------------

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
    const isRead = /^\s*SELECT/i.test(query) || /\bRETURNING\b/i.test(query);
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

/**
 * A database in the exact pre-deploy prod state: every migration up to (but
 * not including) core-0007 applied, plus a few `changes` rows written without
 * a space_id column — the ambiguous rows the floor bump exists for.
 */
function preMigrationDb(changeRows: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const sql = sqliteStorage(db);
  const idx = MIGRATIONS.findIndex((m) => m.id === CHANGES_SPACE_ID_MIGRATION_ID);
  if (idx < 0) throw new Error("core-0007 missing from MIGRATIONS");
  sql.exec(`CREATE TABLE IF NOT EXISTS _migrations (
     id TEXT PRIMARY KEY,
     applied_at INTEGER NOT NULL
   )`);
  applyMigrations(sql, MIGRATIONS.slice(0, idx), savepointTxn(db));
  for (let i = 0; i < changeRows; i++) {
    sql.exec(
      "INSERT INTO changes (op, entity, entity_id, data, actor_user_id, at) VALUES ('create', 'task', ?, '{}', 'us_x', ?)",
      `ta_${i}`,
      1000 + i
    );
  }
  return db;
}

async function bootWorkspace(db: DatabaseSync) {
  const { Workspace } = await import("./index.js");
  return new Workspace(fakeCtx(db), {} as never);
}

/** Hibernation-API socket stand-in: capture what the hello handler sends. */
function fakeWs(userId: string): { ws: WebSocket; sent: () => Array<{ type: string }> } {
  const frames: string[] = [];
  const ws = {
    send: (payload: string) => frames.push(payload),
    deserializeAttachment: () => ({ userId }),
  } as unknown as WebSocket;
  return { ws, sent: () => frames.map((f) => JSON.parse(f) as { type: string }) };
}

describe("core-0007 first-apply resync floor bump", () => {
  it("bumps the floor to MAX(seq) so an old sinceSeq gets a snapshot, not a replay", async () => {
    const db = preMigrationDb(3); // pre-0007 rows at seq 1..3
    const ws = await bootWorkspace(db); // constructor applies 0007+ and bumps

    const sql = sqliteStorage(db);
    expect(resyncFloor(sql)).toBe(3);

    const userId = sql
      .exec<{ id: string }>("SELECT id FROM users ORDER BY created_at LIMIT 1")
      .toArray()[0]?.id;
    if (!userId) throw new Error("seedIfEmpty did not run");

    const { ws: socket, sent } = fakeWs(userId);
    await ws.webSocketMessage(socket, JSON.stringify({ type: "hello", sinceSeq: 1 }));

    const frames = sent();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.type).toBe("snapshot"); // never "deltas" across the boundary
  });

  it("does not bump again on later wakes — post-migration deltas replay normally", async () => {
    const db = preMigrationDb(3);
    await bootWorkspace(db); // first boot: applies 0007, floor = 3

    // New (post-0007) rows land after the migration, at seq 4 and 5.
    const sql = sqliteStorage(db);
    for (const entityId of ["ta_8", "ta_9"]) {
      sql.exec(
        "INSERT INTO changes (op, entity, entity_id, data, actor_user_id, at, space_id) VALUES ('update', 'task', ?, '{\"delta\":true}', 'us_x', 2000, NULL)",
        entityId
      );
    }

    const ws2 = await bootWorkspace(db); // eviction + rewake over same storage
    expect(resyncFloor(sqliteStorage(db))).toBe(3); // unchanged

    const userId = sqliteStorage(db)
      .exec<{ id: string }>("SELECT id FROM users ORDER BY created_at LIMIT 1")
      .toArray()[0]?.id;
    if (!userId) throw new Error("seedIfEmpty did not run");
    const { ws: socket, sent } = fakeWs(userId);
    // sinceSeq strictly above the floor: the seq-5 row replays as a delta
    // (floor is <=-inclusive, so seq 3 itself would still snapshot).
    await ws2.webSocketMessage(socket, JSON.stringify({ type: "hello", sinceSeq: 4 }));
    const frames = sent();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.type).toBe("deltas");
  });

  it("a fresh workspace keeps floor 0 — nothing ambiguous to snapshot over", async () => {
    const db = new DatabaseSync(":memory:");
    await bootWorkspace(db); // full migration run on empty storage
    expect(resyncFloor(sqliteStorage(db))).toBe(0);
  });
});
