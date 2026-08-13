/// <reference types="@cloudflare/workers-types" />
import type { Attachment, Actor } from "@flow/shared";
import { resolveInboundActor } from "./auth.js";
import { workspace } from "./do.js";
import type { Env } from "./env.js";
import { attachmentKey, sanitizeFilename } from "./routes/attachments.js";

export const GLEAP_TICKET_API = "https://api.gleap.io/v3/tickets";
export const DEFAULT_GLEAP_ATTACHMENT_HOSTS = [".gleap.io"] as const;
export const MAX_GLEAP_TICKET_BYTES = 5 * 1024 * 1024;
export const MAX_GLEAP_SCREENSHOT_BYTES = 20 * 1024 * 1024;
export const MAX_GLEAP_REDIRECTS = 3;

export type GleapScreenshotJob = {
  kind: "gleap-screenshot";
  taskId: string;
  ticketId: string;
  projectId: string;
  screenshotUrl: string | null;
};

export type GleapScreenshotResult =
  | { status: "attached"; attachment: Attachment }
  | { status: "already-attached"; attachment: Attachment }
  | { status: "not-ready" }
  | { status: "unavailable" };

type Fetcher = typeof fetch;
type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolve one project's Gleap token without a default or cross-project
 * fallback. Any malformed entry invalidates the whole secret so deployment
 * mistakes fail closed instead of partially working with ambiguous state.
 */
export function gleapProjectToken(projectId: string, rawSecret?: string): string | null {
  const exactProjectId = projectId.trim();
  if (exactProjectId === "" || !rawSecret) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawSecret);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  for (const [key, value] of Object.entries(parsed)) {
    if (key.trim() === "" || typeof value !== "string" || value.trim() === "") return null;
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, exactProjectId)) return null;
  return asString(parsed[exactProjectId]) || null;
}

export function parseGleapScreenshotJob(body: unknown): GleapScreenshotJob | null {
  if (!isRecord(body) || body["kind"] !== "gleap-screenshot") return null;
  const taskId = asString(body["taskId"]);
  const ticketId = asString(body["ticketId"]);
  const projectId = asString(body["projectId"]);
  const screenshotUrl = body["screenshotUrl"];
  if (screenshotUrl !== null && typeof screenshotUrl !== "string") return null;
  const normalizedUrl =
    typeof screenshotUrl === "string" && screenshotUrl.trim() !== ""
      ? screenshotUrl.trim()
      : null;
  if (taskId === "" || ticketId === "" || (projectId === "" && normalizedUrl === null)) {
    return null;
  }
  return {
    kind: "gleap-screenshot",
    taskId,
    ticketId,
    projectId,
    screenshotUrl: normalizedUrl,
  };
}

export function gleapRetryDelay(attempt: number): number {
  const delays = [10, 30, 60, 120, 300];
  return delays[Math.max(0, Math.min(attempt - 1, delays.length - 1))] ?? 300;
}

export function gleapAttachmentHosts(configured?: string): string[] {
  const values = (configured ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return values.length > 0 ? values : [...DEFAULT_GLEAP_ATTACHMENT_HOSTS];
}

export function assertAllowedGleapAssetUrl(value: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Gleap screenshot URL is invalid");
  }
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) {
    throw new Error("Gleap screenshot URL must use HTTPS on the default port");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Gleap screenshot URL must not contain user information");
  }
  const host = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((entry) => {
    const normalized = entry.toLowerCase();
    return normalized.startsWith(".")
      ? host === normalized.slice(1) || host.endsWith(normalized)
      : host === normalized;
  });
  if (!allowed) throw new Error(`Gleap screenshot host ${host} is not allowlisted`);
  return url;
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(`response is ${declared} bytes; limit is ${limit}`);
  }
  if (response.body === null) throw new Error("response body is empty");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error(`response exceeds ${limit} bytes`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function fetchGleapTicket(
  job: GleapScreenshotJob,
  token: string,
  fetcher: Fetcher
): Promise<Rec> {
  const response = await fetcher(`${GLEAP_TICKET_API}/${encodeURIComponent(job.ticketId)}`, {
    headers: { Authorization: `Bearer ${token}`, project: job.projectId },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Gleap ticket lookup redirected unexpectedly");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Gleap ticket lookup returned ${response.status}`);
  }
  const body = await readBoundedBody(response, MAX_GLEAP_TICKET_BYTES);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
  if (!isRecord(parsed)) throw new Error("Gleap ticket lookup returned a non-object");
  return parsed;
}

function screenshotState(ticket: Rec): {
  url: string | null;
  pending: boolean;
  failed: boolean;
} {
  const screenshotUrl = asString(ticket["screenshotUrl"]);
  return {
    url: screenshotUrl === "" ? null : screenshotUrl,
    pending: ticket["generatingScreenshot"] === true,
    failed: ticket["screenshotRenderingFailed"] === true,
  };
}

async function fetchAllowedImage(
  rawUrl: string,
  allowedHosts: readonly string[],
  fetcher: Fetcher
): Promise<{ body: Uint8Array; mimeType: string }> {
  let url = assertAllowedGleapAssetUrl(rawUrl, allowedHosts);
  for (let redirect = 0; redirect <= MAX_GLEAP_REDIRECTS; redirect += 1) {
    const response = await fetcher(url.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (location === null || redirect === MAX_GLEAP_REDIRECTS) {
        throw new Error("Gleap screenshot redirect could not be resolved safely");
      }
      url = assertAllowedGleapAssetUrl(new URL(location, url).toString(), allowedHosts);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Gleap screenshot returned ${response.status}`);
    }
    const mimeType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? "";
    if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(mimeType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Gleap screenshot content type ${mimeType || "(missing)"} is not an image`);
    }
    return {
      body: await readBoundedBody(response, MAX_GLEAP_SCREENSHOT_BYTES),
      mimeType,
    };
  }
  throw new Error("Gleap screenshot exceeded the redirect limit");
}

function filenameFor(job: GleapScreenshotJob, mimeType: string): string {
  const safeTicketId = job.ticketId.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80) || "ticket";
  const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  return sanitizeFilename(`gleap-${safeTicketId}.${extension}`);
}

async function deterministicAttachmentId(taskId: string, ticketId: string): Promise<string> {
  const encoded = new TextEncoder().encode(`${taskId}\0${ticketId}\0screenshot`);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `at_${hex.slice(0, 20)}`;
}

async function storeScreenshot(
  job: GleapScreenshotJob,
  url: string,
  env: Env,
  actor: Actor,
  fetcher: Fetcher
): Promise<GleapScreenshotResult> {
  const ws = workspace(env);
  const attachmentId = await deterministicAttachmentId(job.taskId, job.ticketId);
  const detail = await ws.getTaskDetail(job.taskId);
  const existing = detail.attachments.find((attachment) => attachment.id === attachmentId);
  if (existing) return { status: "already-attached", attachment: existing };

  const allowedHosts = gleapAttachmentHosts(env.GLEAP_ATTACHMENT_HOSTS);
  const image = await fetchAllowedImage(url, allowedHosts, fetcher);
  const filename = filenameFor(job, image.mimeType);
  const r2Key = attachmentKey(job.taskId, attachmentId, filename);
  await env.ATTACHMENTS.put(r2Key, image.body, {
    httpMetadata: { contentType: image.mimeType },
    customMetadata: { taskId: job.taskId, attachmentId, source: "gleap" },
  });

  try {
    const attachment = await ws.createAttachment(
      {
        id: attachmentId,
        taskId: job.taskId,
        filename,
        r2Key,
        size: image.body.byteLength,
        mimeType: image.mimeType,
      },
      actor
    );
    return { status: "attached", attachment };
  } catch (error) {
    const after = await ws.getTaskDetail(job.taskId).catch(() => null);
    const wonRace = after?.attachments.find((attachment) => attachment.id === attachmentId);
    if (wonRace) return { status: "already-attached", attachment: wonRace };
    await env.ATTACHMENTS.delete(r2Key).catch(() => undefined);
    throw error;
  }
}

export async function reconcileGleapScreenshot(
  job: GleapScreenshotJob,
  env: Env,
  fetcher: Fetcher = fetch
): Promise<GleapScreenshotResult> {
  let screenshotUrl = job.screenshotUrl;
  if (screenshotUrl === null) {
    const token = gleapProjectToken(job.projectId, env.GLEAP_PROJECT_TOKENS_JSON);
    if (!token) throw new Error(`Gleap API token is not configured for project ${job.projectId}`);
    const state = screenshotState(await fetchGleapTicket(job, token, fetcher));
    if (state.failed) return { status: "unavailable" };
    if (state.url === null) return state.pending ? { status: "not-ready" } : { status: "unavailable" };
    screenshotUrl = state.url;
  }

  const { actor } = await resolveInboundActor(env);
  return storeScreenshot(job, screenshotUrl, env, actor, fetcher);
}
