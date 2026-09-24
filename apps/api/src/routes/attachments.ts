/// <reference types="@cloudflare/workers-types" />
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Attachment } from "@flow/shared";
import { Id } from "@flow/shared";
import { requireAdmin, requireAuth } from "../auth.js";
import { workspace } from "../do.js";
import type { AppEnv } from "../env.js";
import { ApiError, badRequest, notFound, parseOrThrow, readJson, tooLarge } from "../errors.js";

export const attachmentRoutes = new Hono<AppEnv>();

/** Hard ceiling per file. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MB

const DEFAULT_MIME = "application/octet-stream";

/**
 * The only types a download is served `inline`: raster images, which cannot
 * carry script. Downloads come from the app's own origin, so anything a browser
 * would render as an active document — SVG and HTML above all — would run with
 * the viewer's session (an admin opening a member's upload could be made to mint
 * an api key). Everything else is `attachment`. PDF stays off the list because
 * viewer behaviour under the sandbox CSP below varies by browser.
 *
 * apps/web/src/task/Attachments.tsx mirrors this list to decide which links open
 * in a tab and which download.
 */
export const INLINE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);

/**
 * Sent on every response that carries stored bytes. `sandbox` gives the
 * document an opaque origin with scripts disabled even if a browser does render
 * it; images and inline styles are allowed so an SVG `<img>` thumbnail still
 * draws.
 */
export const ATTACHMENT_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

const MIME_ESSENCE_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

/** Lowercased `type/subtype` with parameters dropped, or null if malformed. */
export function mimeEssence(raw: string | null | undefined): string | null {
  const essence = (raw ?? "").split(";", 1)[0]!.trim().toLowerCase();
  return MIME_ESSENCE_RE.test(essence) ? essence : null;
}

/**
 * The headers that decide how a browser treats attachment bytes. Applied after
 * `writeHttpMetadata()`, whose stored disposition (every pre-fix upload says
 * `inline`) and uploader-supplied type must never win.
 */
export function applyDownloadHeaders(headers: Headers, mimeType: string, filename: string): void {
  headers.set("Content-Type", mimeEssence(mimeType) ?? DEFAULT_MIME);
  headers.set("Content-Disposition", contentDisposition(filename, mimeType));
  applyLockdownHeaders(headers);
}

function applyLockdownHeaders(headers: Headers): void {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", ATTACHMENT_CSP);
}

export function isAllowedDriveLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "drive.google.com";
  } catch {
    return false;
  }
}

const AttachmentStorageBody = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("finalize_drive"),
      driveFileId: z.string().min(1).max(200),
      driveWebViewLink: z.string().refine(isAllowedDriveLink, "must be an HTTPS drive.google.com link"),
      driveDestination: z.enum(["shared", "private"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("cleanup_r2"),
      driveFileId: z.string().min(1).max(200),
      confirmR2Key: z.string().min(1).max(1000),
    })
    .strict(),
]);

/**
 * Strip anything that could escape the intended R2 prefix or confuse a
 * Content-Disposition header. The original name is kept in DO metadata.
 */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/["\\]/g, "")
    .trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "upload.bin" : cleaned.slice(0, 200);
}

/** R2 key layout, per the spec: at/<taskId>/<attachmentId>/<filename>. */
export function attachmentKey(taskId: string, attachmentId: string, filename: string): string {
  return `at/${taskId}/${attachmentId}/${sanitizeFilename(filename)}`;
}

/**
 * Upload. The body is the raw file bytes, streamed straight into R2 — never
 * buffered, so a 100 MB upload does not touch the Worker's memory limit.
 * Filename comes from `?filename=` or the X-Filename header.
 *
 * R2 first, metadata second: a stray R2 object with no DO row is harmless
 * garbage, whereas a metadata row pointing at a missing object is a broken link
 * in the UI.
 */
attachmentRoutes.post("/tasks/:taskId/attachments", async (c) => {
  const auth = requireAuth(c);
  const taskId = parseOrThrow(Id, c.req.param("taskId"), "taskId");

  // Also the permission check: a task in a private space the caller cannot see
  // throws here, before a single byte reaches R2.
  const detail = await workspace(c.env).getTaskDetail(taskId, auth.user.id);
  if (!detail) throw notFound(`no task ${taskId}`);

  const filename = sanitizeFilename(
    c.req.query("filename") ?? c.req.header("X-Filename") ?? "upload.bin"
  );

  const lengthHeader = c.req.header("Content-Length");
  if (!lengthHeader) {
    throw badRequest(
      "Content-Length is required when uploading an attachment (send the raw file bytes as the request body)"
    );
  }
  const size = Number(lengthHeader);
  if (!Number.isInteger(size) || size < 0) {
    throw badRequest(`Content-Length ${lengthHeader} is not a valid byte count`);
  }
  if (size === 0) throw badRequest("attachment body is empty");
  if (size > MAX_ATTACHMENT_BYTES) {
    throw tooLarge(
      `attachment is ${size} bytes; the limit is ${MAX_ATTACHMENT_BYTES} bytes (100 MB)`
    );
  }

  const body = c.req.raw.body;
  if (!body) throw badRequest("attachment request has no body");

  // Uploader-controlled, so it is only ever advisory: the download path decides
  // disposition from an allowlist and pins nosniff + a sandbox CSP.
  const mimeType = mimeEssence(c.req.header("Content-Type")) ?? DEFAULT_MIME;
  // The R2 key has to exist before the upload, so the id is minted here and
  // passed to the DO. packages/core generates its own id today and ignores this,
  // which is harmless — the key then embeds this upload id rather than the
  // attachment id — and becomes exact the moment it honours `input.id`.
  const attachmentId = `at_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const r2Key = attachmentKey(taskId, attachmentId, filename);

  await c.env.ATTACHMENTS.put(r2Key, body, {
    httpMetadata: {
      contentType: mimeType,
      contentDisposition: contentDisposition(filename, mimeType),
    },
    customMetadata: { taskId, attachmentId, uploadedBy: auth.user.id },
  });

  try {
    const attachment = await workspace(c.env).createAttachment(
      { id: attachmentId, taskId, filename, r2Key, size, mimeType },
      auth.actor
    );
    return c.json(attachment, 201);
  } catch (err) {
    // Metadata failed, so nothing references this object — clean it up rather
    // than leaving R2 to accumulate orphans. pending_object_deletes parking
    // doesn't apply here: the DO write is the thing that just failed, and an
    // object with no row is the documented-harmless case (see the upload
    // ordering note above), so best-effort is the right level.
    c.executionCtx.waitUntil(c.env.ATTACHMENTS.delete(r2Key).catch(() => undefined));
    throw err;
  }
});

attachmentRoutes.get("/tasks/:taskId/attachments", async (c) => {
  const auth = requireAuth(c);
  const taskId = parseOrThrow(Id, c.req.param("taskId"), "taskId");
  // Through getTaskDetail rather than listAttachments: it is the read that
  // applies per-space permissions, and it returns the attachments anyway.
  const detail = await workspace(c.env).getTaskDetail(taskId, auth.user.id);
  return c.json({ attachments: detail.attachments });
});

/**
 * The monthly migration's only mutation surface.
 *
 * Phase one makes a verified Drive link canonical but leaves R2 intact. The
 * caller must then read the attachment back. Phase two requires both the exact
 * Drive file id and exact R2 key, deletes that object, confirms it is absent,
 * and only then marks the migration complete.
 */
attachmentRoutes.patch("/attachments/:attachmentId/storage", async (c) => {
  const auth = requireAdmin(c);
  const attachmentId = parseOrThrow(Id, c.req.param("attachmentId"), "attachmentId");
  const body = parseOrThrow(AttachmentStorageBody, await readJson(c));
  const ws = workspace(c.env);

  if (body.action === "finalize_drive") {
    const attachment = await ws.setAttachmentDriveStorage(
      {
        attachmentId,
        driveFileId: body.driveFileId,
        driveWebViewLink: body.driveWebViewLink,
        driveDestination: body.driveDestination,
      },
      auth.actor
    );
    return c.json(attachment);
  }

  const attachment = await ws.getAttachment(attachmentId);
  if (!attachment) throw notFound(`no attachment ${attachmentId}`);
  if (attachment.driveFileId !== body.driveFileId) {
    throw badRequest(`Drive file confirmation does not match attachment ${attachmentId}`);
  }
  if (attachment.r2Key !== body.confirmR2Key) {
    throw badRequest(`R2 key confirmation does not match attachment ${attachmentId}`);
  }
  if (attachment.storageProvider !== "drive") {
    throw badRequest(`attachment ${attachmentId} is not Drive-backed`);
  }

  if (attachment.migrationState !== "complete") {
    await c.env.ATTACHMENTS.delete(attachment.r2Key);
    const remaining = await c.env.ATTACHMENTS.head(attachment.r2Key);
    if (remaining !== null) {
      throw new ApiError(502, `R2 object ${attachment.r2Key} still exists after cleanup`);
    }
  }
  return c.json(
    await ws.markAttachmentDriveCleanupComplete(attachmentId, body.driveFileId, auth.actor)
  );
});

/**
 * Download by id alone.
 */
attachmentRoutes.get("/attachments/:attachmentId", async (c) => {
  const auth = requireAuth(c);
  const attachmentId = parseOrThrow(Id, c.req.param("attachmentId"), "attachmentId");

  const ws = workspace(c.env);
  const meta = await ws.getAttachment(attachmentId);
  if (!meta) throw notFound(`no attachment ${attachmentId}`);
  // An attachment id is guessable-adjacent and says nothing about where it
  // lives, so the parent task decides: this throws for a private space the
  // caller has no access to, before any bytes are streamed.
  await ws.getTaskDetail(meta.taskId, auth.user.id);
  return streamAttachment(c, meta);
});

/**
 * Task-scoped download. Equivalent to the route above and works today, since
 * `listAttachments(taskId)` is the read the DO does expose.
 */
attachmentRoutes.get("/tasks/:taskId/attachments/:attachmentId", async (c) => {
  const auth = requireAuth(c);
  const taskId = parseOrThrow(Id, c.req.param("taskId"), "taskId");
  const attachmentId = parseOrThrow(Id, c.req.param("attachmentId"), "attachmentId");

  const detail = await workspace(c.env).getTaskDetail(taskId, auth.user.id);
  const meta = detail.attachments.find((a) => a.id === attachmentId);
  if (!meta) throw notFound(`no attachment ${attachmentId} on task ${taskId}`);
  return streamAttachment(c, meta);
});

/**
 * A parsed `Range: bytes=…` header.
 *
 * `none` covers both an absent header and forms we deliberately serve whole
 * (multi-range, or a unit other than bytes): a 200 with the full body is always
 * a valid answer to a Range request, whereas a wrong 206 is not.
 */
export type ParsedRange =
  | { kind: "none" }
  | { kind: "unsatisfiable" }
  | { kind: "range"; offset: number; length: number };

/**
 * Parse a single-range `bytes=` header against a known object size.
 *
 * `bytes=0-99` → first 100 bytes; `bytes=500-` → 500 to the end; `bytes=-100` →
 * the last 100 bytes. An end past the object clamps to the last byte (RFC 9110
 * §14.1.1); a start at or past the end is unsatisfiable and must be a 416, not a
 * silently truncated 206.
 */
export function parseRangeHeader(header: string | null | undefined, size: number): ParsedRange {
  if (header === null || header === undefined || header.trim() === "") return { kind: "none" };

  const match = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)$/i.exec(header.trim());
  if (!match) return { kind: "none" }; // multi-range or unknown unit: serve whole
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return { kind: "none" };

  // Suffix form: the last N bytes.
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: "unsatisfiable" };
    if (size === 0) return { kind: "unsatisfiable" };
    const length = Math.min(suffix, size);
    return { kind: "range", offset: size - length, length };
  }

  const offset = Number(rawStart);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size) {
    return { kind: "unsatisfiable" };
  }
  const lastByte = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isSafeInteger(lastByte) || lastByte < offset) return { kind: "unsatisfiable" };
  return { kind: "range", offset, length: lastByte - offset + 1 };
}

/** `bytes 0-99/1234`, built from what R2 actually returned. */
export function contentRangeHeader(range: R2Range | undefined, size: number): string | null {
  if (range === undefined) return null;
  let offset: number;
  let length: number;
  // R2 can return the union with `suffix` present-but-undefined, so a plain
  // `"suffix" in range` check takes this branch with NaN math. Check the value.
  const suffix = (range as { suffix?: number }).suffix;
  if (typeof suffix === "number") {
    length = Math.min(suffix, size);
    offset = size - length;
  } else {
    const r = range as { offset?: number; length?: number };
    offset = r.offset ?? 0;
    length = r.length ?? size - offset;
  }
  if (length <= 0) return null;
  return `bytes ${offset}-${offset + length - 1}/${size}`;
}

/**
 * Stream an object out of R2; supports Range and conditional requests.
 *
 * The Range header is parsed here rather than handed to R2 as a `Headers`
 * object, because `writeHttpMetadata()` only writes the object's stored HTTP
 * metadata (content type, encoding, disposition) and never Content-Range — so
 * deriving the 206 from the response headers could never fire. Content-Range is
 * built from `object.range` and `object.size` instead.
 */
async function streamAttachment(c: Context<AppEnv>, meta: Attachment): Promise<Response> {
  if (meta.storageProvider === "drive" && meta.driveWebViewLink) {
    return c.redirect(meta.driveWebViewLink, 302);
  }
  const wanted = parseRangeHeader(c.req.header("Range"), meta.size);

  const object = await c.env.ATTACHMENTS.get(meta.r2Key, {
    ...(wanted.kind === "range"
      ? { range: { offset: wanted.offset, length: wanted.length } }
      : {}),
    onlyIf: c.req.raw.headers,
  });
  if (!object) {
    throw notFound(`attachment ${meta.id} has no stored object (${meta.r2Key})`);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  applyDownloadHeaders(headers, meta.mimeType, meta.filename);
  // Attachment bytes are immutable once written, and the URL is per-attachment.
  headers.set("Cache-Control", "private, max-age=31536000, immutable");
  // Advertised on every response, including 304 and 416, so a client knows it
  // may retry with a Range at all.
  headers.set("Accept-Ranges", "bytes");

  if (!("body" in object) || object.body === null) {
    // onlyIf matched: a 304/412 body-less object.
    return new Response(null, { status: 304, headers });
  }

  // Decided against the DO's `meta.size` here: R2 is the authority on what was
  // actually stored, and a mismatch would otherwise produce a lying Content-Range.
  if (wanted.kind === "unsatisfiable") {
    const unsatisfiable = new Headers({
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${object.size}`,
      etag: object.httpEtag,
    });
    applyLockdownHeaders(unsatisfiable);
    return new Response(null, { status: 416, headers: unsatisfiable });
  }

  const contentRange = wanted.kind === "range" ? contentRangeHeader(object.range, object.size) : null;
  if (contentRange !== null) {
    headers.set("Content-Range", contentRange);
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

attachmentRoutes.delete("/attachments/:attachmentId", async (c) => {
  const auth = requireAuth(c);
  const attachmentId = parseOrThrow(Id, c.req.param("attachmentId"), "attachmentId");

  // The DO returns the r2Key it just detached (and parked in
  // pending_object_deletes), so no separate lookup is needed. Metadata is
  // gone, so the object is unreachable; drop it after responding and clear
  // the pending row once that succeeds — if it doesn't (Worker evicted,
  // delete failed), the backup job's daily sweep picks the key up.
  const removed = await workspace(c.env).deleteAttachment(attachmentId, auth.actor);
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await c.env.ATTACHMENTS.delete(removed.r2Key);
        await workspace(c.env).clearPendingObjectDeletes([removed.r2Key]);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: "warn",
            msg: "orphaned R2 object after attachment delete; backup job sweep will retry",
            r2Key: removed.r2Key,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    })()
  );
  return c.json({ ok: true, deleted: attachmentId });
});

/**
 * RFC 5987 filename, ASCII-safe with a UTF-8 fallback. `inline` only for
 * INLINE_MIME_TYPES; everything else downloads.
 */
function contentDisposition(filename: string, mimeType: string): string {
  const essence = mimeEssence(mimeType);
  const kind = essence !== null && INLINE_MIME_TYPES.has(essence) ? "inline" : "attachment";
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
