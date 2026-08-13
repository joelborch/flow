import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateListInput, CreateSpaceInput, CreateTaskInput } from "@flow/shared";
import type { BulkUpdateInput } from "@flow/shared";

// ---------------------------------------------------------------------------
// Delivery-failure visibility (hardening-round-2):
//   1. flush() chunks SIDE_EFFECTS.sendBatch calls at 100 messages AND ~200KB
//      of estimated serialized payload (Queues caps a call at 100 msgs/256KB),
//      so a single turn that enqueues more than either per-call cap doesn't
//      lose the overflow (previously: one unchunked sendBatch,
//      caught+console.error only, silently dropping the whole turn's side
//      effects).
//   2. recordDeliveryFailure appends an ok:false automation_runs row,
//      correcting the ok:true "queued" row the engine wrote at enqueue time.
//
// Same real-Workspace-over-node:sqlite harness as import-batch.test.ts /
// visibility-storage.test.ts.
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
    const returnsRows = /^\s*SELECT/i.test(query) || /RETURNING/i.test(query);
    if (!returnsRows) {
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

async function freshWorkspace() {
  const { Workspace } = await import("./index.js");
  const db = new DatabaseSync(":memory:");
  const ctx = fakeCtx(db);
  const sendBatch = vi.fn(async (_batch: Array<{ body: unknown }>) => undefined);
  const env = { SIDE_EFFECTS: { sendBatch } } as never;
  const ws = new Workspace(ctx, env);
  return { ws, db, sendBatch };
}

const OWNER = "us_owner";

describe("flush: chunked sendBatch", () => {
  it("splits a turn that enqueues 250 side effects into 3 sendBatch calls", async () => {
    const { ws, sendBatch } = await freshWorkspace();

    const space = ws.createSpace(CreateSpaceInput.parse({ name: "Space" }), OWNER);
    const list = ws.createList(
      CreateListInput.parse({ spaceId: space.id, name: "List" }),
      OWNER
    );

    // Fires a webhook on every status_changed -> "In Progress".
    ws.upsertAutomation(
      {
        name: "notify vendor",
        enabled: true,
        scope: { kind: "list", listId: list.id },
        trigger: { kind: "status_changed", to: ["In Progress"] },
        conditions: [],
        actions: [{ kind: "call_webhook", url: "https://example.com/hook", secret: null }],
      },
      OWNER
    );

    const taskIds: string[] = [];
    for (let i = 0; i < 250; i++) {
      const task = ws.createTask(
        CreateTaskInput.parse({ listId: list.id, title: `Task ${i}` }),
        OWNER
      );
      taskIds.push(task.id);
    }
    sendBatch.mockClear();

    // Bypasses the route-level BulkUpdateInput.max(200) — the DO method
    // itself has no such cap, and the point here is one runTurn/flush cycle
    // enqueueing more than Queues' 100-message sendBatch limit.
    const input = {
      updates: taskIds.map((taskId) => ({ taskId, status: "In Progress" })),
    } as unknown as BulkUpdateInput;
    ws.bulkUpdate(input, OWNER);

    expect(sendBatch).toHaveBeenCalledTimes(3);
    const sizes = sendBatch.mock.calls.map(([batch]) => batch.length);
    expect(sizes).toEqual([100, 100, 50]);
  });
});

describe("chunkSideEffects: byte-aware chunking", () => {
  const email = (body: string) => ({
    kind: "email" as const,
    to: ["a@example.com"],
    cc: [],
    bcc: [],
    subject: "s",
    body,
    ruleId: "ar_1",
    taskId: "tk_1",
  });

  it("splits 250 small messages at the 100-message cap", async () => {
    const { chunkSideEffects } = await import("./index.js");
    const chunks = chunkSideEffects(Array.from({ length: 250 }, (_, i) => email(`m${i}`)));
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
  });

  it("starts a new chunk when the next message would push past the byte budget", async () => {
    const { SIDE_EFFECTS_BATCH_BYTES, chunkSideEffects } = await import("./index.js");
    // Each ~ a third of the budget: exactly 3 fit per chunk (the 4th would
    // exceed it), even though 100-message chunking alone would put all 10
    // in one call.
    const big = email("x".repeat(Math.floor(SIDE_EFFECTS_BATCH_BYTES / 3) - 200));
    const chunks = chunkSideEffects(Array.from({ length: 10 }, () => ({ ...big })));
    expect(chunks.map((c) => c.length)).toEqual([3, 3, 3, 1]);
    // Nothing dropped, order preserved.
    expect(chunks.flat()).toHaveLength(10);
    for (const chunk of chunks) {
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(SIDE_EFFECTS_BATCH_BYTES + 100);
    }
  });

  it("a single message over the budget is logged and still attempted alone", async () => {
    const { SIDE_EFFECTS_BATCH_BYTES, chunkSideEffects } = await import("./index.js");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const oversize = email("x".repeat(SIDE_EFFECTS_BATCH_BYTES + 1024));
      const chunks = chunkSideEffects([email("small-1"), oversize, email("small-2")]);
      // The oversized one can't be split, so it rides alone; the smalls are
      // not dropped and keep their relative order around it.
      expect(chunks.map((c) => c.length)).toEqual([1, 1, 1]);
      expect(chunks[1]?.[0]).toBe(oversize);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("recordDeliveryFailure", () => {
  let ws: Awaited<ReturnType<typeof freshWorkspace>>["ws"];

  beforeEach(async () => {
    ({ ws } = await freshWorkspace());
  });

  it("appends an ok:false automation_runs row", () => {
    const result = ws.recordDeliveryFailure({
      ruleId: "ar_1",
      taskId: "tk_1",
      kind: "webhook",
      detail: "webhook https://example.com returned 410: gone",
    });
    expect(result).toEqual({ ok: true });

    const runs = ws.listAutomationRuns({ ruleId: "ar_1", taskId: "tk_1" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe("delivery_failure");
    expect(runs[0]?.results).toEqual([
      {
        action: "call_webhook",
        ok: false,
        dryRun: false,
        detail: "webhook https://example.com returned 410: gone",
      },
    ]);
  });

  it("distinguishes email failures in the recorded action name", () => {
    ws.recordDeliveryFailure({
      ruleId: "ar_2",
      taskId: "tk_2",
      kind: "email",
      detail: "SEND_EMAIL binding missing",
    });
    const runs = ws.listAutomationRuns({ ruleId: "ar_2", taskId: "tk_2" });
    expect(runs[0]?.results[0]?.action).toBe("send_email");
  });

  it("never throws even if the underlying write fails", () => {
    const brokenSql = {
      exec: () => {
        throw new Error("SQLITE_BUSY");
      },
    } as unknown as SqlStorage;
    // @ts-expect-error -- reaching into a private field to simulate a storage
    // failure; the method must swallow it rather than crash the caller.
    ws.sql = brokenSql;
    expect(() =>
      ws.recordDeliveryFailure({ ruleId: "ar_3", taskId: "tk_3", kind: "webhook", detail: "x" })
    ).not.toThrow();
  });
});
