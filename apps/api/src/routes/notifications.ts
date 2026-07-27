import { Hono } from "hono";
import { NotificationPrefPatch, type NotificationSettings } from "@flow/shared";
import { requireAuth } from "../auth.js";
import { workspace } from "../do.js";
import type { AppEnv } from "../env.js";
import { parseOrThrow, readJson } from "../errors.js";

export const notificationRoutes = new Hono<AppEnv>();

/**
 * Notification preferences are strictly self-service: both routes act on the
 * calling user's own prefs, never another user's. There is deliberately no
 * userId in the path — the identity comes from the authenticated caller.
 */

/** The prefs the caller has set (or the defaults), plus their derived email. */
notificationRoutes.get("/notifications/prefs", async (c) => {
  const auth = requireAuth(c);
  const prefs = await workspace(c.env).getNotificationPrefs(auth.user.id);
  const settings: NotificationSettings = {
    userId: auth.user.id,
    email: auth.user.email || null,
    prefs,
  };
  return c.json(settings);
});

/** Patch any subset of the booleans; the response is the full merged set. */
notificationRoutes.put("/notifications/prefs", async (c) => {
  const auth = requireAuth(c);
  const patch = parseOrThrow(NotificationPrefPatch, await readJson(c), "notification prefs");
  const prefs = await workspace(c.env).setNotificationPrefs(auth.user.id, patch);
  const settings: NotificationSettings = {
    userId: auth.user.id,
    email: auth.user.email || null,
    prefs,
  };
  return c.json(settings);
});
