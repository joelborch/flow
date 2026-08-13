import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "@flow/shared";
import type { Env } from "./env.js";

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  resolveInboundActor: vi.fn(),
}));

vi.mock("./do.js", () => ({ workspace: mocks.workspace }));
vi.mock("./auth.js", () => ({ resolveInboundActor: mocks.resolveInboundActor }));

import {
  assertAllowedGleapAssetUrl,
  gleapProjectToken,
  gleapRetryDelay,
  parseGleapScreenshotJob,
  reconcileGleapScreenshot,
  type GleapScreenshotJob,
} from "./gleap-screenshot.js";

const job: GleapScreenshotJob = {
  kind: "gleap-screenshot",
  taskId: "tk_adam",
  ticketId: "ticket-71",
  projectId: "project-adam",
  screenshotUrl: "https://storage.gleap.io/screenshots/ticket-71.jpg",
};

describe("Gleap screenshot queue payload", () => {
  it("accepts a direct screenshot without a project id", () => {
    expect(parseGleapScreenshotJob({ ...job, projectId: "" })).toEqual({ ...job, projectId: "" });
  });

  it("requires a project id when the job must poll the ticket API", () => {
    expect(parseGleapScreenshotJob({ ...job, projectId: "", screenshotUrl: null })).toBeNull();
  });

  it("uses bounded retry delays", () => {
    expect([1, 2, 3, 4, 99].map(gleapRetryDelay)).toEqual([10, 30, 60, 120, 300]);
  });
});

describe("Gleap project token selection", () => {
  const configured = JSON.stringify({
    "project-adam": "adam-token",
    "project-alpha": "alpha-token",
  });

  it("selects only the token for the exact project id", () => {
    expect(gleapProjectToken("project-adam", configured)).toBe("adam-token");
    expect(gleapProjectToken("project-alpha", configured)).toBe("alpha-token");
    expect(gleapProjectToken("project-beta", configured)).toBeNull();
    expect(gleapProjectToken("project", configured)).toBeNull();
  });

  it("fails closed for a missing, malformed, non-object, or invalid map", () => {
    expect(gleapProjectToken("project-adam")).toBeNull();
    expect(gleapProjectToken("project-adam", "not-json")).toBeNull();
    expect(gleapProjectToken("project-adam", "[]")).toBeNull();
    expect(gleapProjectToken("project-adam", '{"project-adam":""}')).toBeNull();
    expect(
      gleapProjectToken("project-adam", '{"project-adam":"adam-token","other":7}')
    ).toBeNull();
  });
});

describe("Gleap screenshot URL safety", () => {
  const hosts = [".gleap.io", "cdn.example.com"];

  it("allows exact and subdomain matches", () => {
    expect(assertAllowedGleapAssetUrl("https://gleap.io/x.jpg", hosts).hostname).toBe("gleap.io");
    expect(assertAllowedGleapAssetUrl("https://storage.gleap.io/x.jpg", hosts).hostname).toBe(
      "storage.gleap.io"
    );
    expect(assertAllowedGleapAssetUrl("https://cdn.example.com/x.jpg", hosts).hostname).toBe(
      "cdn.example.com"
    );
  });

  it("rejects userinfo, insecure URLs, suffix tricks, and unknown hosts", () => {
    expect(() => assertAllowedGleapAssetUrl("http://storage.gleap.io/x.jpg", hosts)).toThrow(
      /must use HTTPS/
    );
    expect(() =>
      assertAllowedGleapAssetUrl("https://gleap.io@evil.example/x.jpg", hosts)
    ).toThrow(/user information/);
    expect(() => assertAllowedGleapAssetUrl("https://notgleap.io/x.jpg", hosts)).toThrow(
      /not allowlisted/
    );
    expect(() => assertAllowedGleapAssetUrl("https://evil.example/x.jpg", hosts)).toThrow(
      /not allowlisted/
    );
  });
});

describe("Gleap screenshot reconciliation", () => {
  const put = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(undefined);
  const getTaskDetail = vi.fn();
  const createAttachment = vi.fn();
  const fetcher = vi.fn();
  const attachmentBucket: Env["ATTACHMENTS"] = {
    head: vi.fn(),
    get: vi.fn(),
    put,
    delete: remove,
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
    list: vi.fn(),
  };
  const env: Env = {
    WORKSPACE: {} as Env["WORKSPACE"],
    ATTACHMENTS: attachmentBucket,
    SIDE_EFFECTS: {} as Env["SIDE_EFFECTS"],
    ASSETS: {} as Env["ASSETS"],
    EMAIL_DRY_RUN: "true",
    APP_HOSTNAME: "flow.example.com",
    ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    ACCESS_AUD: "test-audience",
    OWNER_EMAIL: "owner@example.com",
    GLEAP_ATTACHMENT_HOSTS: ".gleap.io",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getTaskDetail.mockResolvedValue({ attachments: [] });
    createAttachment.mockImplementation((input: Record<string, unknown>) => ({
      ...input,
      storageProvider: "r2",
      driveFileId: null,
      driveWebViewLink: null,
      driveDestination: null,
      migrationState: "r2",
      uploadedBy: "us_gleap",
      createdAt: 1,
    }));
    mocks.workspace.mockReturnValue({ getTaskDetail, createAttachment });
    mocks.resolveInboundActor.mockResolvedValue({
      actor: {
        userId: "us_gleap",
        via: "webhook",
        apiKeyId: null,
        automationRuleId: null,
      },
    });
    fetcher.mockResolvedValue(
      new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        headers: { "content-type": "image/jpeg", "content-length": "3" },
      })
    );
  });

  it("stores a rendered screenshot as an R2 attachment", async () => {
    const result = await reconcileGleapScreenshot(job, env, fetcher);
    expect(result.status).toBe("attached");
    expect(fetcher).toHaveBeenCalledWith(
      job.screenshotUrl,
      expect.objectContaining({ redirect: "manual" })
    );
    expect(put).toHaveBeenCalledOnce();
    expect(createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "tk_adam",
        filename: "gleap-ticket-71.jpg",
        size: 3,
        mimeType: "image/jpeg",
      }),
      expect.objectContaining({ via: "webhook" })
    );
  });

  it("revalidates redirects instead of following a screenshot URL to an unknown host", async () => {
    fetcher.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/stolen.jpg" },
      })
    );
    await expect(reconcileGleapScreenshot(job, env, fetcher)).rejects.toThrow(/not allowlisted/);
    expect(put).not.toHaveBeenCalled();
    expect(createAttachment).not.toHaveBeenCalled();
  });

  it("does not fetch or store the same screenshot twice", async () => {
    const first = await reconcileGleapScreenshot(job, env, fetcher);
    expect(first.status).toBe("attached");
    if (first.status !== "attached") throw new Error("expected attached result");
    const attachment: Attachment = first.attachment;
    getTaskDetail.mockResolvedValue({ attachments: [attachment] });

    const second = await reconcileGleapScreenshot(job, env, fetcher);
    expect(second).toEqual({ status: "already-attached", attachment });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
    expect(createAttachment).toHaveBeenCalledOnce();
  });

  it("polls Gleap and reports not-ready without touching attachment storage", async () => {
    const pollingEnv = {
      ...env,
      GLEAP_PROJECT_TOKENS_JSON: '{"project-adam":"development-token"}',
    } as Env;
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ generatingScreenshot: true, screenshotUrl: "" }), {
        headers: { "content-type": "application/json" },
      })
    );

    await expect(
      reconcileGleapScreenshot({ ...job, screenshotUrl: null }, pollingEnv, fetcher)
    ).resolves.toEqual({ status: "not-ready" });
    expect(put).not.toHaveBeenCalled();
    expect(createAttachment).not.toHaveBeenCalled();
  });

  it("polls Gleap and attaches the image once rendering is complete", async () => {
    const pollingEnv = {
      ...env,
      GLEAP_PROJECT_TOKENS_JSON: '{"project-adam":"development-token"}',
    } as Env;
    fetcher
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            generatingScreenshot: false,
            screenshotLive: true,
            screenshotUrl: job.screenshotUrl,
          }),
          { headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          headers: { "content-type": "image/jpeg", "content-length": "3" },
        })
      );

    await expect(
      reconcileGleapScreenshot({ ...job, screenshotUrl: null }, pollingEnv, fetcher)
    ).resolves.toMatchObject({ status: "attached" });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://api.gleap.io/v3/tickets/ticket-71",
      expect.objectContaining({
        headers: { Authorization: "Bearer development-token", project: "project-adam" },
        redirect: "manual",
      })
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      job.screenshotUrl,
      expect.objectContaining({ redirect: "manual" })
    );
  });

  it("rejects redirects from the Gleap ticket API", async () => {
    const pollingEnv = {
      ...env,
      GLEAP_PROJECT_TOKENS_JSON: '{"project-adam":"development-token"}',
    } as Env;
    fetcher.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/ticket-71" },
      })
    );

    await expect(
      reconcileGleapScreenshot({ ...job, screenshotUrl: null }, pollingEnv, fetcher)
    ).rejects.toThrow("Gleap ticket lookup redirected unexpectedly");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
  });

  it("does not poll with a token belonging to another project", async () => {
    const pollingEnv = {
      ...env,
      GLEAP_PROJECT_TOKENS_JSON: '{"project-alpha":"alpha-token"}',
    } as Env;

    await expect(
      reconcileGleapScreenshot({ ...job, screenshotUrl: null }, pollingEnv, fetcher)
    ).rejects.toThrow(/not configured for project project-adam/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
