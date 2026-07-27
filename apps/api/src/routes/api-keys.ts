import { Hono } from "hono";
import { z } from "zod";
import { Id, type Role } from "@flow/shared";
import { requireAuth } from "../auth.js";
import { findUserById, workspace } from "../do.js";
import type { AppEnv } from "../env.js";
import { badRequest, forbidden, notFound, parseOrThrow, readJson } from "../errors.js";
import { generateApiToken, hashToken } from "../tokens.js";

export const apiKeyRoutes = new Hono<AppEnv>();

const CreateApiKeyBody = z.object({
  name: z.string().min(1),
  /** The user this key impersonates. Defaults to the caller. */
  userId: Id.optional(),
});

/**
 * Keys are self-serve. Anyone can mint a key that acts as themselves — that is
 * the "connect my agent" path, and it grants the agent exactly the access its
 * owner already has. Minting a key that acts as somebody *else* is an
 * escalation, so it stays owner/admin. Listing and revoking follow the same
 * line: your own keys are yours, everyone's keys are an admin view.
 */
export type KeyViewer = { id: string; role: Role };

export function managesAllKeys(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** Members see only the keys that impersonate them; owner/admin see all. */
export function visibleApiKeys<K extends { userId: string }>(
  keys: readonly K[],
  viewer: KeyViewer
): K[] {
  if (managesAllKeys(viewer.role)) return [...keys];
  return keys.filter((k) => k.userId === viewer.id);
}

/** Null when the create is allowed, otherwise the sentence to 403 with. */
export function createKeyDenial(viewer: KeyViewer, targetUserId: string): string | null {
  if (targetUserId === viewer.id || managesAllKeys(viewer.role)) return null;
  return `creating an API key that impersonates another user requires the owner or admin role; you can only create keys that act as yourself`;
}

/** Null when the revoke is allowed, otherwise the sentence to 403 with. */
export function revokeKeyDenial(viewer: KeyViewer, key: { userId: string }): string | null {
  if (key.userId === viewer.id || managesAllKeys(viewer.role)) return null;
  return `this API key impersonates another user; only its owner, or a workspace owner or admin, can revoke it`;
}

/**
 * List keys. Only ever hashes — the plaintext token exists for the duration of
 * one create response and is never recoverable afterwards.
 */
apiKeyRoutes.get("/api-keys", async (c) => {
  const auth = requireAuth(c);
  const keys = await workspace(c.env).listApiKeys();
  const mine = visibleApiKeys(keys, auth.user);
  return c.json({
    apiKeys: mine.map(({ tokenHash, ...rest }) => ({
      ...rest,
      // A short fingerprint is enough to match a key to a log line.
      tokenFingerprint: tokenHash.slice(0, 8),
    })),
  });
});

/** Create. The token is in this response body and nowhere else, ever. */
apiKeyRoutes.post("/api-keys", async (c) => {
  const auth = requireAuth(c);
  const input = parseOrThrow(CreateApiKeyBody, await readJson(c));

  const userId = input.userId ?? auth.user.id;
  const denial = createKeyDenial(auth.user, userId);
  if (denial) throw forbidden(denial);

  const target = await findUserById(c.env, userId);
  if (!target) throw badRequest(`cannot create a key for unknown user ${userId}`);
  if (target.deactivated) {
    throw badRequest(`cannot create a key impersonating deactivated user ${target.email}`);
  }

  const token = generateApiToken();
  const apiKey = await workspace(c.env).createApiKey(
    { name: input.name, userId, tokenHash: await hashToken(token) },
    auth.actor
  );

  const { tokenHash: _hash, ...safe } = apiKey;
  return c.json(
    {
      apiKey: safe,
      /** Shown exactly once. Store it now; it cannot be retrieved again. */
      token,
      impersonates: { id: target.id, email: target.email, name: target.name },
      warning: "This token is shown only once and cannot be recovered.",
    },
    201
  );
});

/** Revoke. Idempotent from the caller's point of view. */
apiKeyRoutes.delete("/api-keys/:apiKeyId", async (c) => {
  const auth = requireAuth(c);
  const apiKeyId = parseOrThrow(Id, c.req.param("apiKeyId"), "apiKeyId");

  // Looked up first so the ownership rule can be decided before anything is
  // written, and so a member never gets a 500 from the DO's own not-found.
  const key = (await workspace(c.env).listApiKeys()).find((k) => k.id === apiKeyId);
  if (!key) throw notFound(`API key ${apiKeyId} not found.`);
  const denial = revokeKeyDenial(auth.user, key);
  if (denial) throw forbidden(denial);

  await workspace(c.env).revokeApiKey(apiKeyId, auth.actor);
  return c.json({ ok: true, revoked: apiKeyId });
});
