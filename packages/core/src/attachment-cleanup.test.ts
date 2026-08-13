import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// deleteTask drops `attachments` rows, which are the only record of an
// attachment's R2 key. Before those rows disappear, the r2_keys must land in
// `pending_object_deletes` so a follow-up (the route's waitUntil, or the
// backup job's sweep) can actually remove the R2 objects instead of leaking
// them. Same mocking approach as import-batch.test.ts / backup-job.test.ts:
// `cloudflare:workers` is stubbed so the real Workspace runs against
// node:sqlite, and R2 is a tiny in-memory stand-in.
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
    // Turn.emit's INSERT ... RETURNING seq needs .all()/.one() too — unlike
    // the other harnesses' importBatch-only tests, deleteTask and
    // createAttachment go through the normal turn machinery and emit deltas.
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

interface StoredObject {
  key: string;
  body: ArrayBuffer;
}

/** Minimal in-memory R2Bucket: enough of put/list/delete for the backup +
 *  sweep jobs. */
function fakeR2Bucket() {
  const objects = new Map<string, StoredObject>();
  const bucket = {
    async put(key: string, value: ArrayBuffer) {
      objects.set(key, { key, body: value });
      return undefined;
    },
    async list(opts?: { prefix?: string; cursor?: string }) {
      const prefix = opts?.prefix ?? "";
      const matches = [...objects.values()]
        .filter((o) => o.key.startsWith(prefix))
        .sort((a, b) => a.key.localeCompare(b.key));
      return { objects: matches.map((o) => ({ key: o.key })), truncated: false, cursor: undefined };
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}

async function freshWorkspace(bucket: R2Bucket) {
  const { Workspace } = await import("./index.js");
  const db = new DatabaseSync(":memory:");
  const ctx = fakeCtx(db);
  const env = { ATTACHMENTS: bucket } as never;
  return new Workspace(ctx, env);
}

describe("attachment cleanup on task delete", () => {
  let ws: Awaited<ReturnType<typeof freshWorkspace>>;
  let objects: Map<string, StoredObject>;

  beforeEach(async () => {
    const r2 = fakeR2Bucket();
    objects = r2.objects;
    ws = await freshWorkspace(r2.bucket);

    ws.importBatch(
      {
        users: [{ id: "us_a", email: "a@example.com", name: "A", role: "owner" }],
        spaces: [{ id: "sp_a", name: "Space A" }],
        lists: [{ id: "li_a", spaceId: "sp_a", name: "List A" }],
        tasks: [{ id: "ta_a", listId: "li_a", title: "Task A", status: "To Do" }],
      },
      "import"
    );
  });

  function seedAttachment(filename: string, r2Key: string) {
    ws.createAttachment(
      { taskId: "ta_a", filename, r2Key, size: 10, mimeType: "text/plain" },
      "us_a"
    );
    objects.set(r2Key, { key: r2Key, body: new ArrayBuffer(0) });
  }

  it("records the r2_keys of a deleted task's attachments in pending_object_deletes and returns them", () => {
    seedAttachment("a.txt", "at/ta_a/1/a.txt");
    seedAttachment("b.txt", "at/ta_a/2/b.txt");
    expect(ws.listAttachments("ta_a")).toHaveLength(2);

    const result = ws.deleteTask("ta_a", "us_a");

    expect(result.ok).toBe(true);
    expect(result.r2Keys.sort()).toEqual(["at/ta_a/1/a.txt", "at/ta_a/2/b.txt"]);

    // The attachments row is gone...
    expect(ws.listAttachments("ta_a")).toHaveLength(0);
    // ...but the keys survive in pending_object_deletes.
    const pending = (
      ws as unknown as { sql: SqlStorage }
    ).sql
      .exec<{ r2_key: string }>("SELECT r2_key FROM pending_object_deletes ORDER BY r2_key")
      .toArray()
      .map((r) => r.r2_key);
    expect(pending).toEqual(["at/ta_a/1/a.txt", "at/ta_a/2/b.txt"]);

    // The R2 objects themselves are untouched by deleteTask — that's the
    // caller's job (route waitUntil or the backup sweep).
    expect(objects.has("at/ta_a/1/a.txt")).toBe(true);
    expect(objects.has("at/ta_a/2/b.txt")).toBe(true);
  });

  it("deleting a task with no attachments records nothing", () => {
    const result = ws.deleteTask("ta_a", "us_a");
    expect(result.r2Keys).toEqual([]);
    const pending = (
      ws as unknown as { sql: SqlStorage }
    ).sql
      .exec<{ r2_key: string }>("SELECT r2_key FROM pending_object_deletes")
      .toArray();
    expect(pending).toEqual([]);
  });

  it("clearPendingObjectDeletes drops the given rows", () => {
    seedAttachment("a.txt", "at/ta_a/1/a.txt");
    seedAttachment("b.txt", "at/ta_a/2/b.txt");
    ws.deleteTask("ta_a", "us_a");

    const cleared = ws.clearPendingObjectDeletes(["at/ta_a/1/a.txt"]);
    expect(cleared).toEqual({ ok: true, cleared: 1 });

    const pending = (
      ws as unknown as { sql: SqlStorage }
    ).sql
      .exec<{ r2_key: string }>("SELECT r2_key FROM pending_object_deletes ORDER BY r2_key")
      .toArray()
      .map((r) => r.r2_key);
    expect(pending).toEqual(["at/ta_a/2/b.txt"]);
  });

  it("the backup job's sweep deletes swept keys from R2 and clears their pending rows", async () => {
    seedAttachment("a.txt", "at/ta_a/1/a.txt");
    seedAttachment("b.txt", "at/ta_a/2/b.txt");
    ws.deleteTask("ta_a", "us_a");
    expect(objects.has("at/ta_a/1/a.txt")).toBe(true);
    expect(objects.has("at/ta_a/2/b.txt")).toBe(true);

    const now = Date.UTC(2026, 0, 16, 6, 0, 0);
    const result = await (
      ws as unknown as { runJob(job: unknown, now: number): Promise<Record<string, number>> }
    ).runJob({ id: 1, run_at: now, kind: "backup", payload: null, every_ms: 86_400_000 }, now);

    expect(result.sweptDeletes).toBe(2);
    // The backup job also writes today's ndjson.gz object, so the objects
    // touched by the sweep are the two attachment keys, both now gone.
    expect(objects.has("at/ta_a/1/a.txt")).toBe(false);
    expect(objects.has("at/ta_a/2/b.txt")).toBe(false);

    const pending = (
      ws as unknown as { sql: SqlStorage }
    ).sql
      .exec<{ r2_key: string }>("SELECT r2_key FROM pending_object_deletes")
      .toArray();
    expect(pending).toEqual([]);
  });

  // Single-attachment delete used to return the r2Key WITHOUT parking it, so
  // a Worker eviction between the response and the waitUntil's R2 delete
  // orphaned the object with no sweep fallback. It now mirrors deleteTask.
  it("deleteAttachment parks its r2Key in pending_object_deletes, cleared by the RPC", () => {
    const attachment = ws.createAttachment(
      { taskId: "ta_a", filename: "a.txt", r2Key: "at/ta_a/1/a.txt", size: 10, mimeType: "text/plain" },
      "us_a"
    );
    objects.set("at/ta_a/1/a.txt", { key: "at/ta_a/1/a.txt", body: new ArrayBuffer(0) });

    const removed = ws.deleteAttachment(attachment.id, "us_a");
    expect(removed).toEqual({ ok: true, r2Key: "at/ta_a/1/a.txt" });
    expect(ws.listAttachments("ta_a")).toHaveLength(0);

    const pending = (
      ws as unknown as { sql: SqlStorage }
    ).sql
      .exec<{ r2_key: string }>("SELECT r2_key FROM pending_object_deletes")
      .toArray()
      .map((r) => r.r2_key);
    expect(pending).toEqual(["at/ta_a/1/a.txt"]);
    // The object itself is the route's job, not the DO's.
    expect(objects.has("at/ta_a/1/a.txt")).toBe(true);

    // The route clears the row after a successful R2 delete.
    expect(ws.clearPendingObjectDeletes(["at/ta_a/1/a.txt"])).toEqual({ ok: true, cleared: 1 });
    const after = (
      ws as unknown as { sql: SqlStorage }
    ).sql
      .exec<{ r2_key: string }>("SELECT r2_key FROM pending_object_deletes")
      .toArray();
    expect(after).toEqual([]);
  });
});
