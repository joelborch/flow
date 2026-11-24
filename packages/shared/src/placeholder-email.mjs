// Shared placeholder / local / template sender domains refused whenever
// EMAIL_DRY_RUN === "false". Used by both @flow/api and scripts/deploy-guarded.mjs.

export const PLACEHOLDER_EMAIL_DOMAINS = Object.freeze([
  "example.com",
  "example.net",
  "example.org",
  "example",
  "localhost",
  "localdomain",
  "local",
  "invalid",
  "test",
  "yourdomain.com",
  "yourdomain.net",
  "yourdomain.org",
  "your-domain.com",
  "your-domain.net",
  "your-domain.org",
  "mydomain.com",
  "yourcompany.com",
  "your-company.com",
  "placeholder.flow",
]);

/**
 * True when `email` is empty, malformed, contains whitespace or `<>{}`
 * template delimiters, has a single-label host, or uses a placeholder/local
 * domain from `PLACEHOLDER_EMAIL_DOMAINS`.
 */
export function isPlaceholderEmail(email) {
  const trimmed = String(email ?? "").trim().toLowerCase();
  if (!trimmed || /[<>{}\s]/.test(trimmed)) return true;
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return true;
  const domain = trimmed.slice(at + 1);
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return true;
  if (PLACEHOLDER_EMAIL_DOMAINS.some((p) => domain === p || domain.endsWith(`.${p}`))) return true;
  return !domain.includes(".");
}
