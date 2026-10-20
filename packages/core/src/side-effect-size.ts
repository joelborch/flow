// ---------------------------------------------------------------------------
// Fitting outbound side effects into Cloudflare Queues' size limits.
//
// Queues caps every message at 128KB and every sendBatch call at 100 messages
// / 256KB, and one over-limit message makes sendBatch reject the WHOLE call —
// notification emails batched alongside it included. The api Worker's
// compatibility date (after 2024-03-18) makes `json` the default content type,
// so the size that counts is the UTF-8 byte length of JSON.stringify(body),
// not the UTF-16 `.length`.
//
// A task_created webhook carries the description four times (delta.data,
// task, payload.description, payload.text_content), so a ~35KB Gleap bug
// report is already over the per-message cap. Rather than drop it, the long
// strings in the message content are cut down to a shared byte cap with a
// visible marker, and the webhook envelope gets `truncated: true`.
// ---------------------------------------------------------------------------

/** Queue.sendBatch's hard cap on messages per call. */
export const SIDE_EFFECTS_BATCH_SIZE = 100;
/**
 * Queues caps a sendBatch call at 256KB total. Budget 200KB of serialized
 * UTF-8 JSON per chunk; the 56KB margin absorbs the per-message envelope the
 * queue adds on top of each body.
 */
export const SIDE_EFFECTS_BATCH_BYTES = 200 * 1024;
/**
 * Queues caps a single message at 128KB. Budget 120KB so the queue's own
 * per-message envelope still fits; anything bigger is shrunk before enqueueing.
 */
export const SIDE_EFFECTS_MESSAGE_BYTES = 120 * 1024;
/** Appended to every string the shrink pass cuts, so a reader can tell. */
export const TRUNCATION_MARKER =
  "\n\n[…truncated by Flow: too large to deliver in full; open the task for the complete text]";
/**
 * Strings at or under this many JSON bytes are never cut, so ids, urls,
 * titles, statuses and tags always arrive intact. If the cap would have to
 * drop below it, the payload is reported undeliverable instead.
 */
const MIN_TRUNCATED_FIELD_BYTES = 1024;

const utf8 = new TextEncoder();

/** UTF-8 bytes of the JSON the queue will actually carry for `value`. */
export function sideEffectBytes(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).byteLength;
}

/**
 * Returns the payload unchanged when it fits the per-message budget, a
 * shrunk copy when truncating its content strings makes it fit, or `null`
 * when it cannot be made to fit. `bytes` is the size of whatever was returned
 * (or of the best attempt, for `null`).
 */
export function fitSideEffect<T>(payload: T): { payload: T | null; bytes: number } {
  const bytes = sideEffectBytes(payload);
  if (bytes <= SIDE_EFFECTS_MESSAGE_BYTES) return { payload, bytes };
  const shrunk = shrinkSideEffect(payload);
  if (shrunk === null) return { payload: null, bytes };
  const shrunkBytes = sideEffectBytes(shrunk);
  // The cap arithmetic below is exact, but re-measure so a miscount can only
  // ever cost a delivery, never a whole rejected sendBatch.
  return shrunkBytes <= SIDE_EFFECTS_MESSAGE_BYTES
    ? { payload: shrunk, bytes: shrunkBytes }
    : { payload: null, bytes: shrunkBytes };
}

/**
 * Split a turn's side effects into sendBatch-sized chunks: at most 100
 * messages AND at most ~200KB of serialized payload per chunk, with every
 * message first fitted to the 120KB per-message budget. A payload that still
 * cannot fit is left out of every chunk and handed to `onUndeliverable`, so
 * the caller can record it; sending it would reject its whole chunk.
 */
export function chunkSideEffects<T>(
  payloads: readonly T[],
  onUndeliverable?: (payload: T, bytes: number) => void
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  const flushCurrent = (): void => {
    if (current.length > 0) chunks.push(current);
    current = [];
    currentBytes = 0;
  };
  for (const original of payloads) {
    const { payload, bytes } = fitSideEffect(original);
    if (payload === null) {
      console.error(
        `side effect payload is ${bytes} bytes even after truncation, over the ${SIDE_EFFECTS_MESSAGE_BYTES}-byte message budget; not enqueued`,
        describePayload(original)
      );
      onUndeliverable?.(original, bytes);
      continue;
    }
    if (payload !== original) {
      console.warn(
        `side effect payload truncated to ${bytes} bytes to fit the ${SIDE_EFFECTS_MESSAGE_BYTES}-byte message budget`,
        describePayload(original)
      );
    }
    if (
      current.length >= SIDE_EFFECTS_BATCH_SIZE ||
      currentBytes + bytes > SIDE_EFFECTS_BATCH_BYTES
    ) {
      flushCurrent();
    }
    current.push(payload);
    currentBytes += bytes;
  }
  flushCurrent();
  return chunks;
}

function describePayload(payload: unknown): Record<string, unknown> {
  const p = isRecord(payload) ? payload : {};
  return { kind: p["kind"], ruleId: p["ruleId"], taskId: p["taskId"] };
}

/**
 * Cut the long strings in a webhook's envelope (or an email's subject/body)
 * down to one shared byte cap — the largest cap that makes the whole message
 * fit. Routing fields (url, secret, recipients, ruleId, taskId, kind) are
 * never touched, and the envelope keeps every key it had, so receivers that
 * parse it keep working; webhooks additionally get `truncated: true`.
 */
function shrinkSideEffect<T>(payload: T): T | null {
  if (!isRecord(payload)) return null;
  const contentKeys =
    payload["kind"] === "webhook" ? ["body"] : payload["kind"] === "email" ? ["subject", "body"] : [];
  if (contentKeys.length === 0) return null;

  const draft: Record<string, unknown> = { ...payload };
  const envelope = draft["body"];
  if (payload["kind"] === "webhook" && isRecord(envelope)) {
    draft["body"] = { ...envelope, truncated: true };
  }

  const sizes: number[] = [];
  for (const key of contentKeys) collectLongStrings(draft[key], sizes);
  // Every string contributes exactly its own JSON bytes to the whole, so the
  // bytes outside the cuttable strings are fixed regardless of the cap.
  const fixed = sideEffectBytes(draft) - sizes.reduce((a, b) => a + b, 0);
  const cap = waterLevel(sizes, SIDE_EFFECTS_MESSAGE_BYTES - fixed);
  if (cap === null || cap < MIN_TRUNCATED_FIELD_BYTES) return null;
  for (const key of contentKeys) draft[key] = capStrings(draft[key], cap);
  return draft as T;
}

/** JSON sizes of every string in `value` long enough to be cut. */
function collectLongStrings(value: unknown, out: number[]): void {
  if (typeof value === "string") {
    const bytes = jsonStringBytes(value);
    if (bytes > MIN_TRUNCATED_FIELD_BYTES) out.push(bytes);
  } else if (Array.isArray(value)) {
    for (const item of value) collectLongStrings(item, out);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) collectLongStrings(item, out);
  }
}

/**
 * The largest cap `c` with sum(min(size, c)) <= room: strings smaller than
 * the level keep their full length, the rest share what is left equally.
 * Null when there is no room at all.
 */
function waterLevel(sizes: readonly number[], room: number): number | null {
  if (room <= 0 || sizes.length === 0) return null;
  const sorted = [...sizes].sort((a, b) => a - b);
  let remaining = room;
  for (let i = 0; i < sorted.length; i++) {
    const size = sorted[i] ?? 0;
    const left = sorted.length - i;
    if (size * left <= remaining) {
      remaining -= size;
      continue;
    }
    return Math.floor(remaining / left);
  }
  return Number.MAX_SAFE_INTEGER; // everything fits whole
}

function capStrings(value: unknown, cap: number): unknown {
  if (typeof value === "string") {
    return jsonStringBytes(value) > cap ? truncateToJsonBytes(value, cap) : value;
  }
  if (Array.isArray(value)) return value.map((item) => capStrings(item, cap));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = capStrings(item, cap);
    return out;
  }
  return value;
}

/** Longest prefix of `s` that, with the marker, serializes to <= maxBytes. */
function truncateToJsonBytes(s: string, maxBytes: number): string {
  const room = maxBytes - jsonStringBytes(TRUNCATION_MARKER);
  let used = 2; // the surrounding quotes
  let end = 0;
  for (const ch of s) {
    const cost = jsonCharBytes(ch.codePointAt(0) ?? 0);
    if (used + cost > room) break;
    used += cost;
    end += ch.length;
  }
  return s.slice(0, end) + TRUNCATION_MARKER;
}

/** UTF-8 bytes of JSON.stringify(s), without allocating the encoding. */
function jsonStringBytes(s: string): number {
  let bytes = 2;
  for (const ch of s) bytes += jsonCharBytes(ch.codePointAt(0) ?? 0);
  return bytes;
}

/** UTF-8 bytes one code point costs inside a JSON.stringify string literal. */
function jsonCharBytes(code: number): number {
  if (code === 0x22 || code === 0x5c) return 2; // \" and \\
  if (code < 0x20) {
    // \b \t \n \f \r get two-character escapes; the rest are \u00XX.
    return code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
  }
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdfff) return 6; // lone surrogate, escaped as \uDXXX
  if (code < 0x10000) return 3;
  return 4;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
