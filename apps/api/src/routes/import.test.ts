import { describe, expect, it } from "vitest";
import { ApiError } from "../errors.js";
import { ATTACHMENT_SOURCE_HOSTS, assertAllowedAttachmentSource } from "./import.js";

const reject = (url: string): ApiError => {
  try {
    assertAllowedAttachmentSource(url);
  } catch (err) {
    return err as ApiError;
  }
  throw new Error(`expected ${url} to be rejected`);
};

describe("assertAllowedAttachmentSource", () => {
  it("accepts ClickUp CDN hosts over https", () => {
    expect(
      assertAllowedAttachmentSource("https://attachments.clickup.com/a/b.png").hostname
    ).toBe("attachments.clickup.com");
    expect(
      assertAllowedAttachmentSource("https://t123.clickup-attachments.com/x.pdf").hostname
    ).toBe("t123.clickup-attachments.com");
  });

  it("matches the host suffix case-insensitively", () => {
    expect(() =>
      assertAllowedAttachmentSource("https://ATTACHMENTS.ClickUp.com/a.png")
    ).not.toThrow();
  });

  it("refuses plain http, naming the allowlist", () => {
    const err = reject("http://attachments.clickup.com/a.png");
    expect(err.status).toBe(400);
    expect(err.message).toContain("must use https");
    for (const host of ATTACHMENT_SOURCE_HOSTS) expect(err.message).toContain(host);
  });

  it("refuses internal and metadata targets — the SSRF this guards against", () => {
    for (const url of [
      "https://localhost/secrets",
      "https://127.0.0.1/",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/internal",
    ]) {
      const err = reject(url);
      expect(err.status).toBe(400);
      expect(err.message).toContain("is not permitted");
    }
  });

  it("names the allowlist in the rejection so the caller can act on it", () => {
    const err = reject("https://evil.example/x");
    for (const host of ATTACHMENT_SOURCE_HOSTS) expect(err.message).toContain(host);
  });

  it("is not fooled by a lookalike host that merely contains the domain", () => {
    expect(() => assertAllowedAttachmentSource("https://evil-clickup.com/x")).toThrow();
    expect(() => assertAllowedAttachmentSource("https://clickup.com.evil.example/x")).toThrow();
    expect(() => assertAllowedAttachmentSource("https://notclickup.com/x")).toThrow();
  });

  it("is not fooled by userinfo pointing the real host elsewhere", () => {
    const err = reject("https://attachments.clickup.com@evil.example/x.png");
    expect(err.message).toContain("evil.example");
  });

  it("refuses non-http schemes outright", () => {
    expect(() => assertAllowedAttachmentSource("file:///etc/passwd")).toThrow();
    expect(() => assertAllowedAttachmentSource("data:text/plain,hi")).toThrow();
  });

  it("reports an unparseable URL as such", () => {
    expect(reject("not a url").message).toContain("is not a valid URL");
  });
});
