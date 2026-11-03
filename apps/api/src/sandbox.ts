/// <reference types="@cloudflare/workers-types" />
// Entry point for the public sandbox (sandbox/wrangler.jsonc): the real Flow
// Worker, wrapped so anyone can point an agent at it with a published key.
//
// What the wrapper adds, and why:
//   - Every hour is a fresh workspace (workspaceName in ./env.ts), seeded on
//     first use from sandboxSeed, and the cron wipes the previous hours'. A
//     visitor's mess lasts an hour at most.
//   - The published SANDBOX_TOKEN acts as a plain member, so the app's own
//     rules do the fencing: no spaces, lists, automations or webhooks, and no
//     view of the private Leadership space.
//   - Nothing leaves the sandbox. Attachment uploads are refused (a public
//     write key must not become free file hosting), the side-effects queue is
//     drained without delivering, and there is no email binding.
//   - A per-IP rate limit sits in front of /api and /mcp, on top of the
//     member query budget the DO already enforces.
import { Workspace, SANDBOX_KEY_NAME, SANDBOX_MEMBER_ID, sandboxSeed } from "@flow/core";
import flow from "./index.js";
import type { WorkspaceApi } from "./do.js";
import { SANDBOX_PERIOD_MS, workspaceName, type Env } from "./env.js";
import { hashToken } from "./tokens.js";

export { Workspace };

const REPO_URL = "https://github.com/joelborch/flow";
const DEMO_URL = "https://flow-demo.joel-a67.workers.dev";

/** Hours whose workspaces the cron wipes: the last one, plus one more in case a run was missed. */
const WIPE_HOURS_BACK = [1, 2];

/** Workspaces this isolate has already seen seeded, so it asks the DO once per hour. */
const seeded = new Map<string, Promise<void>>();

/**
 * Seed the current hour's workspace if it isn't yet. The published key's
 * presence is the marker; the seed's ids are fixed, so two isolates racing on
 * a fresh hour upsert the same rows, and the loser's duplicate key insert is
 * the only thing that fails.
 */
export function ensureSeeded(env: Env, now: number = Date.now()): Promise<void> {
  const name = workspaceName(env, now);
  let pending = seeded.get(name);
  if (!pending) {
    pending = seed(env, name, now).catch((err: unknown) => {
      seeded.delete(name);
      throw err;
    });
    seeded.set(name, pending);
    // Only the current hour matters; drop older entries so the map stays tiny.
    for (const key of seeded.keys()) if (key !== name) seeded.delete(key);
  }
  return pending;
}

/** The DO for one named sandbox workspace. Named explicitly so a call made at an hour boundary can't land in the next hour. */
const workspaceNamed = (env: Env, name: string): WorkspaceApi =>
  env.WORKSPACE.get(env.WORKSPACE.idFromName(name)) as unknown as WorkspaceApi;

async function seed(env: Env, name: string, now: number): Promise<void> {
  const token = env.SANDBOX_TOKEN;
  if (!token) throw new Error("SANDBOX_TOKEN is not set");
  const ws = workspaceNamed(env, name);
  const tokenHash = await hashToken(token);
  if (await ws.resolveApiKey(tokenHash)) return;
  const owner = (await ws.listUsers()).find((u) => u.role === "owner");
  if (!owner) throw new Error("sandbox workspace has no owner to seed as");
  await ws.importBatch(sandboxSeed(owner.id, now), owner.id);
  try {
    await ws.createApiKey({ userId: SANDBOX_MEMBER_ID, name: SANDBOX_KEY_NAME, tokenHash }, owner.id);
  } catch (err) {
    // Another isolate seeded the same hour first; its key is the one we wanted.
    if (!(await ws.resolveApiKey(tokenHash))) throw err;
  }
}

/** Wipes the workspaces of the hours just gone. Each is unreachable once its hour ends. */
export async function wipeOldWorkspaces(env: Env, now: number = Date.now()): Promise<void> {
  for (const back of WIPE_HOURS_BACK) {
    await workspaceNamed(env, workspaceName(env, now - back * SANDBOX_PERIOD_MS)).wipeSandbox();
  }
}

const json = (status: number, error: string): Response =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

function landingPage(origin: string, token: string): Response {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const mcp = `claude mcp add --transport http flow-sandbox ${origin}/mcp \\\n  --header "Authorization: Bearer ${token}"`;
  const curl = `curl -sS -X POST ${origin}/api/query \\\n  -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" \\\n  -d '{"sql":"SELECT title, assignee_name, due_on FROM tasks_v WHERE is_closed = 0 ORDER BY due_date"}'`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flow sandbox</title>
<style>
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #1a1a1f; --muted: #6b6b76; --code: #f0f0f3; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121214; --fg: #ececf1; --muted: #9a9aa6; --code: #1e1e22; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 16px; }
  h1 { font-size: 28px; margin: 0 0 8px; } p { margin: 0 0 16px; } .muted { color: var(--muted); }
  pre { background: var(--code); padding: 14px 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
  a { color: #5b5bd6; }
</style></head>
<body><main>
<h1>Flow sandbox</h1>
<p>A live Flow workspace you can point an agent at. The key below is public and acts as a member, so it can read, create and update tasks in the shared spaces, but can't reshape the workspace. Everything resets at the top of every hour.</p>
<p><strong>Connect Claude Code over MCP:</strong></p>
<pre>${esc(mcp)}</pre>
<p>Then ask it something like "what's overdue, and who owns it?" It can answer with one <code>flow_query</code> call.</p>
<p><strong>Or call the API directly:</strong></p>
<pre>${esc(curl)}</pre>
<p class="muted">Don't put anything real here: every visitor uses the same key and sees the same data. Uploads, email and webhooks are off, and requests are rate-limited.</p>
<p><a href="${REPO_URL}">Source and self-hosting</a> · <a href="${DEMO_URL}">See the web app</a></p>
</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/** Paths the wrapper refuses before the app sees them. */
function refused(method: string, pathname: string): string | null {
  if (method === "POST" && /^\/api\/tasks\/[^/]+\/attachments\/?$/.test(pathname)) {
    return "attachment uploads are off in the sandbox";
  }
  return null;
}

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
    const why = refused(request.method, url.pathname);
    if (why) return json(403, why);

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
