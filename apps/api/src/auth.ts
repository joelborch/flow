/// <reference types="@cloudflare/workers-types" />
import type { Context, MiddlewareHandler } from "hono";
import type { Actor, User } from "@flow/shared";
import { ACCESS_JWT_HEADER, AccessJwtError, verifyAccessJwt } from "./access-jwt.js";
import { findApiKeyByName, findUserByEmail, resolveMemberEmail, workspace } from "./do.js";
import type { AppEnv, AuthContext, Env } from "./env.js";
import { forbidden, unauthorized } from "./errors.js";
import { hashToken, looksLikeApiToken, parseBearer } from "./tokens.js";

/**
 * Two ways in:
 *
 *  a) Humans — Cloudflare Access sits in front of the Worker and hands us a
 *     signed JWT in `Cf-Access-Jwt-Assertion`. We verify it against the team's
 *     JWKS, then map the email claim to a workspace user.
 *  b) Agents and scripts — `Authorization: Bearer flow_...`. We sha256 the
 *     token and look the key up in the DO; the key impersonates a real user and
 *     its id lands in the audit trail.
 *
 * Unauthenticated requests are rejected on /api/* and /mcp. The only exceptions
 * are /api/health (liveness) and /api/inbound/* (authenticated per-list by the
 * list's own inboundToken, inside the route).
 */

/** Paths that skip this middleware entirely. */
export function isPublicPath(pathname: string): boolean {
  if (pathname === "/api/health") return true;
  if (pathname === "/api/inbound" || pathname.startsWith("/api/inbound/")) return true;
  return false;
}

function actorForUi(user: User): Actor {
  return { userId: user.id, via: "ui", apiKeyId: null, automationRuleId: null };
}

/** Bearer-token path. Returns null when the header is absent or not ours. */
async function authenticateApiKey(
  c: Context<AppEnv>,
  token: string
): Promise<AuthContext> {
  const tokenHash = await hashToken(token);
  // resolveApiKey stamps lastUsedAt itself, inside the same DO turn — no audit
  // row, no delta, and no second round-trip from here to throttle.
  const found = await workspace(c.env).resolveApiKey(tokenHash);
  if (!found) throw unauthorized("api key is invalid or has been revoked");
  if (found.user.deactivated) {
    throw forbidden(`api key impersonates deactivated user ${found.user.email}`);
  }

  const via = new URL(c.req.url).pathname.startsWith("/mcp") ? "mcp" : "api";
  return {
    user: found.user,
    apiKey: found.key,
    actor: {
      userId: found.user.id,
      via,
      apiKeyId: found.key.id,
      automationRuleId: null,
    },
  };
}

/** Cloudflare Access path. */
async function authenticateAccess(c: Context<AppEnv>, jwt: string): Promise<AuthContext> {
  let email: string;
  try {
    const claims = await verifyAccessJwt(jwt, c.env.ACCESS_TEAM_DOMAIN, c.env.ACCESS_AUD);
    email = claims.email;
  } catch (err) {
    if (err instanceof AccessJwtError) throw unauthorized(err.message);
    throw err;
  }

  const user = await resolveMemberEmail(c.env, email);
  if (!user) throw forbidden(`${email} is not a member of this workspace`);
  if (user.deactivated) throw forbidden(`${email} has been deactivated`);
  return { user, apiKey: null, actor: actorForUi(user) };
}

/**
 * Local-dev escape hatch. Fails closed: anything other than the exact string
 * "true" leaves auth untouched, so an unset or misspelled var cannot open the
 * API up in production.
 */
async function authenticateDev(c: Context<AppEnv>): Promise<AuthContext> {
  const email = (c.env.OWNER_EMAIL || "").toLowerCase();
  const user = await resolveMemberEmail(c.env, email);
  if (!user) {
    throw unauthorized(
      `DEV_NO_AUTH is on but owner ${email || "(OWNER_EMAIL unset)"} does not exist in the workspace`
    );
  }
  console.log(JSON.stringify({ level: "warn", msg: "DEV_NO_AUTH active", user: user.email }));
  return { user, apiKey: null, actor: actorForUi(user) };
}

/** Extract the Access JWT from the CF_Authorization cookie, if present. */
export function readAccessCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === "CF_Authorization") {
      const value = part.slice(eq + 1).trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

/** Resolve the caller for a request, or throw an ApiError. */
export async function resolveAuth(c: Context<AppEnv>): Promise<AuthContext> {
  const bearer = parseBearer(c.req.header("Authorization"));
  if (bearer !== null) {
    if (!looksLikeApiToken(bearer)) {
      throw unauthorized("Authorization bearer must be a flow_ api key");
    }
    return authenticateApiKey(c, bearer);
  }

  const jwt = c.req.header(ACCESS_JWT_HEADER);
  if (jwt) return authenticateAccess(c, jwt);

  // Cookie fallback for paths on the Access BYPASS app — /ws above all.
  // Browsers cannot attach headers to a WebSocket upgrade, and Access does not
  // inject its JWT header on bypassed paths, but the CF_Authorization cookie
  // set at login carries the same JWT for the whole domain. Verifying it here
  // is identical in strength to the header path (same JWKS, same AUD).
  const cookieJwt = readAccessCookie(c.req.header("Cookie"));
  if (cookieJwt) return authenticateAccess(c, cookieJwt);

  if (c.env.DEV_NO_AUTH === "true") return authenticateDev(c);

  throw unauthorized(
    `unauthenticated: send Authorization: Bearer flow_<token>, or reach this API through Cloudflare Access (${ACCESS_JWT_HEADER})`
  );
}

/** Middleware form: authenticates and stashes the result on the context. */
export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (isPublicPath(new URL(c.req.url).pathname)) return next();
  c.set("auth", await resolveAuth(c));
  return next();
};

/** Read the authenticated caller. Throws if used on a public route. */
export function requireAuth(c: Context<AppEnv>): AuthContext {
  const auth = c.get("auth");
  if (!auth) throw unauthorized("this route requires authentication");
  return auth;
}

/** Gate for owner/admin-only routes (api-key management, workspace shape). */
export function requireAdmin(c: Context<AppEnv>): AuthContext {
  const auth = requireAuth(c);
  if (auth.user.role !== "owner" && auth.user.role !== "admin") {
    throw forbidden(
      `this action requires the owner or admin role; ${auth.user.email} is a ${auth.user.role}`
    );
  }
  return auth;
}

/** Resolve the identity an inbound webhook acts as: the gleap key, else owner. */
export async function resolveInboundActor(env: Env): Promise<{ user: User; actor: Actor }> {
  const found = await findApiKeyByName(env, ["gleap", "gleap-inbound"]);
  if (found && !found.user.deactivated) {
    return {
      user: found.user,
      actor: {
        userId: found.user.id,
        via: "webhook",
        apiKeyId: found.key.id,
        automationRuleId: null,
      },
    };
  }

  const owner = await findUserByEmail(env, (env.OWNER_EMAIL || "").toLowerCase());
  if (!owner) {
    throw unauthorized(
      "inbound webhook has no identity to act as: no 'gleap' api key and no OWNER_EMAIL user"
    );
  }
  return {
    user: owner,
    actor: { userId: owner.id, via: "webhook", apiKeyId: null, automationRuleId: null },
  };
}
