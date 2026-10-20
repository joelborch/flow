import { afterEach, describe, expect, it, vi } from "vitest";
import type { SideEffectPayload } from "@flow/core/automation";
import {
  DEFAULT_EMAIL_FROM,
  deliverEmailReply,
  handleDeadLetterBatch,
  handleSideEffectBatch,
  parsePayload,
} from "./index.js";
import type { Env } from "../env.js";

// ---------------------------------------------------------------------------
// Emailed comments ("email-reply" queue messages): parsing, the send itself
// (sender, Reply-To back onto the intake, threading headers and their
// fallback), and the "sent"/"failed" report back to the card, which must never
// turn into a retry that would email the requester twice.
// ---------------------------------------------------------------------------

type Reply = Extract<SideEffectPayload, { kind: "email-reply" }>;

function reply(over: Partial<Reply> = {}): Reply {
  return {
    kind: "email-reply",
    to: "pat@clinic.example",
    alias: "support",
    subject: "Re: Printer jammed",
    body: "Done, here it is: https://example.com/page",
    inReplyTo: "second@clinic.example",
    references: ["first@clinic.example", "second@clinic.example"],
    taskId: "tk_1",
    commentId: "cm_1",
    ...over,
  };
}

function liveEnv(send = vi.fn().mockResolvedValue(undefined), over: Record<string, unknown> = {}) {
  return {
    send,
    env: {
      EMAIL_DRY_RUN: "false",
      APP_HOSTNAME: "flow.example.com",
      EMAIL_INTAKE_DOMAIN: "help.example.com",
      SEND_EMAIL: { send },
      ...over,
    },
  };
}

/** env.WORKSPACE stands in for the DO namespace; its stub carries markEmailReply. */
function queueEnv(send = vi.fn().mockResolvedValue(undefined), markEmailReply = vi.fn().mockResolvedValue({ ok: true })) {
  const stub = { markEmailReply, recordDeliveryFailure: vi.fn().mockResolvedValue({ ok: true }) };
  const env = {
    ...liveEnv(send).env,
    WORKSPACE: { idFromName: () => "id_main", get: () => stub },
  } as unknown as Env;
  return { env, send, markEmailReply };
}

function fakeMessage(body: unknown, attempts = 1) {
  return { id: "msg_1", body, attempts, ack: vi.fn(), retry: vi.fn() };
}

function fakeBatch(messages: ReturnType<typeof fakeMessage>[], queue = "flow-side-effects") {
  return { queue, messages } as unknown as MessageBatch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parsePayload: email-reply", () => {
  it("round-trips a queued reply", () => {
    expect(parsePayload(JSON.parse(JSON.stringify(reply())))).toEqual(reply());
  });

  it("drops a message missing its recipient, alias, comment or task", () => {
    for (const missing of ["to", "alias", "commentId", "taskId"] as const) {
      const body: Record<string, unknown> = { ...reply() };
      delete body[missing];
      expect(parsePayload(body)).toBeNull();
    }
  });
});

describe("deliverEmailReply", () => {
  it("sends the comment as the body, from the configured sender, with Reply-To on the intake and the thread's headers", async () => {
    const { env, send } = liveEnv();
    await deliverEmailReply(reply(), env);
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0]![0];
    expect(message).toMatchObject({
      from: DEFAULT_EMAIL_FROM,
      to: "pat@clinic.example",
      replyTo: "support@help.example.com",
      subject: "Re: Printer jammed",
      text: "Done, here it is: https://example.com/page",
      headers: {
        "In-Reply-To": "<second@clinic.example>",
        References: "<first@clinic.example> <second@clinic.example>",
      },
    });
    expect(message.html).toContain("https://example.com/page");
    // External shell: nothing links back into Flow.
    expect(message.html).not.toContain("flow.example.com");
  });

  it("resends without the threading headers when the binding refuses them", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("bad header"), { code: "E_HEADER_NOT_ALLOWED" }))
      .mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env } = liveEnv(send);
    await deliverEmailReply(reply(), env);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).not.toHaveProperty("headers");
    expect(warn).toHaveBeenCalled();
  });

  it("sends without headers when the ticket had no real Message-ID", async () => {
    const { env, send } = liveEnv();
    await deliverEmailReply(reply({ inReplyTo: null, references: [] }), env);
    expect(send.mock.calls[0]![0]).not.toHaveProperty("headers");
  });

  it("throws rather than send a reply with nowhere to come back to", async () => {
    const { env, send } = liveEnv(undefined, { EMAIL_INTAKE_DOMAIN: undefined });
    await expect(deliverEmailReply(reply(), env)).rejects.toThrow(/EMAIL_INTAKE_DOMAIN/);
    expect(send).not.toHaveBeenCalled();
  });

  it("only logs in dry run", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { env, send } = liveEnv(undefined, { EMAIL_DRY_RUN: "true" });
    await deliverEmailReply(reply(), env);
    expect(send).not.toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0]).toContain("would send email reply");
  });
});

describe("handleSideEffectBatch: email-reply", () => {
  it("marks the comment sent once the mail service took it", async () => {
    const { env, send, markEmailReply } = queueEnv();
    const msg = fakeMessage(reply());
    await handleSideEffectBatch(fakeBatch([msg]), env);
    expect(send).toHaveBeenCalledTimes(1);
    expect(markEmailReply).toHaveBeenCalledWith("cm_1", "sent");
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("acks even when the sent report fails, so the requester is never emailed twice", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { env, send } = queueEnv(undefined, vi.fn().mockRejectedValue(new Error("DO unavailable")));
    const msg = fakeMessage(reply());
    await handleSideEffectBatch(fakeBatch([msg]), env);
    expect(send).toHaveBeenCalledTimes(1);
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it("retries a failed send without reporting anything yet", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { env, markEmailReply } = queueEnv(vi.fn().mockRejectedValue(new Error("E_RATE_LIMIT")));
    const msg = fakeMessage(reply(), 2);
    await handleSideEffectBatch(fakeBatch([msg]), env);
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(markEmailReply).not.toHaveBeenCalled();
  });
});

describe("handleDeadLetterBatch: email-reply", () => {
  it("marks the comment failed once retries are exhausted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { env, markEmailReply } = queueEnv();
    const msg = fakeMessage(reply(), 6);
    await handleDeadLetterBatch(fakeBatch([msg], "flow-dlq"), env);
    expect(markEmailReply).toHaveBeenCalledWith("cm_1", "failed");
    expect(msg.ack).toHaveBeenCalled();
  });
});
