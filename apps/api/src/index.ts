/// <reference types="@cloudflare/workers-types" />
import { Hono } from "hono";
import { Workspace } from "@flow/core";
import { authMiddleware, signInMode } from "./auth.js";
import { cachedBackupHealth } from "./do.js";
import { handleEmail } from "./email-intake.js";
import { onError, notFoundHandler } from "./errors.js";
import { mcpHandler } from "./mcp/index.js";
import { handleDeadLetterBatch, handleSideEffectBatch } from "./side-effects/index.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { auditRoutes } from "./routes/audit.js";
import { automationRoutes } from "./routes/automations.js";
import { emailIntakeRoutes } from "./routes/email-intake.js";
import { handoffRoutes } from "./routes/handoffs.js";
import { importRoutes } from "./routes/import.js";
import { inboundRoutes } from "./routes/inbound.js";
import { listRoutes } from "./routes/lists.js";
import { meRoutes } from "./routes/me.js";
import { notificationRoutes } from "./routes/notifications.js";
import { spaceRoutes } from "./routes/spaces.js";
import { taskRoutes } from "./routes/tasks.js";
import { handleWebSocketUpgrade } from "./routes/ws.js";
import type { AppEnv, Env } from "./env.js";

export { Workspace };
export type { Env } from "./env.js";
// NOTE: no value re-exports here besides the DO class — workerd treats every
// named export on the entrypoint as a handler/DO class and wrangler dev refuses
// to start. Import WORKSPACE_NAME/WS_USER_HEADER from ./env.js directly.

const app = new Hono<AppEnv>();

app.onError(onError);
app.notFound(notFoundHandler);

// Liveness plus backup freshness. Public by design so uptime checks do not
// need a credential, which is why `backup` carries only times and the stale
// flag; the error text and object key live on GET /api/admin/backup. A stale
// backup keeps `ok: true` (the app is up); an unreachable DO is a 503. The
// answer is cached per isolate for a minute (see cachedBackupHealth).
app.get("/api/health", async (c) => {
  try {
    const backup = await cachedBackupHealth(c.env);
    return c.json({ ok: true, service: "flow", ts: Date.now(), backup });
  } catch (err) {
    console.error("health: workspace unreachable", err instanceof Error ? err.message : err);
    return c.json({ ok: false, service: "flow", ts: Date.now(), backup: null }, 503);
  }
});

// Whether sign-in is configured yet: "access", "dev" (DEV_NO_AUTH) or
// "unconfigured". Public and a single word, so the web app can ask before it
// redirects a 401 to Access (see signInMode in auth.ts).
app.get("/api/setup", (c) => c.json({ signIn: signInMode(c.env) }));

/**
 * Auth gate for everything that is not the SPA. `authMiddleware` lets
 * /api/health, /api/setup and /api/inbound/* through (the latter authenticates per-list
 * against the list's own token) and rejects everything else without a valid
 * Cloudflare Access JWT or `flow_` bearer token.
 */
app.use("/api/*", authMiddleware);
app.use("/mcp", authMiddleware);
app.use("/mcp/*", authMiddleware);

// --- REST ------------------------------------------------------------------
// Order matters within taskRoutes (/tasks/search and /tasks/bulk are declared
// before /tasks/:taskId); across routers it does not, since the paths are
// disjoint.
app.route("/api", meRoutes);
app.route("/api", spaceRoutes);
app.route("/api", listRoutes);
app.route("/api", taskRoutes);
app.route("/api", handoffRoutes);
app.route("/api", attachmentRoutes);
app.route("/api", automationRoutes);
app.route("/api", notificationRoutes);
app.route("/api", auditRoutes);
app.route("/api", apiKeyRoutes);
app.route("/api", inboundRoutes);
app.route("/api", emailIntakeRoutes);
app.route("/api", importRoutes);

// --- MCP -------------------------------------------------------------------
// Streamable HTTP: one endpoint, all methods. Auth has
// already run, so the resolved caller is handed straight over and every tool
// acts as that user.
app.all("/mcp", (c) => mcpHandler(c.req.raw, c.env, c.get("auth")));
app.all("/mcp/*", (c) => mcpHandler(c.req.raw, c.env, c.get("auth")));

// --- WebSocket -------------------------------------------------------------
app.get("/ws", handleWebSocketUpgrade);

export default {
  fetch: app.fetch,
  /**
   * Outbound side effects (webhooks, email) and their dead letters. Owned by
   * the automations agent. One Worker consumes both queues (wrangler.jsonc
   * has a consumer entry for each), dispatched on batch.queue.
   */
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    if (batch.queue === "flow-dlq") {
      await handleDeadLetterBatch(batch, env);
      return;
    }
    await handleSideEffectBatch(batch, env);
  },
  /**
   * Email Routing's catch-all on EMAIL_INTAKE_DOMAIN delivers here: an allowed
   * sender's mail opens a ticket, a reply comments on it (src/email-intake.ts).
   */
  email: handleEmail,
} satisfies ExportedHandler<Env>;
