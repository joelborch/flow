import { Hono } from "hono";
import { z } from "zod";
import type { AutomationRunLog } from "@flow/shared";
import { Id, UpsertAutomationInput } from "@flow/shared";
import { requireAdmin, requireAuth } from "../auth.js";
import { workspace } from "../do.js";
import type { AppEnv } from "../env.js";
import { notFound, parseOrThrow, readJson } from "../errors.js";

export const automationRoutes = new Hono<AppEnv>();

/**
 * Shared query shape for both run-log routes. `before` is the previous page's
 * `cursor` — a keyset over the run id rather than an offset, so runs landing
 * mid-pagination cannot make a page skip or repeat rows.
 */
export const RunsQuery = z.object({
  taskId: Id.optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Query params, minus empties so `?before=` is "absent" rather than invalid. */
function queryOf(url: string): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const [key, value] of new URL(url).searchParams) {
    if (value !== "") raw[key] = value;
  }
  return raw;
}

/**
 * A full page means there is probably more; the cursor is the smallest id on
 * it. Null means the caller has reached the end of the log.
 */
export function runsPage(runs: AutomationRunLog[], limit: number): {
  runs: AutomationRunLog[];
  cursor: number | null;
} {
  const last = runs[runs.length - 1];
  return { runs, cursor: runs.length === limit && last ? last.id : null };
}

automationRoutes.get("/automations", async (c) => {
  requireAuth(c);
  return c.json({ automations: await workspace(c.env).listAutomations() });
});

automationRoutes.get("/automations/:ruleId", async (c) => {
  requireAuth(c);
  const ruleId = parseOrThrow(Id, c.req.param("ruleId"), "ruleId");
  const rules = await workspace(c.env).listAutomations();
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) throw notFound(`no automation rule ${ruleId}`);
  return c.json(rule);
});

/**
 * Recent firings across every rule, newest first. This is the "what have the
 * automations been doing?" view — each entry carries one result per action
 * (`ok`, `dryRun`, `detail`), which is the only place a dry-run email or a
 * failed webhook is visible at all.
 */
automationRoutes.get("/automation-runs", async (c) => {
  requireAuth(c);
  const q = parseOrThrow(RunsQuery, queryOf(c.req.url), "automation runs query params");
  const runs = await workspace(c.env).listAutomationRuns({
    ...(q.taskId !== undefined ? { taskId: q.taskId } : {}),
    ...(q.before !== undefined ? { before: q.before } : {}),
    limit: q.limit,
  });
  return c.json(runsPage(runs, q.limit));
});

/** The same log, narrowed to one rule. 404s if the rule does not exist. */
automationRoutes.get("/automations/:ruleId/runs", async (c) => {
  requireAuth(c);
  const ruleId = parseOrThrow(Id, c.req.param("ruleId"), "ruleId");
  const q = parseOrThrow(RunsQuery, queryOf(c.req.url), "automation runs query params");

  const ws = workspace(c.env);
  const rules = await ws.listAutomations();
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) throw notFound(`no automation rule ${ruleId}`);

  const runs = await ws.listAutomationRuns({
    ruleId,
    ...(q.taskId !== undefined ? { taskId: q.taskId } : {}),
    ...(q.before !== undefined ? { before: q.before } : {}),
    limit: q.limit,
  });
  return c.json({ ruleId, ruleName: rule.name, ...runsPage(runs, q.limit) });
});

/** Create. Rules ship disabled unless the body says otherwise. */
automationRoutes.post("/automations", async (c) => {
  const auth = requireAdmin(c);
  const input = parseOrThrow(UpsertAutomationInput, await readJson(c));
  return c.json(await workspace(c.env).upsertAutomation(input, auth.actor), 201);
});

/** Upsert against a known id. The path id always wins over the body's. */
automationRoutes.patch("/automations/:ruleId", async (c) => {
  const auth = requireAdmin(c);
  const ruleId = parseOrThrow(Id, c.req.param("ruleId"), "ruleId");
  const body = await readJson(c);
  const input = parseOrThrow(UpsertAutomationInput, {
    ...(typeof body === "object" && body !== null ? body : {}),
    id: ruleId,
  });
  return c.json(await workspace(c.env).upsertAutomation(input, auth.actor));
});

automationRoutes.delete("/automations/:ruleId", async (c) => {
  const auth = requireAdmin(c);
  const ruleId = parseOrThrow(Id, c.req.param("ruleId"), "ruleId");
  await workspace(c.env).deleteAutomation(ruleId, auth.actor);
  return c.json({ ok: true, deleted: ruleId });
});
