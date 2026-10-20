// Email intake: the DO half. The api Worker's email() handler parses the
// message, uploads attachments to R2 and formats the text; the DO decides what
// the message is (a new ticket, a reply to one, a duplicate, or unwelcome) and
// writes the outcome together with its dedupe record in a single turn, so a
// redelivered message can never produce a second task or comment.

/** Messages one sender may file per hour, across every intake. */
export const EMAIL_INTAKE_HOURLY_LIMIT = 20;
/**
 * Messages one intake (list) accepts per hour across all senders. An
 * "@domain" allowlist entry admits unlimited local parts, each with its own
 * per-sender budget, so this is the cap that actually bounds a flood.
 */
export const EMAIL_INTAKE_LIST_HOURLY_LIMIT = 60;
/** Every task opened by email carries this tag. */
export const EMAIL_INTAKE_TAG = "email";
/**
 * Added to a task opened by mail whose sender Cloudflare couldn't
 * authenticate (no aligned DMARC/DKIM/SPF pass). The allowlist matched, but the
 * envelope sender may be forged, so it gets no acknowledgement either.
 */
export const EMAIL_INTAKE_UNVERIFIED_TAG = "unverified";

/** An attachment the Worker has already written to R2. */
export interface EmailIngestAttachment {
  id: string;
  r2Key: string;
  filename: string;
  size: number;
  mimeType: string;
}

export interface IngestEmailInput {
  /** Lowercased local part of the envelope recipient. */
  alias: string;
  /** Lowercased envelope sender (MAIL FROM). Only trustworthy when `authenticated`. */
  sender: string;
  /**
   * Cloudflare's own authentication results showed an aligned pass for the
   * sender's domain. When false, a new task is tagged EMAIL_INTAKE_UNVERIFIED_TAG.
   */
  authenticated: boolean;
  /** Message-ID without angle brackets; the dedupe key. */
  messageId: string;
  /** In-Reply-To and References ids, without angle brackets, for threading. */
  referenceIds: string[];
  /** Used when the message opens a new ticket. Already within LIMITS. */
  task: { title: string; description: string };
  /** Used when it replies to an existing ticket. Already within LIMITS. */
  commentBody: string;
  attachments: EmailIngestAttachment[];
}

/** The cheap pre-check the Worker runs before parsing or uploading anything. */
export type EmailIntakeCheck =
  | { status: "ok"; listId: string }
  | { status: "unknown_alias" }
  | { status: "sender_not_allowed" }
  | { status: "rate_limited" }
  | { status: "duplicate"; taskId: string };

export type IngestEmailResult =
  | { status: "created"; taskId: string; listId: string }
  | { status: "commented"; taskId: string; commentId: string; listId: string }
  | Exclude<EmailIntakeCheck, { status: "ok" }>;

/**
 * Whether `sender` matches an allowlist entry: "@example.com" admits exactly
 * that domain (subdomains must be listed on their own), "name@example.com"
 * exactly that address. Both sides are compared lowercased.
 */
export function senderAllowed(sender: string, allowedSenders: readonly string[]): boolean {
  const address = sender.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return false;
  const domain = address.slice(at);
  return allowedSenders.some((entry) => {
    const rule = entry.trim().toLowerCase();
    return rule.startsWith("@") ? rule === domain : rule === address;
  });
}

/** "<abc@x>" → "abc@x"; blank or missing → null. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const id = raw.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
  return id === "" ? null : id;
}

/** Every message id in an In-Reply-To or References header value. */
export function messageIdsIn(header: string | null | undefined): string[] {
  if (!header) return [];
  const found = header.match(/<[^<>\s]+>/g) ?? [];
  return [...new Set(found.map((id) => id.slice(1, -1)))];
}
