import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  CreateListInput,
  CreateSpaceInput,
  CreateSubtaskInput,
  CreateTaskInput,
  UpdateSubtaskInput,
} from "@flow/shared";

// ---------------------------------------------------------------------------
// The subtask `note` column (core-0009) round-tripped through the real
// Workspace class: create carries it, update sets and clears it, and both the
// snapshot and the per-task listing read it back. Same harness as
// visibility-storage.test.ts: `cloudflare:workers` is mocked so the real
// Workspace runs against node:sqlite.
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

async function seeded() {
  const { Workspace } = await import("./index.js");
  const db = new DatabaseSync(":memory:");
  const env = { SIDE_EFFECTS: { sendBatch: vi.fn(async () => undefined) } } as never;
  const ws = new Workspace(fakeCtx(db), env);
  ws.upsertUser({ id: OWNER, email: "owner@example.com", name: "Owner", role: "owner" }, OWNER);
  const space = ws.createSpace(
    CreateSpaceInput.parse({ name: "Ops", visibility: "workspace" }),
    OWNER
  );
  const list = ws.createList(CreateListInput.parse({ spaceId: space.id, name: "Inbox" }), OWNER);
  const task = ws.createTask(CreateTaskInput.parse({ listId: list.id, title: "Parent" }), OWNER);
  return { ws, task };
}

describe("subtask notes", () => {
  it("carries a note through create and reads it back everywhere", async () => {
    const { ws, task } = await seeded();
    const created = ws.createSubtask(
      CreateSubtaskInput.parse({ taskId: task.id, title: "Step", note: "Use the March numbers." }),
      OWNER
    );
    expect(created.note).toBe("Use the March numbers.");
    expect(ws.listSubtasks(task.id)[0]?.note).toBe("Use the March numbers.");
    expect(ws.getSnapshot(OWNER).subtasks[0]?.note).toBe("Use the March numbers.");
  });

  it("defaults to null and survives unrelated updates", async () => {
    const { ws, task } = await seeded();
    const created = ws.createSubtask(
      CreateSubtaskInput.parse({ taskId: task.id, title: "Step" }),
      OWNER
    );
    expect(created.note).toBeNull();
    const retitled = ws.updateSubtask({ subtaskId: created.id, title: "Renamed" }, OWNER);
    expect(retitled.note).toBeNull();
  });

  it("updateSubtask sets and clears the note", async () => {
    const { ws, task } = await seeded();
    const created = ws.createSubtask(
      CreateSubtaskInput.parse({ taskId: task.id, title: "Step" }),
      OWNER
    );
    const withNote = ws.updateSubtask(
      UpdateSubtaskInput.parse({ subtaskId: created.id, note: "Check the shared sheet first." }),
      OWNER
    );
    expect(withNote.note).toBe("Check the shared sheet first.");
    expect(withNote.title).toBe("Step");

    const cleared = ws.updateSubtask(
      UpdateSubtaskInput.parse({ subtaskId: created.id, note: null }),
      OWNER
    );
    expect(cleared.note).toBeNull();
    expect(ws.listSubtasks(task.id)[0]?.note).toBeNull();
  });
});
