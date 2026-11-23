import { signInMode } from "./auth.js";
import type { Env } from "./env.js";
import { DEFAULT_EMAIL_FROM } from "./side-effects/index.js";

export const REQUIRED_PROD_EMAIL_VARS = [
  "EMAIL_FROM",
  "EMAIL_FROM_NAME",
  "EMAIL_BRAND_NAME",
  "EMAIL_REQUESTER_FROM_NAME",
] as const;

/**
 * True when the Worker is running as a production deployment: Cloudflare Access
 * is configured or live outbound email (`EMAIL_DRY_RUN === "false"`) is
 * enabled, and neither `DEV_NO_AUTH` nor `SANDBOX` is turned on.
 */
export function isProductionEnv(env: Partial<Env>): boolean {
  if (env.DEV_NO_AUTH === "true" || env.SANDBOX === "true") return false;
  return (
    signInMode({
      ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN ?? "",
      ACCESS_AUD: env.ACCESS_AUD ?? "",
      DEV_NO_AUTH: env.DEV_NO_AUTH,
    }) === "access" || env.EMAIL_DRY_RUN === "false"
  );
}

/**
 * List any missing, blank, or placeholder email branding vars required in
 * production so the Worker refuses to start instead of mailing as `example.com`.
 */
export function missingProductionEmailVars(env: Partial<Env>): string[] {
  if (!isProductionEnv(env)) return [];

  const missing: string[] = [];
  for (const key of REQUIRED_PROD_EMAIL_VARS) {
    const val = env[key];
    if (typeof val !== "string" || !val.trim()) missing.push(key);
  }
  if (
    typeof env.EMAIL_FROM === "string" &&
    env.EMAIL_FROM.trim().toLowerCase() === DEFAULT_EMAIL_FROM.email
  ) {
    missing.push(`EMAIL_FROM (placeholder ${DEFAULT_EMAIL_FROM.email})`);
  }
  return missing;
}

/** Fail closed at Worker startup when production lacks explicit email branding vars. */
export function assertProductionConfig(env: Partial<Env>): void {
  const missing = missingProductionEmailVars(env);
  if (missing.length > 0) {
    throw new Error(
      `Flow startup refused: production requires explicit email branding vars (${missing.join(", ")})`
    );
  }
}
