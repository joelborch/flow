import { describe, expect, it } from "vitest";
import {
  TOKEN_PREFIX,
  base64UrlDecode,
  base64UrlEncode,
  generateApiToken,
  hashToken,
  looksLikeApiToken,
  parseBearer,
  timingSafeEqualString,
} from "./tokens.js";
import { validateClaims, AccessJwtError, normalizeTeamDomain } from "./access-jwt.js";

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect([...base64UrlDecode(base64UrlEncode(bytes))]).toEqual([...bytes]);
  });

  it("emits no padding and no url-unsafe characters", () => {
    for (let len = 1; len <= 34; len++) {
      const bytes = new Uint8Array(len).fill(255);
      const encoded = base64UrlEncode(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
    }
  });
});

describe("generateApiToken", () => {
  it("is prefixed and long enough to pass the cheap pre-filter", () => {
    const token = generateApiToken();
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    // 32 bytes -> 43 base64url chars, no padding.
    expect(token.length).toBe(TOKEN_PREFIX.length + 43);
    expect(looksLikeApiToken(token)).toBe(true);
  });

  it("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateApiToken()));
    expect(tokens.size).toBe(200);
  });

  it("rejects credentials that are not workspace api keys", () => {
    // Inbound-webhook tokens are minted by the DO under its own prefix and must
    // never satisfy the api-key pre-filter.
    expect(looksLikeApiToken("inb_Yk3vQ8mLp2ZxW9nR4tJ7bH5cF1dG6sA0eK")).toBe(false);
    expect(looksLikeApiToken("flow_short")).toBe(false);
    expect(looksLikeApiToken("")).toBe(false);
  });
});

describe("hashToken", () => {
  it("matches a known sha256 vector", async () => {
    // sha256("abc")
    expect(await hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("is 64 lowercase hex chars", async () => {
    expect(await hashToken(generateApiToken())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for the same token and different across tokens", async () => {
    const token = generateApiToken();
    expect(await hashToken(token)).toBe(await hashToken(token));
    expect(await hashToken(token)).not.toBe(await hashToken(generateApiToken()));
  });

  it("is sensitive to a single-character change", async () => {
    expect(await hashToken("flow_aaaa")).not.toBe(await hashToken("flow_aaab"));
  });
});

describe("parseBearer", () => {
  it("extracts the credential", () => {
    expect(parseBearer("Bearer flow_abc")).toBe("flow_abc");
  });

  it("is case-insensitive on the scheme and tolerates extra whitespace", () => {
    expect(parseBearer("  bearer   flow_abc  ")).toBe("flow_abc");
    expect(parseBearer("BEARER flow_abc")).toBe("flow_abc");
  });

  it("returns null for a missing, empty or non-Bearer header", () => {
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer("Basic dXNlcjpwYXNz")).toBeNull();
    expect(parseBearer("Bearer")).toBeNull();
    expect(parseBearer("Bearer    ")).toBeNull();
  });
});

describe("timingSafeEqualString", () => {
  it("accepts identical strings and rejects everything else", () => {
    expect(timingSafeEqualString("inb_secret", "inb_secret")).toBe(true);
    expect(timingSafeEqualString("inb_secret", "inb_secreT")).toBe(false);
    expect(timingSafeEqualString("inb_secret", "inb_secret_longer")).toBe(false);
    expect(timingSafeEqualString("", "")).toBe(true);
  });

  it("handles multi-byte characters without throwing", () => {
    expect(timingSafeEqualString("tökén", "tökén")).toBe(true);
    expect(timingSafeEqualString("tökén", "token")).toBe(false);
  });
});

describe("normalizeTeamDomain", () => {
  it("strips scheme and trailing slashes", () => {
    expect(normalizeTeamDomain("https://acme.cloudflareaccess.com/")).toBe(
      "acme.cloudflareaccess.com"
    );
    expect(normalizeTeamDomain("acme.cloudflareaccess.com")).toBe("acme.cloudflareaccess.com");
  });

  it("rejects an unset value rather than fetching a bogus URL", () => {
    expect(() => normalizeTeamDomain("   ")).toThrow(AccessJwtError);
  });
});

describe("validateClaims", () => {
  const team = "acme.cloudflareaccess.com";
  const aud = "deadbeef";
  const now = 1_800_000_000_000; // fixed clock
  const nowS = Math.floor(now / 1000);
  const valid = {
    aud: [aud],
    iss: `https://${team}`,
    email: "Alice@Example.com",
    sub: "u1",
    exp: nowS + 600,
    iat: nowS - 10,
  };

  it("accepts a well-formed token and lowercases the email", () => {
    const claims = validateClaims(valid, team, aud, now);
    expect(claims.email).toBe("alice@example.com");
    expect(claims.aud).toEqual([aud]);
  });

  it("accepts a string aud as well as an array", () => {
    expect(validateClaims({ ...valid, aud }, team, aud, now).email).toBeTruthy();
  });

  it("rejects a token minted for a different application", () => {
    expect(() => validateClaims({ ...valid, aud: ["other"] }, team, aud, now)).toThrow(
      /audience does not match/
    );
  });

  it("rejects a token from a different team domain", () => {
    expect(() =>
      validateClaims({ ...valid, iss: "https://evil.cloudflareaccess.com" }, team, aud, now)
    ).toThrow(/is not https:\/\/acme/);
  });

  it("tolerates a trailing slash on the issuer", () => {
    expect(validateClaims({ ...valid, iss: `https://${team}/` }, team, aud, now).email).toBeTruthy();
  });

  it("rejects an expired token but allows for small clock skew", () => {
    expect(() => validateClaims({ ...valid, exp: nowS - 3600 }, team, aud, now)).toThrow(
      /has expired/
    );
    // 30s past exp is within the 60s skew allowance.
    expect(validateClaims({ ...valid, exp: nowS - 30 }, team, aud, now).email).toBeTruthy();
  });

  it("rejects a token with no exp at all", () => {
    const { exp: _exp, ...noExp } = valid;
    expect(() => validateClaims(noExp, team, aud, now)).toThrow(/no exp claim/);
  });

  it("rejects a not-yet-valid token", () => {
    expect(() => validateClaims({ ...valid, nbf: nowS + 3600 }, team, aud, now)).toThrow(
      /not valid yet/
    );
  });

  it("rejects a token with no email — service tokens are not users", () => {
    const { email: _email, ...noEmail } = valid;
    expect(() => validateClaims(noEmail, team, aud, now)).toThrow(/no email claim/);
  });
});
