import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { CreateListInput, CreateSpaceInput, CreateTaskInput } from "@flow/shared";

// ---------------------------------------------------------------------------
// A cross-list move keeps the status NAME but swaps the status id.
//
// Statuses are per-list, so "Done" in list A and "Done" in list B have
// different ids. Comparing ids made every Done -> Done move look like a
// status change: `status_changed { to: ["Done"] }` rules re-fired (recurring
// rules minted a second occurrence) and stakeholders got a "status changed to
// Done" email. The product references statuses by name, case-insensitively,
// so the same name is no change — while a genuine same-list change, and a move
// that lands on a differently named status, still count.
//
// Same real-Workspace-over-node:sqlite harness as visibility-storage.test.ts.
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

const OWNER = "us_owner";
const ASSIGNEE = "us_assignee";

interface EmailPayload {
  kind: string;
  to: string[];
  subject: string;
  ruleId: string;
}

/**
 * Lists A and B with the default To Do / In Progress / Done set, list C with
 * "Backlog" / "Shipped" (no "Done"), a `to: ["Done"]` tagging rule on every
 * list, and an assignee who has opted into status-change emails.
 */
async function seeded() {
  const { Workspace } = await import("./index.js");
  const db = new DatabaseSync(":memory:");
  const sendBatch = vi.fn(async (_batch: Array<{ body: unknown }>) => undefined);
  const ws = new Workspace(fakeCtx(db), { SIDE_EFFECTS: { sendBatch } } as never);

  ws.upsertUser({ id: OWNER, email: "owner@example.com", name: "Owner", role: "owner" }, OWNER);
  ws.upsertUser({ id: ASSIGNEE, email: "assignee@example.com", name: "Assignee" }, OWNER);
  ws.setNotificationPrefs(ASSIGNEE, { status_change_on_my_task: true });

  const space = ws.createSpace(CreateSpaceInput.parse({ name: "S", visibility: "workspace" }), OWNER);
  const listA = ws.createList(CreateListInput.parse({ spaceId: space.id, name: "A" }), OWNER);
  const listB = ws.createList(CreateListInput.parse({ spaceId: space.id, name: "B" }), OWNER);
  const listC = ws.createList(
    CreateListInput.parse({
      spaceId: space.id,
      name: "C",
      statuses: [
        { name: "Backlog", color: "#999", type: "open" },
        { name: "Shipped", color: "#0a0", type: "closed" },
      ],
    }),
    OWNER
  );
  ws.upsertAutomation(
    {
      name: "tag on Done",
      enabled: true,
      scope: { kind: "space", spaceId: space.id },
      trigger: { kind: "status_changed", to: ["done"] },
      conditions: [],
      actions: [{ kind: "add_tags", tags: ["fired-done"] }],
    },
    OWNER
  );
  ws.upsertAutomation(
    {
      name: "tag on any change",
      enabled: true,
      scope: { kind: "space", spaceId: space.id },
      trigger: { kind: "status_changed" },
      conditions: [],
      actions: [{ kind: "add_tags", tags: ["fired-any"] }],
    },
    OWNER
  );

  const doneTask = ws.createTask(
    CreateTaskInput.parse({ listId: listA.id, title: "Shipped it", status: "Done", assigneeId: ASSIGNEE }),
    OWNER
  );

  const statusEmails = (): EmailPayload[] =>
    sendBatch.mock.calls
      .flatMap(([batch]) => batch.map((m) => m.body as EmailPayload))
      .filter((p) => p.kind === "email" && p.to.includes("assignee@example.com") && /status/i.test(p.ruleId));
  const tags = (taskId: string) => ws.getTaskDetail(taskId).task.tags;

  return { ws, listA, listB, listC, doneTask, statusEmails, tags };
}

describe("cross-list move, same status name", () => {
  it("does not fire status_changed rules or email a status change", async () => {
    const h = await seeded();
    const moved = h.ws.moveTask({ taskId: h.doneTask.id, listId: h.listB.id }, OWNER);

    // The move really did swap the id for list B's own "Done".
    expect(moved.listId).toBe(h.listB.id);
    expect(moved.statusId).not.toBe(h.doneTask.statusId);
    expect(h.tags(h.doneTask.id)).toEqual([]);
    expect(h.statusEmails()).toEqual([]);
  });

  it("an explicit status name that matches case-insensitively is still no change", async () => {
    const h = await seeded();
    h.ws.moveTask({ taskId: h.doneTask.id, listId: h.listB.id, status: "DONE" }, OWNER);
    expect(h.tags(h.doneTask.id)).toEqual([]);
    expect(h.statusEmails()).toEqual([]);
  });
});

describe("genuine status changes still fire", () => {
  it("a same-list status change fires rules and emails", async () => {
    const h = await seeded();
    const task = h.ws.createTask(
      CreateTaskInput.parse({ listId: h.listB.id, title: "Open work", assigneeId: ASSIGNEE }),
      OWNER
    );
    h.ws.updateTask({ taskId: task.id, status: "Done" }, OWNER);
    expect(h.tags(task.id).sort()).toEqual(["fired-any", "fired-done"]);
    expect(h.statusEmails()).toHaveLength(1);
  });

  it("a cross-list move onto a differently named status fires rules and emails", async () => {
    const h = await seeded();
    // List C has no "Done", so the move falls back to its open status.
    const moved = h.ws.moveTask({ taskId: h.doneTask.id, listId: h.listC.id }, OWNER);
    expect(moved.statusId).toBe(h.listC.statuses.find((s) => s.name === "Backlog")?.id);
    expect(h.tags(h.doneTask.id)).toEqual(["fired-any"]);
    expect(h.statusEmails()).toHaveLength(1);
  });
});
