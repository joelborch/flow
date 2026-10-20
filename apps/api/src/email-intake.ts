/// <reference types="@cloudflare/workers-types" />
import PostalMime, { decodeWords, type Email } from "postal-mime";
import {
  EMAIL_INGEST_PERMANENT_ERROR,
  messageIdsIn,
  normalizeMessageId,
  type EmailIngestAttachment,
  type EmailIntakeCheck,
  type IngestEmailInput,
  type IngestEmailResult,
} from "@flow/core";
import { id, ID_PREFIX } from "@flow/core/id";
import { LIMITS, type Actor } from "@flow/shared";
import { findOwnerActor } from "./auth.js";
import { workspace } from "./do.js";
import type { Env } from "./env.js";
import { contentDisposition, mimeEssence, sanitizeFilename } from "./routes/attachments.js";
import { emailBrandName, emailFrom, renderEmailHtml } from "./side-effects/index.js";

/**
 * Email intake: the Worker half.
 *
 * Email Routing sends every address on the intake domain (a catch-all) to
 * `email()`. The local part picks a list through the DO's email_intakes table;
 * the DO decides whether the message opens a ticket, comments on one, or is
 * refused, and records the dedupe key in the same turn. This file does the
 * parts that need the raw bytes: classification, parsing, sender
 * authentication, formatting, and the R2 uploads, plus the acknowledgement.
 *
 * The envelope sender (MAIL FROM) is what the allowlist matches, but it is not
 * authentication on its own: Email Routing accepts a message on an SPF pass or
 * any valid DKIM signature, so a sender can claim an allowlisted MAIL FROM and
 * sign with a domain of their own. Whether the sender's domain vouched for the
 * message comes from Cloudflare's own authentication results
 * (`senderAuthentication`). Unauthenticated mail still files, tagged and marked
 * unverified, but never gets an acknowledgement. The From header is only ever
 * used for a display name.
 */

/**
 * SMTP reject reasons. The sending server turns these into a bounce for the
 * sender. An unknown alias and a refused sender read the same, so bounces
 * can't be used to find out which aliases exist.
 */
const NOT_APPROVED = "This address only accepts mail from approved senders.";
export const REJECT_REASONS = {
  unknown_alias: NOT_APPROVED,
  sender_not_allowed: NOT_APPROVED,
  rate_limited: "Too many messages to this address in the last hour; this message was not accepted.",
} as const;

/** The DO refused the message in a way no retry can fix (see EMAIL_INGEST_PERMANENT_ERROR). */
export const PERMANENT_REJECT = "This message could not be filed. Please contact us another way.";

const UNREADABLE_REJECT = "This message could not be read. Please send it again as a regular email.";

/** Prefix of the dedupe key minted for a message that arrives without a Message-ID. */
export const SYNTHETIC_ID_PREFIX = "sha256:";


/** Fixed, so nothing the sender wrote is ever reflected back out in our name. */
export const ACK_SUBJECT = "We received your request";

/** Email Service caps each custom header value at 2,048 bytes. */
export const HEADER_VALUE_MAX_BYTES = 2048;

/** Text and HTML parts are cut to this many characters before any regex or normalization runs. */
export const BODY_SOURCE_MAX = 2 * LIMITS.descriptionMax;

/** Attachments kept per message; the rest are counted in the task text. */
export const MAX_ATTACHMENTS = 20;

/** Inline images the HTML references by `cid:` and smaller than this are signature logos, not files. */
export const INLINE_IMAGE_SKIP_BYTES = 15 * 1024;

/** In-Reply-To plus References ids passed to the DO, earliest first. */
export const MAX_REFERENCE_IDS = 20;

/** First line of the text of anything filed from mail Cloudflare couldn't authenticate. */
export const UNVERIFIED_NOTE = "**Unverified sender** — Cloudflare could not authenticate this message.";

/** A legitimate message is a handful of parts; postal-mime's default allows 10,000. */
const PARSE_OPTIONS = { maxPartCount: 200 } as const;
const UPLOAD_CONCURRENCY = 4;
/** R2's `delete(keys[])` takes at most 1,000 keys per call. */
const R2_DELETE_MAX_KEYS = 1000;

const DEFAULT_MIME = "application/octet-stream";
const TRUNCATION_NOTE = "\n\n_[Truncated: the rest of this email was too long to include.]_";

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- addresses ----------------------------------------------------------------

function bareAddress(raw: string): string {
  return raw.trim().replace(/^<|>$/g, "").trim().toLowerCase();
}

/** "Acme+urgent@tickets.example.com" → "acme". */
export function parseAlias(envelopeTo: string): string {
  const address = bareAddress(envelopeTo);
  const at = address.lastIndexOf("@");
  const local = at === -1 ? address : address.slice(0, at);
  const plus = local.indexOf("+");
  return (plus === -1 ? local : local.slice(0, plus)).trim();
}

/** The envelope sender, lowercased; "" for the null sender ("<>") bounces use. */
export function normalizeSender(envelopeFrom: string): string {
  return bareAddress(envelopeFrom);
}

function localPart(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? address : address.slice(0, at);
}

// --- classification -----------------------------------------------------------

/**
 * `bounce` and `auto_reply` are dropped without a trace beyond a log line;
 * answering either is how mail loops start. `automated` mail (newsletters,
 * notifications, no-reply senders) may still open a ticket for an allowed
 * sender, but never gets an acknowledgement.
 */
export type MailKind = "bounce" | "auto_reply" | "automated" | "personal";

const BOUNCE_LOCAL_PARTS = new Set(["mailer-daemon", "postmaster"]);
const BULK_PRECEDENCE = new Set(["bulk", "junk", "list", "auto_reply"]);
const AUTO_REPLY_SUBJECT_RE =
  /^\s*(?:automatic reply|auto[- ]?reply|out of office auto ?reply|out of office reply)\s*:/i;
const NO_REPLY_LOCAL_RE = /^(?:no-?reply|do-?not-?reply)(?:[+._-]|$)/;

/** First token of a structured header, lowercased: "auto-replied; owner=x" → "auto-replied". */
function headerToken(value: string | null): string {
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function flagged(value: string | null): boolean {
  const token = headerToken(value);
  return token !== "" && token !== "no" && token !== "false";
}

function isAutoReply(headers: Headers): boolean {
  if (headerToken(headers.get("Auto-Submitted")) === "auto-replied") return true;
  if (flagged(headers.get("X-Autoreply")) || flagged(headers.get("X-Autorespond"))) return true;
  return AUTO_REPLY_SUBJECT_RE.test(decodeWords(headers.get("Subject") ?? ""));
}

function isAutomated(sender: string, headers: Headers): boolean {
  const autoSubmitted = headerToken(headers.get("Auto-Submitted"));
  if (autoSubmitted !== "" && autoSubmitted !== "no") return true;
  if (BULK_PRECEDENCE.has(headerToken(headers.get("Precedence")))) return true;
  if (headers.has("List-Id") || headers.has("List-Unsubscribe")) return true;
  if (headers.has("X-Auto-Response-Suppress")) return true;
  return NO_REPLY_LOCAL_RE.test(localPart(sender));
}

export function classifyMail(sender: string, headers: Headers): MailKind {
  if (sender === "" || BOUNCE_LOCAL_PARTS.has(localPart(sender))) return "bounce";
  if (isAutoReply(headers)) return "auto_reply";
  return isAutomated(sender, headers) ? "automated" : "personal";
}

// --- sender authentication ------------------------------------------------------

/** One header line, unfolded, in document order (postal-mime's `Email.headers`). */
export interface RawHeader {
  key: string;
  value: string;
}

/** Topmost first is how they are read; see `senderAuthentication`. */
const AUTH_RESULTS_HEADERS = ["arc-authentication-results", "authentication-results"] as const;
const AUTH_RESULTS_HEADER_SET: ReadonlySet<string> = new Set(AUTH_RESULTS_HEADERS);

/** Long enough for any real results header; a forged giant one is only parsed this far. */
const AUTH_VALUE_MAX = 8192;

/** `mx.cloudflare.net` and friends: Cloudflare's receiving MTA names itself this way. */
const CLOUDFLARE_AUTHSERV_RE = /^(?:[a-z0-9-]+\.)*cloudflare\.(?:net|com)$/;

export function isCloudflareAuthservId(authservId: string): boolean {
  const idValue = authservId.toLowerCase();
  return idValue.length <= 100 && CLOUDFLARE_AUTHSERV_RE.test(idValue);
}

export interface AuthResult {
  /** "dkim", "spf", "dmarc", … without any "/version". */
  method: string;
  /** "pass", "fail", "softfail", … lowercased. */
  result: string;
  /** `ptype.property` → value, e.g. "header.d" → "example.com"; first occurrence wins. */
  props: ReadonlyMap<string, string>;
}

export interface ParsedAuthResults {
  /** ARC instance (`i=`), or null for a plain Authentication-Results header. */
  instance: number | null;
  authservId: string;
  results: AuthResult[];
}

/**
 * Split an Authentication-Results value (RFC 8601) into its `;` clauses, with
 * comments removed and quoted strings kept as one token, so a comment like
 * "(… designates 192.0.2.1 as permitted sender)" or a quoted reason can't
 * smuggle in a clause or a property. One pass, linear in the value.
 */
function authResultsClauses(value: string): string[] {
  const clauses: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (depth > 0) {
      if (ch === "\\") i++;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      continue;
    }
    if (quoted) {
      const literal = ch === "\\" ? (value[++i] ?? "") : ch;
      if (ch === '"') quoted = false;
      // Whitespace inside quotes would split the token; \u0001 never appears in a real value.
      else current += /\s/.test(literal) ? "\u0001" : literal;
      continue;
    }
    if (ch === "(") {
      depth = 1;
      current += " ";
    } else if (ch === '"') quoted = true;
    else if (ch === ";") {
      clauses.push(current);
      current = "";
    } else current += ch;
  }
  clauses.push(current);
  // CFWS is allowed around "=" and "."; collapse first so these stay linear.
  return clauses.map((c) => c.replace(/\s+/g, " ").replace(/ ?= ?/g, "=").replace(/ ?\. ?/g, ".").trim());
}

function parseResinfo(clause: string): AuthResult | null {
  const [head = "", ...rest] = clause.split(" ");
  const eq = head.indexOf("=");
  if (eq <= 0) return null;
  const props = new Map<string, string>();
  for (const token of rest) {
    const at = token.indexOf("=");
    const key = token.slice(0, at).toLowerCase();
    // "reason=…" and other bare keys aren't properties.
    if (at <= 0 || !key.includes(".") || props.has(key)) continue;
    props.set(key, token.slice(at + 1));
  }
  return {
    method: head.slice(0, eq).toLowerCase().split("/", 1)[0]!,
    result: head.slice(eq + 1).toLowerCase(),
    props,
  };
}

/** Parse an Authentication-Results or ARC-Authentication-Results value. */
export function parseAuthResults(value: string): ParsedAuthResults {
  const clauses = authResultsClauses(value.slice(0, AUTH_VALUE_MAX));
  let instance: number | null = null;
  if (/^i=\d{1,3}$/i.test(clauses[0] ?? "")) instance = Number(clauses.shift()!.slice(2));
  const authservId = (clauses.shift() ?? "").split(" ", 1)[0]!.toLowerCase();
  const results = clauses.map(parseResinfo).filter((r): r is AuthResult => r !== null);
  return { instance, authservId, results };
}

const DOMAIN_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/;

/** The domain of an address or bare domain ("jane@Example.com" → "example.com"); null if it isn't one. */
function domainOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  const lower = value.trim().toLowerCase();
  const domain = lower.slice(lower.lastIndexOf("@") + 1).replace(/\.$/, "");
  return domain.length <= 253 && DOMAIN_RE.test(domain) ? domain : null;
}

export interface SenderAuthentication {
  authenticated: boolean;
  /** Which Cloudflare result vouched for the sender's domain, when one did. */
  via: "dmarc" | "dkim" | "spf" | null;
}

const UNAUTHENTICATED: SenderAuthentication = { authenticated: false, via: null };

function vouchingMethod(results: readonly AuthResult[], senderDomain: string): SenderAuthentication["via"] {
  const passes = results.filter((r) => r.result === "pass");
  // Equal to the sender's domain or a parent of it: mail.example.com is
  // vouched for by a pass for example.com, never the other way round.
  const covers = (value: string | undefined): boolean => {
    const domain = domainOf(value);
    return domain !== null && (domain === senderDomain || senderDomain.endsWith(`.${domain}`));
  };
  // A DMARC pass is about the From header's domain, which the sender picks
  // freely, so it only counts when that domain is the envelope sender's.
  if (passes.some((r) => r.method === "dmarc" && covers(r.props.get("header.from")))) return "dmarc";
  if (passes.some((r) => r.method === "dkim" && covers(r.props.get("header.d") ?? r.props.get("header.i")))) {
    return "dkim";
  }
  if (passes.some((r) => r.method === "spf" && domainOf(r.props.get("smtp.mailfrom")) === senderDomain)) {
    return "spf";
  }
  return null;
}

/**
 * Whether Cloudflare's receiving MTA authenticated the envelope sender's
 * domain. Pure; reads nothing but `headers`, in document order.
 *
 * Only the topmost ARC-Authentication-Results and the topmost
 * Authentication-Results are considered, and each only when its authserv-id
 * is Cloudflare's. The receiving MTA prepends its headers, so anything a
 * sender wrote into the message (a results header naming Cloudflare
 * included) sits below Cloudflare's own and is never read. Authenticated
 * means one of:
 *
 * - `dmarc=pass` with `header.from` equal to (or a parent of) the sender's domain
 * - `dkim=pass` with `header.d` equal to (or a parent of) the sender's domain
 * - `spf=pass` with `smtp.mailfrom` in the sender's domain
 *
 * No Cloudflare results at all is unauthenticated: fail safe.
 */
export function senderAuthentication(headers: readonly RawHeader[], sender: string): SenderAuthentication {
  const senderDomain = sender.includes("@") ? domainOf(sender) : null;
  if (senderDomain === null) return UNAUTHENTICATED;
  for (const name of AUTH_RESULTS_HEADERS) {
    const topmost = headers.find((h) => h.key.toLowerCase() === name);
    if (topmost === undefined) continue;
    const parsed = parseAuthResults(topmost.value);
    if (!isCloudflareAuthservId(parsed.authservId)) continue;
    const via = vouchingMethod(parsed.results, senderDomain);
    if (via !== null) return { authenticated: true, via };
  }
  return UNAUTHENTICATED;
}

const AUTH_LOG_MAX_HEADERS = 8;
const AUTH_LOG_MAX_RESULTS = 4;
const LOG_TOKEN_RE = /^[a-z0-9_-]{1,24}$/;
const LOG_AUTHSERV_RE = /^[a-z0-9.-]{1,100}$/;

function logToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  const lower = value.toLowerCase();
  return LOG_TOKEN_RE.test(lower) ? lower : "?";
}

/**
 * What the results headers said, for the go-live log that confirms the
 * parser against real Cloudflare mail. Result tokens and DOMAINS only: never
 * a local part, a comment, a reason or a body. Values that aren't a plain
 * token or domain are logged as "?" or null.
 */
export function authenticationLog(headers: readonly RawHeader[]): Record<string, unknown> {
  const authHeaders: Record<string, unknown>[] = [];
  let authHeaderCount = 0;
  headers.forEach((header, pos) => {
    const name = header.key.toLowerCase();
    if (!AUTH_RESULTS_HEADER_SET.has(name)) return;
    authHeaderCount++;
    if (authHeaders.length >= AUTH_LOG_MAX_HEADERS) return;
    const parsed = parseAuthResults(header.value);
    const pick = (method: string, ...props: string[]) =>
      parsed.results
        .filter((r) => r.method === method)
        .slice(0, AUTH_LOG_MAX_RESULTS)
        .map((r) => ({
          r: logToken(r.result),
          d: domainOf(props.map((p) => r.props.get(p)).find((v) => v !== undefined)),
        }));
    authHeaders.push({
      h: name,
      pos,
      i: parsed.instance,
      authserv: LOG_AUTHSERV_RE.test(parsed.authservId) ? parsed.authservId : "?",
      cf: isCloudflareAuthservId(parsed.authservId),
      dmarc: pick("dmarc", "header.from"),
      dkim: pick("dkim", "header.d", "header.i"),
      spf: pick("spf", "smtp.mailfrom"),
    });
  });
  const receivedSpf = headers.find((h) => h.key.toLowerCase() === "received-spf");
  return {
    authHeaders,
    authHeaderCount,
    firstReceivedPos: headers.findIndex((h) => h.key.toLowerCase() === "received"),
    receivedSpf: receivedSpf === undefined ? null : logToken(receivedSpf.value.trim().split(/[\s;(]/, 1)[0]),
  };
}

// --- text formatting (pure) -------------------------------------------------------

/** Slice to `max` UTF-16 units without leaving half a surrogate pair at the end. */
function sliceSafe(text: string, max: number): string {
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Cap `text` at `max` characters, replacing the overflow with a visible note. */
export function truncateWithNote(text: string, max: number, note = TRUNCATION_NOTE): string {
  if (text.length <= max) return text;
  return sliceSafe(text, max - note.length).trimEnd() + note;
}

const REPLY_PREFIX_RE = /^(?:(?:re|fwd?)(?:\[\d+\])?\s*:\s*)+/i;

/** Subject → task title: whitespace collapsed, Re:/Fwd:/Fw: stripped, capped. */
export function titleFromSubject(subject: string | null | undefined): string {
  const collapsed = (subject ?? "").replace(/\s+/g, " ").trim();
  const title = collapsed.replace(REPLY_PREFIX_RE, "").trim() || "(no subject)";
  return title.length <= LIMITS.titleMax ? title : `${sliceSafe(title, LIMITS.titleMax - 1).trimEnd()}…`;
}

const MARKDOWN_INLINE_RE = /[\\`*_[\]()<>!~]/g;

/** Backslash-escape the characters that open inline markdown (emphasis, code, links, images, HTML). */
export function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_INLINE_RE, "\\$&");
}

/**
 * `![alt](url)` → `!\[alt](url)`. Markdown images load from wherever they
 * point the moment a task is opened, which makes them tracking pixels; an
 * escaped one renders as a link (or literal text) instead.
 */
export function escapeImageSyntax(text: string): string {
  return text.replaceAll("![", "!\\[");
}

/**
 * "Jane Doe <jane@example.com>", or the bare address when there is no usable
 * name. Both name and address are markdown-escaped, so neither can restyle the
 * line it sits on, link somewhere, or embed an image.
 */
export function formatSender(displayName: string | null | undefined, sender: string): string {
  const name = sliceSafe(
    (displayName ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    100
  ).trim();
  const address = escapeMarkdown(sender);
  return name === "" || name.toLowerCase() === sender ? address : `${escapeMarkdown(name)} <${address}>`;
}

const ENTITIES = new Map<string, string>([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["nbsp", " "],
  ["ndash", "–"], ["mdash", "—"], ["hellip", "…"], ["lsquo", "‘"], ["rsquo", "’"],
  ["ldquo", "“"], ["rdquo", "”"], ["bull", "•"], ["middot", "·"], ["copy", "©"],
  ["reg", "®"], ["trade", "™"],
]);

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (!ref.startsWith("#")) return ENTITIES.get(ref.toLowerCase()) ?? whole;
    const hex = ref[1] === "x" || ref[1] === "X";
    const code = Number.parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : whole;
  });
}

/** A link's text and target → "label (https://x)", so the link survives as text. */
function linkAsText(label: string, href: string): string {
  const text = label.trim();
  if (text === "" || text === href) return href;
  return text.includes(href) ? text : `${text} (${href})`;
}

/** Trim each line, collapse runs of spaces, and keep at most one blank line in a row. */
function tidyLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const PARAGRAPH_TAGS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table", "ul", "ol",
]);
/** Elements whose content is never text; dropped up to their closing tag. */
const RAW_TEXT_TAGS = ["script", "style", "title"] as const;
const HREF_RE = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isTagNameChar(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57) || code === 45 || code === 58;
}

function httpHref(attributes: string): string | null {
  const m = HREF_RE.exec(attributes);
  const href = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
  return /^https?:/i.test(href) ? href : null;
}

/**
 * Readable plain text from an HTML-only email: script/style/title dropped,
 * block elements and <br> turned into line breaks, list items into "- "
 * bullets, links kept as "label (url)", common entities decoded.
 *
 * A single forward scan rather than a chain of regexes: every search starts
 * where the last one stopped, and a search that comes up empty (an unclosed
 * comment, tag or <title>) is never repeated, so the work is linear in the
 * input whatever it contains.
 */
export function htmlToText(html: string): string {
  const out: string[] = [];
  let link: { href: string; label: string[] } | null = null;
  const emit = (text: string): void => void (link === null ? out : link.label).push(text);
  const closeLink = (): void => {
    if (link !== null) out.push(linkAsText(link.label.join(""), link.href));
    link = null;
  };

  // Position of the next ">" at or after the last search; -1 once there is none left.
  let gt = -2;
  const nextGt = (from: number): number => {
    if (gt !== -1 && gt < from) gt = html.indexOf(">", from);
    return gt;
  };
  const rawClose = new Map<string, RegExp>(
    RAW_TEXT_TAGS.map((tag) => [tag, new RegExp(`</${tag}\\b`, "gi")] as const)
  );
  const unclosed = new Set<string>();

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    const textEnd = lt === -1 ? html.length : lt;
    if (textEnd > i) emit(html.slice(i, textEnd).replace(/\s+/g, " "));
    if (lt === -1) break;
    i = lt;

    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      if (end === -1) break; // an unclosed comment runs to the end
      i = end + 3;
      continue;
    }
    const after = html[i + 1];
    if (after === "!" || after === "?") {
      const end = nextGt(i + 1); // <!DOCTYPE …>, <![CDATA[…]]>, <?xml …?>
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    const closing = after === "/";
    const nameStart = i + (closing ? 2 : 1);
    if (!isAsciiLetter(html.charCodeAt(nameStart))) {
      emit("<"); // "a < b" is text, not a tag
      i += 1;
      continue;
    }
    const end = nextGt(nameStart);
    if (end === -1) break; // an unterminated tag at the end is dropped
    let nameEnd = nameStart;
    while (nameEnd < end && isTagNameChar(html.charCodeAt(nameEnd))) nameEnd++;
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    i = end + 1;

    const close = closing || unclosed.has(name) ? undefined : rawClose.get(name);
    if (close !== undefined) {
      close.lastIndex = i;
      const match = close.exec(html);
      if (match === null) {
        unclosed.add(name); // keep what follows as text, and never search again
        continue;
      }
      const closeEnd = nextGt(match.index);
      if (closeEnd === -1) break;
      i = closeEnd + 1;
      continue;
    }

    if (name === "a") {
      closeLink();
      const href = closing ? null : httpHref(html.slice(nameEnd, end));
      if (href !== null) link = { href, label: [] };
    } else if (name === "br") emit("\n");
    else if (name === "li") {
      if (!closing) emit("\n- ");
    } else if (PARAGRAPH_TAGS.has(name)) emit(closing ? "\n\n" : "\n");
    else if (name === "tr") emit("\n");
    else if (name === "td" || name === "th") emit(" ");
  }
  closeLink();
  return tidyLines(decodeEntities(out.join("")));
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** A part cut to BODY_SOURCE_MAX, and whether anything was cut. */
function clip(part: string | undefined): { value: string; cut: boolean } {
  const value = part ?? "";
  return value.length > BODY_SOURCE_MAX
    ? { value: sliceSafe(value, BODY_SOURCE_MAX), cut: true }
    : { value, cut: false };
}

/**
 * The message's own words: the text part, else the HTML part flattened to
 * text. Each part is cut to BODY_SOURCE_MAX before anything else touches it,
 * with a visible note when that dropped something.
 */
export function bodyText(parsed: Pick<Email, "text" | "html">): string {
  const text = clip(parsed.text);
  const plain = normalizeNewlines(text.value).trim();
  if (plain !== "") return text.cut ? plain + TRUNCATION_NOTE : plain;
  if (!parsed.html) return "";
  const html = clip(parsed.html);
  const flattened = htmlToText(html.value);
  return html.cut && flattened !== "" ? flattened + TRUNCATION_NOTE : flattened;
}

/**
 * Email line breaks are meaningful (signatures, addresses, short lists), but a
 * single newline in markdown is a soft break that reflows into a space. Two
 * trailing spaces make it a hard break in the web editor, and the side-effects
 * email renderer trims them away, so neither surface shows them.
 */
export function hardBreaks(text: string): string {
  const lines = text.split("\n");
  return lines
    .map((line, i) =>
      line.trim() !== "" && (lines[i + 1] ?? "").trim() !== "" ? `${line.trimEnd()}  ` : line
    )
    .join("\n");
}

const ORIGINAL_MESSAGE_RE = /^-{2,}\s*Original Message\s*-{2,}$/i;
const RULE_RE = /^(?:_{10,}|-{10,})$/;
const OUTLOOK_FROM_RE = /^\*?From:\*?\s/i;
const OUTLOOK_SENT_RE = /^\*?(?:Sent|Date):\*?\s/i;
const WROTE_RE = /\bwrote:$/;

/** Index of the line where quoted history starts, or `lines.length` if none. */
function quoteStart(lines: readonly string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (ORIGINAL_MESSAGE_RE.test(line)) return i;
    // Gmail/Apple: "On Mon, … Jane <jane@example.com> wrote:", sometimes wrapped
    // so "wrote:" lands on the following line.
    if (/^On\s/.test(line) && (WROTE_RE.test(line) || WROTE_RE.test(lines[i + 1]?.trim() ?? ""))) {
      return i;
    }
    // Outlook: a "From:" header block with "Sent:" (or "Date:") just below it,
    // often under a rule of underscores.
    const next = lines.slice(i + 1, i + 4).map((l) => l.trim());
    if (OUTLOOK_FROM_RE.test(line) && next.some((l) => OUTLOOK_SENT_RE.test(l))) {
      return i > 0 && RULE_RE.test(lines[i - 1]!.trim()) ? i - 1 : i;
    }
  }
  return lines.length;
}

/** A reply with its quoted history removed, so the comment holds only what's new. */
export function stripQuotedReply(text: string): string {
  const lines = normalizeNewlines(text).split("\n");
  const kept = lines.slice(0, quoteStart(lines));
  while (kept.length > 0) {
    const last = kept[kept.length - 1]!.trim();
    if (last !== "" && !last.startsWith(">")) break;
    kept.pop();
  }
  return kept.join("\n").trim();
}

/** What the formatters need to know about a message beyond its text. */
export interface MessageNotes {
  /** From `senderAuthentication`; false puts UNVERIFIED_NOTE first. */
  authenticated: boolean;
  /** Attachments dropped over MAX_ATTACHMENTS. */
  skippedAttachments: number;
}

function skippedNote(skipped: number): string | null {
  if (skipped <= 0) return null;
  const what = skipped === 1 ? "1 more attachment was" : `${skipped} more attachments were`;
  return `_${what} not saved: at most ${MAX_ATTACHMENTS} are kept per email._`;
}

/** The lines above the message text, which truncation never reaches. */
function preamble(fromLine: string, notes: MessageNotes): string {
  return [notes.authenticated ? null : UNVERIFIED_NOTE, fromLine, skippedNote(notes.skippedAttachments)]
    .filter((line): line is string => line !== null)
    .join("\n\n");
}

export function formatDescription(from: string, body: string, notes: MessageNotes): string {
  const text = body === "" ? "_No message text._" : hardBreaks(escapeImageSyntax(body));
  return truncateWithNote(`${preamble(`**From:** ${from}`, notes)}\n\n${text}`, LIMITS.descriptionMax);
}

export function formatCommentBody(
  from: string,
  reply: string,
  attachmentCount: number,
  notes: MessageNotes
): string {
  let text = hardBreaks(escapeImageSyntax(reply));
  if (text === "") {
    text =
      attachmentCount > 0
        ? `_No message text; ${attachmentCount === 1 ? "1 attachment" : `${attachmentCount} attachments`} added to the task._`
        : "_No message text._";
  }
  return truncateWithNote(`${preamble(`**Email reply from** ${from}`, notes)}\n\n${text}`, LIMITS.commentBodyMax);
}

// --- attachments ------------------------------------------------------------

const MIME_EXTENSIONS = new Map<string, string>([
  ["image/png", ".png"], ["image/jpeg", ".jpg"], ["image/gif", ".gif"], ["image/webp", ".webp"],
  ["image/heic", ".heic"], ["image/bmp", ".bmp"], ["image/tiff", ".tiff"], ["image/svg+xml", ".svg"],
  ["application/pdf", ".pdf"], ["text/plain", ".txt"], ["text/html", ".html"], ["text/csv", ".csv"],
  ["text/calendar", ".ics"], ["message/rfc822", ".eml"], ["application/zip", ".zip"],
  ["application/msword", ".doc"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["application/vnd.ms-excel", ".xls"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
  ["audio/mpeg", ".mp3"], ["video/mp4", ".mp4"], ["video/quicktime", ".mov"],
]);

/**
 * A safe stored name: the sender's filename through the same sanitizer as
 * uploads, or `attachment-N.<ext>` when the part has no usable name (inline
 * images usually don't).
 */
export function attachmentFilename(raw: string | null | undefined, n: number, mimeType: string): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  // At least one character that survives sanitizing and isn't just dots.
  if (/[^\s."\\\u0000-\u001f\u007f]/.test(base)) return sanitizeFilename(base);
  return `attachment-${n}${MIME_EXTENSIONS.get(mimeType) ?? ".bin"}`;
}

/**
 * The task id isn't known until the DO routes the message, so email uploads
 * live under their own namespace keyed by the message instead of `at/<taskId>/`.
 * Nothing reads the key's shape: every consumer uses the exact `r2Key` stored
 * on the attachment row.
 */
export function emailAttachmentKey(messageHash: string, attachmentId: string, filename: string): string {
  return `email/${messageHash}/${attachmentId}/${sanitizeFilename(filename)}`;
}

function contentBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

type PlannedUpload = EmailIngestAttachment & { bytes: Uint8Array };
type MailPart = Email["attachments"][number];

export interface AttachmentPlan {
  /** At most MAX_ATTACHMENTS, in message order. */
  uploads: PlannedUpload[];
  /** Real attachments over the cap; the task text says how many. */
  skipped: number;
  /** Small images the HTML shows by `cid:` (signature logos), dropped without a note. */
  inlineDropped: number;
}

/** Content-IDs the HTML references as `cid:` URLs, lowercased. */
function cidReferences(html: string): Set<string> {
  const refs = new Set<string>();
  for (const match of html.matchAll(/\bcid:([^\s"'<>)]+)/gi)) {
    let ref = match[1]!;
    try {
      ref = decodeURIComponent(ref);
    } catch {
      // A malformed escape: keep the reference as written.
    }
    refs.add(ref.toLowerCase());
  }
  return refs;
}

function isSignatureImage(part: MailPart, size: number, cids: ReadonlySet<string>): boolean {
  if (size >= INLINE_IMAGE_SKIP_BYTES || !part.mimeType.toLowerCase().startsWith("image/")) return false;
  const contentId = normalizeMessageId(part.contentId);
  return contentId !== null && cids.has(contentId.toLowerCase());
}

export function planAttachments(parsed: Pick<Email, "attachments" | "html">, messageHash: string): AttachmentPlan {
  const cids = cidReferences(clip(parsed.html).value);
  const wanted: { part: MailPart; bytes: Uint8Array }[] = [];
  let inlineDropped = 0;
  for (const part of parsed.attachments) {
    const bytes = contentBytes(part.content);
    if (bytes.byteLength === 0) continue;
    if (isSignatureImage(part, bytes.byteLength, cids)) inlineDropped++;
    else wanted.push({ part, bytes });
  }
  const uploads = wanted.slice(0, MAX_ATTACHMENTS).map(({ part, bytes }, i) => {
    const mimeType = mimeEssence(part.mimeType) ?? DEFAULT_MIME;
    const filename = attachmentFilename(part.filename, i + 1, mimeType);
    const attachmentId = id(ID_PREFIX.attachment);
    return {
      id: attachmentId,
      r2Key: emailAttachmentKey(messageHash, attachmentId, filename),
      filename,
      size: bytes.byteLength,
      mimeType,
      bytes,
    };
  });
  return { uploads, skipped: wanted.length - uploads.length, inlineDropped };
}

/**
 * Best effort, in batches R2 accepts: an object left behind is unreferenced
 * garbage, never a broken link. Logs ids and counts only, since keys and
 * filenames can name patients.
 */
export async function deleteUploads(
  env: Env,
  uploads: readonly Pick<EmailIngestAttachment, "id" | "r2Key">[]
): Promise<void> {
  for (let start = 0; start < uploads.length; start += R2_DELETE_MAX_KEYS) {
    const batch = uploads.slice(start, start + R2_DELETE_MAX_KEYS);
    try {
      await env.ATTACHMENTS.delete(batch.map((u) => u.r2Key));
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "warn",
          msg: "email intake: could not delete uploaded attachments",
          count: batch.length,
          attachmentIds: batch.map((u) => u.id),
          error: errorMessage(err),
        })
      );
    }
  }
}

/**
 * Write the planned attachments to R2 with the upload route's metadata
 * conventions, a few at a time. On the first failure no new upload starts;
 * every one that was attempted is deleted and the error rethrown.
 */
async function uploadAttachments(env: Env, uploads: readonly PlannedUpload[], actor: Actor): Promise<void> {
  const state = { next: 0, failed: false, error: undefined as unknown };
  const lane = async (): Promise<void> => {
    while (!state.failed && state.next < uploads.length) {
      const p = uploads[state.next++]!;
      try {
        await env.ATTACHMENTS.put(p.r2Key, p.bytes, {
          httpMetadata: {
            contentType: p.mimeType,
            contentDisposition: contentDisposition(p.filename, p.mimeType),
          },
          customMetadata: { attachmentId: p.id, source: "email", uploadedBy: actor.userId },
        });
      } catch (err) {
        if (!state.failed) state.error = err;
        state.failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, uploads.length) }, lane));
  if (state.failed) {
    await deleteUploads(env, uploads.slice(0, state.next));
    throw state.error;
  }
}

// --- acknowledgement ------------------------------------------------------------

/** Generic on purpose: nothing from the message (subject, body, names) goes back out. */
export function acknowledgementMarkdown(): string {
  return [
    "Thanks for your email. We received it and opened a ticket.",
    "",
    "To add details or attachments, just reply to this email.",
  ].join("\n");
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * In-Reply-To and References for the acknowledgement, so the client's reply
 * carries the original Message-ID in its References and threads back onto the
 * ticket. When the chain outgrows the header value cap, ids are dropped from
 * the middle: RFC 5322 §3.6.4 keeps the thread's first id and its newest ones.
 * Null when the message had no real Message-ID to point at.
 */
export function threadingHeaders(messageId: string, parentIds: readonly string[]): Record<string, string> | null {
  if (messageId.startsWith(SYNTHETIC_ID_PREFIX) || /[\r\n]/.test(messageId)) return null;
  const inReplyTo = `<${messageId}>`;
  if (utf8Length(inReplyTo) > HEADER_VALUE_MAX_BYTES) return null;
  const ids = [...new Set([...parentIds, messageId])];
  const format = () => ids.map((value) => `<${value}>`).join(" ");
  while (ids.length > 2 && utf8Length(format()) > HEADER_VALUE_MAX_BYTES) ids.splice(1, 1);
  const references = utf8Length(format()) > HEADER_VALUE_MAX_BYTES ? inReplyTo : format();
  return { "In-Reply-To": inReplyTo, References: references };
}

export interface Acknowledgement {
  /** The send without custom headers; the fallback when they are refused. */
  base: EmailMessageBuilder;
  headers: Record<string, string>;
  /** The markdown body, for the dry-run log. */
  markdown: string;
}

export function buildAcknowledgement(input: {
  sender: string;
  intakeAddress: string;
  messageId: string;
  parentIds: readonly string[];
  appHostname: string;
  /** emailFrom(env): EMAIL_FROM / EMAIL_FROM_NAME. */
  from: { email: string; name: string };
  /** emailBrandName(env), for the shell's wordmark. */
  brandName: string;
}): Acknowledgement {
  const markdown = acknowledgementMarkdown();
  const threading = threadingHeaders(input.messageId, input.parentIds);
  return {
    base: {
      from: input.from,
      to: input.sender,
      // The intake address, so the client's reply lands back on the ticket.
      replyTo: input.intakeAddress,
      subject: ACK_SUBJECT,
      text: markdown,
      // External shell: clients can't sign in to Flow, so nothing links to it.
      html: renderEmailHtml(markdown, {
        audience: "external",
        appHostname: input.appHostname,
        brandName: input.brandName,
      }),
    },
    // RFC 3834: an automatic response says so, which keeps vacation
    // responders from answering it.
    headers: { ...threading, "Auto-Submitted": "auto-replied" },
    markdown,
  };
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return /\bE_HEADER\w*/.exec(errorMessage(err))?.[0] ?? "";
}

/** "Name <address>" for the dry-run log, whichever form the builder holds. */
function senderLabel(from: EmailMessageBuilder["from"]): string {
  return typeof from === "string" ? from : `${from.name ?? ""} <${from.email}>`.trim();
}

/** Send through SEND_EMAIL, retrying once without custom headers if the binding refuses them. */
export async function sendAcknowledgement(env: Env, ack: Acknowledgement, taskId: string): Promise<void> {
  if (env.EMAIL_DRY_RUN !== "false") {
    console.log(
      "[EMAIL_DRY_RUN] would send email intake acknowledgement:\n" +
        `  from:     ${senderLabel(ack.base.from)}\n` +
        `  to:       ${String(ack.base.to)}\n` +
        `  reply-to: ${String(ack.base.replyTo)}\n` +
        `  subject:  ${ack.base.subject}\n` +
        `  headers:  ${JSON.stringify(ack.headers)}\n` +
        `  task:     ${taskId}\n` +
        `  body (markdown):\n${ack.markdown}\n` +
        `  body (html):\n${ack.base.html ?? ""}`
    );
    return;
  }
  const binding = env.SEND_EMAIL;
  if (!binding) {
    throw new Error('EMAIL_DRY_RUN is off but the SEND_EMAIL binding is missing from wrangler.jsonc');
  }
  try {
    await binding.send({ ...ack.base, headers: ack.headers });
  } catch (err) {
    if (!errorCode(err).startsWith("E_HEADER")) throw err;
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "email intake ack: threading headers were refused; resending without them",
        taskId,
        code: errorCode(err),
      })
    );
    await binding.send(ack.base);
  }
}

// --- the handler --------------------------------------------------------------

type Refusal = Exclude<EmailIntakeCheck, { status: "ok" }>["status"];

/** Reject (or, for a duplicate, quietly accept) per the DO's verdict. */
function refuse(message: ForwardableEmailMessage, status: Refusal): void {
  if (status !== "duplicate") message.setReject(REJECT_REASONS[status]);
}

function logOutcome(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: "info", msg: "email intake", ...fields }));
}

async function readRaw(message: ForwardableEmailMessage): Promise<ArrayBuffer> {
  return new Response(message.raw).arrayBuffer();
}

function displayName(parsed: Email): string | undefined {
  return parsed.from && parsed.from.address !== undefined ? parsed.from.name : undefined;
}

/**
 * The dedupe key for mail without a Message-ID: headers the sender wrote,
 * which every redelivery repeats, plus the size. Never the raw bytes, which
 * carry per-delivery trace headers.
 */
export async function fallbackMessageId(headers: Headers, rawSize: number): Promise<string> {
  const stable = ["From", "Date", "Subject", "To"].map((name) => headers.get(name) ?? "");
  return `${SYNTHETIC_ID_PREFIX}${await sha256Hex(JSON.stringify([...stable, rawSize]))}`;
}

/**
 * In-Reply-To first, then References, deduped and capped: the ids the DO
 * matches a reply against. References lists the thread root first, so the cap
 * keeps the direct parent and the oldest ancestors.
 */
export function referenceIds(headers: Headers): string[] {
  return [
    ...new Set([...messageIdsIn(headers.get("In-Reply-To")), ...messageIdsIn(headers.get("References"))]),
  ].slice(0, MAX_REFERENCE_IDS);
}

/** The thread the original belongs to, root first: References, else In-Reply-To. */
function threadParentIds(headers: Headers): string[] {
  const references = messageIdsIn(headers.get("References"));
  return references.length > 0 ? references : messageIdsIn(headers.get("In-Reply-To"));
}

function buildIngestInput(
  base: Pick<IngestEmailInput, "alias" | "sender" | "messageId" | "authenticated">,
  headers: Headers,
  parsed: Email,
  plan: AttachmentPlan
): IngestEmailInput {
  const from = formatSender(displayName(parsed), base.sender);
  const body = bodyText(parsed);
  const notes: MessageNotes = { authenticated: base.authenticated, skippedAttachments: plan.skipped };
  const attachments = plan.uploads.map(({ bytes: _bytes, ...attachment }) => attachment);
  return {
    ...base,
    referenceIds: referenceIds(headers),
    task: { title: titleFromSubject(parsed.subject), description: formatDescription(from, body, notes) },
    commentBody: formatCommentBody(from, stripQuotedReply(body), attachments.length, notes),
    attachments,
  };
}

/** The DO's "no retry can fix this" refusals. Substring, since the DO proxy may wrap the message. */
export function isPermanentIngestError(err: unknown): boolean {
  return errorMessage(err).includes(EMAIL_INGEST_PERMANENT_ERROR);
}

type IngestOutcome =
  | IngestEmailResult
  | { status: "permanent"; error: string }
  | { status: "filed_before_error"; taskId: string };

/**
 * ingestEmail threw. A permanent refusal wrote nothing: drop the uploads and
 * reject. Anything else may be a transport failure after the turn committed,
 * so ask the DO: a duplicate means the message is filed and the uploads are
 * attached to it. Otherwise drop them and rethrow, so the sending server
 * retries; the dedupe record makes that safe. If the check fails too, nothing
 * says whether the uploads are referenced, so they stay (garbage at worst,
 * never a broken link) and the original error is rethrown.
 */
async function recoverFromIngestError(env: Env, input: IngestEmailInput, err: unknown): Promise<IngestOutcome> {
  if (isPermanentIngestError(err)) {
    await deleteUploads(env, input.attachments);
    return { status: "permanent", error: errorMessage(err) };
  }
  let check: EmailIntakeCheck;
  try {
    check = await workspace(env).checkEmailIntake({
      alias: input.alias,
      sender: input.sender,
      messageId: input.messageId,
    });
  } catch {
    console.error(
      JSON.stringify({
        level: "warn",
        msg: "email intake: ingest failed and its outcome is unknown; keeping uploads",
        alias: input.alias,
        attachments: input.attachments.length,
        attachmentIds: input.attachments.map((a) => a.id),
      })
    );
    throw err;
  }
  if (check.status === "duplicate") return { status: "filed_before_error", taskId: check.taskId };
  await deleteUploads(env, input.attachments);
  throw err;
}

/** Ingest, cleaning up the uploads whenever they didn't end up on a task. */
async function ingest(env: Env, input: IngestEmailInput, actor: Actor): Promise<IngestOutcome> {
  let result: IngestEmailResult;
  try {
    result = await workspace(env).ingestEmail(input, actor);
  } catch (err) {
    return recoverFromIngestError(env, input, err);
  }
  if (result.status !== "created" && result.status !== "commented") await deleteUploads(env, input.attachments);
  return result;
}

/**
 * The Worker's `email()` handler. Cheap checks first: nothing is read,
 * parsed or uploaded until the DO has said this alias exists, this sender may
 * use it, they are under the hourly limits, and the message is new.
 */
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const alias = parseAlias(message.to);
  const sender = normalizeSender(message.from);
  const kind = classifyMail(sender, message.headers);
  if (kind === "bounce" || kind === "auto_reply") {
    logOutcome({ alias, status: "dropped", kind });
    return;
  }

  const messageId =
    normalizeMessageId(message.headers.get("Message-ID")) ??
    (await fallbackMessageId(message.headers, message.rawSize));

  const check = await workspace(env).checkEmailIntake({ alias, sender, messageId });
  if (check.status !== "ok") {
    refuse(message, check.status);
    logOutcome({ alias, status: check.status, stage: "check" });
    return;
  }

  let parsed: Email;
  try {
    parsed = await PostalMime.parse(await readRaw(message), PARSE_OPTIONS);
  } catch (err) {
    message.setReject(UNREADABLE_REJECT);
    logOutcome({ alias, status: "unparseable", error: errorMessage(err) });
    return;
  }

  const auth = senderAuthentication(parsed.headers, sender);
  // Once per message, until real Cloudflare-routed headers have confirmed the parser.
  console.log(
    JSON.stringify({
      level: "info",
      msg: "email intake auth",
      alias,
      authenticated: auth.authenticated,
      via: auth.via,
      ...authenticationLog(parsed.headers),
      inHeadersObject: AUTH_RESULTS_HEADERS.filter((name) => message.headers.has(name)),
    })
  );

  // The owner can write every space; an api key's user might not.
  const owner = await findOwnerActor(env);
  if (owner === null) {
    throw new Error("email intake has no identity to act as: OWNER_EMAIL names no workspace user");
  }
  const { actor } = owner;

  const plan = planAttachments(parsed, (await sha256Hex(messageId)).slice(0, 16));
  await uploadAttachments(env, plan.uploads, actor);
  const input = buildIngestInput(
    { alias, sender, messageId, authenticated: auth.authenticated },
    message.headers,
    parsed,
    plan
  );
  const counts = {
    attachments: input.attachments.length,
    attachmentIds: input.attachments.map((a) => a.id),
    skippedAttachments: plan.skipped,
    inlineImagesDropped: plan.inlineDropped,
  };
  const result = await ingest(env, input, actor);
  if (result.status === "permanent") {
    message.setReject(PERMANENT_REJECT);
    logOutcome({ alias, status: "rejected", stage: "ingest", error: result.error, ...counts });
    return;
  }
  if (result.status === "filed_before_error") {
    logOutcome({ alias, status: "duplicate", stage: "ingest_error", taskId: result.taskId, ...counts });
    return;
  }
  if (result.status !== "created" && result.status !== "commented") {
    refuse(message, result.status);
    logOutcome({ alias, status: result.status, stage: "ingest", ...counts });
    return;
  }

  // Only to a sender Cloudflare authenticated: anything else may be someone
  // else's address, and the ack would be mail we sent them unasked. And only
  // once EMAIL_INTAKE_ACK is on, i.e. after the auth parser has been checked
  // against real Cloudflare headers.
  const acknowledge =
    result.status === "created" &&
    kind === "personal" &&
    auth.authenticated &&
    env.EMAIL_INTAKE_ACK === "true";
  logOutcome({
    alias,
    status: result.status,
    taskId: result.taskId,
    listId: result.listId,
    authenticated: auth.authenticated,
    ...counts,
    acknowledge,
  });
  if (!acknowledge) return;

  const ack = buildAcknowledgement({
    sender,
    intakeAddress: message.to,
    messageId,
    parentIds: threadParentIds(message.headers),
    appHostname: env.APP_HOSTNAME,
    from: emailFrom(env),
    brandName: emailBrandName(env),
  });
  // After the ingest has committed, and outside the SMTP response: a failed
  // ack is logged and never turns a filed ticket into a retry.
  ctx.waitUntil(
    sendAcknowledgement(env, ack, result.taskId).catch((err: unknown) => {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "email intake ack failed",
          alias,
          taskId: result.taskId,
          code: errorCode(err) || undefined,
          error: errorMessage(err),
        })
      );
    })
  );
}
