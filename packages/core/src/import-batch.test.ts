import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// importBatch's user-upsert UPDATE path must only touch role/deactivated when
// the batch row actually supplies them — a re-sync batch that omits `role`
// (e.g. re-importing tasks/spaces without re-sending users) must not demote an
// admin/owner back to member, and must not silently reactivate a deactivated
// user. See the COALESCE(?, role) / COALESCE(?, deactivated) fix.
//
// index.ts imports `cloudflare:workers` for the DurableObject base class,
// which only exists under workerd. It's mocked here with a plain class so the
// real Workspace implementation — not a reimplementation of it — runs against
// a real SQLite database via node:sqlite, the same adapter sync-floor.test.ts
// uses for schema.ts.
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

/** Minimal DurableObjectState stand-in — just enough for the Workspace
 *  constructor and importBatch's broadcast-at-the-end call. */
function fakeCtx(db: DatabaseSync): DurableObjectState {
  return {
    id: { toString: () => "do_test" },
    storage: {
      sql: sqliteStorage(db),
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      // Migrations run inside storage.transactionSync in production; emulate
      // its throws-roll-back contract with a node:sqlite savepoint (explicit
      // savepoints are legal here, unlike in workerd's sql.exec).
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
  const env = {} as never;
  return new Workspace(ctx, env);
}

describe("importBatch user upsert", () => {
  let ws: Awaited<ReturnType<typeof freshWorkspace>>;

  beforeEach(async () => {
    ws = await freshWorkspace();
  });

  it("omitting role/deactivated on an update preserves the existing values", () => {
    const created = ws.importBatch(
      {
        users: [
          { id: "us_admin1", email: "admin@example.com", name: "Admin", role: "admin", deactivated: true },
        ],
      },
      "import"
    );
    expect(created.created.users).toBe(1);

    // Re-import the same user without role/deactivated — as a batch that only
    // touches other fields (e.g. re-syncing name) would.
    const updated = ws.importBatch(
      { users: [{ id: "us_admin1", email: "admin@example.com", name: "Admin Renamed" }] },
      "import"
    );
    expect(updated.updated.users).toBe(1);

    const row = ws.listUsers().find((u) => u.id === "us_admin1");
    expect(row?.role).toBe("admin");
    expect(row?.deactivated).toBe(true);
    expect(row?.name).toBe("Admin Renamed");
  });

  it("still applies role/deactivated when the batch supplies them", () => {
    ws.importBatch(
      {
        users: [
          { id: "us_owner1", email: "owner@example.com", name: "Owner", role: "owner", deactivated: false },
        ],
      },
      "import"
    );

    ws.importBatch(
      {
        users: [
          { id: "us_owner1", email: "owner@example.com", role: "member", deactivated: true },
        ],
      },
      "import"
    );

    const row = ws.listUsers().find((u) => u.id === "us_owner1");
    expect(row?.role).toBe("member");
    expect(row?.deactivated).toBe(true);
  });
});
