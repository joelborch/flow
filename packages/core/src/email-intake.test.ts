import { describe, expect, it } from "vitest";
import { messageIdsIn, normalizeMessageId, replySubject, senderAllowed } from "./email-intake.js";

// ---------------------------------------------------------------------------
// The pure halves of email intake: who may write in, and how Message-ID /
// References headers become the bare ids the dedupe and threading rows use.
// The DO side (checks, ingest, threading) is in email-intake-storage.test.ts.
// ---------------------------------------------------------------------------

describe("senderAllowed", () => {
  it("an exact address admits that address only", () => {
    expect(senderAllowed("pat@clinic.example", ["pat@clinic.example"])).toBe(true);
    expect(senderAllowed("sam@clinic.example", ["pat@clinic.example"])).toBe(false);
  });

  it("an @domain entry admits the whole domain but not its subdomains", () => {
    expect(senderAllowed("anyone@clinic.example", ["@clinic.example"])).toBe(true);
    expect(senderAllowed("x@mail.clinic.example", ["@clinic.example"])).toBe(false);
    expect(senderAllowed("x@evilclinic.example", ["@clinic.example"])).toBe(false);
  });

  it("compares both sides lowercased and trimmed", () => {
    expect(senderAllowed("  Pat@Clinic.example ", ["PAT@clinic.example"])).toBe(true);
    expect(senderAllowed("x@CLINIC.example", [" @Clinic.example "])).toBe(true);
  });

  it("refuses malformed senders and an empty allowlist", () => {
    expect(senderAllowed("clinic.example", ["@clinic.example"])).toBe(false);
    // No local part: a domain entry must never match itself as a sender.
    expect(senderAllowed("@clinic.example", ["@clinic.example"])).toBe(false);
    expect(senderAllowed("pat@", ["@clinic.example"])).toBe(false);
    expect(senderAllowed("pat@clinic.example", [])).toBe(false);
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

describe("replySubject", () => {
  it("prefixes Re: once, dropping earlier reply and forward prefixes and line breaks", () => {
    expect(replySubject("Printer jammed")).toBe("Re: Printer jammed");
    expect(replySubject("RE: Fwd: re :  Printer jammed")).toBe("Re: Printer jammed");
    expect(replySubject("AW: Hours\r\nupdate")).toBe("Re: Hours update");
    expect(replySubject("Re:")).toBe("Re: your request");
    expect(replySubject("Regarding hours")).toBe("Re: Regarding hours");
  });

  it("stays fast on a long run of spaces", () => {
    const started = performance.now();
    expect(replySubject(`re:${" ".repeat(50_000)}x`)).toBe("Re: x");
    expect(replySubject(`re ${" ".repeat(50_000)}x`).startsWith("Re: re")).toBe(true);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
