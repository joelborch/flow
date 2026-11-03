import { Hono } from "hono";
import { z } from "zod";
import { QUERY_DEFAULT_ROWS, QUERY_MAX_ROWS } from "@flow/core/query";
import { requireAdmin } from "../auth.js";
import { workspace } from "../do.js";
import type { AppEnv } from "../env.js";
import { parseOrThrow, readJson } from "../errors.js";

export const queryRoutes = new Hono<AppEnv>();

const QueryBody = z.object({
  /** One SELECT (or WITH … SELECT) over the *_v views; see packages/core/src/query.ts. */
  sql: z.string().min(1),
  maxRows: z.number().int().min(1).max(QUERY_MAX_ROWS).default(QUERY_DEFAULT_ROWS),
});

queryRoutes.post("/query", async (c) => {
  // The views span every space, private ones included, and one heavy query
  // holds the single DO for everyone. Owner/admin only, like /api/audit.
  requireAdmin(c);
  const body = parseOrThrow(QueryBody, await readJson(c));
  const started = Date.now();
  const result = await workspace(c.env).runQuery(body.sql, body.maxRows);
  return c.json({ ...result, rowCount: result.rows.length, ms: Date.now() - started });
});
