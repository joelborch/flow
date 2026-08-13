import { InboundTaskInput } from "@flow/shared";

/**
 * Gleap's ticket.created event is a ticket object, not the small generic
 * webhook shape Flow accepts natively. Keep the source metadata beside the
 * mapped task so the inbound route can reconcile the rendered screenshot.
 */
export type GleapSource = {
  ticketId: string;
  projectId: string | null;
  legacyExternalIds: string[];
  screenshotUrl: string | null;
  screenshotPending: boolean;
  screenshotFailed: boolean;
};

export type GleapTaskInput = InboundTaskInput & {
  gleap: GleapSource | null;
};

export type GleapMapping = GleapTaskInput & {
  /** True when the payload matched InboundTaskInput rather than Gleap. */
  native: boolean;
};

const TITLE_KEYS = ["title", "subject", "name", "summary", "headline"] as const;
const DESCRIPTION_KEYS = [
  "description",
  "message",
  "text",
  "body",
  "content",
  "comment",
  "details",
] as const;
const EXTERNAL_ID_KEYS = [
  "externalId",
  "external_id",
  "ticketId",
  "feedbackId",
  "id",
  "_id",
  "bugId",
  "shareToken",
] as const;
const NESTED_KEYS = ["data", "payload", "feedback", "bug", "ticket", "formData"] as const;
const GLEAP_CONTAINER_KEYS = ["data", "payload", "feedback", "bug", "ticket"] as const;
const GLEAP_URL_KEYS = [
  "dashboardURL",
  "dashboardUrl",
  "ticketURL",
  "ticketUrl",
  "reportURL",
  "reportUrl",
  "shareURL",
  "shareUrl",
] as const;
const MAX_DESCRIPTION_CHARS = 60_000;
const MAX_GLEAP_TITLE_CHARS = 120;

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function firstNonEmptyString(
  source: Rec,
  keys: readonly string[]
): { key: string; value: string } | null {
  for (const key of keys) {
    const value = asString(source[key]);
    if (value !== "") return { key, value };
  }
  return null;
}

function nestedString(source: Rec, path: readonly string[]): string {
  let current: unknown = source;
  for (const key of path) {
    if (!isRecord(current)) return "";
    current = current[key];
  }
  return asString(current);
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  const codePoint = (match: string, digits: string, radix: number): string => {
    const parsed = Number.parseInt(digits, radix);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0x10ffff
      ? String.fromCodePoint(parsed)
      : match;
  };
  return value
    .replace(/&#(\d+);/g, (match, digits: string) => codePoint(match, digits, 10))
    .replace(/&#x([0-9a-f]+);/gi, (match, digits: string) => codePoint(match, digits, 16))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match)
    .replace(/\r\n/g, "\n")
    .trim();
}

function truncateTitle(value: string): string {
  if (value.length <= MAX_GLEAP_TITLE_CHARS) return value;
  return `${value.slice(0, MAX_GLEAP_TITLE_CHARS - 3)}...`;
}

function validHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function firstNamedUrl(source: Rec, keys: readonly string[]): string | null {
  for (const key of keys) {
    const url = validHttpUrl(source[key]);
    if (url !== null) return url;
  }
  return null;
}

function looksLikeGleapTicket(source: Rec): boolean {
  const event = asString(source["event"]);
  return (
    event.startsWith("ticket.") ||
    "bugId" in source ||
    "screenshotDataUrl" in source ||
    "screenshotUrl" in source ||
    "generatingScreenshot" in source ||
    isRecord(source["form"])
  );
}

function findGleapTicket(raw: Rec): Rec | null {
  for (const key of GLEAP_CONTAINER_KEYS) {
    const nested = raw[key];
    if (isRecord(nested) && looksLikeGleapTicket(nested)) return nested;
  }
  return looksLikeGleapTicket(raw) ? raw : null;
}

function collectTags(source: Rec, consumed?: Set<string>): string[] {
  const tags = new Set<string>(["gleap"]);
  for (const key of ["tags", "labels"]) {
    const value = source[key];
    if (!Array.isArray(value)) continue;
    consumed?.add(key);
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim() !== "") tags.add(entry.trim());
    }
  }
  const type = asString(source["type"]);
  if (type !== "" && type.length <= 40) {
    consumed?.add("type");
    tags.add(type.toLowerCase());
  }
  return [...tags];
}

function reporterLabel(ticket: Rec): string {
  const session = isRecord(ticket["session"]) ? ticket["session"] : {};
  const name = asString(session["name"]);
  const email = asString(session["email"]);
  if (name !== "" && email !== "") return `${name} (${email})`;
  if (name !== "") return name;
  if (email !== "") return `Guest (${email})`;
  return "Guest";
}

function priorityLabel(value: string): string {
  const normalized = value.toUpperCase();
  if (normalized === "HIGH") return "🔴 High";
  if (normalized === "MEDIUM") return "🟠 Medium";
  if (normalized === "LOW") return "🟢 Low";
  return value;
}

function renderGleapDescription(ticket: Rec, reportText: string): string {
  const info: string[] = [`**Reported by:** ${reporterLabel(ticket)}`];
  const session = isRecord(ticket["session"]) ? ticket["session"] : {};
  const location = isRecord(session["location"]) ? session["location"] : {};
  const country = asString(location["country"]);
  const priority = asString(ticket["priority"]);
  const internalId = asString(ticket["id"]) || asString(ticket["_id"]);
  const type = asString(ticket["type"]);
  if (country !== "") info.push(`**Location:** ${country}`);
  if (priority !== "") info.push(`**Priority:** ${priorityLabel(priority)}`);
  if (internalId !== "") info.push(`**Internal ID:** ${internalId}`);
  if (type !== "") info.push(`**Type:** 🚨 ${type.toUpperCase()}`);

  const shareUrl = firstNamedUrl(ticket, ["shareURL", "shareUrl"]);
  const dashboardUrl = firstNamedUrl(ticket, [
    "dashboardURL",
    "dashboardUrl",
    "ticketURL",
    "ticketUrl",
    "reportURL",
    "reportUrl",
  ]);
  if (shareUrl !== null) info.push(`[Open share link](${shareUrl})`);
  if (dashboardUrl !== null) info.push(`[Open ticket in Gleap](${dashboardUrl})`);

  const metadata = isRecord(ticket["metaData"])
    ? ticket["metaData"]
    : isRecord(ticket["metadata"])
      ? ticket["metadata"]
      : {};
  const metadataFields: Array<[string, string]> = [
    ["browserName", asString(metadata["browserName"])],
    ["userAgent", asString(metadata["userAgent"])],
    ["browser", asString(metadata["browser"])],
    ["systemName", asString(metadata["systemName"])],
    ["sessionDuration", asString(metadata["sessionDuration"])],
    ["devicePixelRatio", asString(metadata["devicePixelRatio"])],
    ["screenWidth", asString(metadata["screenWidth"])],
    ["screenHeight", asString(metadata["screenHeight"])],
    ["innerWidth", asString(metadata["innerWidth"])],
    ["innerHeight", asString(metadata["innerHeight"])],
    ["currentUrl", asString(metadata["currentUrl"])],
    ["language", asString(metadata["language"])],
    ["mobile", typeof metadata["mobile"] === "boolean" ? String(metadata["mobile"]) : ""],
    ["sdkVersion", asString(metadata["sdkVersion"])],
    ["sdkType", asString(metadata["sdkType"])],
    ["environment", asString(metadata["environment"])],
  ];
  const renderedMetadata = metadataFields
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `**${key}:** ${value}`);

  const sections = ["Description:", reportText || "No description provided.", "", "Info", ...info];
  if (renderedMetadata.length > 0) sections.push("", "Metadata", ...renderedMetadata);
  return sections.join("\n");
}

function mapKnownGleapTicket(ticket: Rec): GleapTaskInput {
  const reportText = decodeHtmlEntities(
    nestedString(ticket, ["form", "description", "value"]) ||
      nestedString(ticket, ["formData", "description"]) ||
      asString(ticket["plainContent"]) ||
      asString(ticket["description"])
  );
  const explicitTitle = decodeHtmlEntities(firstNonEmptyString(ticket, TITLE_KEYS)?.value ?? "");
  const firstLine = (reportText || explicitTitle).split("\n")[0]?.trim() ?? "";
  const bugId = asString(ticket["bugId"]);
  const prefix = bugId === "" ? "" : `[${bugId}] `;
  const title = truncateTitle(`${prefix}${firstLine || "Untitled Gleap report"}`);

  const ticketId =
    asString(ticket["id"]) ||
    asString(ticket["_id"]) ||
    asString(ticket["ticketId"]) ||
    bugId;
  const shareToken = asString(ticket["shareToken"]);
  const externalId = ticketId || shareToken;
  const projectId = asString(ticket["projectId"]) || asString(ticket["project"]);
  const screenshotUrl = validHttpUrl(ticket["screenshotUrl"]);
  const externalUrl = firstNamedUrl(ticket, GLEAP_URL_KEYS);

  const mapped: GleapTaskInput = {
    title,
    description: renderGleapDescription(ticket, reportText || explicitTitle),
    tags: collectTags(ticket),
    gleap: {
      ticketId: ticketId || externalId,
      projectId: projectId || null,
      legacyExternalIds:
        shareToken !== "" && shareToken !== externalId ? [shareToken] : [],
      screenshotUrl,
      screenshotPending: ticket["generatingScreenshot"] === true,
      screenshotFailed: ticket["screenshotRenderingFailed"] === true,
    },
  };
  if (externalId !== "") mapped.externalId = externalId;
  if (externalUrl !== null) mapped.externalUrl = externalUrl;
  return mapped;
}

/** Flatten a generic webhook envelope into one lookup space. */
function flatten(raw: Rec): { flat: Rec; leftovers: Rec } {
  const flat: Rec = { ...raw };
  const leftovers: Rec = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(NESTED_KEYS as readonly string[]).includes(key) || !isRecord(value)) continue;
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
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
  return { flat, leftovers };
}

function findExternalUrl(source: Rec): { key: string; value: string } | null {
  for (const [key, value] of Object.entries(source)) {
    if (!/(url|link|href)$/i.test(key)) continue;
    const url = validHttpUrl(value);
    if (url !== null) return { key, value: url };
  }
  return null;
}

function renderLeftovers(leftovers: Rec): string {
  const keys = Object.keys(leftovers).sort();
  if (keys.length === 0) return "";
  const ordered: Rec = {};
  for (const key of keys) ordered[key] = leftovers[key];
  try {
    return `\n\n---\n\n**Reported payload**\n\n\`\`\`json\n${JSON.stringify(ordered, null, 2)}\n\`\`\`\n`;
  } catch {
    return "";
  }
}

/** Preserve the old best-effort behavior for non-Gleap webhook senders. */
function mapGenericPayload(raw: Rec): GleapTaskInput {
  const { flat, leftovers: nestedLeftovers } = flatten(raw);
  const consumed = new Set<string>([...NESTED_KEYS]);
  const titleHit = firstNonEmptyString(flat, TITLE_KEYS);
  const descriptionHit = firstNonEmptyString(flat, DESCRIPTION_KEYS);
  const urlHit = findExternalUrl(flat);
  const externalIdHit = firstNonEmptyString(flat, EXTERNAL_ID_KEYS);
  if (titleHit) consumed.add(titleHit.key);
  if (descriptionHit) consumed.add(descriptionHit.key);
  if (urlHit) consumed.add(urlHit.key);
  if (externalIdHit) consumed.add(externalIdHit.key);
  const tags = collectTags(flat, consumed);

  let title = titleHit?.value ?? "";
  if (title === "" && descriptionHit) title = descriptionHit.value.split("\n")[0]?.trim() ?? "";
  if (title === "") title = "Untitled Gleap report";
  if (title.length > 200) title = `${title.slice(0, 197)}...`;

  const leftovers: Rec = { ...nestedLeftovers };
  for (const [key, value] of Object.entries(flat)) {
    if (consumed.has(key) || value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    leftovers[key] = value;
  }

  const parts: string[] = [];
  if (descriptionHit) parts.push(descriptionHit.value);
  if (urlHit) parts.push(`[View source](${urlHit.value})`);
  parts.push(renderLeftovers(leftovers));
  let description = parts.filter((part) => part !== "").join("\n\n").trim();
  if (description.length > MAX_DESCRIPTION_CHARS) {
    description = `${description.slice(0, MAX_DESCRIPTION_CHARS)}\n\n_(payload truncated)_`;
  }

  const mapped: GleapTaskInput = { title, description, tags, gleap: null };
  if (externalIdHit) mapped.externalId = externalIdHit.value;
  if (urlHit) mapped.externalUrl = urlHit.value;
  return mapped;
}

/** Map either Flow's native intake shape or a real Gleap ticket payload. */
export function mapInboundPayload(raw: unknown): GleapMapping {
  if (!isRecord(raw)) {
    throw new Error(
      `inbound payload must be a JSON object, received ${Array.isArray(raw) ? "an array" : typeof raw}`
    );
  }

  const ticket = findGleapTicket(raw);
  if (ticket !== null) return { ...mapKnownGleapTicket(ticket), native: false };

  const native = InboundTaskInput.safeParse(raw);
  if (native.success) return { ...native.data, gleap: null, native: true };
  return { ...mapGenericPayload(raw), native: false };
}

/** Exported for direct mapper tests. */
export function mapGleapPayload(raw: Rec): GleapTaskInput {
  const ticket = findGleapTicket(raw);
  return ticket === null ? mapGenericPayload(raw) : mapKnownGleapTicket(ticket);
}
