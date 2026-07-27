/// <reference types="@cloudflare/workers-types" />
// //
// Queue consumer for outbound side effects. The DO enqueues SideEffectPayload
// messages (see @flow/core/automation) and this is the only place that talks to
// the outside world: webhooks over fetch with an optional HMAC signature, and
// email through the Cloudflare Email Sending binding.
//
// Wire-up in apps/api/src/index.ts:
//   async queue(batch, env) { await handleSideEffectBatch(batch, env); }
//
// wrangler.jsonc needs the Email Sending binding for the real send path:
//   "send_email": [{ "name": "SEND_EMAIL" }]
// Until it's added, non-dry-run sends fail loudly (and retry) rather than
// silently dropping mail. EMAIL_DRY_RUN defaults to "true".

import type { SideEffectPayload } from "@flow/core/automation";
import type { WebhookPayload } from "@flow/shared";

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
  SEND_EMAIL?: SendEmail;
}

/** Sender identity from EMAIL_FROM / EMAIL_FROM_NAME vars, with safe fallbacks. */
export function emailFrom(env: SideEffectEnv): { email: string; name: string } {
  return {
    email: env.EMAIL_FROM || DEFAULT_EMAIL_FROM.email,
    name: env.EMAIL_FROM_NAME || DEFAULT_EMAIL_FROM.name,
  };
}

export async function handleSideEffectBatch(
  batch: MessageBatch,
  env: SideEffectEnv
): Promise<void> {
  for (const msg of batch.messages) {
    const payload = parsePayload(msg.body);
    if (payload === null) {
      // An unparseable message will never become parseable — don't burn retries.
      console.error("side-effects: dropping unrecognized message", msg.id, msg.body);
      msg.ack();
      continue;
    }
    try {
      if (payload.kind === "webhook") await deliverWebhook(payload);
      else await deliverEmail(payload, env);
      msg.ack();
    } catch (err) {
      // Per-message retry rather than throwing the whole batch, so one dead
      // endpoint doesn't re-deliver its neighbours. max_retries 5 -> flow-dlq.
      console.error(
        `side-effects: ${payload.kind} failed (attempt ${msg.attempts}) rule=${payload.ruleId} task=${payload.taskId}`,
        err instanceof Error ? err.message : err
      );
      msg.retry();
    }
  }
}

// --- payload validation -----------------------------------------------------

/** Narrow the queue body without pulling zod into apps/api. */
export function parsePayload(body: unknown): SideEffectPayload | null {
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
    if (to.length === 0) return null;
    return {
      kind: "email",
      to,
      subject: typeof b["subject"] === "string" ? b["subject"] : "",
      body: typeof b["body"] === "string" ? b["body"] : "",
      ruleId,
      taskId,
    };
  }

  return null;
}

// --- webhooks ---------------------------------------------------------------

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

  const res = await fetch(payload.url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });

  if (!res.ok) {
    // Throw so the message is retried and eventually dead-lettered.
    const detail = await res.text().then((t) => t.slice(0, 500)).catch(() => "");
    throw new Error(`webhook ${payload.url} returned ${res.status}: ${detail}`);
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
  const html = markdownToHtml(payload.body);
  const from = emailFrom(env);

  // Default-on dry run: log exactly what would have gone out, then ack.
  if ((env.EMAIL_DRY_RUN ?? "true") === "true") {
    console.log(
      "[EMAIL_DRY_RUN] would send:\n" +
        `  from:    ${from.name} <${from.email}>\n` +
        `  to:      ${payload.to.join(", ")}\n` +
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

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

/**
 * Just enough markdown for automation emails: ATX headings, bullet and numbered
 * lists, bold/italic/code/links, horizontal rules, paragraphs. Anything fancier
 * degrades to escaped text.
 */
export function markdownToHtml(markdown: string): string {
  const out: string[] = [];
  let listTag: "ul" | "ol" | null = null;
  let paragraph: string[] = [];

  const closeParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listTag !== null) {
      out.push(`</${listTag}>`);
      listTag = null;
    }
  };

  for (const rawLine of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();

    if (line.length === 0) {
      closeParagraph();
      closeList();
      continue;
    }

    if (/^(---+|\*\*\*+)$/.test(line)) {
      closeParagraph();
      closeList();
      out.push("<hr />");
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const hashes = heading?.[1];
    const headingText = heading?.[2];
    if (hashes !== undefined && headingText !== undefined) {
      closeParagraph();
      closeList();
      out.push(`<h${hashes.length}>${inline(headingText)}</h${hashes.length}>`);
      continue;
    }

    const bulletText = /^[-*+]\s+(.*)$/.exec(line)?.[1];
    if (bulletText !== undefined) {
      closeParagraph();
      if (listTag !== "ul") {
        closeList();
        out.push("<ul>");
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
        out.push("<ol>");
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

  return (
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
    'font-size:14px;line-height:1.5;color:#111">' +
    out.join("\n") +
    "</div>"
  );
}
