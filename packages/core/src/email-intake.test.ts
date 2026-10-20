import { describe, expect, it } from "vitest";
import { messageIdsIn, normalizeMessageId, senderAllowed } from "./email-intake.js";

// ---------------------------------------------------------------------------
// The pure halves of email intake: who may write in, and how Message-ID /
// References headers become the bare ids the dedupe and threading rows use.
// The DO side (checks, ingest, threading) is in email-intake-storage.test.ts.
// ---------------------------------------------------------------------------

describe("senderAllowed", () => {
  it("an exact address admits that address only", () => {
    expect(senderAllowed("pat@clinic.com", ["pat@clinic.com"])).toBe(true);
    expect(senderAllowed("sam@clinic.com", ["pat@clinic.com"])).toBe(false);
  });

  it("an @domain entry admits the whole domain but not its subdomains", () => {
    expect(senderAllowed("anyone@clinic.com", ["@clinic.com"])).toBe(true);
    expect(senderAllowed("x@mail.clinic.com", ["@clinic.com"])).toBe(false);
    expect(senderAllowed("x@evilclinic.com", ["@clinic.com"])).toBe(false);
  });

  it("compares both sides lowercased and trimmed", () => {
    expect(senderAllowed("  Pat@Clinic.COM ", ["PAT@clinic.com"])).toBe(true);
    expect(senderAllowed("x@CLINIC.com", [" @Clinic.com "])).toBe(true);
  });

  it("refuses malformed senders and an empty allowlist", () => {
    expect(senderAllowed("clinic.com", ["@clinic.com"])).toBe(false);
    // No local part: a domain entry must never match itself as a sender.
    expect(senderAllowed("@clinic.com", ["@clinic.com"])).toBe(false);
    expect(senderAllowed("pat@", ["@clinic.com"])).toBe(false);
    expect(senderAllowed("pat@clinic.com", [])).toBe(false);
  });
});

describe("normalizeMessageId", () => {
  it("strips angle brackets and surrounding whitespace", () => {
    expect(normalizeMessageId("<abc@x.com>")).toBe("abc@x.com");
    expect(normalizeMessageId("  <abc@x.com>  ")).toBe("abc@x.com");
    expect(normalizeMessageId("abc@x.com")).toBe("abc@x.com");
    expect(normalizeMessageId("<<abc@x.com>>")).toBe("abc@x.com");
  });

  it("returns null for blank or missing input", () => {
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId(undefined)).toBeNull();
    expect(normalizeMessageId("")).toBeNull();
    expect(normalizeMessageId("   ")).toBeNull();
    expect(normalizeMessageId("<>")).toBeNull();
  });
});

describe("messageIdsIn", () => {
  it("pulls every bracketed id out of a References value, in order", () => {
    expect(messageIdsIn("<a@x> <b@y>\r\n <c@z>")).toEqual(["a@x", "b@y", "c@z"]);
  });

  it("de-duplicates, keeping the first occurrence", () => {
    expect(messageIdsIn("<a@x> <b@y> <a@x>")).toEqual(["a@x", "b@y"]);
  });

  it("ignores text outside brackets and ids containing whitespace", () => {
    expect(messageIdsIn("Re: <a@x> (comment) <bad id@y>")).toEqual(["a@x"]);
  });

  it("returns [] for an empty or missing header", () => {
    expect(messageIdsIn(null)).toEqual([]);
    expect(messageIdsIn(undefined)).toEqual([]);
    expect(messageIdsIn("")).toEqual([]);
    expect(messageIdsIn("no ids here")).toEqual([]);
  });
});
