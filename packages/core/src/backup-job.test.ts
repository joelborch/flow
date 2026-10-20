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

function fakeCtx(db: DatabaseSync, events: string[] = []): DurableObjectState {
  return {
    id: { toString: () => "do_test" },
    storage: {
      sql: sqliteStorage(db),
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      // alarm() waits on this after claiming each job; the log lets a test
      // check the claim was durable before the job started.
      sync: async () => {
        events.push("sync");
      },
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
function fakeR2Bucket(events: string[] = []) {
  const objects = new Map<string, StoredObject>();
  const bucket = {
    async put(key: string, value: ArrayBuffer) {
      events.push("put");
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

async function freshWorkspace(bucket: R2Bucket, db = new DatabaseSync(":memory:"), events: string[] = []) {
  const { Workspace } = await import("./index.js");
  const ctx = fakeCtx(db, events);
  const env = { ATTACHMENTS: bucket } as never;
  return { ws: new Workspace(ctx, env), db };
}

type JobRunner = { runJob(job: unknown, now: number): Promise<Record<string, number>> };
const backupJob = (now: number) => ({
  id: 1,
  run_at: now,
  kind: "backup",
  payload: null,
  every_ms: 86_400_000,
});

async function gunzip(buf: ArrayBuffer): Promise<string> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

describe("backup job", () => {
  let ws: Awaited<ReturnType<typeof freshWorkspace>>["ws"];
  let db: DatabaseSync;
  let objects: Map<string, StoredObject>;

  beforeEach(async () => {
    const r2 = fakeR2Bucket();
    objects = r2.objects;
    ({ ws, db } = await freshWorkspace(r2.bucket));

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

  it("excludes leading-underscore tables — prod's sqlite_master exposes the runtime's _cf_KV, which is prohibited to SELECT and used to kill every backup", async () => {
    // node:sqlite has no _cf_KV, so fabricate one the way workerd exposes it.
    // If the filter regresses, this table shows up in the dump (here) and the
    // whole backup throws (in prod).
    db.prepare("CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)").run();
    db.prepare("INSERT INTO _cf_KV (key, value) VALUES (?, ?)").run("alarm", "internal");

    const now = Date.UTC(2026, 0, 15, 6, 0, 0);
    await (ws as unknown as { runJob(job: unknown, now: number): Promise<Record<string, number>> }).runJob(
      { id: 1, run_at: now, kind: "backup", payload: null, every_ms: 86_400_000 },
      now
    );

    const entry = [...objects.values()][0];
    if (!entry) throw new Error("expected a stored backup object");
    const text = await gunzip(entry.body);
    const tables = new Set(
      text.trim().split("\n").map((l) => (JSON.parse(l) as { table: string }).table)
    );
    expect(tables.has("_cf_KV")).toBe(false);
    expect(tables.has("_migrations")).toBe(false);
    expect(tables.has("tasks")).toBe(true); // still a real backup, not an empty one
  });

  it("runBackupNow runs the same backup immediately", async () => {
    const stats = await ws.runBackupNow();
    expect(stats.processed).toBeGreaterThanOrEqual(4);
    expect(objects.size).toBe(1);
    const key = [...objects.keys()][0];
    expect(key).toMatch(/^backups\/\d{4}-\d{2}-\d{2}\.ndjson\.gz$/);
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

describe("backup outcome in job_status", () => {
  const HOUR = 3_600_000;

  it("records the last success with its key and row count, and goes stale after 36h", async () => {
    const { BACKUP_STALE_MS } = await import("./index.js");
    const r2 = fakeR2Bucket();
    const { ws } = await freshWorkspace(r2.bucket);
    expect(ws.getBackupStatus()).toEqual({
      lastSuccessAt: null,
      lastSuccess: null,
      lastFailureAt: null,
      lastFailureError: null,
      stale: true, // never backed up
    });

    const now = Date.UTC(2026, 8, 20, 5, 0, 0);
    const stats = await (ws as unknown as JobRunner).runJob(backupJob(now), now);

    const status = ws.getBackupStatus(now + HOUR);
    expect(status.lastSuccessAt).toBe(now);
    expect(status.lastSuccess).toEqual({
      key: "backups/2026-09-20.ndjson.gz",
      rows: stats.processed,
      bytes: stats.bytes,
    });
    expect(status.lastFailureAt).toBeNull();
    expect(status.stale).toBe(false);
    expect(ws.getBackupStatus(now + BACKUP_STALE_MS).stale).toBe(false);
    expect(ws.getBackupStatus(now + BACKUP_STALE_MS + 1).stale).toBe(true);
  });

  it("records a failed run's time and error, rethrows, and keeps the previous success", async () => {
    const r2 = fakeR2Bucket();
    const { ws } = await freshWorkspace(r2.bucket);
    const day1 = Date.UTC(2026, 7, 10, 5, 0, 0);
    await (ws as unknown as JobRunner).runJob(backupJob(day1), day1);

    r2.bucket.put = (async () => {
      throw new Error("R2 put failed: 503 Service Unavailable");
    }) as unknown as R2Bucket["put"];
    const day2 = day1 + 24 * HOUR;
    await expect((ws as unknown as JobRunner).runJob(backupJob(day2), day2)).rejects.toThrow(
      "R2 put failed"
    );

    const status = ws.getBackupStatus(day2 + 13 * HOUR); // 37h after the last success
    expect(status.lastSuccessAt).toBe(day1);
    expect(status.lastFailureAt).toBe(day2);
    expect(status.lastFailureError).toBe("R2 put failed: 503 Service Unavailable");
    expect(status.stale).toBe(true);
  });

  it("counts a backup whose post-write cleanup fails as written, and records the cleanup failure", async () => {
    const r2 = fakeR2Bucket();
    r2.bucket.list = (async () => {
      throw new Error("list timed out");
    }) as unknown as R2Bucket["list"];
    const { ws } = await freshWorkspace(r2.bucket);
    const now = Date.UTC(2026, 8, 20, 5, 0, 0);
    await expect((ws as unknown as JobRunner).runJob(backupJob(now), now)).rejects.toThrow(
      "list timed out"
    );

    const status = ws.getBackupStatus(now);
    expect(status.lastSuccessAt).toBe(now);
    expect(status.stale).toBe(false);
    expect(status.lastFailureAt).toBe(now);
    expect(status.lastFailureError).toBe(
      "backups/2026-09-20.ndjson.gz was written, but post-backup cleanup failed: list timed out"
    );
  });

  it("runBackupNow records its outcome too", async () => {
    const r2 = fakeR2Bucket();
    const { ws } = await freshWorkspace(r2.bucket);
    const before = Date.now();
    await ws.runBackupNow();
    const status = ws.getBackupStatus();
    expect(status.lastSuccessAt).toBeGreaterThanOrEqual(before);
    expect(status.stale).toBe(false);
  });
});

describe("alarm: a backup that kills the isolate cannot wedge the schedule", () => {
  const jobRow = (db: DatabaseSync, kind: string) =>
    db
      .prepare("SELECT id, run_at FROM scheduled_jobs WHERE kind = ? AND every_ms IS NOT NULL")
      .all(kind)[0] as { id: number; run_at: number };

  it("runs the other due jobs first, and claims the backup durably before starting it", async () => {
    const events: string[] = [];
    const r2 = fakeR2Bucket(events);
    // A put that never settles stands in for the isolate dying mid-backup:
    // nothing after it in runBackup, or in alarm(), ever runs.
    let putStarted!: () => void;
    const started = new Promise<void>((resolve) => (putStarted = resolve));
    r2.bucket.put = (() => {
      events.push("put");
      putStarted();
      return new Promise(() => undefined);
    }) as unknown as R2Bucket["put"];

    const db = new DatabaseSync(":memory:");
    const first = await freshWorkspace(r2.bucket, db, events);
    const now = Date.now();
    // The backup is the OLDEST due job, which used to make it run first.
    db.prepare("UPDATE scheduled_jobs SET run_at = ? WHERE kind = 'backup'").run(now - 2_000);
    db.prepare("UPDATE scheduled_jobs SET run_at = ? WHERE kind = 'prune_changes'").run(now - 1_000);

    void first.ws.alarm();
    await started;

    // prune_changes ran and was rescheduled before the backup started ...
    expect(jobRow(db, "prune_changes").run_at).toBeGreaterThan(now);
    // ... and the backup was advanced to tomorrow, with the write synced,
    // before it touched R2.
    expect(jobRow(db, "backup").run_at).toBeGreaterThan(now);
    expect(events.slice(-2)).toEqual(["sync", "put"]);

    // "Restart": a fresh instance over the same storage. A due one-off job
    // runs; the backup that killed the last one is not retried first.
    const healthy = fakeR2Bucket(events);
    const second = await freshWorkspace(healthy.bucket, db, events);
    second.ws.scheduleJob({ runAt: Date.now() - 1, kind: "snooze_wake" });
    const putsBefore = events.filter((e) => e === "put").length;
    await second.ws.alarm();

    expect(events.filter((e) => e === "put").length).toBe(putsBefore);
    expect(healthy.objects.size).toBe(0);
    const oneOffs = db
      .prepare("SELECT COUNT(*) AS n FROM scheduled_jobs WHERE kind = 'snooze_wake'")
      .all()[0] as { n: number };
    expect(oneOffs.n).toBe(0);
  });
});
