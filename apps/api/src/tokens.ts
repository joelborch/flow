/**
 * API-key token minting and hashing. Pure and dependency-free so it can be
 * unit-tested outside the Worker runtime (Web Crypto is available in Node 18+).
 *
 * Shape: `flow_` + base64url(32 random bytes). Only the sha256 hex of the whole
 * token is ever stored, and the plaintext is returned exactly once, at create.
 */

export const TOKEN_PREFIX = "flow_";
const TOKEN_BYTES = 32;

/** base64url, no padding — safe in headers, URLs and shell quoting. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Mint a fresh bearer token. Uses the CSPRNG, never Math.random. */
export function generateApiToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return TOKEN_PREFIX + base64UrlEncode(bytes);
}

/** Lowercase sha256 hex of the token, as stored in ApiKey.tokenHash. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when the value looks like one of our tokens. Cheap pre-filter only. */
export function looksLikeApiToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX) && value.length > TOKEN_PREFIX.length + 20;
}

/**
 * Extract the bearer credential from an Authorization header.
 * Returns null for a missing or non-Bearer header.
 */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/**
 * Constant-time string compare for secret material (inbound tokens). Falls back
 * to a length check first, which is not secret.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}
