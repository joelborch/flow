import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Role, User } from "@flow/shared";
import type { AppEnv, AuthContext, Env } from "../env.js";
import { onError } from "../errors.js";
import { queryRoutes } from "./query.js";

// POST /api/query is open to every signed-in user and passes the caller's id to
// the DO, which scopes the views and rate-limits members. The SQL gate and the
// scoping are tested in packages/core/src/query.test.ts; here the DO is a stub.

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

function setup(role: Role, runQuery = vi.fn(async () => ({ columns: ["n"], rows: [[2]], truncated: false }))) {
  const env = { WORKSPACE: { idFromName: () => ({}), get: () => ({ runQuery }) } } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use("*", async (c, next) => {
    c.set("auth", authOf(role));
    return next();
  });
  app.route("/api", queryRoutes);
  const post = (body: unknown) =>
    app.request(
      "/api/query",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      env
    );
  return { post, runQuery };
}

describe("POST /api/query", () => {
  it.each<Role>(["owner", "admin", "member"])("runs for an %s as that user, defaulting maxRows to 200", async (role) => {
    const { post, runQuery } = setup(role);
    const res = await post({ sql: "SELECT count(*) AS n FROM tasks_v" });
    expect(res.status).toBe(200);
    expect(runQuery).toHaveBeenCalledWith("SELECT count(*) AS n FROM tasks_v", 200, `us_${role}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ columns: ["n"], rows: [[2]], truncated: false, rowCount: 1 });
    expect(typeof body.ms).toBe("number");
  });

  it("422s a missing sql or an out-of-range maxRows", async () => {
    const { post } = setup("owner");
    expect((await post({})).status).toBe(422);
    expect((await post({ sql: "SELECT 1", maxRows: 5000 })).status).toBe(422);
  });

  it("passes a member's spent budget through as a 429", async () => {
    const { post } = setup(
      "member",
      vi.fn(async () => {
        throw new Error("too many queries: members may run 30 a minute; try again in 12s");
      })
    );
    const res = await post({ sql: "SELECT 1" });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toContain("try again in 12s");
  });

  it("passes a refusal from the DO through as a readable 422", async () => {
    const { post } = setup(
      "owner",
      vi.fn(async () => {
        throw new Error(`"tasks" is a base table and isn't queryable; use the views (tasks_v)`);
      })
    );
    const res = await post({ sql: "SELECT * FROM tasks" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain("base table");
  });
});
