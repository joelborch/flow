/// <reference types="@cloudflare/workers-types" />
import type { Env as CoreEnv } from "@flow/core";
import type { Actor, ApiKey, User } from "@flow/shared";

/**
 * Worker environment. CoreEnv supplies the bindings (WORKSPACE, ATTACHMENTS,
 * SIDE_EFFECTS, ASSETS); everything below is a plain var or secret declared in
 * wrangler.jsonc.
 */
export type Env = CoreEnv & {
  /** "true" (default) => send_email actions log instead of sending; any value other than "false" keeps dry-run on. */
  EMAIL_DRY_RUN: string;
  /** Public hostname, used in webhook envelopes and task URLs. */
  APP_HOSTNAME: string;
  /** Cloudflare Access team domain, e.g. "your-team.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN: string;
  /** Cloudflare Access application AUD tag (hex). */
  ACCESS_AUD: string;
  /** Email of the workspace owner; the fallback identity for dev + inbound. */
  OWNER_EMAIL: string;
  /** Sender address for automation/notification email (default flow@mail.example.com). */
  EMAIL_FROM?: string;
  /** Sender display name for outbound email (default "Flow"). */
  EMAIL_FROM_NAME?: string;
  /** Wordmark shown in the branded email header (default EMAIL_FROM_NAME ?? "Flow"). */
  EMAIL_BRAND_NAME?: string;
  /** JSON object mapping exact Gleap project IDs to their screenshot API tokens. */
  GLEAP_PROJECT_TOKENS_JSON?: string;
  /** Comma-separated HTTPS host allowlist for rendered Gleap screenshot URLs. */
  GLEAP_ATTACHMENT_HOSTS?: string;
  /**
   * Local-dev escape hatch. Auth resolves to the owner user when this is
   * exactly the string "true". Anything else (including unset) fails closed.
   */
  DEV_NO_AUTH?: string;
};

/** Single workspace by design: one fixed DO instance holds everything. */
export const WORKSPACE_NAME = "main";

/** Header the Worker uses to hand the resolved user id to the DO on /ws. */
export const WS_USER_HEADER = "X-Flow-User-Id";

/** Resolved caller identity, attached to every authenticated request. */
export type AuthContext = {
  user: User;
  actor: Actor;
  /** Present only on the API-key path. */
  apiKey: ApiKey | null;
};

/** Hono generic for the whole app. */
export type AppEnv = {
  Bindings: Env;
  Variables: { auth: AuthContext };
};
