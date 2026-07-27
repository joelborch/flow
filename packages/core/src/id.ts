// Prefixed, URL-safe, nanoid-style ids. No dependency: 64-char alphabet so
// `byte & 63` is unbiased.
const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

export const ID_PREFIX = {
  task: "tk_",
  list: "ls_",
  space: "sp_",
  status: "st_",
  subtask: "sb_",
  comment: "cm_",
  attachment: "at_",
  user: "us_",
  automationRule: "ar_",
  apiKey: "ak_",
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

/** `id("tk_")` -> `tk_Kf3aQ8xZ1mLp`. 12 random chars ≈ 72 bits. */
export function id(prefix: IdPrefix, size = 12): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let out = prefix;
  for (let i = 0; i < size; i++) out += ALPHABET[bytes[i]! & 63];
  return out;
}

/** Prefix on inbound webhook tokens, so a leaked string is identifiable. */
export const INBOUND_TOKEN_PREFIX = "inb_";

/**
 * Opaque token for inbound webhook URLs (Gleap etc.). Not an entity id.
 *
 * Prefixed `inb_` so the credential is recognisable in logs, secret scanners
 * and Gleap's config UI. Lookup is an exact-match on the stored string, so
 * tokens minted before the prefix existed keep working untouched.
 */
export function token(size = 32): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let out = INBOUND_TOKEN_PREFIX;
  for (let i = 0; i < size; i++) out += ALPHABET[bytes[i]! & 63];
  return out;
}
