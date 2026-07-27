import { InboundTaskInput } from "@flow/shared";

/**
 * Best-effort mapper for third-party bug-report webhooks, Gleap in particular.
 *
 * Gleap posts a loosely-shaped envelope: some fields at the top level, the
 * interesting ones nested under `data`, share links under keys like `shareURL`
 * or `dashboardURL`, and a long tail of metadata (session, device, browser,
 * custom form fields) that differs per project and per Gleap version. Rather
 * than model that surface, we pull out the four things a task needs and preserve
 * everything else verbatim as a fenced JSON block in the description, so nothing
 * from the report is silently dropped.
 *
 * Pure function, no I/O — the unit tests cover it directly.
 */

/** Keys checked, in order, for the task title. */
const TITLE_KEYS = ["title", "subject", "name", "summary", "headline"] as const;
/** Keys checked, in order, for the task description body. */
const DESCRIPTION_KEYS = [
  "description",
  "message",
  "text",
  "body",
  "content",
  "comment",
  "details",
] as const;
/** Keys checked, in order, for the idempotency key. */
const EXTERNAL_ID_KEYS = [
  "externalId",
  "external_id",
  "shareToken",
  "bugId",
  "ticketId",
  "feedbackId",
  "id",
  "_id",
] as const;
/** Nested containers merged into the search space, in order of increasing priority. */
const NESTED_KEYS = ["data", "payload", "feedback", "bug", "ticket", "formData"] as const;

const MAX_DESCRIPTION_CHARS = 60_000;

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstNonEmptyString(source: Rec, keys: readonly string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") {
      return { key, value: value.trim() };
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return { key, value: String(value) };
    }
  }
  return null;
}

/** Any key ending in "url"/"link", whose value parses as an http(s) URL. */
function findExternalUrl(source: Rec): { key: string; value: string } | null {
  for (const [key, value] of Object.entries(source)) {
    if (!/(url|link|href)$/i.test(key)) continue;
    if (typeof value !== "string" || value.trim() === "") continue;
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return { key, value: parsed.toString() };
      }
    } catch {
      // Not a URL; keep looking. The value still survives in the JSON block.
    }
  }
  return null;
}

function collectTags(source: Rec, consumed: Set<string>): string[] {
  const tags = new Set<string>(["gleap"]);
  for (const key of ["tags", "labels"]) {
    const value = source[key];
    if (!Array.isArray(value)) continue;
    consumed.add(key);
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim() !== "") tags.add(entry.trim());
    }
  }
  // Gleap's report type ("BUG", "CRASH", "FEATURE_REQUEST") is a useful tag.
  const type = source["type"];
  if (typeof type === "string" && type.trim() !== "" && type.length <= 40) {
    consumed.add("type");
    tags.add(type.trim().toLowerCase());
  }
  return [...tags];
}

/**
 * Flatten the envelope into one lookup space. Top-level keys win on identity
 * (id, url), nested `data`/`formData` keys win on content, which matches how
 * Gleap actually populates the payload.
 */
function flatten(raw: Rec): { flat: Rec; leftovers: Rec } {
  const flat: Rec = { ...raw };
  const leftovers: Rec = {};

  for (const [key, value] of Object.entries(raw)) {
    if ((NESTED_KEYS as readonly string[]).includes(key) && isRecord(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        // Nested content overrides a top-level placeholder, but never clobbers
        // a top-level value with an empty nested one.
        const isContentKey =
          (TITLE_KEYS as readonly string[]).includes(nestedKey) ||
          (DESCRIPTION_KEYS as readonly string[]).includes(nestedKey);
        const nestedIsEmpty =
          nestedValue === null ||
          nestedValue === undefined ||
          (typeof nestedValue === "string" && nestedValue.trim() === "");
        if (nestedIsEmpty) continue;
        if (isContentKey || !(nestedKey in flat)) flat[nestedKey] = nestedValue;
        else leftovers[`${key}.${nestedKey}`] = nestedValue;
      }
    }
  }
  return { flat, leftovers };
}

/** Render the unconsumed fields as a fenced JSON block, or "" if there are none. */
function renderLeftovers(leftovers: Rec): string {
  const keys = Object.keys(leftovers).sort();
  if (keys.length === 0) return "";
  const ordered: Rec = {};
  for (const key of keys) ordered[key] = leftovers[key];
  let json: string;
  try {
    json = JSON.stringify(ordered, null, 2);
  } catch {
    return "";
  }
  return `\n\n---\n\n**Reported payload**\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

export type GleapMapping = InboundTaskInput & {
  /** True when the payload already matched InboundTaskInput exactly. */
  native: boolean;
};

/**
 * Map an arbitrary webhook body to an InboundTaskInput.
 *
 * Tries the native contract shape first; anything else goes through the
 * best-effort Gleap mapping. Throws only when the body is not a JSON object.
 */
export function mapInboundPayload(raw: unknown): GleapMapping {
  if (!isRecord(raw)) {
    throw new Error(
      `inbound payload must be a JSON object, received ${Array.isArray(raw) ? "an array" : typeof raw}`
    );
  }

  const native = InboundTaskInput.safeParse(raw);
  if (native.success) return { ...native.data, native: true };

  return { ...mapGleapPayload(raw), native: false };
}

/**
 * The Gleap-shaped fallback. Exported separately so tests can target it without
 * going through the native-shape check.
 */
export function mapGleapPayload(raw: Rec): InboundTaskInput {
  const { flat, leftovers: nestedLeftovers } = flatten(raw);
  const consumed = new Set<string>([...NESTED_KEYS]);

  const titleHit = firstNonEmptyString(flat, TITLE_KEYS);
  if (titleHit) consumed.add(titleHit.key);

  const descriptionHit = firstNonEmptyString(flat, DESCRIPTION_KEYS);
  if (descriptionHit) consumed.add(descriptionHit.key);

  const urlHit = findExternalUrl(flat);
  if (urlHit) consumed.add(urlHit.key);

  const externalIdHit = firstNonEmptyString(flat, EXTERNAL_ID_KEYS);
  if (externalIdHit) consumed.add(externalIdHit.key);

  const tags = collectTags(flat, consumed);

  // A title is mandatory, so fall back to the first line of the description and
  // finally to a fixed label — an unnamed report is still worth capturing.
  let title = titleHit?.value ?? "";
  if (title === "" && descriptionHit) {
    title = descriptionHit.value.split("\n")[0]?.trim().slice(0, 120) ?? "";
  }
  if (title === "") title = "Untitled Gleap report";
  if (title.length > 200) title = `${title.slice(0, 197)}...`;

  const leftovers: Rec = { ...nestedLeftovers };
  for (const [key, value] of Object.entries(flat)) {
    if (consumed.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    leftovers[key] = value;
  }

  const parts: string[] = [];
  if (descriptionHit) parts.push(descriptionHit.value);
  if (urlHit) parts.push(`[View in Gleap](${urlHit.value})`);
  parts.push(renderLeftovers(leftovers));
  let description = parts.filter((p) => p !== "").join("\n\n").trim();
  if (description.length > MAX_DESCRIPTION_CHARS) {
    description = `${description.slice(0, MAX_DESCRIPTION_CHARS)}\n\n_(payload truncated)_`;
  }

  // Deliberately no `status`: Gleap's own state vocabulary ("OPEN", "DONE")
  // has nothing to do with the target list's statuses, and guessing would fail
  // task creation. Inbound tasks land in the list's open status.
  const mapped: InboundTaskInput = { title, description, tags };
  if (externalIdHit) mapped.externalId = externalIdHit.value;
  if (urlHit) mapped.externalUrl = urlHit.value;

  return mapped;
}
