import { Hono } from "hono";
import { z } from "zod";
import type { ImportBatch, ImportResult } from "@flow/core";
import { requireAdmin } from "../auth.js";
import { workspace } from "../do.js";
import type { AppEnv } from "../env.js";
import { badRequest, parseOrThrow } from "../errors.js";
import { sanitizeFilename } from "./attachments.js";

// Import surface for the ClickUp migration (apps/importer). Admin-only.
// importBatch upserts by id-then-clickupId inside the DO and never fires
// automations or per-row broadcasts, so re-running a load is safe.
export const importRoutes = new Hono<AppEnv>();

importRoutes.get("/import/status", async (c) => {
  requireAdmin(c);
  return c.json({ ok: true });
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

importRoutes.post("/import/attachments", async (c) => {
  const auth = requireAdmin(c);
  const input = parseOrThrow(AttachmentImport, await c.req.json(), "attachment import");
  const sourceUrl = assertAllowedAttachmentSource(input.sourceUrl);

  const id = `at_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  // Same sanitiser as the interactive upload: a filename like `../../evil` must
  // not be able to steer the key out of its `at/<taskId>/<id>/` prefix.
  const r2Key = `at/${input.taskId}/${id}/${sanitizeFilename(input.filename)}`;

  // Redirects are followed as before: ClickUp's CDN hands off to object storage,
  // and the guard that matters is on the URL the admin supplied, not on where
  // ClickUp's own infrastructure sends us.
  const source = await fetch(sourceUrl.toString(), {
    signal: AbortSignal.timeout(60_000),
  });
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

  const attachment = await workspace(c.env).createAttachment(
    {
      id,
      taskId: input.taskId,
      filename: input.filename,
      r2Key,
      size: input.size,
      mimeType: input.mimeType,
    },
    { ...auth.actor, via: "import" }
  );
  return c.json(attachment);
});
