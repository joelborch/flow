import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  type Actor,
  CreateListInput,
  CreateSpaceInput,
  type ServerMsg,
} from "@flow/shared";
import {
  EMAIL_INTAKE_HOURLY_LIMIT,
  EMAIL_INTAKE_LIST_HOURLY_LIMIT,
  type IngestEmailInput,
} from "./email-intake.js";

// ---------------------------------------------------------------------------
// Email intake against the real Workspace class: owner/admin configuration,
// the read-only pre-check, and ingestEmail's one-turn routing — a new ticket,
// a threaded reply that lands as a comment without touching status, dedupe and
// threading keyed by list rather than alias, unverified senders, every refusal
// (unknown or archived alias, disallowed sender, duplicate, both rate limits),
// the permanent errors the Worker rejects instead of retrying — plus
// deleteList releasing a list's alias.
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

function fakeCtx(db: DatabaseSync, sockets: WebSocket[]): DurableObjectState {
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
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: WebSocket) => {
      sockets.push(ws);
    },
  } as unknown as DurableObjectState;
}

const OWNER = "us_owner";
const ADMIN = "us_admin";
const MEMBER = "us_member";
/** What the Worker's email() handler passes: a real user, via the webhook path. */
const MAIL: Actor = { userId: OWNER, via: "webhook", apiKeyId: null, automationRuleId: null };
/** An inbound actor without access to private spaces it isn't a member of. */
const MEMBER_MAIL: Actor = { userId: MEMBER, via: "webhook", apiKeyId: null, automationRuleId: null };

/** Two lists with intakes "support" and "billing", a third list with none. */
async function seeded() {
  const { Workspace } = await import("./index.js");
  const db = new DatabaseSync(":memory:");
  const sockets: WebSocket[] = [];
  const ws = new Workspace(fakeCtx(db, sockets), {
    SIDE_EFFECTS: { sendBatch: vi.fn(async () => undefined) },
  } as never);

  ws.upsertUser({ id: OWNER, email: "owner@example.com", name: "Owner", role: "owner" }, OWNER);
  ws.upsertUser({ id: ADMIN, email: "admin@example.com", name: "Admin", role: "admin" }, OWNER);
  ws.upsertUser({ id: MEMBER, email: "member@example.com", name: "Member", role: "member" }, OWNER);

  const space = ws.createSpace(CreateSpaceInput.parse({ name: "Ops", visibility: "workspace" }), OWNER);
  const support = ws.createList(CreateListInput.parse({ spaceId: space.id, name: "Support" }), OWNER);
  const billing = ws.createList(CreateListInput.parse({ spaceId: space.id, name: "Billing" }), OWNER);
  const plain = ws.createList(CreateListInput.parse({ spaceId: space.id, name: "Plain" }), OWNER);
  ws.setEmailIntake(support.id, { alias: "support", allowedSenders: ["@clinic.com"] }, OWNER);
  ws.setEmailIntake(billing.id, { alias: "billing", allowedSenders: ["@clinic.com"] }, OWNER);

  /** A live owner socket, so tests can see what ingestEmail broadcast. */
  const frames: ServerMsg[] = [];
  sockets.push({
    deserializeAttachment: () => ({ userId: OWNER }),
    serializeAttachment: () => undefined,
    send: (payload: string) => frames.push(JSON.parse(payload) as ServerMsg),
  } as unknown as WebSocket);

  let n = 0;
  /** A well-formed, authenticated message to "support" from pat@clinic.com, with overrides. */
  const mail = (over: Partial<IngestEmailInput> = {}): IngestEmailInput => {
    n += 1;
    return {
      alias: "support",
      sender: "pat@clinic.com",
      authenticated: true,
      messageId: `m${n}@clinic.com`,
      referenceIds: [],
      task: { title: `Ticket ${n}`, description: `Body ${n}` },
      commentBody: `Reply ${n}`,
      attachments: [],
      ...over,
    };
  };

  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all()[0] as { n: number }).n;
  const auditActions = (): string[] =>
    (db.prepare("SELECT action FROM audit ORDER BY id").all() as Array<{ action: string }>).map(
      (r) => r.action
    );

  return { ws, db, frames, space, support, billing, plain, mail, count, auditActions };
}

describe("setEmailIntake", () => {
  it("creates an intake, normalizing the alias and de-duplicating senders", async () => {
    const { ws, plain, auditActions } = await seeded();
    const intake = ws.setEmailIntake(
      plain.id,
      { alias: "  Front-Desk ", allowedSenders: ["Pat@Clinic.com", "pat@clinic.com", "@Clinic.com"] },
      ADMIN
    );
    expect(intake).toMatchObject({
      listId: plain.id,
      alias: "front-desk",
      allowedSenders: ["pat@clinic.com", "@clinic.com"],
    });
    expect(ws.listEmailIntakes().find((i) => i.listId === plain.id)).toEqual(intake);
    expect(auditActions()).toContain("list.email_intake.set");
  });

  it("lists every intake ordered by alias", async () => {
    const { ws } = await seeded();
    expect(ws.listEmailIntakes().map((i) => i.alias)).toEqual(["billing", "support"]);
  });

  it("replaces in place: same createdAt, new alias, and the old alias stops resolving", async () => {
    const { ws, support } = await seeded();
    const before = ws.listEmailIntakes().find((i) => i.listId === support.id);
    const after = ws.setEmailIntake(
      support.id,
      { alias: "help", allowedSenders: ["sam@clinic.com"] },
      OWNER
    );
    expect(after).toMatchObject({ alias: "help", allowedSenders: ["sam@clinic.com"] });
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(ws.listEmailIntakes().filter((i) => i.listId === support.id)).toHaveLength(1);
    expect(
      ws.checkEmailIntake({ alias: "support", sender: "sam@clinic.com", messageId: "x@y" })
    ).toEqual({ status: "unknown_alias" });
  });

  it("null removes the intake, and removing a missing one is a quiet no-op", async () => {
    const { ws, support, plain, auditActions } = await seeded();
    expect(ws.setEmailIntake(support.id, null, OWNER)).toBeNull();
    expect(ws.listEmailIntakes().map((i) => i.alias)).toEqual(["billing"]);
    expect(auditActions()).toContain("list.email_intake.remove");

    const audits = auditActions().length;
    expect(ws.setEmailIntake(plain.id, null, OWNER)).toBeNull();
    expect(auditActions()).toHaveLength(audits);
  });

  it("is refused for a member, even though the route also gates it", async () => {
    const { ws, plain } = await seeded();
    expect(() =>
      ws.setEmailIntake(plain.id, { alias: "front", allowedSenders: ["@clinic.com"] }, MEMBER)
    ).toThrow(/requires the owner or admin role/);
    expect(() => ws.setEmailIntake(plain.id, null, MEMBER)).toThrow(/owner or admin/);
    expect(ws.listEmailIntakes()).toHaveLength(2);
  });

  it("refuses an alias another list holds, naming that list (a 422, not a 404)", async () => {
    const { ws, plain, support } = await seeded();
    let message = "";
    try {
      ws.setEmailIntake(plain.id, { alias: "Support", allowedSenders: ["@clinic.com"] }, OWNER);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(`list ${support.id} ("Support")`);
    expect(message).not.toMatch(/not found/i);
    expect(ws.listEmailIntakes().find((i) => i.listId === plain.id)).toBeUndefined();
  });

  it("throws the list not-found error for an unknown list", async () => {
    const { ws } = await seeded();
    expect(() =>
      ws.setEmailIntake("ls_missing", { alias: "x", allowedSenders: ["@clinic.com"] }, OWNER)
    ).toThrow(/List ls_missing not found/);
  });

  it("re-validates input the route would have rejected", async () => {
    const { ws, plain } = await seeded();
    expect(() =>
      ws.setEmailIntake(plain.id, { alias: "-bad-", allowedSenders: ["@clinic.com"] }, OWNER)
    ).toThrow(/Alias must be/);
    expect(() => ws.setEmailIntake(plain.id, { alias: "ok", allowedSenders: [] }, OWNER)).toThrow(
      /at least one allowed sender/
    );
  });
});

describe("checkEmailIntake", () => {
  it("ok carries the intake's list, matching case- and bracket-insensitively", async () => {
    const { ws, support } = await seeded();
    expect(
      ws.checkEmailIntake({ alias: "SUPPORT", sender: "Pat@Clinic.com", messageId: "<a@b>" })
    ).toEqual({ status: "ok", listId: support.id });
  });

  it("unknown_alias for an alias no list has", async () => {
    const { ws } = await seeded();
    expect(ws.checkEmailIntake({ alias: "nobody", sender: "pat@clinic.com", messageId: "a@b" }))
      .toEqual({ status: "unknown_alias" });
  });

  it("unknown_alias when the intake's list is archived", async () => {
    const { ws, support } = await seeded();
    ws.updateList({ listId: support.id, archived: true }, OWNER);
    expect(ws.checkEmailIntake({ alias: "support", sender: "pat@clinic.com", messageId: "a@b" }))
      .toEqual({ status: "unknown_alias" });
  });

  it("sender_not_allowed outside the allowlist", async () => {
    const { ws } = await seeded();
    expect(ws.checkEmailIntake({ alias: "support", sender: "pat@gmail.com", messageId: "a@b" }))
      .toEqual({ status: "sender_not_allowed" });
  });

  it("duplicate names the task an already-ingested message produced", async () => {
    const { ws, mail } = await seeded();
    const first = ws.ingestEmail(mail({ messageId: "dup@clinic.com" }), MAIL);
    if (first.status !== "created") throw new Error(`expected created, got ${first.status}`);
    expect(
      ws.checkEmailIntake({ alias: "support", sender: "pat@clinic.com", messageId: "<dup@clinic.com>" })
    ).toEqual({ status: "duplicate", taskId: first.taskId });
  });

  it("rate_limited once the sender has filed the hourly limit", async () => {
    const { ws, mail } = await seeded();
    for (let i = 0; i < EMAIL_INTAKE_HOURLY_LIMIT; i++) ws.ingestEmail(mail(), MAIL);
    expect(ws.checkEmailIntake({ alias: "support", sender: "pat@clinic.com", messageId: "new@x" }))
      .toEqual({ status: "rate_limited" });
  });

  it("duplicate is per list: the same Message-ID is new to another intake", async () => {
    const { ws, billing, mail } = await seeded();
    ws.ingestEmail(mail({ messageId: "both@clinic.com" }), MAIL);
    expect(
      ws.checkEmailIntake({ alias: "billing", sender: "pat@clinic.com", messageId: "both@clinic.com" })
    ).toEqual({ status: "ok", listId: billing.id });
  });

  it("rate_limited once the list has received its hourly limit from any mix of senders", async () => {
    const { ws, billing, mail } = await seeded();
    for (let i = 0; i < EMAIL_INTAKE_LIST_HOURLY_LIMIT; i++) {
      ws.ingestEmail(mail({ sender: `s${i}@clinic.com` }), MAIL);
    }
    expect(ws.checkEmailIntake({ alias: "support", sender: "fresh@clinic.com", messageId: "new@x" }))
      .toEqual({ status: "rate_limited" });
    expect(ws.checkEmailIntake({ alias: "billing", sender: "fresh@clinic.com", messageId: "new@x" }))
      .toEqual({ status: "ok", listId: billing.id });
  });

  it("writes nothing", async () => {
    const { ws, count, auditActions } = await seeded();
    const audits = auditActions().length;
    const changes = count("changes");
    ws.checkEmailIntake({ alias: "support", sender: "pat@clinic.com", messageId: "a@b" });
    expect(auditActions()).toHaveLength(audits);
    expect(count("changes")).toBe(changes);
  });
});

describe("ingestEmail", () => {
  it("opens an unassigned, open-status task tagged 'email' in the intake's list, with attachments", async () => {
    const { ws, db, frames, support, mail, auditActions } = await seeded();
    const result = ws.ingestEmail(
      mail({
        messageId: "<first@clinic.com>",
        task: { title: "Printer jammed", description: "From: pat@clinic.com\n\nHelp" },
        attachments: [
          { id: "at_email_1", r2Key: "attachments/at_email_1/photo.png", filename: "photo.png", size: 10, mimeType: "image/png" },
        ],
      }),
      MAIL
    );
    expect(result).toMatchObject({ status: "created", listId: support.id });
    if (result.status !== "created") throw new Error("unreachable");

    const detail = ws.getTaskDetail(result.taskId);
    expect(detail.task).toMatchObject({
      listId: support.id,
      title: "Printer jammed",
      description: "From: pat@clinic.com\n\nHelp",
      tags: ["email"],
      assigneeId: null,
      closedAt: null,
    });
    const open = ws.getSnapshot().lists.find((l) => l.id === support.id)?.statuses.find((s) => s.type === "open");
    expect(detail.task.statusId).toBe(open?.id);
    expect(ws.listAttachments(result.taskId)).toEqual([
      expect.objectContaining({ id: "at_email_1", r2Key: "attachments/at_email_1/photo.png", filename: "photo.png" }),
    ]);

    expect(db.prepare("SELECT * FROM email_messages").all()).toEqual([
      expect.objectContaining({
        message_id: "first@clinic.com",
        list_id: support.id,
        alias: "support",
        task_id: result.taskId,
        comment_id: null,
        sender: "pat@clinic.com",
      }),
    ]);
    expect(auditActions()).toEqual(
      expect.arrayContaining(["task.create", "attachment.create", "email.ingest"])
    );
    // An ordinary turn: the task and attachment deltas reached the socket.
    const broadcast = frames.flatMap((f) => (f.type === "deltas" ? f.deltas : []));
    expect(broadcast.map((d) => `${d.entity}:${d.op}`)).toEqual(
      expect.arrayContaining(["task:create", "attachment:create"])
    );
  });

  it("a redelivered Message-ID is a duplicate: no second task, comment or attachment", async () => {
    const { ws, mail, count } = await seeded();
    const message = mail({
      attachments: [{ id: "at_dup", r2Key: "k/at_dup", filename: "a.txt", size: 1, mimeType: "text/plain" }],
    });
    const first = ws.ingestEmail(message, MAIL);
    if (first.status !== "created") throw new Error(`expected created, got ${first.status}`);
    const tasks = count("tasks");

    // Same id, fresh attachment ids (a Worker retry re-mints them) and brackets.
    const again = ws.ingestEmail(
      {
        ...message,
        messageId: `<${message.messageId}>`,
        attachments: [{ id: "at_dup_2", r2Key: "k/at_dup_2", filename: "a.txt", size: 1, mimeType: "text/plain" }],
      },
      MAIL
    );
    expect(again).toEqual({ status: "duplicate", taskId: first.taskId });
    expect(count("tasks")).toBe(tasks);
    expect(count("attachments")).toBe(1);
    expect(count("comments")).toBe(0);
    expect(count("email_messages")).toBe(1);
  });

  it("threads a reply into a comment on the earlier ticket without reopening it", async () => {
    const { ws, db, mail } = await seeded();
    const first = ws.ingestEmail(mail({ messageId: "orig@clinic.com" }), MAIL);
    if (first.status !== "created") throw new Error(`expected created, got ${first.status}`);
    ws.updateTask({ taskId: first.taskId, status: "Done" }, OWNER);
    const closed = ws.getTaskDetail(first.taskId).task;
    expect(closed.closedAt).not.toBeNull();

    const reply = ws.ingestEmail(
      mail({
        messageId: "reply@clinic.com",
        // In-Reply-To/References order: an unknown id first, then the original.
        referenceIds: ["someone-else@gmail.com", "<orig@clinic.com>"],
        commentBody: "Still broken",
        attachments: [{ id: "at_reply", r2Key: "k/at_reply", filename: "b.txt", size: 2, mimeType: "text/plain" }],
      }),
      MAIL
    );
    expect(reply).toMatchObject({ status: "commented", taskId: first.taskId, listId: first.listId });
    if (reply.status !== "commented") throw new Error("unreachable");

    const after = ws.getTaskDetail(first.taskId).task;
    expect(after.statusId).toBe(closed.statusId);
    expect(after.closedAt).toBe(closed.closedAt);
    expect(ws.listComments(first.taskId)).toEqual([
      expect.objectContaining({ id: reply.commentId, body: "Still broken", authorId: OWNER }),
    ]);
    expect(ws.listAttachments(first.taskId).map((a) => a.id)).toEqual(["at_reply"]);
    expect(
      db.prepare("SELECT comment_id FROM email_messages WHERE message_id = 'reply@clinic.com'").all()
    ).toEqual([{ comment_id: reply.commentId }]);
    // The reply itself can be replied to: threading follows the reply's own id too.
    const third = ws.ingestEmail(mail({ referenceIds: ["reply@clinic.com"] }), MAIL);
    expect(third).toMatchObject({ status: "commented", taskId: first.taskId });
  });

  it("never threads across aliases: a reply sent to another intake opens a ticket there", async () => {
    const { ws, billing, mail } = await seeded();
    const first = ws.ingestEmail(mail({ messageId: "orig@clinic.com" }), MAIL);
    if (first.status !== "created") throw new Error(`expected created, got ${first.status}`);

    const crossed = ws.ingestEmail(
      mail({ alias: "billing", referenceIds: ["orig@clinic.com"] }),
      MAIL
    );
    expect(crossed).toMatchObject({ status: "created", listId: billing.id });
    if (crossed.status !== "created") throw new Error("unreachable");
    expect(crossed.taskId).not.toBe(first.taskId);
    expect(ws.listComments(first.taskId)).toEqual([]);
  });

  it("falls back to a new ticket when the referenced task was deleted", async () => {
    const { ws, support, mail } = await seeded();
    const first = ws.ingestEmail(mail({ messageId: "orig@clinic.com" }), MAIL);
    if (first.status !== "created") throw new Error(`expected created, got ${first.status}`);
    ws.deleteTask(first.taskId, OWNER);

    const reply = ws.ingestEmail(mail({ referenceIds: ["orig@clinic.com"] }), MAIL);
    expect(reply).toMatchObject({ status: "created", listId: support.id });
    if (reply.status !== "created") throw new Error("unreachable");
    expect(reply.taskId).not.toBe(first.taskId);
  });

  it("rate-limits a sender's 21st message within the hour, and only that sender", async () => {
    const { ws, db, mail, count } = await seeded();
    for (let i = 0; i < EMAIL_INTAKE_HOURLY_LIMIT; i++) {
      expect(ws.ingestEmail(mail(), MAIL).status).toBe("created");
    }
    const tasks = count("tasks");
    expect(ws.ingestEmail(mail(), MAIL)).toEqual({ status: "rate_limited" });
    expect(count("tasks")).toBe(tasks);
    // Another sender on the same domain has their own budget.
    expect(ws.ingestEmail(mail({ sender: "sam@clinic.com" }), MAIL).status).toBe("created");

    // Once the earlier messages age out of the window, pat may write again.
    db.prepare("UPDATE email_messages SET received_at = received_at - 3600001").run();
    expect(ws.ingestEmail(mail(), MAIL).status).toBe("created");
  });

  it("refuses an unknown alias, an archived list and a disallowed sender, writing nothing", async () => {
    const { ws, billing, mail, count } = await seeded();
    ws.updateList({ listId: billing.id, archived: true }, OWNER);
    const tasks = count("tasks");
    const changes = count("changes");

    expect(ws.ingestEmail(mail({ alias: "nobody" }), MAIL)).toEqual({ status: "unknown_alias" });
    expect(ws.ingestEmail(mail({ alias: "billing" }), MAIL)).toEqual({ status: "unknown_alias" });
    expect(ws.ingestEmail(mail({ sender: "pat@gmail.com" }), MAIL)).toEqual({
      status: "sender_not_allowed",
    });

    expect(count("tasks")).toBe(tasks);
    expect(count("email_messages")).toBe(0);
    expect(count("changes")).toBe(changes);
  });

  it("one Message-ID sent to two intakes files once in each, and redelivery to either is a duplicate", async () => {
    const { ws, db, support, billing, mail, count } = await seeded();
    const toSupport = ws.ingestEmail(mail({ messageId: "<both@clinic.com>" }), MAIL);
    const toBilling = ws.ingestEmail(mail({ alias: "billing", messageId: "both@clinic.com" }), MAIL);
    expect(toSupport).toMatchObject({ status: "created", listId: support.id });
    expect(toBilling).toMatchObject({ status: "created", listId: billing.id });
    if (toSupport.status !== "created" || toBilling.status !== "created") throw new Error("unreachable");
    expect(toBilling.taskId).not.toBe(toSupport.taskId);

    expect(ws.ingestEmail(mail({ messageId: "both@clinic.com" }), MAIL)).toEqual({
      status: "duplicate",
      taskId: toSupport.taskId,
    });
    expect(ws.ingestEmail(mail({ alias: "billing", messageId: "both@clinic.com" }), MAIL)).toEqual({
      status: "duplicate",
      taskId: toBilling.taskId,
    });
    expect(count("tasks")).toBe(2);
    const rows = db
      .prepare("SELECT list_id FROM email_messages WHERE message_id = 'both@clinic.com'")
      .all() as Array<{ list_id: string }>;
    expect(rows.map((r) => r.list_id).sort()).toEqual([support.id, billing.id].sort());
  });

  it("threads by list, not alias: a reassigned alias never reaches the old list's tickets", async () => {
    const { ws, support, plain, mail } = await seeded();
    const first = ws.ingestEmail(mail({ messageId: "orig@clinic.com" }), MAIL);
    if (first.status !== "created") throw new Error(`expected created, got ${first.status}`);

    // The alias moves to another client's list.
    ws.setEmailIntake(support.id, null, OWNER);
    ws.setEmailIntake(plain.id, { alias: "support", allowedSenders: ["@clinic.com"] }, OWNER);
    const reassigned = ws.ingestEmail(mail({ referenceIds: ["orig@clinic.com"] }), MAIL);
    expect(reassigned).toMatchObject({ status: "created", listId: plain.id });
    expect(ws.listComments(first.taskId)).toEqual([]);

    // The original list, under a new alias, still threads its own tickets.
    ws.setEmailIntake(support.id, { alias: "help", allowedSenders: ["@clinic.com"] }, OWNER);
    const renamed = ws.ingestEmail(mail({ alias: "help", referenceIds: ["orig@clinic.com"] }), MAIL);
    expect(renamed).toMatchObject({ status: "commented", taskId: first.taskId, listId: support.id });
  });

  it("caps a list at its hourly limit across senders, independently of other lists", async () => {
    const { ws, db, mail, count } = await seeded();
    for (let i = 0; i < EMAIL_INTAKE_LIST_HOURLY_LIMIT; i++) {
      expect(ws.ingestEmail(mail({ sender: `s${i}@clinic.com` }), MAIL).status).toBe("created");
    }
    const tasks = count("tasks");
    expect(ws.ingestEmail(mail({ sender: "s-new@clinic.com" }), MAIL)).toEqual({ status: "rate_limited" });
    expect(count("tasks")).toBe(tasks);
    expect(ws.ingestEmail(mail({ alias: "billing", sender: "s-new@clinic.com" }), MAIL).status).toBe("created");

    db.prepare("UPDATE email_messages SET received_at = received_at - 3600001").run();
    expect(ws.ingestEmail(mail({ sender: "s-new@clinic.com" }), MAIL).status).toBe("created");
  });

  it("tags a new task from an unauthenticated sender 'unverified', and still threads its replies", async () => {
    const { ws, db, mail } = await seeded();
    const opened = ws.ingestEmail(mail({ messageId: "spoof@clinic.com", authenticated: false }), MAIL);
    if (opened.status !== "created") throw new Error(`expected created, got ${opened.status}`);
    expect(ws.getTaskDetail(opened.taskId).task.tags).toEqual(["email", "unverified"]);

    const verified = ws.ingestEmail(mail({ messageId: "real@clinic.com" }), MAIL);
    if (verified.status !== "created") throw new Error(`expected created, got ${verified.status}`);
    expect(ws.getTaskDetail(verified.taskId).task.tags).toEqual(["email"]);

    // An unauthenticated reply lands as a comment and leaves the tags alone.
    const reply = ws.ingestEmail(
      mail({ authenticated: false, referenceIds: ["spoof@clinic.com"] }),
      MAIL
    );
    expect(reply).toMatchObject({ status: "commented", taskId: opened.taskId });
    const replyToVerified = ws.ingestEmail(
      mail({ authenticated: false, referenceIds: ["real@clinic.com"] }),
      MAIL
    );
    expect(replyToVerified).toMatchObject({ status: "commented", taskId: verified.taskId });
    expect(ws.getTaskDetail(verified.taskId).task.tags).toEqual(["email"]);

    const audits = (
      db.prepare("SELECT diff FROM audit WHERE action = 'email.ingest' ORDER BY id").all() as Array<{ diff: string }>
    ).map((r) => JSON.parse(r.diff) as { authenticated: boolean });
    expect(audits.map((a) => a.authenticated)).toEqual([false, true, false, false]);
  });

  it("looks at only the first 20 reference ids", async () => {
    const { ws, support, mail } = await seeded();
    const first = ws.ingestEmail(mail({ messageId: "orig@clinic.com" }), MAIL);
    if (first.status !== "created") throw new Error(`expected created, got ${first.status}`);
    const noise = (k: number) => Array.from({ length: k }, (_, i) => `noise${i}@elsewhere.com`);

    const twentyFirst = ws.ingestEmail(mail({ referenceIds: [...noise(20), "orig@clinic.com"] }), MAIL);
    expect(twentyFirst).toMatchObject({ status: "created", listId: support.id });

    const twentieth = ws.ingestEmail(mail({ referenceIds: [...noise(19), "orig@clinic.com"] }), MAIL);
    expect(twentieth).toMatchObject({ status: "commented", taskId: first.taskId });
  });

  it("throws a permanent error when the inbound actor can't write to the intake's list", async () => {
    const { ws, space, mail, count } = await seeded();
    ws.setSpaceVisibility({ spaceId: space.id, visibility: "private" }, OWNER);
    const changes = count("changes");
    expect(() => ws.ingestEmail(mail(), MEMBER_MAIL)).toThrow(
      /^Email intake permanent failure: the inbound actor may not write to list ls_\S+\. Space \S+ is private/
    );
    expect(count("tasks")).toBe(0);
    expect(count("email_messages")).toBe(0);
    expect(count("changes")).toBe(changes);
  });

  it("throws a permanent error when the inbound actor can't write to the threaded task", async () => {
    const { ws, space, mail, count } = await seeded();
    const first = ws.ingestEmail(mail({ messageId: "orig@clinic.com" }), MAIL);
    if (first.status !== "created") throw new Error(`expected created, got ${first.status}`);
    ws.setSpaceVisibility({ spaceId: space.id, visibility: "private" }, OWNER);
    const changes = count("changes");
    expect(() => ws.ingestEmail(mail({ referenceIds: ["orig@clinic.com"] }), MEMBER_MAIL)).toThrow(
      new RegExp(`^Email intake permanent failure: the inbound actor may not write to task ${first.taskId}\\.`)
    );
    expect(count("comments")).toBe(0);
    expect(count("email_messages")).toBe(1);
    expect(count("changes")).toBe(changes);
  });

  it("refuses a message with no Message-ID, since it could never be deduped", async () => {
    const { ws, mail, count } = await seeded();
    expect(() => ws.ingestEmail(mail({ messageId: " <> " }), MAIL)).toThrow(
      /^Email intake permanent failure: .*Message-ID/
    );
    expect(count("tasks")).toBe(0);
  });

  it("refuses a reused attachment id before writing the task", async () => {
    const { ws, mail, count } = await seeded();
    const att = { id: "at_same", r2Key: "k/at_same", filename: "a", size: 1, mimeType: "text/plain" };
    ws.ingestEmail(mail({ attachments: [att] }), MAIL);
    const tasks = count("tasks");
    expect(() => ws.ingestEmail(mail({ attachments: [att] }), MAIL)).toThrow(
      /^Email intake permanent failure: attachment id at_same is already in use/
    );
    expect(() => ws.ingestEmail(mail({ attachments: [{ ...att, id: "at_twice" }, { ...att, id: "at_twice" }] }), MAIL))
      .toThrow(/^Email intake permanent failure: attachment id at_twice is already in use/);
    expect(count("tasks")).toBe(tasks);
    expect(count("email_messages")).toBe(1);
  });
});

describe("deleteList", () => {
  it("removes the list's intake in the same turn, freeing the alias", async () => {
    const { ws, plain } = await seeded();
    ws.setEmailIntake(plain.id, { alias: "front", allowedSenders: ["@clinic.com"] }, OWNER);
    ws.deleteList(plain.id, OWNER);

    expect(ws.listEmailIntakes().map((i) => i.alias)).toEqual(["billing", "support"]);
    expect(ws.checkEmailIntake({ alias: "front", sender: "pat@clinic.com", messageId: "a@b" }))
      .toEqual({ status: "unknown_alias" });
  });
});
