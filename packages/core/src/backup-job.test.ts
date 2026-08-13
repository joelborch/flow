import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The daily `backup` job dumps every user table to gzipped NDJSON in R2 and
// prunes to the newest 30 objects under `backups/`. Same mocking approach as
// import-batch.test.ts: `cloudflare:workers` is stubbed with a plain class so
// the real Workspace implementation runs against node:sqlite, and R2 is a
// tiny in-memory stand-in (put/list/delete) rather than miniflare.
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

/** Minimal in-memory R2Bucket: enough of put/list/delete for the backup job. */
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

async function gunzip(buf: ArrayBuffer): Promise<string> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

describe("backup job", () => {
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

  it("produces gzipped NDJSON with rows from tasks, spaces and users, keyed by date", async () => {
    // Fixed clock so the R2 key is deterministic.
    const now = Date.UTC(2026, 0, 15, 6, 0, 0); // 2026-01-15
    const result = await (ws as unknown as { runJob(job: unknown, now: number): Promise<Record<string, number>> }).runJob(
      { id: 1, run_at: now, kind: "backup", payload: null, every_ms: 86_400_000 },
      now
    );

    expect(result.processed).toBeGreaterThanOrEqual(4); // at least the 4 seeded rows
    expect(objects.size).toBe(1);
    const entry = [...objects.entries()][0];
    if (!entry) throw new Error("expected exactly one stored object");
    const [key, obj] = entry;
    expect(key).toBe("backups/2026-01-15.ndjson.gz");

    const text = await gunzip(obj.body);
    const lines = text.trim().split("\n").map((l) => JSON.parse(l) as { table: string; row: Record<string, unknown> });

    const tables = new Set(lines.map((l) => l.table));
    expect(tables.has("users")).toBe(true);
    expect(tables.has("spaces")).toBe(true);
    expect(tables.has("tasks")).toBe(true);

    const userRow = lines.find((l) => l.table === "users" && l.row.id === "us_a");
    expect(userRow?.row.email).toBe("a@example.com");
    const taskRow = lines.find((l) => l.table === "tasks" && l.row.id === "ta_a");
    expect(taskRow?.row.title).toBe("Task A");
    const spaceRow = lines.find((l) => l.table === "spaces" && l.row.id === "sp_a");
    expect(spaceRow?.row.name).toBe("Space A");
  });

  it("prunes backups/ down to the newest 30 objects after a successful run", async () => {
    // Seed 32 older backups directly (bypassing runBackup — we only care
    // about the prune behavior here, not re-serializing the DB 32 times).
    for (let day = 1; day <= 32; day++) {
      const key = `backups/2026-01-${String(day).padStart(2, "0")}.ndjson.gz`;
      objects.set(key, { key, body: new ArrayBuffer(0) });
    }
    expect(objects.size).toBe(32);

    const now = Date.UTC(2026, 1, 2, 6, 0, 0); // 2026-02-02 — sorts after all seeded days
    await (ws as unknown as { runJob(job: unknown, now: number): Promise<Record<string, number>> }).runJob(
      { id: 1, run_at: now, kind: "backup", payload: null, every_ms: 86_400_000 },
      now
    );

    // 32 old + 1 new = 33, pruned down to 30.
    expect(objects.size).toBe(30);
    // The newest (today's) backup and the most recent of the old ones survive.
    expect(objects.has("backups/2026-02-02.ndjson.gz")).toBe(true);
    expect(objects.has("backups/2026-01-32.ndjson.gz")).toBe(true); // fabricated key, but still newest-30
    // The oldest ones are gone.
    expect(objects.has("backups/2026-01-01.ndjson.gz")).toBe(false);
    expect(objects.has("backups/2026-01-02.ndjson.gz")).toBe(false);
  });
});
