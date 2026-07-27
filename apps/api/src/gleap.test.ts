import { describe, expect, it } from "vitest";
import { InboundTaskInput } from "@flow/shared";
import { mapGleapPayload, mapInboundPayload } from "./gleap.js";
import { externalIdTag, toCreateTaskInput } from "./routes/inbound.js";

/**
 * A representative Gleap bug-report webhook: the content lives under `data`,
 * share links are `*URL` keys, and there is a long metadata tail.
 */
const gleapBugReport = {
  type: "BUG",
  id: "0123456789abcdef01234567",
  shareToken: "abc123share",
  dashboardURL: "https://app.gleap.io/projects/example-project/bugs/0123456789abcdef01234567",
  data: {
    title: "Checkout button does nothing on Safari",
    description: "Clicked Pay and the spinner never stops.",
    priority: "HIGH",
    reportedBy: { email: "customer@example.com", name: "A Customer" },
    session: { browser: "Safari 17.4", os: "macOS 14.4" },
    formData: { severity: "blocker" },
  },
  createdAt: "2026-07-20T10:11:12.000Z",
};

describe("mapInboundPayload", () => {
  it("passes a native InboundTaskInput straight through", () => {
    const native = {
      title: "Fix the thing",
      description: "details",
      externalId: "ext-1",
      externalUrl: "https://example.com/t/1",
      tags: ["bug"],
    };
    const mapped = mapInboundPayload(native);
    expect(mapped.native).toBe(true);
    expect(mapped.title).toBe("Fix the thing");
    expect(mapped.description).toBe("details");
    expect(mapped.tags).toEqual(["bug"]);
    expect(mapped.externalUrl).toBe("https://example.com/t/1");
  });

  it("falls back to the Gleap mapper when the shape does not match", () => {
    const mapped = mapInboundPayload(gleapBugReport);
    expect(mapped.native).toBe(false);
    expect(mapped.title).toBe("Checkout button does nothing on Safari");
  });

  it("rejects non-object bodies with a readable message", () => {
    expect(() => mapInboundPayload([1, 2, 3])).toThrow(/must be a JSON object.*an array/);
    expect(() => mapInboundPayload("nope")).toThrow(/must be a JSON object.*string/);
    expect(() => mapInboundPayload(null)).toThrow(/must be a JSON object/);
  });
});

describe("mapGleapPayload", () => {
  const mapped = mapGleapPayload(gleapBugReport);

  it("always produces something InboundTaskInput accepts", () => {
    expect(InboundTaskInput.safeParse(mapped).success).toBe(true);
  });

  it("lifts the title out of the nested data object", () => {
    expect(mapped.title).toBe("Checkout button does nothing on Safari");
  });

  it("uses the nested description as the description body", () => {
    expect(mapped.description).toContain("Clicked Pay and the spinner never stops.");
  });

  it("takes externalUrl from a *URL key and links it in the body", () => {
    expect(mapped.externalUrl).toBe(gleapBugReport.dashboardURL);
    expect(mapped.description).toContain(`[View in Gleap](${gleapBugReport.dashboardURL})`);
  });

  it("prefers an explicit external id key over the raw mongo id", () => {
    // shareToken is checked before id, so a re-delivery of the same share stays
    // idempotent even if Gleap changes its internal id format.
    expect(mapped.externalId).toBe("abc123share");
  });

  it("preserves every unconsumed field in a fenced JSON block", () => {
    expect(mapped.description).toContain("```json");
    expect(mapped.description).toContain("reportedBy");
    expect(mapped.description).toContain("customer@example.com");
    expect(mapped.description).toContain("Safari 17.4");
    expect(mapped.description).toContain("createdAt");
  });

  it("tags the source and the report type", () => {
    expect(mapped.tags).toContain("gleap");
    expect(mapped.tags).toContain("bug");
  });

  it("never guesses a status", () => {
    // Gleap's own state vocabulary would not match the list's statuses.
    expect(mapped.status).toBeUndefined();
  });

  it("falls back to the first description line when there is no title", () => {
    const mapped2 = mapGleapPayload({
      message: "Page 500s on save\nStack trace follows...",
      id: "x1",
    });
    expect(mapped2.title).toBe("Page 500s on save");
    expect(InboundTaskInput.safeParse(mapped2).success).toBe(true);
  });

  it("falls back to a fixed label when there is no content at all", () => {
    const mapped3 = mapGleapPayload({ someField: 42 });
    expect(mapped3.title).toBe("Untitled Gleap report");
    expect(mapped3.description).toContain("someField");
    expect(InboundTaskInput.safeParse(mapped3).success).toBe(true);
  });

  it("accepts subject/name as title aliases", () => {
    expect(mapGleapPayload({ subject: "From subject" }).title).toBe("From subject");
    expect(mapGleapPayload({ name: "From name" }).title).toBe("From name");
  });

  it("ignores a *url key whose value is not a real http url", () => {
    const m = mapGleapPayload({ title: "t", websiteUrl: "not a url" });
    expect(m.externalUrl).toBeUndefined();
    // The value still survives, so nothing is lost.
    expect(m.description).toContain("not a url");
  });

  it("truncates an absurdly long title rather than failing", () => {
    const m = mapGleapPayload({ title: "x".repeat(500) });
    expect(m.title.length).toBe(200);
    expect(m.title.endsWith("...")).toBe(true);
  });

  it("is deterministic — the JSON block is key-sorted", () => {
    const a = mapGleapPayload({ title: "t", zeta: 1, alpha: 2 });
    const b = mapGleapPayload({ title: "t", alpha: 2, zeta: 1 });
    const body = a.description ?? "";
    expect(body).toBe(b.description);
    expect(body.indexOf("alpha")).toBeLessThan(body.indexOf("zeta"));
  });
});

describe("toCreateTaskInput", () => {
  it("records the external id as an ext: tag for idempotency", () => {
    const input = toCreateTaskInput(mapGleapPayload(gleapBugReport), "ls_target");
    expect(input.listId).toBe("ls_target");
    expect(input.tags).toContain(externalIdTag("abc123share"));
  });

  it("does not duplicate the source link already in the body", () => {
    const input = toCreateTaskInput(mapGleapPayload(gleapBugReport), "ls_target");
    const occurrences = (input.description ?? "").split(gleapBugReport.dashboardURL).length - 1;
    expect(occurrences).toBe(1);
  });

  it("appends the source link when the description lacks it", () => {
    const input = toCreateTaskInput(
      { title: "t", description: "body", externalUrl: "https://example.com/x" },
      "ls_1"
    );
    expect(input.description).toBe("body\n\nSource: https://example.com/x");
  });

  it("de-duplicates tags", () => {
    const input = toCreateTaskInput({ title: "t", tags: ["a", "a", "b"] }, "ls_1");
    expect(input.tags).toEqual(["a", "b"]);
  });
});
