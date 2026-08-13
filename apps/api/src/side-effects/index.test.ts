import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebhookDeliveryError,
  deliverEmail,
  deliverWebhook,
  deliveryRetryDelay,
  handleDeadLetterBatch,
  handleSideEffectBatch,
  isRetryableWebhookStatus,
  markdownToHtml,
  parsePayload,
  renderEmailHtml,
} from "./index.js";
import type { Env } from "../env.js";
import type { WebhookPayload } from "@flow/shared";

describe("email side effects", () => {
  it("preserves to, cc, and bcc when parsing a queue message", () => {
    expect(
      parsePayload({
        kind: "email",
        to: ["to@example.com"],
        cc: ["cc@example.com"],
        bcc: ["bcc@example.com"],
        subject: "Subject",
        body: "Body",
        ruleId: "ar_1",
        taskId: "tk_1",
      })
    ).toEqual({
      kind: "email",
      to: ["to@example.com"],
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
      subject: "Subject",
      body: "Body",
      ruleId: "ar_1",
      taskId: "tk_1",
    });
  });

  it("accepts older queue messages that did not carry cc or bcc", () => {
    const parsed = parsePayload({
      kind: "email",
      to: ["to@example.com"],
      subject: "Subject",
      body: "Body",
      ruleId: "ar_1",
      taskId: "tk_1",
    });
    expect(parsed?.kind).toBe("email");
    if (parsed?.kind !== "email") throw new Error("expected email payload");
    expect(parsed.cc).toEqual([]);
    expect(parsed.bcc).toEqual([]);
  });

  it("fails closed: a typo'd EMAIL_DRY_RUN value keeps dry-run on instead of sending", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await deliverEmail(
      {
        kind: "email",
        to: ["to@example.com"],
        cc: [],
        bcc: [],
        subject: "Subject",
        body: "Body",
        ruleId: "ar_1",
        taskId: "tk_1",
      },
      { EMAIL_DRY_RUN: "True", SEND_EMAIL: { send } as unknown as SendEmail }
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("passes distinct recipient classes to the Cloudflare binding", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await deliverEmail(
      {
        kind: "email",
        to: ["to@example.com"],
        cc: ["cc@example.com"],
        bcc: ["bcc@example.com"],
        subject: "Subject",
        body: "Body",
        ruleId: "ar_1",
        taskId: "tk_1",
      },
      { EMAIL_DRY_RUN: "false", SEND_EMAIL: { send } as unknown as SendEmail }
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["to@example.com"],
        cc: ["cc@example.com"],
        bcc: ["bcc@example.com"],
      })
    );
  });

  it("sends multipart: plain-text markdown plus the branded HTML shell", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await deliverEmail(
      {
        kind: "email",
        to: ["client@example.com"],
        cc: [],
        bcc: [],
        subject: "New Task",
        body: "Task: **Fix the form**\n\nDescription:\nSee https://example.com/spec.",
        ruleId: "ar_2bLa2iMVYC6l",
        taskId: "tk_1",
      },
      {
        EMAIL_DRY_RUN: "false",
        APP_HOSTNAME: "flow.example.com",
        EMAIL_BRAND_NAME: "Acme Corp",
        SEND_EMAIL: { send } as unknown as SendEmail,
      }
    );
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0]?.[0] as { text: string; html: string };
    // Plain-text part is the untouched markdown body.
    expect(message.text).toBe("Task: **Fix the form**\n\nDescription:\nSee https://example.com/spec.");
    // HTML part: branded shell + rendered markdown + autolinked bare URL.
    expect(message.html).toContain("Acme Corp");
    expect(message.html).toContain("via Flow");
    expect(message.html).toContain("<strong>Fix the form</strong>");
    expect(message.html).toContain('<a href="https://example.com/spec"');
  });

  it("falls back to EMAIL_FROM_NAME, then \"Flow\", when no brand is configured", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await deliverEmail(
      {
        kind: "email",
        to: ["client@example.com"],
        cc: [],
        bcc: [],
        subject: "S",
        body: "Body.",
        ruleId: "ar_1",
        taskId: "tk_1",
      },
      {
        EMAIL_DRY_RUN: "false",
        APP_HOSTNAME: "flow.example.com",
        SEND_EMAIL: { send } as unknown as SendEmail,
      }
    );
    const html = (send.mock.calls[0]?.[0] as { html: string }).html;
    expect(html).toContain('style="font-size:16px;font-weight:600;color:#111827">Flow<');
  });

  it("gives automation emails an unlinked footer and no Flow URLs", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await deliverEmail(
      {
        kind: "email",
        to: ["client@example.com"],
        cc: [],
        bcc: [],
        subject: "S",
        body: "Plain body.",
        ruleId: "ar_1",
        taskId: "tk_1",
      },
      {
        EMAIL_DRY_RUN: "false",
        APP_HOSTNAME: "flow.example.com",
        SEND_EMAIL: { send } as unknown as SendEmail,
      }
    );
    const html = (send.mock.calls[0]?.[0] as { html: string }).html;
    expect(html).toContain("Sent via Flow");
    expect(html).not.toContain("flow.example.com");
  });

  it("gives internal notification emails a linked footer", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await deliverEmail(
      {
        kind: "email",
        to: ["member@example.com"],
        cc: [],
        bcc: [],
        subject: "You were assigned: X",
        body: "**Alice** assigned you to **X**.\n\n[Open the task](https://flow.example.com/t/tk_9)",
        ruleId: "notify:assigned_to_me",
        taskId: "tk_9",
      },
      {
        EMAIL_DRY_RUN: "false",
        APP_HOSTNAME: "flow.example.com",
        SEND_EMAIL: { send } as unknown as SendEmail,
      }
    );
    const html = (send.mock.calls[0]?.[0] as { html: string }).html;
    expect(html).toContain('href="https://flow.example.com"');
    expect(html).toContain("Sent by Flow");
    expect(html).toContain('<a href="https://flow.example.com/t/tk_9"');
  });
});

describe("markdownToHtml", () => {
  it("escapes HTML in user content before any transform", () => {
    const html = markdownToHtml('<script>alert("x")</script> & <img src=x onerror=y>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("renders markdown links, bold, italics, and inline code", () => {
    const html = markdownToHtml("See [the spec](https://example.com/a) in **bold** or *em* with `code`.");
    expect(html).toContain('<a href="https://example.com/a"');
    expect(html).toContain(">the spec</a>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain(">code</code>");
  });

  it("autolinks bare URLs without trailing punctuation", () => {
    const html = markdownToHtml("Go to https://example.com/page. Then stop.");
    expect(html).toContain('<a href="https://example.com/page"');
    expect(html).toContain(">https://example.com/page</a>.");
  });

  it("does not double-link URLs inside markdown links", () => {
    const html = markdownToHtml("[label](https://example.com/x)");
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("renders bullet and numbered lists and headings", () => {
    const html = markdownToHtml("# Title\n\n- one\n- two\n\n1. first\n2. second");
    expect(html).toContain("<h1");
    expect(html).toContain("<ul");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<ol");
    expect(html).toContain("<li>second</li>");
  });

  it("renders > quoted lines as a blockquote (comment notifications)", () => {
    const html = markdownToHtml("> first line\n> second line");
    expect(html).toContain("<blockquote");
    expect(html).toContain("first line<br />second line");
  });
});

describe("renderEmailHtml", () => {
  it("wraps content in the 600px shell with header and footer", () => {
    const html = renderEmailHtml("Hello.", {
      audience: "external",
      appHostname: "flow.example.com",
      brandName: "Acme Corp",
    });
    expect(html).toContain("max-width:600px");
    expect(html).toContain("Acme Corp");
    expect(html).toContain("via Flow");
    expect(html).toContain("Sent via Acme Corp");
    expect(html).not.toContain("href");
    expect(html).not.toContain("<img");
  });
});

describe("Gleap screenshot side effects", () => {
  it("recognizes a bounded screenshot reconciliation message", () => {
    expect(
      parsePayload({
        kind: "gleap-screenshot",
        taskId: "tk_71",
        ticketId: "ticket-71",
        projectId: "project-delta",
        screenshotUrl: null,
      })
    ).toEqual({
      kind: "gleap-screenshot",
      taskId: "tk_71",
      ticketId: "ticket-71",
      projectId: "project-delta",
      screenshotUrl: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Retry classification, backoff, and delivery-failure write-back
// (hardening-round-2). handleSideEffectBatch/handleDeadLetterBatch call
// workspace(env) — env.WORKSPACE stands in for the DO namespace binding, its
// `.get()` returning a plain object with a `recordDeliveryFailure` mock, the
// same shape `workspace()`'s Proxy calls through to.
// ---------------------------------------------------------------------------

function fakeEnv(recordDeliveryFailure = vi.fn().mockResolvedValue({ ok: true })): {
  env: Env;
  recordDeliveryFailure: typeof recordDeliveryFailure;
} {
  const stub = { recordDeliveryFailure };
  const env = {
    EMAIL_DRY_RUN: "true",
    APP_HOSTNAME: "flow.example.com",
    WORKSPACE: {
      idFromName: () => "id_main",
      get: () => stub,
    },
  } as unknown as Env;
  return { env, recordDeliveryFailure };
}

function fakeMessage(body: unknown, attempts = 1) {
  return {
    id: "msg_1",
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function fakeBatch(messages: ReturnType<typeof fakeMessage>[], queue = "flow-side-effects") {
  return { queue, messages } as unknown as MessageBatch;
}

describe("isRetryableWebhookStatus", () => {
  it("classifies retryable vs. permanent statuses", () => {
    const table: Array<[number, boolean]> = [
      [408, true],
      [429, true],
      [500, true],
      [502, true],
      [503, true],
      [400, false],
      [401, false],
      [403, false],
      [404, false],
      [410, false],
      [422, false],
    ];
    for (const [status, retryable] of table) {
      expect(isRetryableWebhookStatus(status)).toBe(retryable);
    }
  });
});

describe("deliveryRetryDelay", () => {
  it("doubles from 30s and caps at 1 hour", () => {
    expect(deliveryRetryDelay(1)).toBe(30);
    expect(deliveryRetryDelay(2)).toBe(60);
    expect(deliveryRetryDelay(3)).toBe(120);
    expect(deliveryRetryDelay(4)).toBe(240);
    expect(deliveryRetryDelay(10)).toBe(3_600);
  });
});

describe("deliverWebhook classification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const payload = {
    kind: "webhook" as const,
    url: "https://example.com/hook",
    secret: null,
    body: { event: "task.updated" } as unknown as WebhookPayload,
    ruleId: "ar_1",
    taskId: "tk_1",
  };

  it("marks a 410 as permanent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("gone", { status: 410 }))
    );
    await expect(deliverWebhook(payload)).rejects.toMatchObject({
      retryable: false,
      status: 410,
    });
  });

  it("marks a 429 as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("slow down", { status: 429 }))
    );
    await expect(deliverWebhook(payload)).rejects.toMatchObject({
      retryable: true,
      status: 429,
    });
  });

  it("marks a 500 as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 500 }))
    );
    await expect(deliverWebhook(payload)).rejects.toMatchObject({
      retryable: true,
      status: 500,
    });
  });

  it("marks a network failure as retryable with no status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );
    const err = await deliverWebhook(payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookDeliveryError);
    expect((err as WebhookDeliveryError).retryable).toBe(true);
    expect((err as WebhookDeliveryError).status).toBeUndefined();
  });
});

describe("handleSideEffectBatch: retry vs. permanent failure", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("acks a permanent webhook failure and records it, without retrying", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unprocessable", { status: 422 }))
    );
    const { env, recordDeliveryFailure } = fakeEnv();
    const msg = fakeMessage(
      {
        kind: "webhook",
        url: "https://example.com/hook",
        body: { event: "task.updated" },
        ruleId: "ar_1",
        taskId: "tk_1",
      },
      3
    );

    await handleSideEffectBatch(fakeBatch([msg]), env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(recordDeliveryFailure).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: "ar_1", taskId: "tk_1", kind: "webhook" })
    );
  });

  it("retries a transient webhook failure with backoff, without recording", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 503 }))
    );
    const { env, recordDeliveryFailure } = fakeEnv();
    const msg = fakeMessage(
      {
        kind: "webhook",
        url: "https://example.com/hook",
        body: { event: "task.updated" },
        ruleId: "ar_1",
        taskId: "tk_1",
      },
      2
    );

    await handleSideEffectBatch(fakeBatch([msg]), env);

    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: deliveryRetryDelay(2) });
    expect(recordDeliveryFailure).not.toHaveBeenCalled();
  });

  it("retries an email failure with backoff and never records it directly", async () => {
    const { env, recordDeliveryFailure } = fakeEnv();
    const msg = fakeMessage(
      {
        kind: "email",
        to: ["client@example.com"],
        subject: "S",
        body: "B",
        ruleId: "ar_2",
        taskId: "tk_2",
      },
      4
    );
    // EMAIL_DRY_RUN is "true" in fakeEnv, so force a failure by flipping it
    // off without a SEND_EMAIL binding — deliverEmail throws in that case.
    (env as unknown as { EMAIL_DRY_RUN: string }).EMAIL_DRY_RUN = "false";

    await handleSideEffectBatch(fakeBatch([msg]), env);

    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: deliveryRetryDelay(4) });
    expect(recordDeliveryFailure).not.toHaveBeenCalled();
  });
});

describe("handleDeadLetterBatch", () => {
  it("logs, records the failure, and always acks", async () => {
    const { env, recordDeliveryFailure } = fakeEnv();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const msg = fakeMessage(
      {
        kind: "webhook",
        url: "https://example.com/hook",
        body: { event: "task.updated" },
        ruleId: "ar_3",
        taskId: "tk_3",
      },
      5
    );

    await handleDeadLetterBatch(fakeBatch([msg], "flow-dlq"), env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(recordDeliveryFailure).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: "ar_3", taskId: "tk_3", kind: "webhook" })
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("flow.dlq"));
    errorSpy.mockRestore();
  });

  it("still acks and logs an unparseable message, without recording", async () => {
    const { env, recordDeliveryFailure } = fakeEnv();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const msg = fakeMessage({ garbage: true }, 5);

    await handleDeadLetterBatch(fakeBatch([msg], "flow-dlq"), env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(recordDeliveryFailure).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("never throws even if the write-back RPC rejects", async () => {
    const { env } = fakeEnv(vi.fn().mockRejectedValue(new Error("DO unreachable")));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const msg = fakeMessage(
      {
        kind: "email",
        to: ["client@example.com"],
        subject: "S",
        body: "B",
        ruleId: "ar_4",
        taskId: "tk_4",
      },
      5
    );

    await expect(handleDeadLetterBatch(fakeBatch([msg], "flow-dlq"), env)).resolves.toBeUndefined();
    expect(msg.ack).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
});
