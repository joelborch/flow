import { Hono } from "hono";
import { z } from "zod";
import type { ImportBatch, ImportResult } from "@flow/core";
import { id, ID_PREFIX } from "@flow/core/id";
import { requireAdmin } from "../auth.js";
import { workspace } from "../do.js";
import type { AppEnv } from "../env.js";
import { badRequest, parseOrThrow } from "../errors.js";
import { sanitizeFilename } from "./attachments.js";

// Import surface for the ClickUp migration (apps/importer). Admin-only.
// importBatch upserts by id-then-clickupId inside the DO and never fires
// automations or per-row broadcasts, so re-running a load is safe.
export const importRoutes = new Hono<AppEnv>();

export const MAX_ATTACHMENT_REDIRECTS = 3;

importRoutes.get("/import/status", async (c) => {
  requireAdmin(c);
  return c.json({ ok: true });
});

// Manual backup trigger. Lives on the admin ops surface with import because
// both are owner-only maintenance endpoints, not workspace features.
importRoutes.post("/admin/backup", async (c) => {
  requireAdmin(c);
  const result = await workspace(c.env).runBackupNow();
  return c.json({ ok: true, ...result });
});

importRoutes.post("/import/batch", async (c) => {
  const auth = requireAdmin(c);
  const batch = (await c.req.json()) as ImportBatch;
  if (typeof batch !== "object" || batch === null) {
    throw badRequest("import batch must be a JSON object");
  }
  const result: ImportResult = await workspace(c.env).importBatch(batch, {
    ...auth.actor,
    via: "import",
  });
  return c.json(result);
});

const AttachmentImport = z.object({
  taskId: z.string().min(4),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  /** ClickUp CDN URL; the Worker fetches it so bytes never leave Cloudflare's
   * edge on the way in. */
  sourceUrl: z.string().url(),
  clickupAttachmentId: z.string().optional(),
});

/**
 * Hostname suffixes `sourceUrl` may point at.
 *
 * This route makes the Worker fetch a caller-supplied URL, which is a
 * server-side request forgery primitive: without a guard an admin token could
 * aim it at `http://localhost`, a Cloudflare metadata endpoint, or any internal
 * host, and the response body would be written into R2 and served back. The
 * importer only ever needs ClickUp's own CDN, so the allowlist is exactly that.
 */
export const ATTACHMENT_SOURCE_HOSTS = [".clickup.com", ".clickup-attachments.com"] as const;

/**
 * Parse `sourceUrl` and refuse anything that is not HTTPS on an allowlisted
 * host. Pure, and exported for tests.
 *
 * Suffix matching on the parsed hostname (never the raw string) is what makes
 * `https://attachments.clickup.com@evil.example/x` safe: the URL parser puts
 * `evil.example` in `hostname`, so the userinfo trick does not match.
 */
export function assertAllowedAttachmentSource(sourceUrl: string): URL {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw badRequest(`sourceUrl ${sourceUrl} is not a valid URL`);
  }
  const allowed = ATTACHMENT_SOURCE_HOSTS.join(", ");
  if (url.protocol !== "https:") {
    throw badRequest(
      `sourceUrl must use https (got "${url.protocol.replace(":", "")}"); ` +
        `attachment imports are only fetched from ${allowed}`
    );
  }
  const host = url.hostname.toLowerCase();
  if (!ATTACHMENT_SOURCE_HOSTS.some((suffix) => host.endsWith(suffix))) {
    throw badRequest(
      `sourceUrl host "${url.hostname}" is not permitted. ` +
        `Attachment imports may only be fetched from hosts ending in: ${allowed}`
    );
  }
  return url;
}

/**
 * Stream an attachment from the source URL. Handles ClickUp CDN's 302 handoff
 * to presigned object storage via an explicit manual redirect loop that enforces
 * HTTPS and caps total hops.
 */
export async function fetchAttachmentSource(initialUrl: URL, timeoutMs = 60_000): Promise<Response> {
  let url = initialUrl;
  for (let redirect = 0; ; redirect += 1) {
    const response = await fetch(url.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      if (redirect >= MAX_ATTACHMENT_REDIRECTS) {
        await response.body?.cancel().catch(() => undefined);
        throw badRequest("attachment source exceeded the redirect limit");
      }
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (location === null) {
        throw badRequest("attachment source redirect could not be resolved safely");
      }
      const nextUrl = new URL(location, url);
      if (nextUrl.protocol !== "https:") {
        throw badRequest(`attachment source redirected to non-HTTPS protocol: ${nextUrl.protocol}`);
      }
      url = nextUrl;
      continue;
    }
    return response;
  }
}

importRoutes.post("/import/attachments", async (c) => {
  const auth = requireAdmin(c);
  const input = parseOrThrow(AttachmentImport, await c.req.json(), "attachment import");
  const sourceUrl = assertAllowedAttachmentSource(input.sourceUrl);

  const attachmentId = id(ID_PREFIX.attachment);
  // Same sanitiser as the interactive upload: a filename like `../../evil` must
  // not be able to steer the key out of its `at/<taskId>/<id>/` prefix.
  const r2Key = `at/${input.taskId}/${attachmentId}/${sanitizeFilename(input.filename)}`;

  const source = await fetchAttachmentSource(sourceUrl);
  if (!source.ok || source.body === null) {
    throw badRequest(
      `could not fetch attachment source (${source.status}) from ${input.sourceUrl}`
    );
  }
  // R2 needs a known length to stream a put; the CDN often omits
  // Content-Length, so pin the stream to the size ClickUp reported.
  const sourceLength = Number(source.headers.get("content-length") ?? 0);
  let body: ReadableStream | ArrayBuffer = source.body;
  if (!Number.isInteger(sourceLength) || sourceLength <= 0) {
    const fixed = new FixedLengthStream(input.size);
    void source.body.pipeTo(fixed.writable);
    body = fixed.readable;
  }
  await c.env.ATTACHMENTS.put(r2Key, body, {
    httpMetadata: { contentType: input.mimeType },
  });

  try {
    const attachment = await workspace(c.env).createAttachment(
      {
        id: attachmentId,
        taskId: input.taskId,
        filename: input.filename,
        r2Key,
        size: input.size,
        mimeType: input.mimeType,
      },
      { ...auth.actor, via: "import" }
    );
    return c.json(attachment);
  } catch (err) {
    // Match the interactive upload route: if metadata rejects the import,
    // nothing references the object that just landed in R2.
    c.executionCtx.waitUntil(c.env.ATTACHMENTS.delete(r2Key).catch(() => undefined));
    throw err;
  }
});
