import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateListInput, CreateSpaceInput, CreateTaskInput } from "@flow/shared";
import type { BulkUpdateInput } from "@flow/shared";

// ---------------------------------------------------------------------------
// Delivery-failure visibility (hardening-round-2):
//   1. flush() chunks SIDE_EFFECTS.sendBatch calls at 100 messages AND ~200KB
//      of UTF-8 JSON (Queues caps a call at 100 msgs/256KB), and fits every
//      message under the 128KB per-message cap first by truncating long
//      content strings, so neither limit makes sendBatch reject a whole chunk.
//      A payload that can't be fitted, or a chunk sendBatch still rejects,
//      gets an ok:false run-log row for each automation message in it.
//   2. recordDeliveryFailure appends an ok:false automation_runs row,
//      correcting the ok:true "queued" row the engine wrote at enqueue time.
//
// The queue mock enforces the real limits (strictSendBatch below) instead of
// accepting anything, so a chunking regression fails here rather than in prod.
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

function fakeCtx(db: DatabaseSync, pending: Promise<unknown>[]): DurableObjectState {
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
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    getWebSockets: () => [],
    acceptWebSocket: () => undefined,
  } as unknown as DurableObjectState;
}

/** Cloudflare Queues' real limits, as documented. */
const QUEUE_MESSAGE_LIMIT = 128 * 1024;
const QUEUE_BATCH_LIMIT = 256 * 1024;
const QUEUE_BATCH_MESSAGES = 100;

const utf8Bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * A sendBatch that rejects the whole call the way Queues does: any message
 * over 128KB, more than 100 messages, or more than 256KB in total. Bodies are
 * measured as UTF-8 JSON, which is what the default `json` content type sends.
 */
function strictSendBatch() {
  return vi.fn(async (batch: Array<{ body: unknown }>) => {
    if (batch.length > QUEUE_BATCH_MESSAGES) {
      throw new Error(`sendBatch: ${batch.length} messages exceeds ${QUEUE_BATCH_MESSAGES}`);
    }
    let total = 0;
    for (const { body } of batch) {
      const bytes = utf8Bytes(body);
      if (bytes > QUEUE_MESSAGE_LIMIT) {
        throw new Error(`sendBatch: a ${bytes}-byte message exceeds ${QUEUE_MESSAGE_LIMIT}`);
      }
      total += bytes;
    }
    if (total > QUEUE_BATCH_LIMIT) {
      throw new Error(`sendBatch: ${total} bytes exceeds ${QUEUE_BATCH_LIMIT}`);
    }
  });
}

async function freshWorkspace(
  sendBatch: ReturnType<typeof strictSendBatch> = strictSendBatch()
) {
  const { Workspace } = await import("./index.js");
  const db = new DatabaseSync(":memory:");
  const pending: Promise<unknown>[] = [];
  const ctx = fakeCtx(db, pending);
  const env = { SIDE_EFFECTS: { sendBatch } } as never;
  const ws = new Workspace(ctx, env);
  /** Wait for every waitUntil'd sendBatch (and its failure handling). */
  const settle = async (): Promise<void> => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };
  return { ws, db, sendBatch, settle };
}

const OWNER = "us_owner";

describe("flush: chunked sendBatch", () => {
  it("splits a turn that enqueues 250 side effects into 3 sendBatch calls", async () => {
    const { ws, sendBatch, settle } = await freshWorkspace();

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
    await settle();

    expect(sendBatch).toHaveBeenCalledTimes(3);
    const sizes = sendBatch.mock.calls.map(([batch]) => batch.length);
    expect(sizes).toEqual([100, 100, 50]);
    // The strict mock rejects anything the real queue would; none were.
    for (const result of sendBatch.mock.results) {
      await expect(result.value).resolves.toBeUndefined();
    }
  });
});

describe("flush: Queues' 128KB per-message cap", () => {
  // A Gleap-sized bug report: long, multi-line, quoted and not pure ASCII, so
  // UTF-16 length, UTF-8 bytes and JSON-escaped bytes all disagree.
  const gleapDescription = (minChars: number): string => {
    const line =
      'Steps: tap “Save” → spinner never stops; console: "TypeError: x is undefined" \\ 🐛\n';
    return line.repeat(Math.ceil(minChars / line.length));
  };

  async function assigneeChangeSetup(sendBatch?: ReturnType<typeof strictSendBatch>) {
    const h = await freshWorkspace(sendBatch);
    const avery = h.ws.listUsers().find((u) => u.role === "owner");
    if (!avery) throw new Error("expected the seeded owner");
    // Only the placeholder owner is seeded; the assignee is an admin made here.
    const blake = h.ws.upsertUser({ id: "us_blake", email: "blake@example.com", name: "Blake", role: "admin" }, avery.id);
    const space = h.ws.createSpace(CreateSpaceInput.parse({ name: "Space" }), avery.id);
    const list = h.ws.createList(CreateListInput.parse({ spaceId: space.id, name: "List" }), avery.id);
    const scope = { kind: "list" as const, listId: list.id };
    const trigger = { kind: "assignee_changed" as const };
    const webhookRule = h.ws.upsertAutomation(
      {
        name: "tell the vendor",
        enabled: true,
        scope,
        trigger,
        conditions: [],
        actions: [{ kind: "call_webhook", url: "https://example.com/hook", secret: "s3cret" }],
      },
      avery.id
    );
    const emailRule = h.ws.upsertAutomation(
      {
        name: "tell ops",
        enabled: true,
        scope,
        trigger,
        conditions: [],
        actions: [
          {
            kind: "send_email",
            to: ["ops@example.com"],
            subject: "Reassigned: {{task.title}}",
            body: "{{task.title}} changed hands.",
          },
        ],
      },
      avery.id
    );
    const task = h.ws.createTask(
      CreateTaskInput.parse({ listId: list.id, title: "Gleap #4521" }),
      avery.id
    );
    await h.settle();
    h.sendBatch.mockClear();
    return { ...h, avery, blake, task, webhookRule, emailRule };
  }

  const deliveryFailures = (db: DatabaseSync) =>
    db
      .prepare("SELECT rule_id, results FROM automation_runs WHERE trigger = 'delivery_failure'")
      .all() as Array<{ rule_id: string; results: string }>;

  it("truncates a webhook that carries a ~36KB description 4 times, so the emails batched with it still go out", async () => {
    const { SIDE_EFFECTS_MESSAGE_BYTES, TRUNCATION_MARKER } = await import("./index.js");
    const s = await assigneeChangeSetup();
    const description = gleapDescription(36_000);
    // Four copies of this are well over 128KB, but far under the old 200KB
    // chunk budget, which is how it used to ride along with (and sink) the
    // notification emails in the same sendBatch.
    expect(4 * utf8Bytes(description)).toBeGreaterThan(QUEUE_MESSAGE_LIMIT);

    s.ws.updateTask({ taskId: s.task.id, description, assigneeId: s.blake.id }, s.avery.id);
    await s.settle();

    expect(s.sendBatch).toHaveBeenCalledTimes(1);
    await expect(s.sendBatch.mock.results[0]?.value).resolves.toBeUndefined();
    const bodies = (s.sendBatch.mock.calls[0]?.[0] ?? []).map((m) => m.body) as Array<
      Record<string, unknown>
    >;
    // The rule webhook, the rule email and Blake's "assigned to you" email.
    expect(bodies.map((b) => `${String(b.kind)}:${String(b.ruleId)}`).sort()).toEqual(
      [
        `email:${s.emailRule.id}`,
        "email:notify:assigned_to_me",
        `webhook:${s.webhookRule.id}`,
      ].sort()
    );

    const hook = bodies.find((b) => b.kind === "webhook");
    if (!hook) throw new Error("expected the webhook message");
    expect(utf8Bytes(hook)).toBeLessThanOrEqual(SIDE_EFFECTS_MESSAGE_BYTES);
    // Routing is untouched; the envelope keeps every key receivers read.
    expect(hook.url).toBe("https://example.com/hook");
    expect(hook.secret).toBe("s3cret");
    expect(hook.taskId).toBe(s.task.id);
    const envelope = hook.body as {
      event: string;
      truncated?: boolean;
      delta: { data: Record<string, unknown> };
      task: { id: string; title: string; description: string };
      payload: { name: string; description: string; text_content: string };
      workspace: string;
    };
    expect(Object.keys(envelope).sort()).toEqual(
      ["delta", "event", "payload", "task", "truncated", "workspace"].sort()
    );
    expect(envelope.truncated).toBe(true);
    expect(envelope.task.id).toBe(s.task.id);
    expect(envelope.task.title).toBe("Gleap #4521");
    expect(envelope.payload.name).toBe("Gleap #4521");
    expect(envelope.delta.data.assigneeId).toBe(s.blake.id);
    // All four copies are cut to the same visible prefix plus the marker.
    const copies = [
      envelope.delta.data.description as string,
      envelope.task.description,
      envelope.payload.description,
      envelope.payload.text_content,
    ];
    for (const copy of copies) {
      expect(copy.endsWith(TRUNCATION_MARKER)).toBe(true);
      const kept = copy.slice(0, -TRUNCATION_MARKER.length);
      expect(kept.length).toBeGreaterThan(20_000);
      expect(description.startsWith(kept)).toBe(true);
    }
    expect(deliveryFailures(s.db)).toEqual([]);
  });

  it("records an ok:false run for a payload that cannot fit even after truncation, and sends the rest", async () => {
    const s = await assigneeChangeSetup();
    // The url is routing, never truncated; a 130KB one can't be made to fit.
    const hugeUrl = `https://example.com/${"a".repeat(130 * 1024)}`;
    s.ws.upsertAutomation(
      {
        id: s.webhookRule.id,
        name: "tell the vendor",
        enabled: true,
        scope: s.webhookRule.scope,
        trigger: { kind: "assignee_changed" },
        conditions: [],
        actions: [{ kind: "call_webhook", url: hugeUrl, secret: null }],
      },
      s.avery.id
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      s.ws.updateTask({ taskId: s.task.id, assigneeId: s.blake.id }, s.avery.id);
      await s.settle();
    } finally {
      errorSpy.mockRestore();
    }

    expect(s.sendBatch).toHaveBeenCalledTimes(1);
    await expect(s.sendBatch.mock.results[0]?.value).resolves.toBeUndefined();
    const kinds = (s.sendBatch.mock.calls[0]?.[0] ?? []).map(
      (m) => (m.body as { ruleId: string }).ruleId
    );
    expect(kinds.sort()).toEqual([s.emailRule.id, "notify:assigned_to_me"].sort());

    const failures = deliveryFailures(s.db);
    expect(failures.map((f) => f.rule_id)).toEqual([s.webhookRule.id]);
    const [result] = JSON.parse(failures[0]?.results ?? "[]") as Array<{
      action: string;
      ok: boolean;
      detail: string;
    }>;
    expect(result?.action).toBe("call_webhook");
    expect(result?.ok).toBe(false);
    expect(result?.detail).toMatch(/not sent: payload is \d+ bytes even after truncation/);
  });

  it("records ok:false runs for the automation messages in a chunk sendBatch rejects, not for notifications", async () => {
    const rejecting = strictSendBatch().mockRejectedValue(new Error("Queue sendBatch failed: 500"));
    const s = await assigneeChangeSetup(rejecting);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      s.ws.updateTask({ taskId: s.task.id, assigneeId: s.blake.id }, s.avery.id);
      await s.settle();
    } finally {
      errorSpy.mockRestore();
    }

    const failures = deliveryFailures(s.db);
    expect(failures.map((f) => f.rule_id).sort()).toEqual(
      [s.webhookRule.id, s.emailRule.id].sort()
    );
    for (const f of failures) {
      const [result] = JSON.parse(f.results) as Array<{ ok: boolean; detail: string }>;
      expect(result?.ok).toBe(false);
      expect(result?.detail).toContain("queue rejected the batch (Queue sendBatch failed: 500)");
    }
    // The notification has no rule to log against.
    expect(failures.some((f) => f.rule_id.startsWith("notify:"))).toBe(false);
  });
});

describe("chunkSideEffects: byte-aware chunking", () => {
  const email = (body: string, to: string[] = ["a@example.com"]) => ({
    kind: "email" as const,
    to,
    cc: [],
    bcc: [],
    subject: "s",
    body,
    ruleId: "ar_1",
    taskId: "tk_1",
  });

  /** Every chunk must be one call the real queue would accept. */
  async function expectQueueAccepts(chunks: unknown[][]): Promise<void> {
    const send = strictSendBatch();
    for (const chunk of chunks) {
      await expect(send(chunk.map((body) => ({ body })))).resolves.toBeUndefined();
    }
  }

  it("splits 250 small messages at the 100-message cap", async () => {
    const { chunkSideEffects } = await import("./index.js");
    const chunks = chunkSideEffects(Array.from({ length: 250 }, (_, i) => email(`m${i}`)));
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
    await expectQueueAccepts(chunks);
  });

  it("budgets batches in UTF-8 bytes, not UTF-16 length", async () => {
    const { SIDE_EFFECTS_BATCH_BYTES, chunkSideEffects } = await import("./index.js");
    // 35k "é" is 35k UTF-16 units but 70k UTF-8 bytes: only 2 fit per 200KB
    // chunk. Measured by .length, 5 would have been packed into one 350KB call.
    const big = email("é".repeat(35_000));
    const chunks = chunkSideEffects(Array.from({ length: 10 }, () => ({ ...big })));
    expect(chunks.map((c) => c.length)).toEqual([2, 2, 2, 2, 2]);
    for (const chunk of chunks) {
      expect(chunk.reduce((n, m) => n + utf8Bytes(m), 0)).toBeLessThanOrEqual(
        SIDE_EFFECTS_BATCH_BYTES
      );
    }
    await expectQueueAccepts(chunks);
  });

  it("truncates an oversized email body to fit instead of attempting it whole", async () => {
    const { SIDE_EFFECTS_MESSAGE_BYTES, TRUNCATION_MARKER, chunkSideEffects } = await import(
      "./index.js"
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const oversize = email("x".repeat(200 * 1024));
      const chunks = chunkSideEffects([email("small-1"), oversize, email("small-2")]);
      const flat = chunks.flat();
      // Nothing dropped, order preserved, the big one shrunk to fit.
      expect(flat.map((m) => m.body.slice(0, 7))).toEqual(["small-1", "xxxxxxx", "small-2"]);
      const shrunk = flat[1];
      if (!shrunk) throw new Error("expected the shrunk message");
      expect(shrunk).not.toBe(oversize);
      expect(shrunk.body.endsWith(TRUNCATION_MARKER)).toBe(true);
      expect(shrunk.to).toEqual(["a@example.com"]);
      expect(utf8Bytes(shrunk)).toBeLessThanOrEqual(SIDE_EFFECTS_MESSAGE_BYTES);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      await expectQueueAccepts(chunks);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("leaves out a payload that can't be fitted and reports it to onUndeliverable", async () => {
    const { chunkSideEffects } = await import("./index.js");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // Recipients are routing and never truncated: 6,000 of them can't fit.
      const recipients = Array.from({ length: 6_000 }, (_, i) => `person-${i}@example.com`);
      const unfittable = email("hi", recipients);
      const undeliverable: Array<{ payload: unknown; bytes: number }> = [];
      const chunks = chunkSideEffects(
        [email("small-1"), unfittable, email("small-2")],
        (payload, bytes) => undeliverable.push({ payload, bytes })
      );
      expect(chunks.flat().map((m) => m.body)).toEqual(["small-1", "small-2"]);
      expect(undeliverable).toHaveLength(1);
      expect(undeliverable[0]?.payload).toBe(unfittable);
      expect(undeliverable[0]?.bytes).toBeGreaterThan(QUEUE_MESSAGE_LIMIT);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      await expectQueueAccepts(chunks);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("fitSideEffect", () => {
  // Every character class whose JSON cost differs: quotes and backslashes
  // (2 bytes), newlines/tabs (2), other control chars (6), 2- and 3-byte
  // UTF-8, and astral-plane emoji (4).
  const nasty = 'a"b\\c\nd\te\u0001fé→🐛 ';
  const description = nasty.repeat(Math.ceil(40_000 / nasty.length));
  const webhook = {
    kind: "webhook" as const,
    url: "https://example.com/hook",
    secret: "s3cret",
    ruleId: "ar_1",
    taskId: "tk_1",
    body: {
      event: "task.created",
      delta: {
        seq: 7,
        op: "create",
        entity: "task",
        id: "tk_1",
        data: { id: "tk_1", title: "Bug", description },
        actorUserId: "us_1",
        at: 1,
      },
      task: { id: "tk_1", title: "Bug", description, tags: ["gleap"] },
      payload: { id: "tk_1", name: "Bug", description, text_content: description },
      workspace: "flow.example.com",
    },
  };

  it("returns a payload under the budget unchanged", async () => {
    const { fitSideEffect } = await import("./index.js");
    const small = { ...webhook, body: { ...webhook.body, task: null, payload: null } };
    const fitted = fitSideEffect({ ...small, body: { ...small.body, delta: { ...small.body.delta, data: null } } });
    expect(fitted.payload).not.toBeNull();
    expect(fitted.payload?.body).not.toHaveProperty("truncated");
  });

  it("cuts every copy to one shared cap that fills the budget, and the result round-trips as JSON", async () => {
    const { SIDE_EFFECTS_MESSAGE_BYTES, TRUNCATION_MARKER, fitSideEffect, sideEffectBytes } =
      await import("./index.js");
    expect(sideEffectBytes(webhook)).toBeGreaterThan(QUEUE_MESSAGE_LIMIT);

    const { payload, bytes } = fitSideEffect(webhook);
    if (payload === null) throw new Error("expected the webhook to be fitted");
    expect(bytes).toBe(utf8Bytes(payload));
    expect(bytes).toBeLessThanOrEqual(SIDE_EFFECTS_MESSAGE_BYTES);
    // Not over-truncated: the shared cap leaves only char-boundary slack.
    expect(bytes).toBeGreaterThan(SIDE_EFFECTS_MESSAGE_BYTES - 64);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);

    const body = payload.body as typeof webhook.body & { truncated?: boolean };
    expect(body.truncated).toBe(true);
    const copies = [
      body.delta.data.description,
      body.task.description,
      body.payload.description,
      body.payload.text_content,
    ];
    for (const copy of copies) {
      expect(copy.endsWith(TRUNCATION_MARKER)).toBe(true);
      expect(description.startsWith(copy.slice(0, -TRUNCATION_MARKER.length))).toBe(true);
      // Never split inside a surrogate pair.
      expect(/[\uD800-\uDBFF]$/.test(copy.slice(0, -TRUNCATION_MARKER.length))).toBe(false);
    }
    expect(new Set(copies).size).toBe(1);
    // Short fields and routing survive intact; the original is not mutated.
    expect(body.task.title).toBe("Bug");
    expect(body.task.tags).toEqual(["gleap"]);
    expect(payload.url).toBe(webhook.url);
    expect(payload.secret).toBe(webhook.secret);
    expect(webhook.body.task.description).toBe(description);
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
