import { describe, expect, it } from "vitest";
import { InboundTaskInput } from "@flow/shared";
import { mapGleapPayload, mapInboundPayload } from "./gleap.js";
import {
  externalIdTag,
  gleapEnrichmentUpdate,
  toCreateTaskInput,
} from "./routes/inbound.js";

/**
 * A representative Gleap bug-report webhook: the content lives under `data`,
 * share links are `*URL` keys, and there is a long metadata tail.
 */
const gleapBugReport = {
  type: "BUG",
  id: "65f0c1a2b3d4e5f60718293a",
  shareToken: "abc123share",
  dashboardURL: "https://app.gleap.io/projects/p1/bugs/65f0c1a2b3d4e5f60718293a",
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

/** Modeled on the shape of a real Gleap ticket.created payload; all values synthetic. */
const deltaTicketCreated = {
  event: "ticket.created",
  id: "65f0c2b3c4d5e6f708192a3b",
  bugId: 42,
  project: "project-delta",
  projectId: "project-delta",
  type: "BUG",
  status: "OPEN",
  priority: "MEDIUM",
  shareToken: "legacy-share-token",
  secretShareToken: "must-never-reach-flow",
  form: {
    description: {
      title: "Description",
      type: "textarea",
      name: "description",
      value:
        "Layout should look like this on Tablet: https://figma.example/design?node-id=1000-100&amp;t=redacted\n",
    },
  },
  plainContent: "different flattened content",
  session: {
    name: "",
    email: "reporter@example.com",
    location: { country: "US" },
    eventData: { privateNoise: { count: 99 } },
  },
  metaData: {
    browserName: "Chrome(120.0)",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    browser: "Chrome",
    systemName: "Windows",
    sessionDuration: 842,
    devicePixelRatio: 1,
    screenWidth: 1920,
    screenHeight: 1080,
    innerWidth: 1440,
    innerHeight: 900,
    currentUrl: "https://staging.example/reviews/",
    language: "en-US",
    mobile: false,
    sdkVersion: "17.0.2",
    sdkType: "javascript",
    environment: "prod",
  },
  screenshotDataUrl: "https://storage.gleap.io/redacted_screenshotdata.json",
  screenshotUrl: "",
  generatingScreenshot: true,
  screenshotLive: false,
  screenshotRenderingFailed: false,
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
    expect(mapped.description).toContain(`[View source](${gleapBugReport.dashboardURL})`);
  });

  it("prefers the source object's id over a share token", () => {
    expect(mapped.externalId).toBe("65f0c1a2b3d4e5f60718293a");
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

describe("real Gleap ticket mapping", () => {
  const mapped = mapGleapPayload(deltaTicketCreated);

  it("uses the bug number and nested form value for the title", () => {
    expect(mapped.title).toMatch(/^\[42\] Layout should look like this on Tablet:/);
    expect(mapped.title).not.toBe("Untitled Gleap report");
    expect(mapped.title.length).toBeLessThanOrEqual(120);
  });

  it("renders the useful ClickUp-style sections and decodes HTML entities", () => {
    expect(mapped.description).toContain("Description:\nLayout should look like this on Tablet:");
    expect(mapped.description).toContain("&t=redacted");
    expect(mapped.description).toContain("Info\n**Reported by:** Guest (reporter@example.com)");
    expect(mapped.description).toContain("**Priority:** 🟠 Medium");
    expect(mapped.description).toContain("**Type:** 🚨 BUG");
    expect(mapped.description).toContain("Metadata\n**browserName:** Chrome(120.0)");
    expect(mapped.description).toContain("**innerWidth:** 1440");
    expect(mapped.description).toContain("**currentUrl:** https://staging.example/reviews/");
  });

  it("does not leak tokens, session internals, or the raw webhook", () => {
    expect(mapped.description).not.toContain("must-never-reach-flow");
    expect(mapped.description).not.toContain("legacy-share-token");
    expect(mapped.description).not.toContain("privateNoise");
    expect(mapped.description).not.toContain("Reported payload");
    expect(mapped.externalUrl).toBeUndefined();
  });

  it("uses the stable ticket id while retaining the old share id only for migration lookup", () => {
    expect(mapped.externalId).toBe("65f0c2b3c4d5e6f708192a3b");
    expect(mapped.gleap).toMatchObject({
      ticketId: "65f0c2b3c4d5e6f708192a3b",
      projectId: "project-delta",
      legacyExternalIds: ["legacy-share-token"],
      screenshotUrl: null,
      screenshotPending: true,
      screenshotFailed: false,
    });
  });

  it("recognizes a Gleap object before the permissive native schema", () => {
    const mappedWithTitle = mapInboundPayload({ ...deltaTicketCreated, title: "Gleap placeholder" });
    expect(mappedWithTitle.native).toBe(false);
    expect(mappedWithTitle.title).toMatch(/^\[42\]/);
  });

  it("unwraps an event envelope whose ticket lives under data", () => {
    const { event: _event, ...ticket } = deltaTicketCreated;
    const enveloped = mapInboundPayload({ event: "ticket.created", data: ticket });
    expect(enveloped.title).toMatch(/^\[42\] Layout should look/);
    expect(enveloped.externalId).toBe("65f0c2b3c4d5e6f708192a3b");
  });
});

describe("toCreateTaskInput", () => {
  it("records the external id as an ext: tag for idempotency", () => {
    const input = toCreateTaskInput(mapGleapPayload(gleapBugReport), "ls_target");
    expect(input.listId).toBe("ls_target");
    expect(input.tags).toContain(externalIdTag("65f0c1a2b3d4e5f60718293a"));
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

describe("Gleap duplicate enrichment", () => {
  const mapped = mapInboundPayload(deltaTicketCreated);

  it("repairs Flow's known raw-payload task and migrates the legacy id tag", () => {
    const update = gleapEnrichmentUpdate(
      {
        id: "tk_existing",
        title: "Untitled Gleap report",
        description: "**Reported payload**\n```json\n{}\n```",
        tags: ["gleap", "bug", externalIdTag("legacy-share-token")],
      },
      mapped
    );
    expect(update).toMatchObject({
      taskId: "tk_existing",
      title: mapped.title,
      description: mapped.description,
      tags: ["gleap", "bug", externalIdTag("65f0c2b3c4d5e6f708192a3b")],
    });
  });

  it("preserves human-edited content while migrating only the machine id tag", () => {
    const update = gleapEnrichmentUpdate(
      {
        id: "tk_existing",
        title: "Developer clarified title",
        description: "Developer notes and acceptance criteria",
        tags: ["needs-review", externalIdTag("legacy-share-token")],
      },
      mapped
    );
    expect(update).toEqual({
      taskId: "tk_existing",
      tags: [
        "needs-review",
        "gleap",
        "bug",
        externalIdTag("65f0c2b3c4d5e6f708192a3b"),
      ],
    });
  });
});
