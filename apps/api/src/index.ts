/// <reference types="@cloudflare/workers-types" />
import { Hono } from "hono";
import { Workspace } from "@flow/core";
import { authMiddleware } from "./auth.js";
import { onError, notFoundHandler } from "./errors.js";
import { mcpHandler } from "./mcp/index.js";
import { handleSideEffectBatch } from "./side-effects/index.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { auditRoutes } from "./routes/audit.js";
import { automationRoutes } from "./routes/automations.js";
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

// Liveness. Public by design so uptime checks do not need a credential.
app.get("/api/health", (c) =>
  c.json({ ok: true, service: "flow", ts: Date.now() })
);

/**
 * Auth gate for everything that is not the SPA. `authMiddleware` lets
 * /api/health and /api/inbound/* through (the latter authenticates per-list
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
app.route("/api", attachmentRoutes);
app.route("/api", automationRoutes);
app.route("/api", notificationRoutes);
app.route("/api", auditRoutes);
app.route("/api", apiKeyRoutes);
app.route("/api", inboundRoutes);
app.route("/api", importRoutes);

// --- MCP -------------------------------------------------------------------
// Streamable HTTP: one endpoint, all methods. Owned by the mcp agent; auth has
// already run, so the resolved caller is handed straight over and every tool
// acts as that user.
app.all("/mcp", (c) => mcpHandler(c.req.raw, c.env, c.get("auth")));
app.all("/mcp/*", (c) => mcpHandler(c.req.raw, c.env, c.get("auth")));

// --- WebSocket -------------------------------------------------------------
app.get("/ws", handleWebSocketUpgrade);

export default {
  fetch: app.fetch,
  /** Outbound side effects (webhooks, email). Owned by the automations agent. */
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await handleSideEffectBatch(batch, env);
  },
} satisfies ExportedHandler<Env>;
