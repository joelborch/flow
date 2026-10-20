/// <reference types="@cloudflare/workers-types" />
// Threading and sending for mail Flow writes back to the person who emailed a
// ticket in: the intake acknowledgement (./email-intake.ts) and the comments a
// person chooses to email back (./side-effects). Kept apart from both so
// neither has to import the other.

import { SYNTHETIC_ID_PREFIX } from "@flow/core/email-intake";

/** Email Service caps each custom header value at 2,048 bytes. */
export const HEADER_VALUE_MAX_BYTES = 2048;

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** A message id that can go inside angle brackets in a header: no whitespace, brackets or synthetic key. */
function headerSafeId(value: string): boolean {
  return value !== "" && !value.startsWith(SYNTHETIC_ID_PREFIX) && !/[\s<>]/.test(value);
}

/**
 * In-Reply-To and References, so the requester's reply carries the ticket's
 * Message-IDs in its References and threads back onto it. When the chain
 * outgrows the header value cap, ids are dropped from the middle: RFC 5322
 * §3.6.4 keeps the thread's first id and its newest ones. Null when there is
 * no real Message-ID to point at.
 */
export function threadingHeaders(messageId: string, parentIds: readonly string[]): Record<string, string> | null {
  if (!headerSafeId(messageId)) return null;
  const inReplyTo = `<${messageId}>`;
  if (utf8Length(inReplyTo) > HEADER_VALUE_MAX_BYTES) return null;
  const ids = [...new Set([...parentIds.filter(headerSafeId), messageId])];
  const format = () => ids.map((value) => `<${value}>`).join(" ");
  while (ids.length > 2 && utf8Length(format()) > HEADER_VALUE_MAX_BYTES) ids.splice(1, 1);
  const references = utf8Length(format()) > HEADER_VALUE_MAX_BYTES ? inReplyTo : format();
  return { "In-Reply-To": inReplyTo, References: references };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The Email Service error code (E_HEADER_…, E_RATE_LIMIT…), or "" when there isn't one. */
export function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return /\bE_HEADER\w*/.exec(errorMessage(err))?.[0] ?? "";
}

/**
 * Send with custom headers, and once more without them if the binding refuses
 * a header: mail that lands outside the thread beats mail that never lands.
 * `onHeadersRefused` gets the refusal's code so the caller can log it.
 */
export async function sendWithHeaders(
  binding: SendEmail,
  base: EmailMessageBuilder,
  headers: Record<string, string>,
  onHeadersRefused: (code: string) => void
): Promise<void> {
  try {
    await binding.send({ ...base, headers });
  } catch (err) {
    const code = errorCode(err);
    if (!code.startsWith("E_HEADER")) throw err;
    onHeadersRefused(code);
    await binding.send(base);
  }
}
