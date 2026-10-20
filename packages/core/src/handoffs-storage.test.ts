import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Actor,
  CreateListInput,
  CreateSpaceInput,
  CreateTaskInput,
  ListHandoffsInput,
  type ReplyHandoffInput,
  RequestHandoffInput,
} from "@flow/shared";

// ---------------------------------------------------------------------------
// Agent handoffs against the real Workspace class: requestHandoff's task shape,
// assignment email and every refusal (all before a single write);
// replyHandoff's comment `via`, its state rules per role, the close/reopen
// status moves and the audit row; the `handoff` field riding task deltas only
// when it changes; listHandoffs' direction, state filter, ordering, limit and
// per-space visibility; and importBatch still landing tasks with no handoff.
//
// Same real-Workspace-over-node:sqlite harness as email-intake-storage.test.ts.
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
const ADMIN = "us_admin";
/** Files the handoffs. */
const ALICE = "us_alice";
/** Receives them. */
const BOB = "us_bob";
/** Neither: a member with no part in the exchange. */
const CAROL = "us_carol";
const GONE = "us_gone";

const agent = (userId: string, via: Actor["via"] = "mcp"): Actor => ({
  userId,
  via,
  apiKeyId: via === "ui" ? null : `ak_${userId}`,
  automationRuleId: null,
});

interface EmailPayload {
  kind: string;
  to: string[];
  subject: string;
  ruleId: string;
  taskId: string;
}

/** A controllable Date.now, so stateChangedAt ordering is deterministic. */
let clock = 1_800_000_000_000;
beforeEach(() => {
  clock = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => {
  vi.restoreAllMocks();
});
const tick = (ms = 1_000): void => {
  clock += ms;
};

/**
 * "Ops" is workspace-visible with list "Requests"; "Vault" is private with
 * list "Hidden", whose members are the owner and Alice. Every user has a real
 * address, so notification emails are observable through sendBatch.
 */
async function seeded() {
  const { Workspace } = await import("./index.js");
  const db = new DatabaseSync(":memory:");
  const sendBatch = vi.fn(async (_batch: Array<{ body: unknown }>) => undefined);
  const ws = new Workspace(fakeCtx(db), { SIDE_EFFECTS: { sendBatch } } as never);

  ws.upsertUser({ id: OWNER, email: "owner@example.com", name: "Owner", role: "owner" }, OWNER);
  ws.upsertUser({ id: ADMIN, email: "admin@example.com", name: "Admin", role: "admin" }, OWNER);
  ws.upsertUser({ id: ALICE, email: "alice@example.com", name: "Alice" }, OWNER);
  ws.upsertUser({ id: BOB, email: "bob@example.com", name: "Bob" }, OWNER);
  ws.upsertUser({ id: CAROL, email: "carol@example.com", name: "Carol" }, OWNER);
  ws.upsertUser({ id: GONE, email: "gone@example.com", name: "Gone", deactivated: true }, OWNER);

  const ops = ws.createSpace(CreateSpaceInput.parse({ name: "Ops", visibility: "workspace" }), OWNER);
  const requests = ws.createList(CreateListInput.parse({ spaceId: ops.id, name: "Requests" }), OWNER);
  const vault = ws.createSpace(CreateSpaceInput.parse({ name: "Vault", visibility: "private" }), OWNER);
  ws.setSpaceMembers({ spaceId: vault.id, userIds: [OWNER, ALICE] }, OWNER);
  const hidden = ws.createList(CreateListInput.parse({ spaceId: vault.id, name: "Hidden" }), OWNER);

  const request = (over: Partial<RequestHandoffInput> = {}, by: string | Actor = agent(ALICE)) =>
    ws.requestHandoff(
      RequestHandoffInput.parse({
        listId: requests.id,
        toUserId: BOB,
        title: "Pull last month's sessions",
        ask: "Which pages lost the most sessions in September?",
        ...over,
      }),
      by
    );
  const reply = (input: ReplyHandoffInput, by: string | Actor) => ws.replyHandoff(input, by);
  const list = (
    by: string,
    over: { direction?: "incoming" | "outgoing"; states?: string[]; limit?: number } = {}
  ) => ws.listHandoffs(ListHandoffsInput.parse(over), by).map((task) => task.id);

  const emails = (): EmailPayload[] =>
    sendBatch.mock.calls
      .flatMap(([batch]) => batch.map((m) => m.body as EmailPayload))
      .filter((p) => p.kind === "email");
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all()[0] as { n: number }).n;
  /** Every task delta's data for one task, oldest first, as stored in `changes`. */
  const taskDeltas = (taskId: string) =>
    (
      db
        .prepare("SELECT op, data FROM changes WHERE entity = 'task' AND entity_id = ? ORDER BY seq")
        .all(taskId) as Array<{ op: string; data: string | null }>
    ).map((r) => ({ op: r.op, data: r.data === null ? null : (JSON.parse(r.data) as Record<string, unknown>) }));
  const audit = (taskId: string, action: string) =>
    (
      db
        .prepare("SELECT diff FROM audit WHERE entity = ? AND action = ? ORDER BY id")
        .all(taskId, action) as Array<{ diff: string | null }>
    ).map((r) => (r.diff === null ? null : (JSON.parse(r.diff) as Record<string, unknown>)));
  const statusName = (taskId: string) => {
    const task = ws.getTaskDetail(taskId).task;
    const lists = ws.getSnapshot().lists;
    return lists.find((l) => l.id === task.listId)?.statuses.find((s) => s.id === task.statusId)?.name;
  };

  return {
    ws, db, sendBatch, ops, requests, vault, hidden,
    request, reply, list, emails, count, taskDeltas, audit, statusName,
  };
}

// ---------------------------------------------------------------------------

describe("requestHandoff", () => {
  it("files an ordinary task for the recipient, with the handoff attached", async () => {
    const h = await seeded();
    const context = h.ws.createTask(CreateTaskInput.parse({ listId: h.requests.id, title: "Background" }), ALICE);
    tick();
    const due = clock + 86_400_000;
    const task = h.request({ returnFormat: "a table of page, sessions, change date", contextTaskIds: [context.id], dueDate: due });

    expect(task).toMatchObject({
      listId: h.requests.id,
      title: "Pull last month's sessions",
      description: "Which pages lost the most sessions in September?",
      assigneeId: BOB,
      assignedBy: ALICE,
      assignedAt: clock,
      dueDate: due,
      tags: ["handoff"],
      createdBy: ALICE,
      closedAt: null,
      handoff: {
        requestedBy: ALICE,
        state: "requested",
        returnFormat: "a table of page, sessions, change date",
        contextTaskIds: [context.id],
        stateChangedAt: clock,
      },
    });
    expect(h.statusName(task.id)).toBe("To Do");
    // Persisted, not just returned: a fresh read and the snapshot agree.
    expect(h.ws.getTaskDetail(task.id).task.handoff).toEqual(task.handoff);
    expect(h.ws.getSnapshot().tasks.find((t) => t.id === task.id)?.handoff).toEqual(task.handoff);
    // The create delta carries the whole task, handoff included.
    expect(h.taskDeltas(task.id)[0]).toMatchObject({ op: "create", data: { handoff: task.handoff } });
    expect(h.audit(task.id, "handoff.request")).toEqual([{ toUserId: BOB, contextTaskIds: [context.id] }]);
  });

  it("defaults returnFormat to null, contextTaskIds to [] and the due date to none", async () => {
    const h = await seeded();
    const task = h.request();
    expect(task.dueDate).toBeNull();
    expect(task.handoff).toMatchObject({ returnFormat: null, contextTaskIds: [] });
  });

  it("emails the recipient an assignment notice; an ordinary assigned create still sends none", async () => {
    const h = await seeded();
    const task = h.request();
    const assigned = h.emails().filter((e) => e.ruleId === "notify:assigned_to_me");
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({ to: ["bob@example.com"], taskId: task.id });
    expect(assigned[0]?.subject).toContain("Pull last month's sessions");

    h.sendBatch.mockClear();
    h.ws.createTask(CreateTaskInput.parse({ listId: h.requests.id, title: "Plain", assigneeId: BOB }), ALICE);
    expect(h.emails()).toEqual([]);
  });

  it("refuses each bad request with a sentence naming the problem, before writing anything", async () => {
    const h = await seeded();
    const secret = h.ws.createTask(CreateTaskInput.parse({ listId: h.hidden.id, title: "Secret" }), ALICE);
    const tasksBefore = h.count("tasks");
    const changesBefore = h.count("changes");

    expect(() => h.request({ toUserId: "us_nobody" })).toThrow(
      /Unknown toUserId "us_nobody"\. Active teammates: .*us_bob \("Bob"\)/
    );
    expect(() => h.request({ toUserId: "us_nobody" })).not.toThrow(/us_gone/);
    expect(() => h.request({ toUserId: ALICE })).toThrow(/can't hand off to yourself \(us_alice\)/);
    expect(() => h.request({ toUserId: GONE })).toThrow(/Gone \(us_gone\) is deactivated/);
    expect(() => h.request({ listId: h.hidden.id })).toThrow(
      new RegExp(`Bob \\(us_bob\\) can't see space ${h.vault.id} \\("Vault"\\)`)
    );
    expect(() => h.request({ contextTaskIds: ["tk_missing"] })).toThrow(/Context task tk_missing not found/);
    // Bob files for Alice, pointing at a task in a space Bob can't see.
    expect(() => h.request({ toUserId: ALICE, contextTaskIds: [secret.id] }, agent(BOB))).toThrow(
      new RegExp(`Context task ${secret.id} isn't visible to you\\. Space ${h.vault.id} is private`)
    );
    // Bob can't write to the private list at all.
    expect(() => h.request({ listId: h.hidden.id, toUserId: ALICE }, agent(BOB))).toThrow(
      new RegExp(`Space ${h.vault.id} is private`)
    );
    expect(() => h.request({ listId: "ls_missing" })).toThrow(/List ls_missing not found/);
    // Contract limits, re-checked by the DO for callers that skipped the route.
    expect(() =>
      h.ws.requestHandoff({ listId: h.requests.id, toUserId: BOB, title: "T", ask: "" } as RequestHandoffInput, ALICE)
    ).toThrow(/Invalid handoff request: ask: Describe what you need\./);
    expect(() =>
      h.ws.requestHandoff(
        {
          listId: h.requests.id,
          toUserId: BOB,
          title: "T",
          ask: "A",
          contextTaskIds: Array.from({ length: 21 }, (_, i) => `tk_${i}`),
        } as RequestHandoffInput,
        ALICE
      )
    ).toThrow(/Invalid handoff request: contextTaskIds/);

    expect(h.count("tasks")).toBe(tasksBefore);
    expect(h.count("changes")).toBe(changesBefore);
  });

  it("refuses a context task the recipient can't see, since their agent couldn't read it", async () => {
    const h = await seeded();
    const secret = h.ws.createTask(CreateTaskInput.parse({ listId: h.hidden.id, title: "Secret" }), ALICE);
    expect(() => h.request({ contextTaskIds: [secret.id] })).toThrow(/Bob can't see/);
  });

  it("accepts private context both ends can see, de-duplicated in order", async () => {
    const h = await seeded();
    h.ws.setSpaceMembers({ spaceId: h.vault.id, userIds: [OWNER, ALICE, BOB] }, OWNER);
    const secret = h.ws.createTask(CreateTaskInput.parse({ listId: h.hidden.id, title: "Secret" }), ALICE);
    const open = h.ws.createTask(CreateTaskInput.parse({ listId: h.requests.id, title: "Open" }), ALICE);
    const task = h.request({ contextTaskIds: [secret.id, open.id, secret.id] });
    expect(task.handoff?.contextTaskIds).toEqual([secret.id, open.id]);
  });
});

// ---------------------------------------------------------------------------

describe("replyHandoff: messages", () => {
  it("posts the message as a comment that records how it arrived", async () => {
    const h = await seeded();
    const task = h.request();

    const fromBob = h.reply({ taskId: task.id, message: "On it." }, agent(BOB, "api"));
    expect(fromBob.comment).toMatchObject({ taskId: task.id, authorId: BOB, body: "On it.", via: "api" });
    expect(fromBob.task.handoff?.state).toBe("requested"); // a message alone moves nothing

    h.reply({ taskId: task.id, message: "Thanks!" }, agent(ALICE, "mcp"));
    h.ws.createComment({ taskId: task.id, body: "Typed by a person" }, agent(CAROL, "ui"));
    expect(h.ws.listComments(task.id).map((c) => [c.authorId, c.via])).toEqual([
      [BOB, "api"],
      [ALICE, "mcp"],
      [CAROL, "ui"],
    ]);
  });

  it("wakes a snoozed handoff, exactly like any other comment", async () => {
    const h = await seeded();
    const task = h.request();
    h.ws.updateTask({ taskId: task.id, snoozedUntil: clock + 86_400_000 }, BOB);
    const { task: after } = h.reply({ taskId: task.id, message: "Back on this" }, agent(BOB));
    expect(after.snoozedUntil).toBeNull();
  });

  it("refuses a task that is not a handoff", async () => {
    const h = await seeded();
    const plain = h.ws.createTask(CreateTaskInput.parse({ listId: h.requests.id, title: "Plain" }), ALICE);
    expect(() => h.reply({ taskId: plain.id, message: "hi" }, agent(ALICE))).toThrow(
      new RegExp(`Task ${plain.id} is not a handoff`)
    );
    expect(h.ws.listComments(plain.id)).toEqual([]);
  });
});

describe("replyHandoff: who may set which state", () => {
  it("the recipient may set any state, and each change stamps stateChangedAt", async () => {
    const h = await seeded();
    const task = h.request();
    for (const state of ["working", "needs_input", "requested", "done", "declined", "working"] as const) {
      tick();
      const { task: after } = h.reply({ taskId: task.id, state }, agent(BOB));
      expect(after.handoff).toMatchObject({ state, stateChangedAt: clock });
    }
  });

  it("the requester may withdraw (declined) and nothing else", async () => {
    const h = await seeded();
    const task = h.request();
    for (const state of ["working", "needs_input", "done", "requested"] as const) {
      expect(() => h.reply({ taskId: task.id, state }, agent(ALICE))).toThrow(
        /As the requester you can only withdraw handoff .* \(state "declined"\), and only while it's still open\. The recipient \(Bob \(us_bob\)\)/
      );
    }
    expect(h.reply({ taskId: task.id, state: "declined" }, agent(ALICE)).task.handoff?.state).toBe("declined");
  });

  it("the requester can't decline a handoff the recipient already finished", async () => {
    const h = await seeded();
    const task = h.request();
    h.reply({ taskId: task.id, state: "done", message: "Here you go." }, agent(BOB));
    expect(() => h.reply({ taskId: task.id, state: "declined" }, agent(ALICE))).toThrow(/only while it's still open/);
    expect(h.ws.getTaskDetail(task.id).task.handoff?.state).toBe("done");
  });

  it("a requester's message on needs_input hands it back as working; nowhere else", async () => {
    const h = await seeded();
    const task = h.request();
    h.reply({ taskId: task.id, message: "Which month?", state: "needs_input" }, agent(BOB));
    // The recipient's own follow-up leaves it waiting on the requester.
    expect(h.reply({ taskId: task.id, message: "Also, which site?" }, agent(BOB)).task.handoff?.state).toBe(
      "needs_input"
    );
    tick();
    const answered = h.reply({ taskId: task.id, message: "September, both sites." }, agent(ALICE));
    expect(answered.task.handoff).toMatchObject({ state: "working", stateChangedAt: clock });
    expect(answered.comment?.body).toBe("September, both sites.");
    // On a working handoff the requester's message changes nothing.
    expect(h.reply({ taskId: task.id, message: "No rush." }, agent(ALICE)).task.handoff?.state).toBe("working");
  });

  it("refuses anyone who is neither recipient, requester, owner nor admin", async () => {
    const h = await seeded();
    const task = h.request();
    const outsider = /Only handoff .*'s recipient \(Bob \(us_bob\)\) or requester \(Alice \(us_alice\)\) can reply/;
    expect(() => h.reply({ taskId: task.id, message: "me too" }, agent(CAROL))).toThrow(outsider);
    expect(() => h.reply({ taskId: task.id, state: "done" }, agent(CAROL))).toThrow(outsider);
    expect(h.ws.listComments(task.id)).toEqual([]);
  });

  it("owners and admins may set any state", async () => {
    const h = await seeded();
    const task = h.request();
    expect(h.reply({ taskId: task.id, state: "working" }, OWNER).task.handoff?.state).toBe("working");
    expect(h.reply({ taskId: task.id, state: "done" }, ADMIN).task.handoff?.state).toBe("done");
  });

  it("the recipient is the CURRENT assignee: reassigning hands the role over", async () => {
    const h = await seeded();
    const task = h.request();
    h.ws.updateTask({ taskId: task.id, assigneeId: CAROL }, ALICE);
    expect(h.reply({ taskId: task.id, state: "working" }, agent(CAROL)).task.handoff?.state).toBe("working");
    expect(() => h.reply({ taskId: task.id, state: "done" }, agent(BOB))).toThrow(/Only handoff/);
  });

  it("validates before writing: a refused state change posts no comment", async () => {
    const h = await seeded();
    const task = h.request();
    const changesBefore = h.count("changes");
    expect(() => h.reply({ taskId: task.id, message: "Done!", state: "done" }, agent(ALICE))).toThrow(
      /only withdraw/
    );
    expect(h.ws.listComments(task.id)).toEqual([]);
    expect(h.count("changes")).toBe(changesBefore);
  });

  it("an unchanged state is a no-op: no delta, no audit, the old stateChangedAt", async () => {
    const h = await seeded();
    const task = h.request();
    h.reply({ taskId: task.id, state: "working" }, agent(BOB));
    const stamped = h.ws.getTaskDetail(task.id).task.handoff?.stateChangedAt;
    const changesBefore = h.count("changes");
    tick();
    const { task: after, comment } = h.reply({ taskId: task.id, state: "working" }, agent(BOB));
    expect(comment).toBeNull();
    expect(after.handoff?.stateChangedAt).toBe(stamped);
    expect(h.count("changes")).toBe(changesBefore);
    expect(h.audit(task.id, "handoff.state")).toEqual([{ from: "requested", to: "working" }]);
  });
});

describe("replyHandoff: the task follows the state", () => {
  it("done closes the task; going back to an open state reopens it", async () => {
    const h = await seeded();
    const task = h.request();
    tick();
    const done = h.reply({ taskId: task.id, message: "Here's the table.", state: "done" }, agent(BOB)).task;
    expect(h.statusName(task.id)).toBe("Done");
    expect(done.closedAt).toBe(clock);
    expect(done.handoff?.state).toBe("done");

    const reopened = h.reply({ taskId: task.id, state: "working" }, agent(BOB)).task;
    expect(h.statusName(task.id)).toBe("To Do");
    expect(reopened.closedAt).toBeNull();

    expect(h.audit(task.id, "handoff.state")).toEqual([
      { from: "requested", to: "done" },
      { from: "done", to: "working" },
    ]);
  });

  it("declined closes too, and done -> declined leaves an already-closed task alone", async () => {
    const h = await seeded();
    const task = h.request();
    h.reply({ taskId: task.id, state: "declined" }, agent(ALICE));
    expect(h.statusName(task.id)).toBe("Done");

    const other = h.request();
    h.reply({ taskId: other.id, state: "done" }, agent(BOB));
    const closedAt = h.ws.getTaskDetail(other.id).task.closedAt;
    tick();
    const declined = h.reply({ taskId: other.id, state: "declined" }, agent(BOB)).task;
    expect(declined.closedAt).toBe(closedAt);
    expect(h.taskDeltas(other.id).at(-1)?.data).not.toHaveProperty("statusId");
  });

  it("uses the list's own closed and open statuses, whatever they are called", async () => {
    const h = await seeded();
    const custom = h.ws.createList(
      CreateListInput.parse({
        spaceId: h.ops.id,
        name: "Custom",
        statuses: [
          { name: "Inbox", color: "#999", type: "open" },
          { name: "Doing", color: "#36f", type: "custom" },
          { name: "Shipped", color: "#0a0", type: "closed" },
        ],
      }),
      OWNER
    );
    const task = h.request({ listId: custom.id });
    h.ws.updateTask({ taskId: task.id, status: "Doing" }, BOB);
    h.reply({ taskId: task.id, state: "done" }, agent(BOB));
    expect(h.statusName(task.id)).toBe("Shipped");
    h.reply({ taskId: task.id, state: "needs_input" }, agent(BOB));
    expect(h.statusName(task.id)).toBe("Inbox");
  });
});

describe("deltas carry handoff only when it changes", () => {
  it("a state change is one task update with the whole new handoff and the status move", async () => {
    const h = await seeded();
    const task = h.request();
    h.reply({ taskId: task.id, state: "done" }, agent(BOB));
    const update = h.taskDeltas(task.id).at(-1);
    expect(update?.op).toBe("update");
    expect(update?.data).toMatchObject({
      handoff: { requestedBy: ALICE, state: "done", returnFormat: null, contextTaskIds: [], stateChangedAt: clock },
    });
    expect(update?.data).toHaveProperty("statusId");
    expect(update?.data).toHaveProperty("closedAt", clock);
    // Exactly one update for the state change (create + this one).
    expect(h.taskDeltas(task.id).map((d) => d.op)).toEqual(["create", "update"]);
  });

  it("an ordinary update to a handoff task leaves handoff out of the patch", async () => {
    const h = await seeded();
    const task = h.request();
    h.ws.updateTask({ taskId: task.id, title: "Renamed", priority: "high" }, BOB);
    const update = h.taskDeltas(task.id).at(-1)?.data ?? {};
    expect(Object.keys(update).sort()).toEqual(["priority", "title", "updatedAt"]);
    h.ws.moveTask({ taskId: task.id, status: "In Progress" }, BOB);
    expect(h.taskDeltas(task.id).at(-1)?.data).not.toHaveProperty("handoff");
  });
});

// ---------------------------------------------------------------------------

describe("listHandoffs", () => {
  it("incoming is what's assigned to me, outgoing what I filed, newest state change first", async () => {
    const h = await seeded();
    const first = h.request({ title: "First" });
    tick();
    const second = h.request({ title: "Second" });
    tick();
    const fromBob = h.request({ title: "Bob asks Alice", toUserId: ALICE }, agent(BOB));
    tick();
    h.reply({ taskId: first.id, state: "working" }, agent(BOB)); // first is now the newest change

    expect(h.list(BOB)).toEqual([first.id, second.id]);
    expect(h.list(ALICE)).toEqual([fromBob.id]);
    expect(h.list(ALICE, { direction: "outgoing" })).toEqual([first.id, second.id]);
    expect(h.list(BOB, { direction: "outgoing" })).toEqual([fromBob.id]);
    expect(h.list(CAROL)).toEqual([]);
  });

  it("defaults to the open states; naming terminal states returns the closed tasks", async () => {
    const h = await seeded();
    const open = h.request({ title: "Open" });
    tick();
    const done = h.request({ title: "Done" });
    h.reply({ taskId: done.id, state: "done" }, agent(BOB));
    tick();
    const declined = h.request({ title: "Declined" });
    h.reply({ taskId: declined.id, state: "declined" }, agent(ALICE));

    expect(h.list(BOB)).toEqual([open.id]);
    expect(h.list(BOB, { states: ["done"] })).toEqual([done.id]);
    expect(h.list(BOB, { states: ["done", "declined"] })).toEqual([declined.id, done.id]);
    expect(h.list(BOB, { states: ["requested", "done"] })).toEqual([done.id, open.id]);
    expect(h.ws.getTaskDetail(done.id).task.closedAt).not.toBeNull();
  });

  it("closing a handoff task by hand marks it done, and reopening it puts it back to working", async () => {
    const h = await seeded();
    const task = h.request({ title: "Closed by hand" });
    const statuses = h.ws.getSnapshot().lists.find((l) => l.id === task.listId)!.statuses;
    const closed = statuses.find((st) => st.type === "closed")!;
    const open = statuses.find((st) => st.type === "open")!;

    const done = h.ws.updateTask({ taskId: task.id, status: closed.name }, BOB);
    expect(done.handoff?.state).toBe("done");
    expect(h.list(BOB)).toEqual([]);
    expect(h.list(ALICE, { direction: "outgoing", states: ["done"] })).toEqual([task.id]);

    tick();
    const reopened = h.ws.moveTask({ taskId: task.id, status: open.name }, BOB);
    expect(reopened.handoff?.state).toBe("working");
    expect(reopened.handoff?.stateChangedAt).toBeGreaterThan(done.handoff!.stateChangedAt);
    expect(h.list(BOB)).toEqual([task.id]);
  });

  it("honours the limit", async () => {
    const h = await seeded();
    const ids = [];
    for (let i = 0; i < 4; i++) {
      tick();
      ids.push(h.request({ title: `Ask ${i}` }).id);
    }
    expect(h.list(BOB, { limit: 2 })).toEqual([ids[3], ids[2]]);
  });

  it("only returns handoffs in spaces the caller can still see", async () => {
    const h = await seeded();
    const hidden = h.request({ listId: h.hidden.id, toUserId: OWNER });
    tick();
    const visible = h.request({ toUserId: OWNER });
    expect(h.list(ALICE, { direction: "outgoing" })).toEqual([visible.id, hidden.id]);

    // Alice loses the private space: her own request there drops out of her list.
    h.ws.setSpaceMembers({ spaceId: h.vault.id, userIds: [OWNER] }, OWNER);
    expect(h.list(ALICE, { direction: "outgoing" })).toEqual([visible.id]);
    // The owner sees everything.
    expect(h.list(OWNER)).toEqual([visible.id, hidden.id]);
  });

  it("ignores ordinary tasks entirely", async () => {
    const h = await seeded();
    h.ws.createTask(CreateTaskInput.parse({ listId: h.requests.id, title: "Plain", assigneeId: BOB }), ALICE);
    expect(h.list(BOB)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("importBatch with handoffs in the schema", () => {
  it("imports tasks with no handoff and comments marked via import", async () => {
    const h = await seeded();
    const result = h.ws.importBatch(
      {
        tasks: [{ id: "tk_imported", clickupId: "cu_1", listId: h.requests.id, title: "From ClickUp" }],
        comments: [{ id: "cm_imported", clickupId: "cu_c1", taskId: "tk_imported", authorId: ALICE, body: "old note" }],
      },
      "import"
    );
    expect(result.errors).toEqual([]);
    expect(h.ws.getTaskDetail("tk_imported").task.handoff).toBeNull();
    expect(h.ws.getSnapshot().tasks.find((t) => t.id === "tk_imported")?.handoff).toBeNull();
    expect(h.ws.listComments("tk_imported")).toMatchObject([{ id: "cm_imported", via: "import" }]);
  });
});
