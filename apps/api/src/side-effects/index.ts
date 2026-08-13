/// <reference types="@cloudflare/workers-types" />
//
// Queue consumer for outbound side effects. The DO enqueues SideEffectPayload
// messages (see @flow/core/automation), and the inbound route reuses the same
// queue for delayed Gleap screenshot reconciliation. This is the only place
// that talks to those external delivery surfaces.
//
// Wire-up in apps/api/src/index.ts, dispatching on batch.queue:
//   async queue(batch, env) {
//     if (batch.queue === "flow-dlq") return handleDeadLetterBatch(batch, env);
//     await handleSideEffectBatch(batch, env);
//   }
//
// wrangler.jsonc needs the Email Sending binding for the real send path:
//   "send_email": [{ "name": "SEND_EMAIL" }]
// Until it's added, non-dry-run sends fail loudly (and retry) rather than
// silently dropping mail. EMAIL_DRY_RUN defaults to "true".
//
// Delivery failures: webhook non-2xx responses are classified via
// WebhookDeliveryError — 408/429/5xx and network errors retry with backoff
// (deliveryRetryDelay), other 4xx are permanent and ack immediately after
// recording the failure onto the DO's automation run log
// (recordDeliveryFailure). Email always retries with the same backoff (the
// SEND_EMAIL binding gives no retryable/permanent signal). Anything that
// survives all 5 flow-side-effects retries lands in flow-dlq, handled by
// handleDeadLetterBatch: log, record, ack — no further retry queue.

import type { SideEffectPayload } from "@flow/core/automation";
import type { WebhookPayload } from "@flow/shared";
import {
  gleapRetryDelay,
  parseGleapScreenshotJob,
  reconcileGleapScreenshot,
  type GleapScreenshotJob,
} from "../gleap-screenshot.js";
import { workspace } from "../do.js";
import type { Env } from "../env.js";

export const DEFAULT_EMAIL_FROM = { email: "flow@mail.example.com", name: "Flow" };
export const WEBHOOK_TIMEOUT_MS = 7_000;
export const SIGNATURE_HEADER = "X-Flow-Signature";

/**
 * Structural, so apps/api's Env (EMAIL_DRY_RUN/APP_HOSTNAME plus the DO, R2 and
 * Queue bindings) is assignable without either side importing the other.
 */
export interface SideEffectEnv {
  EMAIL_DRY_RUN?: string;
  APP_HOSTNAME?: string;
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;
  EMAIL_BRAND_NAME?: string;
  SEND_EMAIL?: SendEmail;
}

/** Sender identity from EMAIL_FROM / EMAIL_FROM_NAME vars, with safe fallbacks. */
export function emailFrom(env: SideEffectEnv): { email: string; name: string } {
  return {
    email: env.EMAIL_FROM || DEFAULT_EMAIL_FROM.email,
    name: env.EMAIL_FROM_NAME || DEFAULT_EMAIL_FROM.name,
  };
}

/** Wordmark for the branded email header: EMAIL_BRAND_NAME, else EMAIL_FROM_NAME, else "Flow". */
export function emailBrandName(env: SideEffectEnv): string {
  return env.EMAIL_BRAND_NAME || env.EMAIL_FROM_NAME || "Flow";
}

export async function handleSideEffectBatch(batch: MessageBatch, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const payload = parsePayload(msg.body);
    if (payload === null) {
      // An unparseable message will never become parseable — don't burn retries.
      console.error("side-effects: dropping unrecognized message", msg.id, msg.body);
      msg.ack();
      continue;
    }
    try {
      if (payload.kind === "gleap-screenshot") {
        const result = await reconcileGleapScreenshot(payload, env);
        if (result.status === "not-ready") {
          msg.retry({ delaySeconds: gleapRetryDelay(msg.attempts) });
          continue;
        }
        if (result.status === "unavailable") {
          console.warn(
            JSON.stringify({
              level: "warn",
              msg: "Gleap screenshot unavailable",
              taskId: payload.taskId,
              ticketId: payload.ticketId,
            })
          );
        }
      } else if (payload.kind === "webhook") await deliverWebhook(payload);
      else await deliverEmail(payload, env);
      msg.ack();
    } catch (err) {
      // Per-message retry rather than throwing the whole batch, so one dead
      // endpoint doesn't re-deliver its neighbours. max_retries 5 -> flow-dlq.
      const rule = payload.kind === "gleap-screenshot" ? "" : ` rule=${payload.ruleId}`;
      console.error(
        `side-effects: ${payload.kind} failed (attempt ${msg.attempts})${rule} task=${payload.taskId}`,
        err instanceof Error ? err.message : err
      );

      if (payload.kind === "gleap-screenshot") {
        msg.retry({ delaySeconds: gleapRetryDelay(msg.attempts) });
        continue;
      }

      // Webhook delivery classifies its own failures (see WebhookDeliveryError
      // below). A permanent one (404/410/422/etc.) will never succeed on
      // retry, so ack now and correct the "queued" run-log entry rather than
      // burning 5 attempts before it lands in flow-dlq. Email keeps the
      // original always-retry behavior — it has no equivalent permanent/
      // transient signal from the SEND_EMAIL binding — just with the same
      // backoff.
      if (payload.kind === "webhook" && err instanceof WebhookDeliveryError && !err.retryable) {
        await recordPermanentFailure(env, payload, err);
        msg.ack();
        continue;
      }

      msg.retry({ delaySeconds: deliveryRetryDelay(msg.attempts) });
    }
  }
}

/**
 * Dead-lettered messages that survived all 5 `flow-side-effects` retries
 * (or a permanent failure recorded above still lands here too, having been
 * acked rather than dead-lettered — this handler is only for the
 * `flow-dlq` queue itself). Logs a structured line, corrects the run log,
 * and always acks: there is nowhere further to retry to, and leaving these
 * unacked would just re-deliver them into flow-dlq's own retry loop.
 */
export async function handleDeadLetterBatch(batch: MessageBatch, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const payload = parsePayload(msg.body);
    const deliverable =
      payload !== null && (payload.kind === "webhook" || payload.kind === "email")
        ? payload
        : null;
    console.error(
      JSON.stringify({
        level: "error",
        msg: "flow.dlq",
        kind: payload?.kind ?? "unknown",
        ruleId: deliverable?.ruleId,
        taskId: payload?.taskId,
        attempts: msg.attempts,
      })
    );
    if (deliverable !== null) {
      await recordPermanentFailure(
        env,
        deliverable,
        new Error(`dead-lettered after ${msg.attempts} attempts`)
      );
    }
    msg.ack();
  }
}

/** Guarded write-back so a DO failure never crashes a queue consumer. */
async function recordPermanentFailure(
  env: Env,
  payload: Extract<SideEffectPayload, { kind: "webhook" | "email" }>,
  err: unknown
): Promise<void> {
  try {
    await workspace(env).recordDeliveryFailure({
      ruleId: payload.ruleId,
      taskId: payload.taskId,
      kind: payload.kind,
      detail: err instanceof Error ? err.message : String(err),
    });
  } catch (writeErr) {
    console.error(
      "side-effects: recordDeliveryFailure failed",
      writeErr instanceof Error ? writeErr.message : writeErr
    );
  }
}

/**
 * Exponential backoff for webhook and email retries: 30s * 2^(attempts-1),
 * capped at 1 hour so a long-dead endpoint doesn't push the eventual
 * dead-letter out for days. `msg.attempts` is 1 on the first delivery
 * attempt (Cloudflare Queues convention, matching gleapRetryDelay above).
 */
export function deliveryRetryDelay(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(30 * 2 ** exponent, 3_600);
}

// --- payload validation -----------------------------------------------------

/** Narrow the queue body without pulling zod into apps/api. */
export function parsePayload(body: unknown): SideEffectPayload | GleapScreenshotJob | null {
  const screenshotJob = parseGleapScreenshotJob(body);
  if (screenshotJob !== null) return screenshotJob;
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const ruleId = typeof b["ruleId"] === "string" ? b["ruleId"] : "";
  const taskId = typeof b["taskId"] === "string" ? b["taskId"] : "";

  if (b["kind"] === "webhook") {
    const url = b["url"];
    const envelope = b["body"];
    if (typeof url !== "string" || url.length === 0) return null;
    if (typeof envelope !== "object" || envelope === null) return null;
    const secret = typeof b["secret"] === "string" && b["secret"].length > 0 ? b["secret"] : null;
    return { kind: "webhook", url, secret, body: envelope as WebhookPayload, ruleId, taskId };
  }

  if (b["kind"] === "email") {
    const raw = b["to"];
    const to = Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
    const rawCc = b["cc"];
    const cc = Array.isArray(rawCc)
      ? rawCc.filter((t): t is string => typeof t === "string")
      : [];
    const rawBcc = b["bcc"];
    const bcc = Array.isArray(rawBcc)
      ? rawBcc.filter((t): t is string => typeof t === "string")
      : [];
    if (to.length === 0) return null;
    return {
      kind: "email",
      to,
      cc,
      bcc,
      subject: typeof b["subject"] === "string" ? b["subject"] : "",
      body: typeof b["body"] === "string" ? b["body"] : "",
      ruleId,
      taskId,
    };
  }

  return null;
}

// --- webhooks ---------------------------------------------------------------

/**
 * Thrown by deliverWebhook so the caller knows whether the failure is worth
 * retrying. `retryable` covers network failures (no `status`) and
 * 408/429/5xx; a 404/410/422/etc. is permanent — the endpoint told us
 * plainly that this exact payload will never be accepted, so retrying burns
 * 5 attempts before dead-lettering for no benefit.
 */
export class WebhookDeliveryError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = "WebhookDeliveryError";
    this.retryable = retryable;
    if (status !== undefined) this.status = status;
  }
}

/** 408 (timeout) and 429 (rate limit) are worth retrying same as 5xx. */
export function isRetryableWebhookStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function deliverWebhook(
  payload: Extract<SideEffectPayload, { kind: "webhook" }>
): Promise<void> {
  const body = JSON.stringify(payload.body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "flow-automations/1",
    "x-flow-event": payload.body.event ?? "",
    "x-flow-rule": payload.ruleId,
  };
  if (payload.secret) headers[SIGNATURE_HEADER] = await hmacSha256Hex(payload.secret, body);

  let res: Response;
  try {
    res = await fetch(payload.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (err) {
    // DNS failure, connection refused, timeout abort, etc. — no response at
    // all, so there is nothing to classify against; always retryable.
    throw new WebhookDeliveryError(
      `webhook ${payload.url} request failed: ${err instanceof Error ? err.message : String(err)}`,
      true
    );
  }

  if (!res.ok) {
    const detail = await res.text().then((t) => t.slice(0, 500)).catch(() => "");
    throw new WebhookDeliveryError(
      `webhook ${payload.url} returned ${res.status}: ${detail}`,
      isRetryableWebhookStatus(res.status),
      res.status
    );
  }
  await res.body?.cancel().catch(() => undefined);
}

/** Lowercase hex HMAC-SHA256 of `body` under `secret`. */
export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- email ------------------------------------------------------------------

export async function deliverEmail(
  payload: Extract<SideEffectPayload, { kind: "email" }>,
  env: SideEffectEnv
): Promise<void> {
  // Notifications (ruleId "notify:*") go to workspace members who can open
  // task links; automation emails go to external recipients, so their shell
  // must not link back into Flow at all.
  const audience = payload.ruleId.startsWith("notify:") ? "internal" : "external";
  const from = emailFrom(env);
  const html = renderEmailHtml(payload.body, {
    audience,
    appHostname: env.APP_HOSTNAME ?? "localhost",
    brandName: emailBrandName(env),
  });

  // Default-on dry run: log exactly what would have gone out, then ack.
  if ((env.EMAIL_DRY_RUN ?? "true") === "true") {
    console.log(
      "[EMAIL_DRY_RUN] would send:\n" +
        `  from:    ${from.name} <${from.email}>\n` +
        `  to:      ${payload.to.join(", ")}\n` +
        `  cc:      ${payload.cc.join(", ")}\n` +
        `  bcc:     ${payload.bcc.join(", ")}\n` +
        `  subject: ${payload.subject}\n` +
        `  rule:    ${payload.ruleId}  task: ${payload.taskId}\n` +
        `  body (markdown):\n${payload.body}\n` +
        `  body (html):\n${html}`
    );
    return;
  }

  const binding = env.SEND_EMAIL;
  if (!binding) {
    throw new Error(
      'EMAIL_DRY_RUN is off but the SEND_EMAIL binding is missing — add "send_email": [{ "name": "SEND_EMAIL" }] to wrangler.jsonc'
    );
  }

  await binding.send({
    from,
    to: payload.to,
    ...(payload.cc.length > 0 ? { cc: payload.cc } : {}),
    ...(payload.bcc.length > 0 ? { bcc: payload.bcc } : {}),
    subject: payload.subject,
    text: payload.body,
    html,
  });
}

// --- tiny markdown renderer -------------------------------------------------

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const LINK_STYLE = "color:#4f46e5;text-decoration:underline";
const CODE_STYLE =
  "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;" +
  "font-size:13px;background-color:#f3f4f6;padding:1px 4px;border-radius:3px";

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, `<code style="${CODE_STYLE}">$1</code>`)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      `<a href="$2" style="${LINK_STYLE}">$1</a>`
    )
    // Autolink bare URLs. Requiring start-of-string/whitespace/( before the
    // URL keeps this from re-linking hrefs and link text produced above.
    .replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (_whole, pre: string, url: string) => {
      const trimmed = url.replace(/[.,;:!?)\]]+$/, "");
      const rest = url.slice(trimmed.length);
      return `${pre}<a href="${trimmed}" style="${LINK_STYLE}">${trimmed}</a>${rest}`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

const HEADING_SIZES = ["22px", "18px", "16px", "14px", "14px", "14px"] as const;

/**
 * Just enough markdown for automation and notification emails: ATX headings,
 * bullet and numbered lists, blockquotes, bold/italic/code, markdown links and
 * autolinked bare URLs, horizontal rules, paragraphs. All input is
 * HTML-escaped before any transform (task descriptions and comments are user
 * content), so anything fancier degrades to escaped text. Returns a fragment;
 * renderEmailHtml wraps it in the branded shell.
 */
export function markdownToHtml(markdown: string): string {
  const out: string[] = [];
  let listTag: "ul" | "ol" | null = null;
  let paragraph: string[] = [];
  let quote: string[] = [];

  const closeParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p style="margin:0 0 12px">${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listTag !== null) {
      out.push(`</${listTag}>`);
      listTag = null;
    }
  };
  const closeQuote = () => {
    if (quote.length > 0) {
      out.push(
        '<blockquote style="margin:0 0 12px;padding:2px 0 2px 12px;' +
          'border-left:3px solid #d1d5db;color:#4b5563">' +
          quote.map((line) => inline(line)).join("<br />") +
          "</blockquote>"
      );
      quote = [];
    }
  };

  for (const rawLine of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();

    const quoted = /^>\s?(.*)$/.exec(line)?.[1];
    if (quoted !== undefined) {
      closeParagraph();
      closeList();
      quote.push(quoted);
      continue;
    }
    closeQuote();

    if (line.length === 0) {
      closeParagraph();
      closeList();
      continue;
    }

    if (/^(---+|\*\*\*+)$/.test(line)) {
      closeParagraph();
      closeList();
      out.push('<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0" />');
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const hashes = heading?.[1];
    const headingText = heading?.[2];
    if (hashes !== undefined && headingText !== undefined) {
      closeParagraph();
      closeList();
      const level = hashes.length;
      out.push(
        `<h${level} style="margin:16px 0 8px;font-size:${HEADING_SIZES[level - 1]};` +
          `line-height:1.3">${inline(headingText)}</h${level}>`
      );
      continue;
    }

    const bulletText = /^[-*+]\s+(.*)$/.exec(line)?.[1];
    if (bulletText !== undefined) {
      closeParagraph();
      if (listTag !== "ul") {
        closeList();
        out.push('<ul style="margin:0 0 12px;padding-left:24px">');
        listTag = "ul";
      }
      out.push(`<li>${inline(bulletText)}</li>`);
      continue;
    }

    const numberedText = /^\d+[.)]\s+(.*)$/.exec(line)?.[1];
    if (numberedText !== undefined) {
      closeParagraph();
      if (listTag !== "ol") {
        closeList();
        out.push('<ol style="margin:0 0 12px;padding-left:24px">');
        listTag = "ol";
      }
      out.push(`<li>${inline(numberedText)}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line);
  }
  closeParagraph();
  closeList();
  closeQuote();

  return out.join("\n");
}

// --- branded shell ----------------------------------------------------------

export interface EmailShellOptions {
  /**
   * "internal" recipients are workspace members (system notifications) whose
   * footer may link back to the app. "external" recipients (automation
   * send_email rules, e.g. clients) get a plain unlinked "Sent via {brand}" —
   * they have no Flow access, so nothing in the shell links to it.
   */
  audience: "internal" | "external";
  /** Footer link host for internal mail, e.g. "flow.example.com". */
  appHostname: string;
  /** Wordmark shown in the shell header, e.g. from emailBrandName(env). */
  brandName: string;
}

/**
 * Render markdown into the branded, email-client-safe HTML shell: inline
 * styles only, single centered column capped at 600px, system font stack, no
 * images, no external resources.
 */
export function renderEmailHtml(markdown: string, opts: EmailShellOptions): string {
  const host = escapeHtml(opts.appHostname);
  const brand = escapeHtml(opts.brandName);
  const footer =
    opts.audience === "internal"
      ? `Sent by ${brand} · <a href="https://${host}" style="color:#9aa0ab;text-decoration:underline">${host}</a>`
      : `Sent via ${brand}`;

  return (
    '<div style="margin:0;padding:24px 12px;background-color:#f4f5f7">' +
    '<div style="max-width:600px;margin:0 auto;background-color:#ffffff;' +
    "border:1px solid #e4e6ea;border-top:3px solid #4f46e5;border-radius:6px;" +
    "padding:28px 32px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
    'font-size:14px;line-height:1.55;color:#1f2430">' +
    '<div style="margin:0 0 20px;padding:0 0 14px;border-bottom:1px solid #eceef1">' +
    `<div style="font-size:16px;font-weight:600;color:#111827">${brand}</div>` +
    '<div style="font-size:12px;color:#8b919e;margin-top:2px">via Flow</div>' +
    "</div>" +
    markdownToHtml(markdown) +
    '<div style="margin:24px 0 0;padding:14px 0 0;border-top:1px solid #eceef1;' +
    `font-size:12px;color:#9aa0ab">${footer}</div>` +
    "</div>" +
    "</div>"
  );
}
