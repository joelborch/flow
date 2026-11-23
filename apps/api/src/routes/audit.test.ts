import { describe, expect, it } from "vitest";
import type { Role } from "@flow/shared";
import { auditRoutes } from "./audit.js";
import { authedApp, workspaceEnv } from "./testkit.js";

// GET /api/audit is workspace-wide history — every space, every actor — so it
// carries the same owner/admin gate as the routes that shape the workspace.
// These tests run the real Hono routes against a stubbed DO binding: the gate
// under test is requireAdmin, not the audit walk itself.

const env = workspaceEnv({
  getAuditLog: async () => ({ entries: [], nextBefore: null }),
});

const appAs = (role: Role) => authedApp(role, auditRoutes);

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
