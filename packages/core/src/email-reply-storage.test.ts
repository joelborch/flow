import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  type Actor,
  CreateCommentInput,
  CreateListInput,
  CreateSpaceInput,
  CreateTaskInput,
  type ServerMsg,
} from "@flow/shared";
import type { SideEffectPayload } from "./automation/types.js";
import type { IngestEmailInput } from "./email-intake.js";

// ---------------------------------------------------------------------------
// Email replies against the real Workspace class: a person in the app (or an
// allowed api key) emails a comment back to the requester of an emailed
// ticket, verified or not. Covers what the comment records and what gets
// queued (recipient, Reply-To alias, the "Re:" subject, the thread's
// Message-IDs), TaskDetail.emailReplyTo, every refusal (a key nobody allowed,
// MCP, replies off, a task that never came in by email, a removed alias), the
// key permission itself, and markEmailReply's one-way status moves.
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
/** What the Worker's email() handler passes. */
const MAIL: Actor = { userId: OWNER, via: "webhook", apiKeyId: null, automationRuleId: null };
/** A person signed in to the web app. */
const PERSON: Actor = { userId: OWNER, via: "ui", apiKeyId: null, automationRuleId: null };
const API_KEY: Actor = { userId: OWNER, via: "api", apiKeyId: "ak_1", automationRuleId: null };
const MCP: Actor = { userId: OWNER, via: "mcp", apiKeyId: "ak_1", automationRuleId: null };

async function seeded(env: { EMAIL_INTAKE_REPLY?: string } = { EMAIL_INTAKE_REPLY: "true" }) {
  const { Workspace } = await import("./index.js");
  const db = new DatabaseSync(":memory:");
  const sockets: WebSocket[] = [];
  const sendBatch = vi.fn(async (_batch: Array<{ body: unknown }>) => undefined);
  const ws = new Workspace(fakeCtx(db, sockets), { SIDE_EFFECTS: { sendBatch }, ...env } as never);

  ws.upsertUser({ id: OWNER, email: "owner@example.com", name: "Owner", role: "owner" }, OWNER);
  const space = ws.createSpace(CreateSpaceInput.parse({ name: "Ops", visibility: "workspace" }), OWNER);
  const support = ws.createList(CreateListInput.parse({ spaceId: space.id, name: "Support" }), OWNER);
  ws.setEmailIntake(support.id, { alias: "support", allowedSenders: ["@clinic.example"] }, OWNER);

  const frames: ServerMsg[] = [];
  sockets.push({
    deserializeAttachment: () => ({ userId: OWNER }),
    serializeAttachment: () => undefined,
    send: (payload: string) => frames.push(JSON.parse(payload) as ServerMsg),
  } as unknown as WebSocket);

  let n = 0;
  const mail = (over: Partial<IngestEmailInput> = {}): IngestEmailInput => {
    n += 1;
    return {
      alias: "support",
      sender: "pat@clinic.example",
      authenticated: true,
      messageId: `m${n}@clinic.example`,
      referenceIds: [],
      task: { title: `Ticket ${n}`, description: `Body ${n}` },
      commentBody: `Reply ${n}`,
      attachments: [],
      ...over,
    };
  };

  /** A ticket opened by `mail(over)`; returns its task id. */
  const ticket = (over: Partial<IngestEmailInput> = {}): string => {
    const result = ws.ingestEmail(mail(over), MAIL);
    if (result.status !== "created") throw new Error(`expected a new ticket, got ${result.status}`);
    return result.taskId;
  };

  const queued = (): SideEffectPayload[] =>
    sendBatch.mock.calls.flatMap(([batch]) => batch.map((m) => m.body as SideEffectPayload));
  const replies = () => queued().filter((p) => p.kind === "email-reply");
  const comment = (taskId: string, body: string, emailToRequester?: boolean) =>
    CreateCommentInput.parse({ taskId, body, ...(emailToRequester === undefined ? {} : { emailToRequester }) });
  const commentCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM comments").all()[0] as { n: number }).n;
  const auditActions = (): string[] =>
    (db.prepare("SELECT action FROM audit ORDER BY id").all() as Array<{ action: string }>).map((r) => r.action);

  /** A key acting as the owner; `allowed` turns on canEmailRequesters the way the app does. */
  const key = (allowed: boolean) => {
    const created = ws.createApiKey({ name: "cli", userId: OWNER, tokenHash: `hash_${++n}` }, OWNER);
    if (allowed) ws.setApiKeyEmailRequesters(created.id, true, PERSON);
    return created;
  };
  const viaKey = (keyId: string, via: "api" | "mcp" = "api"): Actor => ({
    userId: OWNER,
    via,
    apiKeyId: keyId,
    automationRuleId: null,
  });

  return { ws, db, frames, support, mail, ticket, replies, comment, commentCount, auditActions, key, viaKey };
}

describe("createComment with emailToRequester", () => {
  it("records the recipient on the comment and queues the reply in the requester's thread", async () => {
    const { ws, ticket, mail, replies, comment, auditActions } = await seeded();
    const taskId = ticket({ messageId: "first@clinic.example", task: { title: "Re: Printer jammed", description: "Help" } });
    // A follow-up in the same thread, so the reply answers the newest message.
    ws.ingestEmail(mail({ messageId: "second@clinic.example", referenceIds: ["first@clinic.example"] }), MAIL);

    const created = ws.createComment(comment(taskId, "Done, here it is: https://example.com/page", true), PERSON);
    expect(created).toMatchObject({ emailTo: "pat@clinic.example", emailStatus: "sending", via: "ui" });
    expect(ws.getTaskDetail(taskId).comments.find((c) => c.id === created.id)).toMatchObject({
      emailTo: "pat@clinic.example",
      emailStatus: "sending",
    });

    expect(replies()).toEqual([
      {
        kind: "email-reply",
        to: "pat@clinic.example",
        alias: "support",
        subject: "Re: Printer jammed",
        body: "Done, here it is: https://example.com/page",
        inReplyTo: "second@clinic.example",
        references: ["first@clinic.example", "second@clinic.example"],
        taskId,
        commentId: created.id,
      },
    ]);
    expect(auditActions()).toContain("comment.email_reply");
  });

  it("leaves an ordinary comment internal: nothing recorded, nothing queued", async () => {
    const { ws, ticket, replies, comment } = await seeded();
    const taskId = ticket();
    for (const flag of [undefined, false]) {
      const created = ws.createComment(comment(taskId, "Internal note", flag), PERSON);
      expect(created).toMatchObject({ emailTo: null, emailStatus: null });
    }
    expect(replies()).toEqual([]);
  });

  it("threads onto nothing when the ticket had no real Message-ID", async () => {
    const { ws, ticket, replies, comment } = await seeded();
    const taskId = ticket({ messageId: "sha256:abc123" });
    ws.createComment(comment(taskId, "Done", true), PERSON);
    expect(replies()[0]).toMatchObject({ inReplyTo: null, references: [] });
  });

  it("is sent with an api key an owner allowed, but never through MCP or a revoked key", async () => {
    const { ws, ticket, replies, comment, key, viaKey } = await seeded();
    const taskId = ticket();
    const allowed = key(true);

    const sent = ws.createComment(comment(taskId, "Done, from an API client", true), viaKey(allowed.id));
    expect(sent).toMatchObject({ emailTo: "pat@clinic.example", emailStatus: "sending", via: "api" });
    expect(replies()).toHaveLength(1);

    expect(() => ws.createComment(comment(taskId, "Done", true), viaKey(allowed.id, "mcp"))).toThrow(
      /allowed to email requesters/
    );
    ws.revokeApiKey(allowed.id, OWNER);
    expect(() => ws.createComment(comment(taskId, "Done", true), viaKey(allowed.id))).toThrow(
      /allowed to email requesters/
    );
    expect(replies()).toHaveLength(1);
  });

  it("is refused for an api key and for MCP, before anything is written", async () => {
    const { ws, ticket, replies, comment, commentCount } = await seeded();
    const taskId = ticket();
    for (const actor of [API_KEY, MCP]) {
      expect(() => ws.createComment(comment(taskId, "From an agent", true), actor)).toThrow(
        /allowed to email requesters/
      );
    }
    expect(commentCount()).toBe(0);
    expect(replies()).toEqual([]);
  });

  it("is refused while replies are turned off", async () => {
    const { ws, ticket, comment, commentCount } = await seeded({});
    const taskId = ticket();
    expect(() => ws.createComment(comment(taskId, "Done", true), PERSON)).toThrow(/turned off/);
    expect(commentCount()).toBe(0);
  });

  it("answers an unverified sender too, at the address the ticket came from", async () => {
    const { ws, ticket, replies, comment } = await seeded();
    const taskId = ticket({ authenticated: false, sender: "dana@clinic.example" });
    const created = ws.createComment(comment(taskId, "Done", true), PERSON);
    expect(created).toMatchObject({ emailTo: "dana@clinic.example", emailStatus: "sending" });
    expect(replies()).toEqual([expect.objectContaining({ to: "dana@clinic.example", commentId: created.id })]);
  });

  it("is refused for a task that never came in by email, and after its intake alias is removed", async () => {
    const { ws, ticket, support, comment, commentCount } = await seeded();
    const typed = ws.createTask(CreateTaskInput.parse({ listId: support.id, title: "Typed in" }), PERSON);
    expect(() => ws.createComment(comment(typed.id, "Done", true), PERSON)).toThrow(/no email sender to reply to/);

    const orphaned = ticket();
    ws.setEmailIntake(support.id, null, OWNER);
    expect(() => ws.createComment(comment(orphaned, "Done", true), PERSON)).toThrow(/no email sender to reply to/);
    expect(commentCount()).toBe(0);
  });
});

describe("TaskDetail.emailReplyTo", () => {
  it("names the requester, verified or not, and is null for a task that can't be answered", async () => {
    const { ws, ticket, support } = await seeded();
    expect(ws.getTaskDetail(ticket({ task: { title: "Fwd: Hours", description: "x" } }))).toMatchObject({
      emailReplyTo: "pat@clinic.example",
      emailReplySubject: "Re: Hours",
    });
    expect(ws.getTaskDetail(ticket({ authenticated: false, task: { title: "Hours", description: "x" } }))).toMatchObject({
      emailReplyTo: "pat@clinic.example",
      emailReplySubject: "Re: Hours",
    });
    const typed = ws.createTask(CreateTaskInput.parse({ listId: support.id, title: "Typed in" }), PERSON);
    expect(ws.getTaskDetail(typed.id)).toMatchObject({ emailReplyTo: null, emailReplySubject: null });
  });

  it("is null while replies are turned off", async () => {
    const { ws, ticket } = await seeded({ EMAIL_INTAKE_REPLY: "false" });
    expect(ws.getTaskDetail(ticket()).emailReplyTo).toBeNull();
  });
});

describe("markEmailReply", () => {
  it("moves a sending comment to sent once, broadcasting the update", async () => {
    const { ws, frames, ticket, comment, auditActions } = await seeded();
    const taskId = ticket();
    const created = ws.createComment(comment(taskId, "Done", true), PERSON);
    frames.length = 0;

    expect(ws.markEmailReply(created.id, "sent")).toEqual({ ok: true });
    expect(ws.getTaskDetail(taskId).comments[0]).toMatchObject({ emailStatus: "sent" });
    const broadcast = frames.flatMap((f) => (f.type === "deltas" ? f.deltas : []));
    expect(broadcast).toEqual([
      expect.objectContaining({
        entity: "comment",
        op: "update",
        id: created.id,
        data: expect.objectContaining({ taskId, emailStatus: "sent", emailTo: "pat@clinic.example" }),
      }),
    ]);
    expect(auditActions()).toContain("comment.email_status");

    // Settled: a late "failed" or a repeat can't move it again.
    expect(ws.markEmailReply(created.id, "failed")).toEqual({ ok: false });
    expect(ws.markEmailReply(created.id, "sent")).toEqual({ ok: false });
    expect(ws.getTaskDetail(taskId).comments[0]?.emailStatus).toBe("sent");
  });

  it("records a failure, and ignores internal and unknown comments", async () => {
    const { ws, ticket, comment } = await seeded();
    const taskId = ticket();
    const emailed = ws.createComment(comment(taskId, "Done", true), PERSON);
    const internal = ws.createComment(comment(taskId, "Note"), PERSON);

    expect(ws.markEmailReply(emailed.id, "failed")).toEqual({ ok: true });
    expect(ws.markEmailReply(internal.id, "sent")).toEqual({ ok: false });
    expect(ws.markEmailReply("cm_missing", "sent")).toEqual({ ok: false });
    const byId = new Map(ws.getTaskDetail(taskId).comments.map((c) => [c.id, c]));
    expect(byId.get(emailed.id)?.emailStatus).toBe("failed");
    expect(byId.get(internal.id)).toMatchObject({ emailTo: null, emailStatus: null });
  });
});

describe("setApiKeyEmailRequesters", () => {
  it("lets an owner allow and stop a key, and lists the setting", async () => {
    const { ws, key, auditActions } = await seeded();
    const created = key(false);
    expect(created.canEmailRequesters).toBe(false);

    expect(ws.setApiKeyEmailRequesters(created.id, true, PERSON).canEmailRequesters).toBe(true);
    expect(ws.listApiKeys().find((k) => k.id === created.id)?.canEmailRequesters).toBe(true);
    expect(ws.setApiKeyEmailRequesters(created.id, false, PERSON).canEmailRequesters).toBe(false);
    expect(ws.listApiKeys().find((k) => k.id === created.id)?.canEmailRequesters).toBe(false);
    expect(auditActions().filter((a) => a === "api_key.email_requesters")).toHaveLength(2);
  });

  it("works from an owner's api key, but never over MCP", async () => {
    const { ws, key, viaKey } = await seeded();
    const cli = key(false);
    expect(ws.setApiKeyEmailRequesters(cli.id, true, viaKey(cli.id)).canEmailRequesters).toBe(true);
    expect(() => ws.setApiKeyEmailRequesters(cli.id, false, viaKey(cli.id, "mcp"))).toThrow(/over MCP/);
    expect(ws.listApiKeys().find((k) => k.id === cli.id)?.canEmailRequesters).toBe(true);
  });

  it("can't be granted by a member, or to a revoked or unknown key", async () => {
    const { ws, key } = await seeded();
    const other = key(false);

    ws.upsertUser({ id: "us_member", email: "member@example.com", name: "Member", role: "member" }, OWNER);
    const member: Actor = { userId: "us_member", via: "ui", apiKeyId: null, automationRuleId: null };
    expect(() => ws.setApiKeyEmailRequesters(other.id, true, member)).toThrow(/owner or admin/);

    expect(() => ws.setApiKeyEmailRequesters("ak_missing", true, PERSON)).toThrow(/not found/);
    ws.revokeApiKey(other.id, OWNER);
    expect(() => ws.setApiKeyEmailRequesters(other.id, true, PERSON)).toThrow(/revoked/);
    expect(ws.listApiKeys().find((k) => k.id === other.id)?.canEmailRequesters).toBe(false);
  });
});
