import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  CreateListInput,
  CreateSpaceInput,
  CreateTaskInput,
  type ServerMsg,
} from "@flow/shared";
import { resyncFloor } from "./sync-floor.js";

// ---------------------------------------------------------------------------
// Mutations that change who can see something must resync, not just patch.
//
// A task or list moved across spaces is broadcast as an ordinary update
// stamped with the NEW space, so a member who sees only the destination got a
// partial row for a task they never held, and a member who sees only the
// source never learned it left. Role changes flip a user's whole visible set,
// and a deactivated user's open sockets kept streaming. Each of these must bump
// the resync floor (offline clients) and resync or close the affected sockets
// (connected clients) — while same-space moves stay a plain patch.
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
  const sockets: WebSocket[] = [];
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
    // Closed sockets drop out, as they do from the real getWebSockets().
    getWebSockets: () => sockets.filter((ws) => !(ws as unknown as { closed: boolean }).closed),
    acceptWebSocket: (ws: WebSocket) => {
      sockets.push(ws);
    },
  } as unknown as DurableObjectState;
}

interface FakeSocket {
  ws: WebSocket;
  frames: ServerMsg[];
  closes: Array<{ code: number; reason: string }>;
}

/** A hibernated-socket stand-in: an identity, a transcript, and its closes. */
function fakeSocket(userId: string): FakeSocket {
  const frames: ServerMsg[] = [];
  const closes: FakeSocket["closes"] = [];
  const state = { closed: false };
  const ws = Object.assign(state, {
    deserializeAttachment: () => ({ userId }),
    serializeAttachment: () => undefined,
    send: (payload: string) => {
      frames.push(JSON.parse(payload) as ServerMsg);
    },
    close: (code: number, reason: string) => {
      state.closed = true;
      closes.push({ code, reason });
    },
  }) as unknown as WebSocket;
  return { ws, frames, closes };
}

const OWNER = "us_owner";
const MEMBER_A = "us_member_a";
const MEMBER_B = "us_member_b";

/**
 * Private spaces A (member_a) and B (member_b), workspace-visible spaces C and
 * D, one task in each of A and C, and a second list in A. The owner is in
 * neither private member list, and everyone has a live socket.
 */
async function seeded() {
  const { Workspace } = await import("./index.js");
  const db = new DatabaseSync(":memory:");
  const ctx = fakeCtx(db);
  const sendBatch = vi.fn(async () => undefined);
  const ws = new Workspace(ctx, { SIDE_EFFECTS: { sendBatch } } as never);

  ws.upsertUser({ id: OWNER, email: "owner@example.com", name: "Owner", role: "owner" }, OWNER);
  ws.upsertUser({ id: MEMBER_A, email: "a@example.com", name: "A", role: "member" }, OWNER);
  ws.upsertUser({ id: MEMBER_B, email: "b@example.com", name: "B", role: "member" }, OWNER);

  const space = (name: string) =>
    ws.createSpace(CreateSpaceInput.parse({ name, visibility: "workspace" }), OWNER);
  const list = (spaceId: string, name: string) =>
    ws.createList(CreateListInput.parse({ spaceId, name }), OWNER);
  const task = (listId: string, title: string) =>
    ws.createTask(CreateTaskInput.parse({ listId, title, subtasks: [{ title: `${title} sub` }] }), OWNER);

  const a = space("Alpha");
  const b = space("Beta");
  const c = space("Common");
  const d = space("Delta");
  const aList = list(a.id, "A list");
  const aList2 = list(a.id, "A list 2");
  const bList = list(b.id, "B list");
  const cList = list(c.id, "C list");
  const dList = list(d.id, "D list");
  const aTask = task(aList.id, "A task");
  const cTask = task(cList.id, "C task");

  ws.setSpaceVisibility({ spaceId: a.id, visibility: "private" }, OWNER);
  ws.setSpaceMembers({ spaceId: a.id, userIds: [MEMBER_A] }, OWNER);
  ws.setSpaceVisibility({ spaceId: b.id, visibility: "private" }, OWNER);
  ws.setSpaceMembers({ spaceId: b.id, userIds: [MEMBER_B] }, OWNER);

  // A delta past the setup's floor bumps, so "floor unchanged" is observable
  // and a hello from `seq` is a genuine replay candidate.
  task(cList.id, "marker");
  const seq = ws.getSnapshot().seq;

  const socks = { owner: fakeSocket(OWNER), a: fakeSocket(MEMBER_A), b: fakeSocket(MEMBER_B) };
  for (const s of Object.values(socks)) ctx.acceptWebSocket(s.ws);

  return {
    ws,
    db,
    ctx,
    socks,
    seq,
    spaces: { a, b, c, d },
    lists: { aList, aList2, bList, cList, dList },
    tasks: { aTask, cTask },
    floor: () => resyncFloor(ctx.storage.sql),
  };
}

const kinds = (s: FakeSocket) => s.frames.map((f) => f.type);
const resynced = (s: FakeSocket) => s.frames.some((f) => f.type === "resync");

async function hello(
  ws: Awaited<ReturnType<typeof seeded>>["ws"],
  userId: string,
  sinceSeq: number | null
): Promise<FakeSocket> {
  const sock = fakeSocket(userId);
  await ws.webSocketMessage(sock.ws, JSON.stringify({ type: "hello", sinceSeq }));
  return sock;
}

describe("moveTask across spaces", () => {
  it("resyncs exactly the members whose view of the task changed, before the half-patch", async () => {
    const h = await seeded();
    h.ws.moveTask({ taskId: h.tasks.aTask.id, listId: h.lists.bList.id }, OWNER);

    // A lost the task, B gained it; the owner sees both ends and just patches.
    expect(resynced(h.socks.a)).toBe(true);
    expect(resynced(h.socks.b)).toBe(true);
    expect(resynced(h.socks.owner)).toBe(false);
    expect(kinds(h.socks.owner)).toEqual(["deltas"]);
    // resync first, so the client drops the partial row that follows.
    expect(kinds(h.socks.b)).toEqual(["resync", "deltas"]);
  });

  it("bumps the floor so an offline member reconnecting from before the move gets a snapshot", async () => {
    const h = await seeded();
    const before = h.floor();
    h.ws.moveTask({ taskId: h.tasks.aTask.id, listId: h.lists.bList.id }, OWNER);
    expect(h.floor()).toBeGreaterThan(before);

    const b = await hello(h.ws, MEMBER_B, h.seq);
    const snap = b.frames.find((f) => f.type === "snapshot");
    expect(snap?.type).toBe("snapshot");
    if (snap?.type !== "snapshot") return;
    // The full task and its subtask, not a partial row.
    const moved = snap.snapshot.tasks.find((t) => t.id === h.tasks.aTask.id);
    expect(moved?.title).toBe("A task");
    expect(snap.snapshot.subtasks.some((s) => s.taskId === h.tasks.aTask.id)).toBe(true);

    const a = await hello(h.ws, MEMBER_A, h.seq);
    const aSnap = a.frames.find((f) => f.type === "snapshot");
    expect(aSnap?.type === "snapshot" && aSnap.snapshot.tasks.some((t) => t.id === h.tasks.aTask.id)).toBe(false);
  });

  it("private -> workspace resyncs only the member who never had the task", async () => {
    const h = await seeded();
    h.ws.moveTask({ taskId: h.tasks.aTask.id, listId: h.lists.cList.id }, OWNER);
    // A sees both A and C: the patch is enough.
    expect(resynced(h.socks.a)).toBe(false);
    expect(kinds(h.socks.a)).toEqual(["deltas"]);
    // B sees C but never saw A.
    expect(resynced(h.socks.b)).toBe(true);
  });

  it("a same-space cross-list move stays a plain patch: no resync, no floor bump, replay still works", async () => {
    const h = await seeded();
    const before = h.floor();
    h.ws.moveTask({ taskId: h.tasks.aTask.id, listId: h.lists.aList2.id }, OWNER);
    expect(h.floor()).toBe(before);
    expect(resynced(h.socks.a)).toBe(false);
    expect(kinds(h.socks.a)).toEqual(["deltas"]);
    expect(h.socks.b.frames).toEqual([]);

    const a = await hello(h.ws, MEMBER_A, h.seq);
    expect(kinds(a)).toEqual(["deltas"]);
  });

  it("a move between two workspace-visible spaces bumps nothing", async () => {
    const h = await seeded();
    const before = h.floor();
    h.ws.moveTask({ taskId: h.tasks.cTask.id, listId: h.lists.dList.id }, OWNER);
    expect(h.floor()).toBe(before);
    for (const s of Object.values(h.socks)) expect(kinds(s)).toEqual(["deltas"]);
  });

  it("an automation move_to_list across spaces resyncs too", async () => {
    const h = await seeded();
    h.ws.upsertAutomation(
      {
        name: "file done work in B",
        enabled: true,
        scope: { kind: "list", listId: h.lists.cList.id },
        trigger: { kind: "status_changed", to: ["Done"] },
        conditions: [],
        actions: [{ kind: "move_to_list", listId: h.lists.bList.id }],
      },
      OWNER
    );
    for (const s of Object.values(h.socks)) s.frames.length = 0;
    const before = h.floor();

    // The member's own edit trips the rule; the rule carries it into B.
    h.ws.updateTask({ taskId: h.tasks.cTask.id, status: "Done" }, MEMBER_A);
    expect(h.ws.getTaskDetail(h.tasks.cTask.id).task.listId).toBe(h.lists.bList.id);
    expect(h.floor()).toBeGreaterThan(before);
    expect(resynced(h.socks.a)).toBe(true);
    // B could already see C, and now sees B: both ends visible, so a patch.
    expect(resynced(h.socks.b)).toBe(false);
  });
});

describe("updateList across spaces", () => {
  it("moving a list resyncs members whose view of it (and its tasks) changed, and bumps the floor", async () => {
    const h = await seeded();
    const before = h.floor();
    h.ws.updateList({ listId: h.lists.aList.id, spaceId: h.spaces.c.id }, OWNER);

    expect(h.floor()).toBeGreaterThan(before);
    expect(resynced(h.socks.a)).toBe(false);
    expect(resynced(h.socks.b)).toBe(true);
    expect(resynced(h.socks.owner)).toBe(false);

    // B's snapshot now carries the list's task, which it never had before.
    const b = await hello(h.ws, MEMBER_B, h.seq);
    const snap = b.frames.find((f) => f.type === "snapshot");
    expect(snap?.type === "snapshot" && snap.snapshot.tasks.some((t) => t.id === h.tasks.aTask.id)).toBe(true);
  });

  it("a rename leaves everyone on plain patches", async () => {
    const h = await seeded();
    const before = h.floor();
    h.ws.updateList({ listId: h.lists.cList.id, name: "Renamed" }, OWNER);
    expect(h.floor()).toBe(before);
    for (const s of Object.values(h.socks)) expect(resynced(s)).toBe(false);
  });
});

describe("upsertUser access changes", () => {
  it("promotion resyncs the promoted user (now privileged) and bumps the floor", async () => {
    const h = await seeded();
    const before = h.floor();
    h.ws.upsertUser({ id: MEMBER_A, email: "a@example.com", role: "admin" }, OWNER);
    expect(h.floor()).toBeGreaterThan(before);
    expect(resynced(h.socks.a)).toBe(true);
    expect(resynced(h.socks.b)).toBe(false);
    expect(resynced(h.socks.owner)).toBe(false);
  });

  it("demotion resyncs the demoted user", async () => {
    const h = await seeded();
    h.ws.upsertUser({ id: MEMBER_A, email: "a@example.com", role: "admin" }, OWNER);
    h.socks.a.frames.length = 0;
    h.ws.upsertUser({ id: MEMBER_A, email: "a@example.com", role: "member" }, OWNER);
    expect(resynced(h.socks.a)).toBe(true);
  });

  it("a rename or an owner<->admin change resyncs nobody", async () => {
    const h = await seeded();
    const before = h.floor();
    h.ws.upsertUser({ id: MEMBER_A, email: "a@example.com", name: "Renamed" }, OWNER);
    h.ws.upsertUser({ id: OWNER, email: "owner@example.com", role: "admin" }, OWNER);
    expect(h.floor()).toBe(before);
    for (const s of Object.values(h.socks)) expect(resynced(s)).toBe(false);
  });

  it("deactivation closes that user's open sockets and nobody else's", async () => {
    const h = await seeded();
    h.ws.upsertUser({ id: MEMBER_A, email: "a@example.com", deactivated: true }, OWNER);
    expect(h.socks.a.closes).toHaveLength(1);
    expect(h.socks.a.closes[0]?.code).toBe(1008);
    expect(h.socks.b.closes).toEqual([]);
    expect(h.socks.owner.closes).toEqual([]);
  });

  it("a deactivated user's hello gets neither a snapshot nor a replay", async () => {
    const h = await seeded();
    h.ws.upsertUser({ id: MEMBER_A, email: "a@example.com", deactivated: true }, OWNER);

    const fresh = await hello(h.ws, MEMBER_A, null);
    expect(fresh.frames).toEqual([]);
    expect(fresh.closes[0]?.code).toBe(1008);
    const replay = await hello(h.ws, MEMBER_A, h.seq);
    expect(replay.frames).toEqual([]);

    // Reactivated, the same hello works again.
    h.ws.upsertUser({ id: MEMBER_A, email: "a@example.com", deactivated: false }, OWNER);
    expect(kinds(await hello(h.ws, MEMBER_A, null))).toEqual(["snapshot"]);
  });
});
