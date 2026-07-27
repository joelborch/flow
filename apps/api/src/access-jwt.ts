/**
 * Cloudflare Access JWT verification.
 *
 * Access puts a signed RS256 JWT on every request that passes its policy, in
 * the `Cf-Access-Jwt-Assertion` header. We verify the signature against the
 * team's JWKS at `https://<team>/cdn-cgi/access/certs`, then check iss/aud/exp.
 * Cloudflare rotates the signing key pair periodically, so the JWKS is fetched
 * (never hardcoded) and cached with a short TTL, with an immediate refetch when
 * a token presents an unknown `kid`.
 *
 * Docs: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
 */
import { base64UrlDecode } from "./tokens.js";

export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

/** How long a fetched key set is trusted before refetching. */
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour
/** Floor between refetches, so an unknown-kid storm cannot hammer the endpoint. */
const JWKS_MIN_REFETCH_MS = 60 * 1000;
/** Clock-skew allowance on exp/nbf/iat. */
const CLOCK_SKEW_S = 60;

type JwksResponse = { keys?: unknown };

type CacheEntry = {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
};

/**
 * Module-level cache, keyed by team domain. This is immutable configuration
 * (public signing keys), never request-scoped state, so it is safe to share
 * across requests in an isolate.
 */
const jwksCache = new Map<string, CacheEntry>();
/** In-flight dedupe so concurrent requests share one JWKS fetch. */
const inflight = new Map<string, Promise<CacheEntry>>();

export type AccessClaims = {
  email: string;
  sub: string;
  iss: string;
  aud: string[];
  exp: number;
  iat?: number;
  nbf?: number;
};

export class AccessJwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessJwtError";
  }
}

/** Normalise a team domain to a bare hostname (accepts a full URL too). */
export function normalizeTeamDomain(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") throw new AccessJwtError("ACCESS_TEAM_DOMAIN is not configured");
  const withoutScheme = trimmed.replace(/^https?:\/\//i, "");
  return withoutScheme;
}

async function fetchJwks(teamDomain: string): Promise<CacheEntry> {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const res = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) {
    throw new AccessJwtError(
      `could not fetch Access signing keys from ${url} (status ${res.status})`
    );
  }
  const body = (await res.json()) as JwksResponse;
  const rawKeys = Array.isArray(body.keys) ? body.keys : [];
  if (rawKeys.length === 0) {
    throw new AccessJwtError(`Access signing key set at ${url} is empty`);
  }

  const keys = new Map<string, CryptoKey>();
  for (const raw of rawKeys) {
    const jwk = raw as JsonWebKey & { kid?: string };
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      );
      keys.set(jwk.kid, key);
    } catch {
      // A key we cannot import is not fatal; others in the set may work.
    }
  }
  if (keys.size === 0) {
    throw new AccessJwtError(`no usable RSA signing keys at ${url}`);
  }
  return { keys, fetchedAt: Date.now() };
}

async function getKeySet(teamDomain: string, forceRefresh: boolean): Promise<CacheEntry> {
  const cached = jwksCache.get(teamDomain);
  const now = Date.now();
  const stale = !cached || now - cached.fetchedAt > JWKS_TTL_MS;
  const mayRefetch = !cached || now - cached.fetchedAt > JWKS_MIN_REFETCH_MS;

  if (cached && !stale && !(forceRefresh && mayRefetch)) return cached;

  const existing = inflight.get(teamDomain);
  if (existing) return existing;

  const pending = fetchJwks(teamDomain)
    .then((entry) => {
      jwksCache.set(teamDomain, entry);
      return entry;
    })
    .finally(() => {
      inflight.delete(teamDomain);
    });
  inflight.set(teamDomain, pending);

  try {
    return await pending;
  } catch (err) {
    // Serve a stale-but-valid key set rather than locking everyone out when the
    // certs endpoint blips.
    if (cached) return cached;
    throw err;
  }
}

function decodeSegment(segment: string): unknown {
  const json = new TextDecoder().decode(base64UrlDecode(segment));
  return JSON.parse(json) as unknown;
}

/**
 * Verify an Access JWT and return its claims. Throws AccessJwtError with a
 * caller-readable reason on any failure.
 */
export async function verifyAccessJwt(
  token: string,
  teamDomainRaw: string,
  expectedAud: string
): Promise<AccessClaims> {
  const teamDomain = normalizeTeamDomain(teamDomainRaw);
  if (!expectedAud || expectedAud.trim() === "") {
    throw new AccessJwtError("ACCESS_AUD is not configured");
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AccessJwtError("Access token is not a well-formed JWT");
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = decodeSegment(headerB64) as { alg?: string; kid?: string };
    payload = decodeSegment(payloadB64) as Record<string, unknown>;
  } catch {
    throw new AccessJwtError("Access token header or payload is not valid base64url JSON");
  }

  if (header.alg !== "RS256") {
    throw new AccessJwtError(`unsupported Access token algorithm: ${header.alg ?? "none"}`);
  }
  const kid = header.kid;
  if (!kid) throw new AccessJwtError("Access token has no kid");

  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);

  let keySet = await getKeySet(teamDomain, false);
  let key = keySet.keys.get(kid);
  if (!key) {
    // Unknown kid usually means Cloudflare rotated keys; refetch once.
    keySet = await getKeySet(teamDomain, true);
    key = keySet.keys.get(kid);
  }
  if (!key) {
    throw new AccessJwtError(`Access token signed by unknown key ${kid}`);
  }

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature as unknown as ArrayBuffer,
    signed as unknown as ArrayBuffer
  );
  if (!ok) throw new AccessJwtError("Access token signature is invalid");

  return validateClaims(payload, teamDomain, expectedAud);
}

/**
 * Claim checks, split out so they are unit-testable without a signing key.
 * Exported for tests.
 */
export function validateClaims(
  payload: Record<string, unknown>,
  teamDomain: string,
  expectedAud: string,
  nowMs: number = Date.now()
): AccessClaims {
  const nowS = Math.floor(nowMs / 1000);

  const audRaw = payload["aud"];
  const aud = typeof audRaw === "string" ? [audRaw] : Array.isArray(audRaw) ? audRaw.filter((a): a is string => typeof a === "string") : [];
  if (!aud.includes(expectedAud)) {
    throw new AccessJwtError("Access token audience does not match this application");
  }

  const iss = typeof payload["iss"] === "string" ? payload["iss"] : "";
  const expectedIss = `https://${teamDomain}`;
  if (iss.replace(/\/+$/, "") !== expectedIss) {
    throw new AccessJwtError(`Access token issuer ${iss || "(missing)"} is not ${expectedIss}`);
  }

  const exp = typeof payload["exp"] === "number" ? payload["exp"] : 0;
  if (exp === 0) throw new AccessJwtError("Access token has no exp claim");
  if (nowS > exp + CLOCK_SKEW_S) throw new AccessJwtError("Access token has expired");

  const nbf = typeof payload["nbf"] === "number" ? payload["nbf"] : undefined;
  if (nbf !== undefined && nowS + CLOCK_SKEW_S < nbf) {
    throw new AccessJwtError("Access token is not valid yet");
  }

  const email = typeof payload["email"] === "string" ? payload["email"] : "";
  if (email === "") {
    throw new AccessJwtError("Access token carries no email claim (service tokens are not accepted here)");
  }

  return {
    email: email.toLowerCase(),
    sub: typeof payload["sub"] === "string" ? payload["sub"] : "",
    iss,
    aud,
    exp,
    iat: typeof payload["iat"] === "number" ? payload["iat"] : undefined,
    nbf,
  };
}
