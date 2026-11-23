import { Hono } from "hono";
import { requireAdmin } from "../auth.js";
import { workspace } from "../do.js";
import type { AppEnv } from "../env.js";

export const adminRoutes = new Hono<AppEnv>();

// Manual backup trigger. Owner/admin-only maintenance endpoint.
adminRoutes.post("/admin/backup", async (c) => {
  requireAdmin(c);
  const result = await workspace(c.env).runBackupNow();
  return c.json({ ok: true, ...result });
});

// Full backup status, including the last error message and object key that
// the public /api/health deliberately leaves out.
adminRoutes.get("/admin/backup", async (c) => {
  requireAdmin(c);
  return c.json(await workspace(c.env).getBackupStatus());
});
