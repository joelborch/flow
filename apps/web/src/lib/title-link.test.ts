import { describe, expect, it } from "vitest";
import { titleLink } from "./title-link.js";

describe("titleLink", () => {
  it("returns a bare URL title as-is", () => {
    expect(titleLink("https://x.com/example/status/1234567890")).toBe(
      "https://x.com/example/status/1234567890"
    );
  });

  it("finds a URL inside a sentence and drops trailing punctuation", () => {
    expect(titleLink("Read this: https://example.com/post.")).toBe("https://example.com/post");
    expect(titleLink("(see https://example.com/a)")).toBe("https://example.com/a");
  });

  it("keeps a paren the URL itself opened", () => {
    expect(titleLink("https://en.wikipedia.org/wiki/Flow_(psychology)")).toBe(
      "https://en.wikipedia.org/wiki/Flow_(psychology)"
    );
  });

  it("ignores titles with no http(s) link", () => {
    expect(titleLink("Call the printer")).toBeNull();
    expect(titleLink("javascript:alert(1)")).toBeNull();
    expect(titleLink("x.com/someone/status/1")).toBeNull();
    expect(titleLink("https://")).toBeNull();
  });
});
