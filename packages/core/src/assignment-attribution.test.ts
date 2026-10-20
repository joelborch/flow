import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  CreateListInput,
  CreateSpaceInput,
  CreateSubtaskInput,
  CreateTaskInput,
  UpdateSubtaskInput,
  UpdateTaskInput,
  type Actor,
} from "@flow/shared";
import {
  ASSIGNMENT_ATTRIBUTION_MIGRATION_ID,
  MIGRATIONS,
  applyMigrations,
  type MigrationTxn,
} from "./schema.js";

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

function savepointTxn(db: DatabaseSync): MigrationTxn {
  return <T,>(fn: () => T): T => {
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
  };
}

function fakeCtx(db: DatabaseSync): DurableObjectState {
  return {
    id: { toString: () => "do_test" },
    storage: {
      sql: sqliteStorage(db),
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      transactionSync: savepointTxn(db),
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T> | T): Promise<T> => fn(),
    waitUntil: () => undefined,
    getWebSockets: () => [],
    acceptWebSocket: () => undefined,
  } as unknown as DurableObjectState;
}

const OWNER = "us_owner";
const BLAKE = "us_blake";

const automationActor: Actor = {
  userId: OWNER,
  via: "automation",
  apiKeyId: null,
  automationRuleId: "ar_test",
};

async function seeded() {
  const { Workspace } = await import("./index.js");
  const db = new DatabaseSync(":memory:");
  const env = { SIDE_EFFECTS: { sendBatch: vi.fn(async () => undefined) } } as never;
  const ws = new Workspace(fakeCtx(db), env);
  ws.upsertUser({ id: OWNER, email: "owner@example.com", name: "Avery", role: "owner" }, OWNER);
  ws.upsertUser({ id: BLAKE, email: "blake@example.com", name: "Blake", role: "admin" }, OWNER);
  const space = ws.createSpace(CreateSpaceInput.parse({ name: "Ops", visibility: "workspace" }), OWNER);
  const list = ws.createList(CreateListInput.parse({ spaceId: space.id, name: "Inbox" }), OWNER);
  return { ws, list };
}

describe("assignment attribution", () => {
  it("tracks human task delegation in the task, snapshot, and reassignment path", async () => {
    const { ws, list } = await seeded();
    const task = ws.createTask(
      CreateTaskInput.parse({ listId: list.id, title: "Prepare packet", assigneeId: BLAKE }),
      OWNER
    );
    expect(task.assignedBy).toBe(OWNER);
    expect(task.assignedAt).toBe(task.createdAt);
    expect(ws.getSnapshot(OWNER).tasks[0]).toMatchObject({ assignedBy: OWNER, assignedAt: task.createdAt });

    const automated = ws.updateTask(
      UpdateTaskInput.parse({ taskId: task.id, assigneeId: OWNER }),
      automationActor
    );
    expect(automated).toMatchObject({ assigneeId: OWNER, assignedBy: null, assignedAt: null });

    const delegatedAgain = ws.updateTask(
      UpdateTaskInput.parse({ taskId: task.id, assigneeId: BLAKE }),
      OWNER
    );
    expect(delegatedAgain.assignedBy).toBe(OWNER);
    expect(delegatedAgain.assignedAt).not.toBeNull();

    const unassigned = ws.updateTask(
      UpdateTaskInput.parse({ taskId: task.id, assigneeId: null }),
      OWNER
    );
    expect(unassigned).toMatchObject({ assigneeId: null, assignedBy: null, assignedAt: null });
  });

  it("tracks task and subtask assignments with the same semantics", async () => {
    const { ws, list } = await seeded();
    const task = ws.createTask(CreateTaskInput.parse({ listId: list.id, title: "Parent" }), OWNER);
    const subtask = ws.createSubtask(
      CreateSubtaskInput.parse({ taskId: task.id, title: "Print", assigneeId: BLAKE }),
      OWNER
    );
    expect(subtask.assignedBy).toBe(OWNER);
    expect(ws.getSnapshot(OWNER).subtasks[0]?.assignedBy).toBe(OWNER);

    const unassigned = ws.updateSubtask(
      UpdateSubtaskInput.parse({ subtaskId: subtask.id, assigneeId: null }),
      OWNER
    );
    expect(unassigned).toMatchObject({ assigneeId: null, assignedBy: null, assignedAt: null });
  });

  it("backfills clear human history and clears automated history", () => {
    const db = new DatabaseSync(":memory:");
    const sql = sqliteStorage(db);
    const index = MIGRATIONS.findIndex((migration) => migration.id === ASSIGNMENT_ATTRIBUTION_MIGRATION_ID);
    expect(index).toBeGreaterThan(0);
    sql.exec(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
    applyMigrations(sql, MIGRATIONS.slice(0, index), savepointTxn(db));

    sql.exec(
      `INSERT INTO tasks (id, list_id, title, description, status_id, assignee_id, priority,
                          due_date, start_date, snoozed_until, blocked_note, tags, tags_text,
                          position, created_by, created_at, updated_at, closed_at, clickup_id)
       VALUES ('tk_human', 'ls_1', 'Human', '', 'st_1', ?, NULL, NULL, NULL, NULL,
               NULL, '[]', '|', 0, ?, 10, 10, NULL, NULL),
              ('tk_auto', 'ls_1', 'Auto', '', 'st_1', ?, NULL, NULL, NULL, NULL,
               NULL, '[]', '|', 1, ?, 10, 10, NULL, NULL)`,
      BLAKE,
      OWNER,
      BLAKE,
      OWNER
    );
    sql.exec(
      `INSERT INTO audit (actor, action, entity, diff, at, actor_user_id, api_key_id)
       VALUES (?, 'task.update', 'tk_human', ?, 20, ?, NULL),
              (?, 'automation.set_assignee', 'tk_auto', ?, 30, ?, NULL)`,
      JSON.stringify({ userId: OWNER, via: "ui", apiKeyId: null, automationRuleId: null }),
      JSON.stringify({ assigneeId: BLAKE }),
      OWNER,
      JSON.stringify(automationActor),
      JSON.stringify({ assigneeId: BLAKE }),
      OWNER
    );

    applyMigrations(sql, [MIGRATIONS[index]!], savepointTxn(db));
    const rows = sql
      .exec<{ id: string; assigned_by: string | null; assigned_at: number | null }>(
        "SELECT id, assigned_by, assigned_at FROM tasks ORDER BY id"
      )
      .toArray();
    expect(rows).toEqual([
      { id: "tk_auto", assigned_by: null, assigned_at: null },
      { id: "tk_human", assigned_by: OWNER, assigned_at: 20 },
    ]);
  });
});
