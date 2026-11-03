import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { SANDBOX_MEMBER_ID, sandboxSeed } from "./sandbox-seed.js";

// The public sandbox's starting workspace and the two DO behaviours only the
// sandbox uses: no recurring jobs, and wipeSandbox. Same harness as
// import-batch.test.ts: the real Workspace against node:sqlite.

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
    if (!/^\s*SELECT/i.test(query) && !/RETURNING/i.test(query)) {
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

async function freshWorkspace(env: Record<string, unknown>) {
  const { Workspace } = await import("./index.js");
  const db = new DatabaseSync(":memory:");
  const deleteAll = vi.fn(async () => undefined);
  const deleteAlarm = vi.fn(async () => undefined);
  const ctx = {
    id: { toString: () => "do_test" },
    storage: {
      sql: sqliteStorage(db),
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      deleteAll,
      deleteAlarm,
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
    blockConcurrencyWhile: async <T,>(fn: () => Promise<T> | T): Promise<T> => fn(),
    waitUntil: () => undefined,
    getWebSockets: () => [],
    acceptWebSocket: () => undefined,
  } as unknown as DurableObjectState;
  const ws = new Workspace(ctx, { SIDE_EFFECTS: { sendBatch: async () => undefined }, ...env } as never);
  // The constructor's migration runs inside blockConcurrencyWhile; let it settle.
  await new Promise((r) => setTimeout(r, 0));
  return { ws, db, deleteAll, deleteAlarm };
}

const ownerOf = (ws: Awaited<ReturnType<typeof freshWorkspace>>["ws"]) =>
  ws.listUsers().find((u) => u.role === "owner")!;

describe("sandboxSeed", () => {
  it("imports cleanly, and a second seeding of the same workspace changes nothing", async () => {
    const { ws } = await freshWorkspace({ SANDBOX: "true" });
    const owner = ownerOf(ws);
    const first = ws.importBatch(sandboxSeed(owner.id), owner.id);
    expect(first.errors).toEqual([]);
    expect(first.created.tasks).toBeGreaterThan(10);
    const second = ws.importBatch(sandboxSeed(owner.id), owner.id);
    expect(second.errors).toEqual([]);
    expect(second.created).toEqual({ users: 0, spaces: 0, lists: 0, tasks: 0, subtasks: 0, comments: 0 });
  });

  it("renames the placeholder owner instead of adding a second one", async () => {
    const { ws } = await freshWorkspace({ SANDBOX: "true" });
    const owner = ownerOf(ws);
    ws.importBatch(sandboxSeed(owner.id), owner.id);
    const owners = ws.listUsers().filter((u) => u.role === "owner");
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ id: owner.id, name: "Avery Chen", email: "avery@example.com" });
  });

  it("gives the sandbox member the shared spaces and never the private one", async () => {
    const { ws } = await freshWorkspace({ SANDBOX: "true" });
    const owner = ownerOf(ws);
    ws.importBatch(sandboxSeed(owner.id), owner.id);
    const snap = ws.getSnapshot(SANDBOX_MEMBER_ID);
    expect(snap.spaces.map((s) => s.name).sort()).toEqual(["Marketing", "Operations"]);
    expect(JSON.stringify(snap)).not.toContain("hiring plan");
    expect(snap.tasks.some((t) => t.assigneeId === SANDBOX_MEMBER_ID)).toBe(true);
  });
});

describe("sandbox mode in the DO", () => {
  it("schedules no recurring jobs, where a normal workspace does", async () => {
    const sandbox = await freshWorkspace({ SANDBOX: "true" });
    const normal = await freshWorkspace({});
    const jobs = (db: DatabaseSync) => (db.prepare("SELECT count(*) AS n FROM scheduled_jobs").get() as { n: number }).n;
    expect(jobs(sandbox.db)).toBe(0);
    expect(jobs(normal.db)).toBeGreaterThan(0);
  });

  it("wipeSandbox deletes the alarm and every row, and refuses outside the sandbox", async () => {
    const sandbox = await freshWorkspace({ SANDBOX: "true" });
    await sandbox.ws.wipeSandbox();
    expect(sandbox.deleteAlarm).toHaveBeenCalledTimes(1);
    expect(sandbox.deleteAll).toHaveBeenCalledTimes(1);

    const normal = await freshWorkspace({});
    await expect(normal.ws.wipeSandbox()).rejects.toThrow(/only runs on the sandbox/);
    expect(normal.deleteAll).not.toHaveBeenCalled();
  });
});
