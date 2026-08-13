import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreateCommentInput,
  CreateListInput,
  CreateSpaceInput,
  CreateTaskInput,
  SearchTasksInput,
  type Delta,
  type ServerMsg,
} from "@flow/shared";

// ---------------------------------------------------------------------------
// Storage-level per-space permission tests against the real Workspace class.
//
// Covers the two hardening fixes:
//   1. Notification emails are gated by canSeeSpace — a stakeholder removed
//      from a private space's membership no longer receives task titles /
//      comment bodies by email, while members and owners/admins still do, and
//      automation send_email side effects (external recipients) are untouched.
//   2. Delta replay reads the space id STORED on each `changes` row
//      (core-0007-changes-space-id), so create/delete deltas for rows that
//      lived and died inside a private space no longer leak to reconnecting
//      members once live resolution can't answer. Null stored ids fail closed
//      for space-scoped entities; workspace-scoped deltas (`user`) still
//      reach everyone.
//
// Same harness as import-batch.test.ts: `cloudflare:workers` is mocked so the
// real Workspace runs against node:sqlite. INSERT ... RETURNING is routed
// through .all() because these tests exercise delta-emitting mutations.
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

/**
 * `getWebSockets`/`acceptWebSocket` track pushed-in fake sockets so tests can
 * assert on live `broadcastDeltas` (not just the pull-based replay/snapshot
 * paths covered elsewhere). No existing test calls `acceptWebSocket`, so this
 * stays an empty array — and broadcast a no-op — for all of them.
 */
function fakeCtx(db: DatabaseSync): DurableObjectState {
  const sockets: WebSocket[] = [];
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
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: WebSocket) => {
      sockets.push(ws);
    },
  } as unknown as DurableObjectState;
}

/** A hibernated-socket stand-in: an identity plus a transcript of frames. */
function fakeSocket(userId: string): { ws: WebSocket; frames: ServerMsg[] } {
  const frames: ServerMsg[] = [];
  const ws = {
    deserializeAttachment: () => ({ userId }),
    serializeAttachment: () => undefined,
    send: (payload: string) => {
      frames.push(JSON.parse(payload) as ServerMsg);
    },
  } as unknown as WebSocket;
  return { ws, frames };
}

interface EmailPayload {
  kind: string;
  to: string[];
  subject: string;
  body: string;
  ruleId: string;
}

async function freshWorkspace() {
  const { Workspace } = await import("./index.js");
  const db = new DatabaseSync(":memory:");
  const ctx = fakeCtx(db);
  const sendBatch = vi.fn(async (_batch: Array<{ body: unknown }>) => undefined);
  const env = { SIDE_EFFECTS: { sendBatch } } as never;
  const ws = new Workspace(ctx, env);
  const emails = (): EmailPayload[] =>
    sendBatch.mock.calls
      .flatMap(([batch]) => batch.map((m) => m.body as EmailPayload))
      .filter((p) => p.kind === "email");
  return { ws, db, ctx, sendBatch, emails };
}

const OWNER = "us_owner";
const MEMBER_A = "us_member_a";
const MEMBER_B = "us_member_b";

/**
 * Two private spaces (A: member_a, B: member_b), one workspace-visible space
 * C, one list + one task (with a subtask) in each. Content is created while
 * everything is still workspace-visible (spaces are born that way), then A
 * and B are flipped private with exactly one member each — the owner is
 * deliberately NOT left in either member list.
 */
async function seededWorkspace() {
  const h = await freshWorkspace();
  const { ws } = h;

  ws.upsertUser({ id: OWNER, email: "owner@example.com", name: "Owner", role: "owner" }, OWNER);
  ws.upsertUser({ id: MEMBER_A, email: "a@example.com", name: "Member A", role: "member" }, OWNER);
  ws.upsertUser({ id: MEMBER_B, email: "b@example.com", name: "Member B", role: "member" }, OWNER);

  const make = (name: string) => {
    // Spaces are born private now, but these fixtures need to start
    // workspace-visible so the later explicit setSpaceVisibility flips (A, B)
    // and the deliberately-untouched space (C) mean what the tests below say.
    const space = ws.createSpace(CreateSpaceInput.parse({ name, visibility: "workspace" }), OWNER);
    const list = ws.createList(CreateListInput.parse({ spaceId: space.id, name: `${name} list` }), OWNER);
    const task = ws.createTask(
      CreateTaskInput.parse({
        listId: list.id,
        title: `${name} task`,
        subtasks: [{ title: `${name} subtask` }],
      }),
      OWNER
    );
    return { space, list, task };
  };

  const a = make("Alpha");
  const b = make("Beta");
  const c = make("Common");

  ws.setSpaceVisibility({ spaceId: a.space.id, visibility: "private" }, OWNER);
  ws.setSpaceMembers({ spaceId: a.space.id, userIds: [MEMBER_A] }, OWNER);
  ws.setSpaceVisibility({ spaceId: b.space.id, visibility: "private" }, OWNER);
  ws.setSpaceMembers({ spaceId: b.space.id, userIds: [MEMBER_B] }, OWNER);

  return { ...h, a, b, c };
}

describe("snapshot cascade", () => {
  it("a member of one private space gets exactly that space's subtree", async () => {
    const { ws, a, b, c } = await seededWorkspace();
    const snap = ws.getSnapshot(MEMBER_A);

    expect(snap.spaces.map((s) => s.id).sort()).toEqual([a.space.id, c.space.id].sort());
    expect(snap.lists.map((l) => l.id).sort()).toEqual([a.list.id, c.list.id].sort());
    expect(snap.tasks.map((t) => t.id).sort()).toEqual([a.task.id, c.task.id].sort());
    expect(snap.subtasks.map((s) => s.taskId).sort()).toEqual([a.task.id, c.task.id].sort());
    // Nothing from space B leaks through any level of the cascade.
    expect(JSON.stringify(snap)).not.toContain(b.task.id);
  });

  it("a privileged user gets everything", async () => {
    const { ws, a, b, c } = await seededWorkspace();
    const snap = ws.getSnapshot(OWNER);
    expect(snap.spaces.map((s) => s.id).sort()).toEqual(
      [a.space.id, b.space.id, c.space.id].sort()
    );
    expect(snap.tasks.map((t) => t.id).sort()).toEqual(
      [a.task.id, b.task.id, c.task.id].sort()
    );
  });
});

describe("searchTasks", () => {
  it("rows and total respect visibleSpaceIds for a member", async () => {
    const { ws, a, b, c } = await seededWorkspace();
    const forMember = ws.searchTasks(SearchTasksInput.parse({}), MEMBER_A);
    expect(forMember.tasks.map((t) => t.id).sort()).toEqual([a.task.id, c.task.id].sort());
    expect(forMember.total).toBe(2);
    expect(forMember.tasks.some((t) => t.id === b.task.id)).toBe(false);

    const forOwner = ws.searchTasks(SearchTasksInput.parse({}), OWNER);
    expect(forOwner.total).toBe(3);
    expect(forOwner.tasks.map((t) => t.id).sort()).toEqual(
      [a.task.id, b.task.id, c.task.id].sort()
    );
  });
});

describe("replay after row deletion", () => {
  async function replayFrames(
    ws: Awaited<ReturnType<typeof seededWorkspace>>["ws"],
    userId: string,
    sinceSeq: number
  ): Promise<ServerMsg[]> {
    const { ws: sock, frames } = fakeSocket(userId);
    await ws.webSocketMessage(sock, JSON.stringify({ type: "hello", sinceSeq }));
    return frames;
  }

  function deltasOf(frames: ServerMsg[]): Delta[] {
    return frames.flatMap((f) => (f.type === "deltas" ? f.deltas : []));
  }

  it("create/delete deltas for a row that lived and died in a private space never reach a non-member, but reach the owner", async () => {
    const { ws, b, c } = await seededWorkspace();

    // Advance seq past the resync floor (bumped by the membership mutations)
    // so the hello handler replays instead of falling back to a snapshot.
    ws.createTask(CreateTaskInput.parse({ listId: c.list.id, title: "public marker" }), OWNER);
    const sinceSeq = ws.getSnapshot().seq;

    const secret = ws.createTask(
      CreateTaskInput.parse({ listId: b.list.id, title: "secret in B", description: "hidden body" }),
      OWNER
    );
    ws.deleteTask(secret.id, OWNER);

    const memberFrames = await replayFrames(ws, MEMBER_A, sinceSeq);
    expect(memberFrames.some((f) => f.type === "snapshot")).toBe(false);
    const memberDeltas = deltasOf(memberFrames);
    expect(memberDeltas.filter((d) => d.id === secret.id)).toEqual([]);
    expect(JSON.stringify(memberFrames)).not.toContain("secret in B");

    const ownerDeltas = deltasOf(await replayFrames(ws, OWNER, sinceSeq));
    expect(ownerDeltas.filter((d) => d.id === secret.id).map((d) => d.op)).toEqual([
      "create",
      "delete",
    ]);
  });

  it("pre-migration rows (null space_id) fail closed for deleted private rows, while user deltas still reach everyone", async () => {
    const { ws, db, b, c } = await seededWorkspace();

    ws.createTask(CreateTaskInput.parse({ listId: c.list.id, title: "public marker" }), OWNER);
    const sinceSeq = ws.getSnapshot().seq;

    const secret = ws.createTask(
      CreateTaskInput.parse({ listId: b.list.id, title: "secret in B" }),
      OWNER
    );
    ws.deleteTask(secret.id, OWNER);
    const alive = ws.createTask(
      CreateTaskInput.parse({ listId: c.list.id, title: "public alive" }),
      OWNER
    );
    ws.upsertUser({ id: "us_newbie", email: "n@example.com", name: "Newbie" }, OWNER);

    // Simulate rows written before core-0007-changes-space-id.
    db.prepare("UPDATE changes SET space_id = NULL").run();

    const memberDeltas = deltasOf(await replayFrames(ws, MEMBER_A, sinceSeq));
    // Deleted private row: live resolution returns null too -> fail closed.
    expect(memberDeltas.filter((d) => d.id === secret.id)).toEqual([]);
    // Live row in a workspace space: live resolution still answers -> visible.
    expect(memberDeltas.some((d) => d.id === alive.id)).toBe(true);
    // Workspace-scoped delta with a legitimately-null space: visible.
    expect(memberDeltas.some((d) => d.entity === "user" && d.id === "us_newbie")).toBe(true);

    // Owner/admin replay is never filtered, resolved or not.
    const ownerDeltas = deltasOf(await replayFrames(ws, OWNER, sinceSeq));
    expect(ownerDeltas.filter((d) => d.id === secret.id)).toHaveLength(2);
  });
});

describe("notification space gate", () => {
  it("skips a creator who lost access, keeps the member assignee, keeps the owner", async () => {
    const h = await freshWorkspace();
    const { ws, emails } = h;
    ws.upsertUser({ id: OWNER, email: "owner@example.com", name: "Owner", role: "owner" }, OWNER);
    ws.upsertUser({ id: MEMBER_A, email: "a@example.com", name: "Member A", role: "member" }, OWNER);
    ws.upsertUser({ id: MEMBER_B, email: "b@example.com", name: "Member B", role: "member" }, OWNER);

    // Born workspace-visible so MEMBER_B (not yet a member of anything) can
    // create a task in it below, before the space is flipped private.
    const space = ws.createSpace(CreateSpaceInput.parse({ name: "P", visibility: "workspace" }), OWNER);
    const list = ws.createList(CreateListInput.parse({ spaceId: space.id, name: "P list" }), OWNER);
    // MEMBER_B creates the task (becomes creator) while the space is still
    // workspace-visible; MEMBER_A is the assignee.
    const task = ws.createTask(
      CreateTaskInput.parse({ listId: list.id, title: "P task", assigneeId: MEMBER_A }),
      MEMBER_B
    );
    // Flip private with MEMBER_A as the only member: the creator (MEMBER_B)
    // and the owner both fall out of the membership list.
    ws.setSpaceVisibility({ spaceId: space.id, visibility: "private" }, OWNER);
    ws.setSpaceMembers({ spaceId: space.id, userIds: [MEMBER_A] }, OWNER);

    // Owner comments -> stakeholders are assignee MEMBER_A + creator MEMBER_B.
    ws.createComment(CreateCommentInput.parse({ taskId: task.id, body: "status?" }), OWNER);
    const afterComment = emails();
    expect(afterComment.some((p) => p.to.includes("a@example.com"))).toBe(true);
    expect(afterComment.some((p) => p.to.includes("b@example.com"))).toBe(false);

    // Owner-created task in the same private space: owner is not in
    // space_members but is privileged, so a member's comment still emails them.
    const ownersTask = ws.createTask(
      CreateTaskInput.parse({ listId: list.id, title: "Owner task", assigneeId: MEMBER_A }),
      OWNER
    );
    const before = emails().length;
    ws.createComment(CreateCommentInput.parse({ taskId: ownersTask.id, body: "done" }), MEMBER_A);
    const fresh = emails().slice(before);
    expect(fresh.some((p) => p.to.includes("owner@example.com"))).toBe(true);
  });

  it("automation send_email side effects to external addresses are not gated", async () => {
    const h = await freshWorkspace();
    const { ws, emails } = h;
    ws.upsertUser({ id: OWNER, email: "owner@example.com", name: "Owner", role: "owner" }, OWNER);

    const space = ws.createSpace(CreateSpaceInput.parse({ name: "P" }), OWNER);
    const list = ws.createList(CreateListInput.parse({ spaceId: space.id, name: "P list" }), OWNER);
    ws.setSpaceVisibility({ spaceId: space.id, visibility: "private" }, OWNER);

    ws.upsertAutomation(
      {
        name: "notify vendor",
        enabled: true,
        scope: { kind: "list", listId: list.id },
        trigger: { kind: "task_created" },
        conditions: [],
        actions: [
          {
            kind: "send_email",
            to: ["external@vendor.example"],
            subject: "New: {{task.title}}",
            body: "created",
          },
        ],
      },
      OWNER
    );

    const task = ws.createTask(
      CreateTaskInput.parse({ listId: list.id, title: "Private task" }),
      OWNER
    );

    const rule = emails().filter((p) => p.to.includes("external@vendor.example"));
    expect(rule).toHaveLength(1);
    expect(rule[0]?.subject).toBe("New: Private task");
    // Sanity: it fired for the private-space task, addressed only externally.
    expect(rule[0]?.to).toEqual(["external@vendor.example"]);
    expect(task.title).toBe("Private task");
  });
});

describe("stored space_id column", () => {
  let h: Awaited<ReturnType<typeof seededWorkspace>>;

  beforeEach(async () => {
    h = await seededWorkspace();
  });

  it("stamps every space-scoped delta row and leaves user deltas null", () => {
    const rows = h.db
      .prepare("SELECT entity, entity_id, space_id FROM changes ORDER BY seq")
      .all() as Array<{ entity: string; entity_id: string; space_id: string | null }>;
    for (const row of rows) {
      if (row.entity === "user") expect(row.space_id).toBeNull();
      else expect(row.space_id).not.toBeNull();
    }
    const taskRow = rows.find((r) => r.entity === "task" && r.entity_id === h.b.task.id);
    expect(taskRow?.space_id).toBe(h.b.space.id);
  });

  it("keeps the stamped space on delete deltas after the row is gone", () => {
    h.ws.deleteTask(h.b.task.id, OWNER);
    const row = h.db
      .prepare("SELECT space_id FROM changes WHERE entity = 'task' AND entity_id = ? AND op = 'delete'")
      .all(h.b.task.id)[0] as { space_id: string | null } | undefined;
    expect(row?.space_id).toBe(h.b.space.id);
  });
});

describe("createSpace: born private", () => {
  it("defaults to private and auto-adds the creator as a member", async () => {
    const { ws } = await freshWorkspace();
    ws.upsertUser({ id: OWNER, email: "owner@example.com", name: "Owner", role: "owner" }, OWNER);
    ws.upsertUser({ id: MEMBER_A, email: "a@example.com", name: "Member A", role: "member" }, OWNER);

    // CreateSpaceInput.parse applies the schema default: no visibility given.
    const space = ws.createSpace(CreateSpaceInput.parse({ name: "Solo" }), MEMBER_A);
    expect(space.visibility).toBe("private");
    expect(ws.listSpaceMembers(space.id)).toEqual([MEMBER_A]);
  });

  it("also adds an admin/owner creator as a member, for consistency", async () => {
    const { ws } = await freshWorkspace();
    ws.upsertUser({ id: OWNER, email: "owner@example.com", name: "Owner", role: "owner" }, OWNER);

    const space = ws.createSpace(CreateSpaceInput.parse({ name: "Owner's" }), OWNER);
    expect(space.visibility).toBe("private");
    // Owner sees everything regardless of membership, but the row should
    // still exist so behavior is consistent whoever the creator is.
    expect(ws.listSpaceMembers(space.id)).toEqual([OWNER]);
  });

  it("an explicit visibility: \"workspace\" still opts out of the private default", async () => {
    const { ws } = await freshWorkspace();
    ws.upsertUser({ id: OWNER, email: "owner@example.com", name: "Owner", role: "owner" }, OWNER);

    const space = ws.createSpace(
      CreateSpaceInput.parse({ name: "Public", visibility: "workspace" }),
      OWNER
    );
    expect(space.visibility).toBe("workspace");
    expect(ws.listSpaceMembers(space.id)).toEqual([]);
  });

  it("the create delta for a private space reaches only owner/admin + its members, not other members", async () => {
    const { ws, ctx } = await freshWorkspace();
    ws.upsertUser({ id: OWNER, email: "owner@example.com", name: "Owner", role: "owner" }, OWNER);
    ws.upsertUser({ id: MEMBER_A, email: "a@example.com", name: "Member A", role: "member" }, OWNER);
    ws.upsertUser({ id: MEMBER_B, email: "b@example.com", name: "Member B", role: "member" }, OWNER);

    const ownerSock = fakeSocket(OWNER);
    const memberASock = fakeSocket(MEMBER_A);
    const memberBSock = fakeSocket(MEMBER_B);
    ctx.acceptWebSocket(ownerSock.ws);
    ctx.acceptWebSocket(memberASock.ws);
    ctx.acceptWebSocket(memberBSock.ws);

    // MEMBER_A creates a space; it is born private, so MEMBER_A is auto-added.
    const space = ws.createSpace(CreateSpaceInput.parse({ name: "Secret" }), MEMBER_A);

    const createDeltasFor = (frames: ServerMsg[]) =>
      frames
        .flatMap((f) => (f.type === "deltas" ? f.deltas : []))
        .filter((d) => d.entity === "space" && d.id === space.id && d.op === "create");

    expect(createDeltasFor(ownerSock.frames)).toHaveLength(1);
    expect(createDeltasFor(memberASock.frames)).toHaveLength(1);
    expect(createDeltasFor(memberBSock.frames)).toHaveLength(0);
  });
});
