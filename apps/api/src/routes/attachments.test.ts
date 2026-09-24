import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Attachment } from "@flow/shared";
import type { AppEnv, AuthContext, Env } from "../env.js";
import { onError } from "../errors.js";
import {
  ATTACHMENT_CSP,
  attachmentKey,
  attachmentRoutes,
  contentRangeHeader,
  isAllowedDriveLink,
  mimeEssence,
  parseRangeHeader,
  sanitizeFilename,
} from "./attachments.js";

const SIZE = 1000;

describe("parseRangeHeader", () => {
  it("treats an absent or empty header as no range", () => {
    expect(parseRangeHeader(undefined, SIZE)).toEqual({ kind: "none" });
    expect(parseRangeHeader(null, SIZE)).toEqual({ kind: "none" });
    expect(parseRangeHeader("   ", SIZE)).toEqual({ kind: "none" });
  });

  it("parses a closed range inclusively", () => {
    expect(parseRangeHeader("bytes=0-99", SIZE)).toEqual({ kind: "range", offset: 0, length: 100 });
    expect(parseRangeHeader("bytes=100-199", SIZE)).toEqual({
      kind: "range",
      offset: 100,
      length: 100,
    });
  });

  it("parses an open-ended range as everything from the offset", () => {
    expect(parseRangeHeader("bytes=500-", SIZE)).toEqual({
      kind: "range",
      offset: 500,
      length: 500,
    });
  });

  it("parses a suffix range as the last N bytes", () => {
    expect(parseRangeHeader("bytes=-100", SIZE)).toEqual({
      kind: "range",
      offset: 900,
      length: 100,
    });
  });

  it("clamps a suffix larger than the object to the whole object", () => {
    expect(parseRangeHeader("bytes=-5000", SIZE)).toEqual({
      kind: "range",
      offset: 0,
      length: SIZE,
    });
  });

  it("clamps an end past the last byte rather than failing", () => {
    expect(parseRangeHeader("bytes=990-99999", SIZE)).toEqual({
      kind: "range",
      offset: 990,
      length: 10,
    });
  });

  it("calls a start at or past the end unsatisfiable", () => {
    expect(parseRangeHeader("bytes=1000-", SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=5000-6000", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("calls an inverted range and a zero suffix unsatisfiable", () => {
    expect(parseRangeHeader("bytes=500-100", SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=-0", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("has nothing satisfiable in a zero-byte object", () => {
    expect(parseRangeHeader("bytes=0-10", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=-10", 0)).toEqual({ kind: "unsatisfiable" });
  });

  it("serves the whole object for multi-range and unknown units", () => {
    expect(parseRangeHeader("bytes=0-99,200-299", SIZE)).toEqual({ kind: "none" });
    expect(parseRangeHeader("items=0-99", SIZE)).toEqual({ kind: "none" });
    expect(parseRangeHeader("bytes=-", SIZE)).toEqual({ kind: "none" });
  });

  it("tolerates whitespace and casing", () => {
    expect(parseRangeHeader("Bytes = 0 - 9", SIZE)).toEqual({ kind: "range", offset: 0, length: 10 });
  });
});

describe("contentRangeHeader", () => {
  it("is null when R2 returned no range (a whole-object read)", () => {
    expect(contentRangeHeader(undefined, SIZE)).toBeNull();
  });

  it("builds an inclusive byte range from offset and length", () => {
    expect(contentRangeHeader({ offset: 0, length: 100 }, SIZE)).toBe("bytes 0-99/1000");
    expect(contentRangeHeader({ offset: 100, length: 100 }, SIZE)).toBe("bytes 100-199/1000");
  });

  it("fills in a missing length as everything after the offset", () => {
    expect(contentRangeHeader({ offset: 500 }, SIZE)).toBe("bytes 500-999/1000");
  });

  it("fills in a missing offset as the start of the object", () => {
    expect(contentRangeHeader({ length: 10 }, SIZE)).toBe("bytes 0-9/1000");
  });

  it("resolves a suffix range against the size", () => {
    expect(contentRangeHeader({ suffix: 100 }, SIZE)).toBe("bytes 900-999/1000");
    expect(contentRangeHeader({ suffix: 5000 }, SIZE)).toBe("bytes 0-999/1000");
  });

  it("round-trips a parsed range back to the header a 206 should carry", () => {
    const parsed = parseRangeHeader("bytes=250-749", SIZE);
    expect(parsed.kind).toBe("range");
    if (parsed.kind !== "range") return;
    expect(contentRangeHeader({ offset: parsed.offset, length: parsed.length }, SIZE)).toBe(
      "bytes 250-749/1000"
    );
  });
});

describe("sanitizeFilename", () => {
  it("strips path separators so a key cannot escape its prefix", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\alice\\report.pdf")).toBe("report.pdf");
  });

  it("falls back for names that would be empty or traversal-only", () => {
    expect(sanitizeFilename("")).toBe("upload.bin");
    expect(sanitizeFilename("..")).toBe("upload.bin");
  });

  it("is applied by attachmentKey", () => {
    expect(attachmentKey("tk_1", "at_1", "../evil.png")).toBe("at/tk_1/at_1/evil.png");
  });
});

describe("isAllowedDriveLink", () => {
  it("accepts only HTTPS Google Drive links", () => {
    expect(isAllowedDriveLink("https://drive.google.com/file/d/abc/view")).toBe(true);
    expect(isAllowedDriveLink("http://drive.google.com/file/d/abc/view")).toBe(false);
    expect(isAllowedDriveLink("https://drive.google.com.evil.test/file/d/abc/view")).toBe(false);
    expect(isAllowedDriveLink("not a url")).toBe(false);
  });
});

describe("mimeEssence", () => {
  it("drops parameters and lowercases", () => {
    expect(mimeEssence("Text/HTML; charset=utf-8")).toBe("text/html");
    expect(mimeEssence("image/svg+xml")).toBe("image/svg+xml");
  });

  it("is null for anything that is not a type/subtype pair", () => {
    expect(mimeEssence(undefined)).toBeNull();
    expect(mimeEssence("")).toBeNull();
    expect(mimeEssence("html")).toBeNull();
    expect(mimeEssence("text/html\r\nX-Evil: 1")).toBeNull();
  });
});

// Attachment bytes are user-controlled and served from the app's own origin,
// so an SVG or HTML upload opened by an admin would run script with the admin's
// session. These drive the real download route against a stubbed DO and R2.
describe("GET /api/attachments/:id — download headers", () => {
  const BYTES = new TextEncoder().encode("0123456789");

  const metaOf = (filename: string, mimeType: string): Attachment => ({
    id: "at_test",
    taskId: "tk_test",
    filename,
    r2Key: `at/tk_test/at_test/${filename}`,
    storageProvider: "r2",
    driveFileId: null,
    driveWebViewLink: null,
    driveDestination: null,
    migrationState: "r2",
    size: BYTES.byteLength,
    mimeType,
    uploadedBy: "us_member",
    createdAt: 1_700_000_000_000,
  });

  const auth: AuthContext = {
    user: {
      id: "us_admin",
      email: "admin@example.com",
      name: "admin",
      role: "admin",
      deactivated: false,
      createdAt: 1_700_000_000_000,
    },
    apiKey: null,
    actor: { userId: "us_admin", via: "ui", apiKeyId: null, automationRuleId: null },
  };

  /**
   * A stored object as a pre-fix upload left it: `inline` disposition and the
   * uploader's type in httpMetadata, which writeHttpMetadata() copies out.
   */
  function r2With(meta: Attachment, opts: { withBody?: boolean } = {}) {
    return {
      get: async (_key: string, options?: { range?: { offset: number; length: number } }) => {
        const range = options?.range;
        const slice = range ? BYTES.slice(range.offset, range.offset + range.length) : BYTES;
        return {
          size: BYTES.byteLength,
          httpEtag: '"etag-1"',
          range,
          writeHttpMetadata(headers: Headers) {
            headers.set("Content-Type", meta.mimeType);
            headers.set("Content-Disposition", `inline; filename="${meta.filename}"`);
          },
          ...(opts.withBody === false ? {} : { body: new Blob([slice]).stream() }),
        };
      },
    };
  }

  async function download(meta: Attachment, init: RequestInit = {}, opts?: { withBody?: boolean }) {
    const stub = {
      getAttachment: async () => meta,
      getTaskDetail: async () => ({ attachments: [meta] }),
    };
    const env = {
      WORKSPACE: { idFromName: () => ({}), get: () => stub },
      ATTACHMENTS: r2With(meta, opts),
    } as unknown as Env;
    const app = new Hono<AppEnv>();
    app.onError(onError);
    app.use("*", async (c, next) => {
      c.set("auth", auth);
      return next();
    });
    app.route("/api", attachmentRoutes);
    return app.request(`/api/attachments/${meta.id}`, init, env);
  }

  function expectLockedDown(res: Response) {
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe(ATTACHMENT_CSP);
    expect(ATTACHMENT_CSP).toContain("default-src 'none'");
    expect(ATTACHMENT_CSP).toMatch(/(^|; )sandbox($|;)/);
  }

  it("downloads an SVG rather than rendering it, overriding the stored inline", async () => {
    const res = await download(metaOf("evil.svg", "image/svg+xml"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="evil\.svg"/);
    expectLockedDown(res);
  });

  it("downloads an HTML file rather than rendering it", async () => {
    const res = await download(metaOf("evil.html", "text/html; charset=utf-8"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; /);
    expectLockedDown(res);
  });

  it("still shows a PNG inline, with the same lockdown headers", async () => {
    const res = await download(metaOf("shot.png", "image/png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Disposition")).toMatch(/^inline; filename="shot\.png"/);
    expectLockedDown(res);
    expect(await res.text()).toBe("0123456789");
  });

  it("downloads a PDF", async () => {
    const res = await download(metaOf("report.pdf", "application/pdf"));
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; /);
    expectLockedDown(res);
  });

  it("serves a malformed stored type as an opaque download", async () => {
    const res = await download(metaOf("x.bin", "not a mime type"));
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; /);
    expectLockedDown(res);
  });

  it("keeps the lockdown on a 206 partial response", async () => {
    const res = await download(metaOf("evil.svg", "image/svg+xml"), {
      headers: { Range: "bytes=0-3" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-3/10");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; /);
    expectLockedDown(res);
  });

  it("keeps the lockdown on a 304", async () => {
    const res = await download(
      metaOf("evil.svg", "image/svg+xml"),
      { headers: { "If-None-Match": '"etag-1"' } },
      { withBody: false }
    );
    expect(res.status).toBe(304);
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; /);
    expectLockedDown(res);
  });

  it("keeps the lockdown on a 416", async () => {
    const res = await download(metaOf("evil.svg", "image/svg+xml"), {
      headers: { Range: "bytes=500-" },
    });
    expect(res.status).toBe(416);
    expectLockedDown(res);
  });
});
