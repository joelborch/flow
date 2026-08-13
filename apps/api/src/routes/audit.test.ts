import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Role, User } from "@flow/shared";
import type { AppEnv, AuthContext, Env } from "../env.js";
import { onError } from "../errors.js";
import { auditRoutes } from "./audit.js";

// GET /api/audit is workspace-wide history — every space, every actor — so it
// carries the same owner/admin gate as the routes that shape the workspace.
// These tests run the real Hono routes against a stubbed DO binding: the gate
// under test is requireAdmin, not the audit walk itself.

const userOf = (role: Role): User => ({
  id: `us_${role}`,
  email: `${role}@example.com`,
  name: role,
  role,
  deactivated: false,
  createdAt: 1_700_000_000_000,
});

const authOf = (role: Role): AuthContext => ({
  user: userOf(role),
  apiKey: null,
  actor: { userId: `us_${role}`, via: "api", apiKeyId: null, automationRuleId: null },
});

/** The one DO method the route reaches after the gate. */
const stub = {
  getAuditLog: async () => ({ entries: [], nextBefore: null }),
};

const env = {
  WORKSPACE: { idFromName: () => ({}), get: () => stub },
} as unknown as Env;

function appAs(role: Role): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use("*", async (c, next) => {
    c.set("auth", authOf(role));
    return next();
  });
  app.route("/api", auditRoutes);
  return app;
}

describe("GET /api/audit — admin gate", () => {
  it("403s a member, naming the role and the requirement", async () => {
    const res = await appAs("member").request("/api/audit", {}, env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("owner or admin");
    expect(body.error).toContain("member");
  });

  it.each<Role>(["owner", "admin"])("still serves an %s", async (role) => {
    const res = await appAs(role).request("/api/audit", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [], cursor: null });
  });
});
