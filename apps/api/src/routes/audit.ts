import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { queryAudit } from "../do.js";
import type { AppEnv } from "../env.js";
import { parseOrThrow } from "../errors.js";

export const auditRoutes = new Hono<AppEnv>();

const AuditQuery = z.object({
  /** Which key made the change — the reason the audit trail records key ids. */
  apiKeyId: z.string().min(4).optional(),
  userId: z.string().min(4).optional(),
  /** Entity id, e.g. "tk_abc123". */
  entity: z.string().min(1).optional(),
  /** Mutation name, e.g. "task.update". */
  action: z.string().min(1).optional(),
  before: z.coerce.number().int().nonnegative().optional(),
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

auditRoutes.get("/audit", async (c) => {
  requireAuth(c);
  const url = new URL(c.req.url);
  const raw: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (value !== "") raw[key] = value;
  }
  const filter = parseOrThrow(AuditQuery, raw, "audit query params");
  return c.json(await queryAudit(c.env, filter));
});
