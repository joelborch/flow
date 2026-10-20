import { Hono } from "hono";
import { Id, SetEmailIntakeInput } from "@flow/shared";
import { requireAdmin } from "../auth.js";
import { workspace } from "../do.js";
import type { AppEnv } from "../env.js";
import { parseOrThrow, readJson } from "../errors.js";

export const emailIntakeRoutes = new Hono<AppEnv>();

/**
 * Per-list email intake: mail to <alias>@<EMAIL_INTAKE_DOMAIN> from an allowed
 * sender opens a task in that list (see src/email-intake.ts). Every route is
 * owner/admin only, reads included: the allowlists name clients' addresses,
 * and an intake decides who outside the workspace can file work into it.
 */

emailIntakeRoutes.get("/email-intakes", async (c) => {
  requireAdmin(c);
  const intakes = await workspace(c.env).listEmailIntakes();
  // The domain lets the UI show full addresses; null means Email Routing
  // isn't configured for this deployment.
  return c.json({ domain: c.env.EMAIL_INTAKE_DOMAIN?.trim() || null, intakes });
});

/** Create or replace. The DO refuses an alias another list already uses. */
emailIntakeRoutes.put("/lists/:listId/email-intake", async (c) => {
  const auth = requireAdmin(c);
  const listId = parseOrThrow(Id, c.req.param("listId"), "listId");
  const input = parseOrThrow(SetEmailIntakeInput, await readJson(c));
  const intake = await workspace(c.env).setEmailIntake(listId, input, auth.actor);
  return c.json({ intake });
});

emailIntakeRoutes.delete("/lists/:listId/email-intake", async (c) => {
  const auth = requireAdmin(c);
  const listId = parseOrThrow(Id, c.req.param("listId"), "listId");
  await workspace(c.env).setEmailIntake(listId, null, auth.actor);
  return c.json({ ok: true });
});
