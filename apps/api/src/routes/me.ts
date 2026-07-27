import { Hono } from "hono";
import { requireAuth } from "../auth.js";
import { workspace } from "../do.js";
import type { AppEnv } from "../env.js";

export const meRoutes = new Hono<AppEnv>();

/** Who am I, and how did I get here. Agents use this to confirm impersonation. */
meRoutes.get("/me", (c) => {
  const auth = requireAuth(c);
  return c.json({
    user: auth.user,
    via: auth.actor.via,
    apiKey: auth.apiKey ? { id: auth.apiKey.id, name: auth.apiKey.name } : null,
  });
});

/** The whole board in one shot. WS clients get this via the DO instead. */
meRoutes.get("/snapshot", async (c) => {
  const auth = requireAuth(c);
  // Filtered to what this caller may see: private spaces they are not a member
  // of, and every list, task and subtask under them, are simply not here.
  return c.json(await workspace(c.env).getSnapshot(auth.user.id));
});

/** Workspace members, for assignee pickers. */
meRoutes.get("/users", async (c) => {
  requireAuth(c);
  return c.json({ users: await workspace(c.env).listUsers() });
});
