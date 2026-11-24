import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { type StoredObject, fakeCtx, fakeR2Bucket } from "./testkit.js";

// ---------------------------------------------------------------------------
// deleteTask drops `attachments` rows, which are the only record of an
// attachment's R2 key. Before those rows disappear, the r2_keys must land in
// `pending_object_deletes` so a follow-up (the route's waitUntil, or the
// backup job's sweep) can actually remove the R2 objects instead of leaking
// them. Same mocking approach as import-batch.test.ts / backup-job.test.ts:
// `cloudflare:workers` is stubbed so the real Workspace runs against
// node:sqlite, and R2 is a tiny in-memory stand-in.
// ---------------------------------------------------------------------------

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
  let taskId: string;

  beforeEach(async () => {
    const r2 = fakeR2Bucket();
    objects = r2.objects;
    ws = await freshWorkspace(r2.bucket);

    ws.upsertUser({ id: "us_a", email: "a@example.com", name: "A", role: "owner" }, "us_a");
    const space = ws.createSpace({ name: "Space A", visibility: "workspace" }, "us_a");
    const list = ws.createList({ spaceId: space.id, name: "List A" }, "us_a");
    taskId = ws.createTask({ listId: list.id, title: "Task A", description: "" }, "us_a").id;
  });

  function seedAttachment(filename: string, r2Key: string) {
    ws.createAttachment(
      { taskId, filename, r2Key, size: 10, mimeType: "text/plain" },
      "us_a"
    );
    objects.set(r2Key, { key: r2Key, body: new ArrayBuffer(0) });
  }

  it("records the r2_keys of a deleted task's attachments in pending_object_deletes and returns them", () => {
    seedAttachment("a.txt", `at/${taskId}/1/a.txt`);
    seedAttachment("b.txt", `at/${taskId}/2/b.txt`);
    expect(ws.listAttachments(taskId)).toHaveLength(2);

    const result = ws.deleteTask(taskId, "us_a");

    expect(result.ok).toBe(true);
    expect(result.r2Keys.sort()).toEqual([`at/${taskId}/1/a.txt`, `at/${taskId}/2/b.txt`]);

    // The attachments row is gone...
    expect(ws.listAttachments("ta_a")).toHaveLength(0);
    // ...but the keys survive in pending_object_deletes.
    const pending = (
      ws as unknown as { sql: SqlStorage }
    ).sql
      .exec<{ r2_key: string }>("SELECT r2_key FROM pending_object_deletes ORDER BY r2_key")
      .toArray()
      .map((r) => r.r2_key);
    expect(pending).toEqual([`at/${taskId}/1/a.txt`, `at/${taskId}/2/b.txt`]);

    // The R2 objects themselves are untouched by deleteTask — that's the
    // caller's job (route waitUntil or the backup sweep).
    expect(objects.has(`at/${taskId}/1/a.txt`)).toBe(true);
    expect(objects.has(`at/${taskId}/2/b.txt`)).toBe(true);
  });

  it("deleting a task with no attachments records nothing", () => {
    const result = ws.deleteTask(taskId, "us_a");
    expect(result.r2Keys).toEqual([]);
    const pending = (
      ws as unknown as { sql: SqlStorage }
    ).sql
      .exec<{ r2_key: string }>("SELECT r2_key FROM pending_object_deletes")
      .toArray();
    expect(pending).toEqual([]);
  });

  it("clearPendingObjectDeletes drops the given rows", () => {
    seedAttachment("a.txt", `at/${taskId}/1/a.txt`);
    seedAttachment("b.txt", `at/${taskId}/2/b.txt`);
    ws.deleteTask(taskId, "us_a");

    const cleared = ws.clearPendingObjectDeletes([`at/${taskId}/1/a.txt`]);
    expect(cleared).toEqual({ ok: true, cleared: 1 });

    const pending = (
      ws as unknown as { sql: SqlStorage }
    ).sql
      .exec<{ r2_key: string }>("SELECT r2_key FROM pending_object_deletes ORDER BY r2_key")
      .toArray()
      .map((r) => r.r2_key);
    expect(pending).toEqual([`at/${taskId}/2/b.txt`]);
  });

  it("the backup job's sweep deletes swept keys from R2 and clears their pending rows", async () => {
    seedAttachment("a.txt", `at/${taskId}/1/a.txt`);
    seedAttachment("b.txt", `at/${taskId}/2/b.txt`);
    ws.deleteTask(taskId, "us_a");
    expect(objects.has(`at/${taskId}/1/a.txt`)).toBe(true);
    expect(objects.has(`at/${taskId}/2/b.txt`)).toBe(true);

    const now = Date.UTC(2026, 0, 16, 6, 0, 0);
    const result = await (
      ws as unknown as { runJob(job: unknown, now: number): Promise<Record<string, number>> }
    ).runJob({ id: 1, run_at: now, kind: "backup", payload: null, every_ms: 86_400_000 }, now);

    expect(result.sweptDeletes).toBe(2);
    // The backup job also writes today's ndjson.gz object, so the objects
    // touched by the sweep are the two attachment keys, both now gone.
    expect(objects.has(`at/${taskId}/1/a.txt`)).toBe(false);
    expect(objects.has(`at/${taskId}/2/b.txt`)).toBe(false);

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
      { taskId, filename: "a.txt", r2Key: `at/${taskId}/1/a.txt`, size: 10, mimeType: "text/plain" },
      "us_a"
    );
    objects.set(`at/${taskId}/1/a.txt`, { key: `at/${taskId}/1/a.txt`, body: new ArrayBuffer(0) });

    const removed = ws.deleteAttachment(attachment.id, "us_a");
    expect(removed).toEqual({ ok: true, r2Key: `at/${taskId}/1/a.txt` });
    expect(ws.listAttachments(taskId)).toHaveLength(0);

    const pending = (
      ws as unknown as { sql: SqlStorage }
    ).sql
      .exec<{ r2_key: string }>("SELECT r2_key FROM pending_object_deletes")
      .toArray()
      .map((r) => r.r2_key);
    expect(pending).toEqual([`at/${taskId}/1/a.txt`]);
    // The object itself is the route's job, not the DO's.
    expect(objects.has(`at/${taskId}/1/a.txt`)).toBe(true);

    // The route clears the row after a successful R2 delete.
    expect(ws.clearPendingObjectDeletes([`at/${taskId}/1/a.txt`])).toEqual({ ok: true, cleared: 1 });
    const after = (
      ws as unknown as { sql: SqlStorage }
    ).sql
      .exec<{ r2_key: string }>("SELECT r2_key FROM pending_object_deletes")
      .toArray();
    expect(after).toEqual([]);
  });
});
