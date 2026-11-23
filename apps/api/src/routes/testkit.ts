import { Hono } from "hono";
import type { Actor, Role, User } from "@flow/shared";
import type { AppEnv, AuthContext, Env } from "../env.js";
import { onError } from "../errors.js";

export function testUser(role: Role): User {
  return {
    id: `us_${role}`,
    email: `${role}@example.com`,
    name: role,
    role,
    deactivated: false,
    createdAt: 1_700_000_000_000,
  };
}

export function authOf(role: Role, via: Actor["via"] = "api"): AuthContext {
  return {
    user: testUser(role),
    apiKey: null,
    actor: { userId: `us_${role}`, via, apiKeyId: null, automationRuleId: null },
  };
}

export function authedApp(
  auth: AuthContext | Role,
  ...routers: Array<Hono<AppEnv>>
): Hono<AppEnv> {
  const resolved = typeof auth === "string" ? authOf(auth) : auth;
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use("*", async (c, next) => {
    c.set("auth", resolved);
    return next();
  });
  for (const router of routers) app.route("/api", router);
  return app;
}

export function workspaceEnv(stub: unknown, extra: Record<string, unknown> = {}): Env {
  return {
    WORKSPACE: { idFromName: () => ({}), get: () => stub },
    ...extra,
  } as unknown as Env;
}
