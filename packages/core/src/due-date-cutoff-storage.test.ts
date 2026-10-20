import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { CreateListInput, CreateSpaceInput, CreateTaskInput } from "@flow/shared";

// ---------------------------------------------------------------------------
// set_due_date: a ticket that arrives before the cutoff is due that day, one
// that arrives later is due the next business day. Same real-Workspace-over-
// node:sqlite harness as visibility-storage.test.ts.
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
const NY = "America/New_York";

async function seeded() {
  const { Workspace } = await import("./index.js");
  const db = new DatabaseSync(":memory:");
  const ws = new Workspace(fakeCtx(db), { SIDE_EFFECTS: { sendBatch: async () => undefined } } as never);
  ws.upsertUser({ id: OWNER, email: "owner@example.com", name: "Owner", role: "owner" }, OWNER);
  const space = ws.createSpace(CreateSpaceInput.parse({ name: "S", visibility: "workspace" }), OWNER);
  const list = ws.createList(CreateListInput.parse({ spaceId: space.id, name: "Ongoing" }), OWNER);
  ws.upsertAutomation(
    {
      name: "email tickets -> owner, due by 10 a.m. cutoff",
      enabled: true,
      scope: { kind: "list", listId: list.id },
      trigger: { kind: "task_created" },
      conditions: [{ kind: "has_tag", tags: ["email"] }],
      actions: [
        { kind: "set_assignee", userId: OWNER },
        { kind: "set_due_date", cutoffHour: 10, timeZone: NY, businessDays: true },
      ],
    },
    OWNER
  );
  const create = (title: string, tags: string[], now: number) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const task = ws.createTask(CreateTaskInput.parse({ listId: list.id, title, tags }), OWNER);
    return ws.getTaskDetail(task.id).task;
  };
  return { create };
}

describe("set_due_date automation action", () => {
  it("dates an email ticket from when it arrived, and assigns it in the same turn", async () => {
    const h = await seeded();
    // Thursday Oct 15: 9:30 a.m. EDT is 13:30 UTC; 2 p.m. EDT is 18:00 UTC.
    const early = h.create("Morning ticket", ["email"], Date.UTC(2026, 9, 15, 13, 30));
    const late = h.create("Afternoon ticket", ["email"], Date.UTC(2026, 9, 15, 18, 0));
    expect(early.assigneeId).toBe(OWNER);
    expect(early.dueDate).toBe(Date.UTC(2026, 9, 15, 16)); // Thu noon EDT
    expect(late.dueDate).toBe(Date.UTC(2026, 9, 16, 16)); // Fri noon EDT
  });

  it("rolls a Friday-afternoon ticket to Monday", async () => {
    const h = await seeded();
    const friday = h.create("Friday ticket", ["email"], Date.UTC(2026, 9, 16, 19, 0)); // 3 p.m. EDT
    expect(friday.dueDate).toBe(Date.UTC(2026, 9, 19, 16)); // Mon noon EDT
  });

  it("leaves tasks the rule doesn't match alone", async () => {
    const h = await seeded();
    const plain = h.create("Typed in by hand", [], Date.UTC(2026, 9, 15, 13, 30));
    expect(plain.dueDate).toBeNull();
    expect(plain.assigneeId).toBeNull();
  });
});
