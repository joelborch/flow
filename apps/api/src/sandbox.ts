/// <reference types="@cloudflare/workers-types" />
// Entry point for the public sandbox (sandbox/wrangler.jsonc). The guards and
// seeding live in ./sandbox-core.ts, which explains what each one is for; this
// file only wires them in front of the real Worker. Export nothing else here:
// workerd treats every named export of an entry module as a handler.
import { Workspace } from "@flow/core";
import flow from "./index.js";
import type { Env } from "./env.js";
import { ensureSeeded, json, landingPage, oversizedWrite, refused, wipeOldWorkspaces } from "./sandbox-core.js";

export { Workspace };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Without SANDBOX the workspace name falls back to "main", so this entry
    // would seed sample data into a real workspace. Refuse instead.
    if (env.SANDBOX !== "true") return json(500, "the sandbox entry needs SANDBOX=\"true\"");
    const url = new URL(request.url);
    const isApp = url.pathname.startsWith("/api/") || url.pathname === "/mcp" || url.pathname.startsWith("/mcp/") || url.pathname === "/ws";
    if (!isApp) return landingPage(url.origin, env.SANDBOX_TOKEN ?? "flow_…");

    if (env.SANDBOX_RATE_LIMIT) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.SANDBOX_RATE_LIMIT.limit({ key: ip });
      if (!success) return json(429, "too many requests to the sandbox; slow down and try again in a minute");
    }
    if (env.SANDBOX_TOTAL_LIMIT) {
      const { success } = await env.SANDBOX_TOTAL_LIMIT.limit({ key: "all" });
      if (!success) return json(429, "the sandbox is busy right now; try again in a minute");
    }
    const why = refused(request.method, url.pathname);
    if (why) return json(403, why);
    const tooBig = await oversizedWrite(request);
    if (tooBig) return json(413, tooBig);

    await ensureSeeded(env);
    return flow.fetch(request, env, ctx);
  },

  /** Side effects never leave the sandbox: acknowledge and drop them. */
  async queue(batch: MessageBatch): Promise<void> {
    batch.ackAll();
  },

  /** Hourly: wipe the hours that just ended and seed the new one before anyone asks. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    if (env.SANDBOX !== "true") return;
    await wipeOldWorkspaces(env);
    await ensureSeeded(env);
  },
} satisfies ExportedHandler<Env>;
