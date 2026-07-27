import { describe, expect, it } from "vitest";
import { attachmentKey, contentRangeHeader, parseRangeHeader, sanitizeFilename } from "./attachments.js";

const SIZE = 1000;

describe("parseRangeHeader", () => {
  it("treats an absent or empty header as no range", () => {
    expect(parseRangeHeader(undefined, SIZE)).toEqual({ kind: "none" });
    expect(parseRangeHeader(null, SIZE)).toEqual({ kind: "none" });
    expect(parseRangeHeader("   ", SIZE)).toEqual({ kind: "none" });
  });

  it("parses a closed range inclusively", () => {
    expect(parseRangeHeader("bytes=0-99", SIZE)).toEqual({ kind: "range", offset: 0, length: 100 });
    expect(parseRangeHeader("bytes=100-199", SIZE)).toEqual({
      kind: "range",
      offset: 100,
      length: 100,
    });
  });

  it("parses an open-ended range as everything from the offset", () => {
    expect(parseRangeHeader("bytes=500-", SIZE)).toEqual({
      kind: "range",
      offset: 500,
      length: 500,
    });
  });

  it("parses a suffix range as the last N bytes", () => {
    expect(parseRangeHeader("bytes=-100", SIZE)).toEqual({
      kind: "range",
      offset: 900,
      length: 100,
    });
  });

  it("clamps a suffix larger than the object to the whole object", () => {
    expect(parseRangeHeader("bytes=-5000", SIZE)).toEqual({
      kind: "range",
      offset: 0,
      length: SIZE,
    });
  });

  it("clamps an end past the last byte rather than failing", () => {
    expect(parseRangeHeader("bytes=990-99999", SIZE)).toEqual({
      kind: "range",
      offset: 990,
      length: 10,
    });
  });

  it("calls a start at or past the end unsatisfiable", () => {
    expect(parseRangeHeader("bytes=1000-", SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=5000-6000", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("calls an inverted range and a zero suffix unsatisfiable", () => {
    expect(parseRangeHeader("bytes=500-100", SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=-0", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("has nothing satisfiable in a zero-byte object", () => {
    expect(parseRangeHeader("bytes=0-10", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=-10", 0)).toEqual({ kind: "unsatisfiable" });
  });

  it("serves the whole object for multi-range and unknown units", () => {
    expect(parseRangeHeader("bytes=0-99,200-299", SIZE)).toEqual({ kind: "none" });
    expect(parseRangeHeader("items=0-99", SIZE)).toEqual({ kind: "none" });
    expect(parseRangeHeader("bytes=-", SIZE)).toEqual({ kind: "none" });
  });

  it("tolerates whitespace and casing", () => {
    expect(parseRangeHeader("Bytes = 0 - 9", SIZE)).toEqual({ kind: "range", offset: 0, length: 10 });
  });
});

describe("contentRangeHeader", () => {
  it("is null when R2 returned no range (a whole-object read)", () => {
    expect(contentRangeHeader(undefined, SIZE)).toBeNull();
  });

  it("builds an inclusive byte range from offset and length", () => {
    expect(contentRangeHeader({ offset: 0, length: 100 }, SIZE)).toBe("bytes 0-99/1000");
    expect(contentRangeHeader({ offset: 100, length: 100 }, SIZE)).toBe("bytes 100-199/1000");
  });

  it("fills in a missing length as everything after the offset", () => {
    expect(contentRangeHeader({ offset: 500 }, SIZE)).toBe("bytes 500-999/1000");
  });

  it("fills in a missing offset as the start of the object", () => {
    expect(contentRangeHeader({ length: 10 }, SIZE)).toBe("bytes 0-9/1000");
  });

  it("resolves a suffix range against the size", () => {
    expect(contentRangeHeader({ suffix: 100 }, SIZE)).toBe("bytes 900-999/1000");
    expect(contentRangeHeader({ suffix: 5000 }, SIZE)).toBe("bytes 0-999/1000");
  });

  it("round-trips a parsed range back to the header a 206 should carry", () => {
    const parsed = parseRangeHeader("bytes=250-749", SIZE);
    expect(parsed.kind).toBe("range");
    if (parsed.kind !== "range") return;
    expect(contentRangeHeader({ offset: parsed.offset, length: parsed.length }, SIZE)).toBe(
      "bytes 250-749/1000"
    );
  });
});

describe("sanitizeFilename", () => {
  it("strips path separators so a key cannot escape its prefix", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\alice\\report.pdf")).toBe("report.pdf");
  });

  it("falls back for names that would be empty or traversal-only", () => {
    expect(sanitizeFilename("")).toBe("upload.bin");
    expect(sanitizeFilename("..")).toBe("upload.bin");
  });

  it("is applied by attachmentKey", () => {
    expect(attachmentKey("tk_1", "at_1", "../evil.png")).toBe("at/tk_1/at_1/evil.png");
  });
});
