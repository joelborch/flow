import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv, AuthContext, Env } from "../env.js";
import { ApiError, onError } from "../errors.js";
import {
  ATTACHMENT_SOURCE_HOSTS,
  assertAllowedAttachmentSource,
  importRoutes,
} from "./import.js";

const reject = (url: string): ApiError => {
  try {
    assertAllowedAttachmentSource(url);
  } catch (err) {
    return err as ApiError;
  }
  throw new Error(`expected ${url} to be rejected`);
};

describe("assertAllowedAttachmentSource", () => {
  it("accepts ClickUp CDN hosts over https", () => {
    expect(
      assertAllowedAttachmentSource("https://attachments.clickup.com/a/b.png").hostname
    ).toBe("attachments.clickup.com");
    expect(
      assertAllowedAttachmentSource("https://t123.clickup-attachments.com/x.pdf").hostname
    ).toBe("t123.clickup-attachments.com");
  });

  it("matches the host suffix case-insensitively", () => {
    expect(() =>
      assertAllowedAttachmentSource("https://ATTACHMENTS.ClickUp.com/a.png")
    ).not.toThrow();
  });

  it("refuses plain http, naming the allowlist", () => {
    const err = reject("http://attachments.clickup.com/a.png");
    expect(err.status).toBe(400);
    expect(err.message).toContain("must use https");
    for (const host of ATTACHMENT_SOURCE_HOSTS) expect(err.message).toContain(host);
  });

  it("refuses internal and metadata targets — the SSRF this guards against", () => {
    for (const url of [
      "https://localhost/secrets",
      "https://127.0.0.1/",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/internal",
    ]) {
      const err = reject(url);
      expect(err.status).toBe(400);
      expect(err.message).toContain("is not permitted");
    }
  });

  it("names the allowlist in the rejection so the caller can act on it", () => {
    const err = reject("https://evil.example/x");
    for (const host of ATTACHMENT_SOURCE_HOSTS) expect(err.message).toContain(host);
  });

  it("is not fooled by a lookalike host that merely contains the domain", () => {
    expect(() => assertAllowedAttachmentSource("https://evil-clickup.com/x")).toThrow();
    expect(() => assertAllowedAttachmentSource("https://clickup.com.evil.example/x")).toThrow();
    expect(() => assertAllowedAttachmentSource("https://notclickup.com/x")).toThrow();
  });

  it("is not fooled by userinfo pointing the real host elsewhere", () => {
    const err = reject("https://attachments.clickup.com@evil.example/x.png");
    expect(err.message).toContain("evil.example");
  });

  it("refuses non-http schemes outright", () => {
    expect(() => assertAllowedAttachmentSource("file:///etc/passwd")).toThrow();
    expect(() => assertAllowedAttachmentSource("data:text/plain,hi")).toThrow();
  });

  it("reports an unparseable URL as such", () => {
    expect(reject("not a url").message).toContain("is not a valid URL");
  });
});

describe("POST /import/attachments", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("deletes the R2 object when attachment metadata is rejected", async () => {
    const app = new Hono<AppEnv>();
    app.onError(onError);
    const auth = {
      user: { id: "us_owner", email: "owner@example.com", role: "owner" },
      actor: {
        userId: "us_owner",
        via: "api",
        apiKeyId: null,
        automationRuleId: null,
      },
      apiKey: null,
    } as AuthContext;
    app.use("*", async (c, next) => {
      c.set("auth", auth);
      await next();
    });
    app.route("/api", importRoutes);

    const createAttachment = vi.fn().mockRejectedValue(new Error("Task tk_missing not found."));
    const put = vi.fn().mockResolvedValue(null);
    const remove = vi.fn().mockResolvedValue(undefined);
    const env = {
      WORKSPACE: {
        idFromName: vi.fn().mockReturnValue({}),
        get: vi.fn().mockReturnValue({ createAttachment }),
      },
      ATTACHMENTS: { put, delete: remove },
    } as unknown as Env;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("abc", {
          status: 200,
          headers: { "content-length": "3", "content-type": "text/plain" },
        })
      )
    );

    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    const response = await app.fetch(
      new Request("https://flow.example/api/import/attachments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskId: "tk_missing",
          filename: "note.txt",
          mimeType: "text/plain",
          size: 3,
          sourceUrl: "https://attachments.clickup.com/note.txt",
        }),
      }),
      env,
      executionCtx
    );
    await Promise.all(pending);

    expect(response.status).toBe(404);
    expect(put).toHaveBeenCalledOnce();
    expect(createAttachment).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(expect.stringMatching(/^at\/tk_missing\/at_/));
  });
});
