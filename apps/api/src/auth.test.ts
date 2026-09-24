import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ApiKey, User } from "@flow/shared";
import type { AppEnv, Env } from "./env.js";
import { onError } from "./errors.js";
import { generateApiToken } from "./tokens.js";

// The CSRF gate on ambient browser credentials. JWT verification and the DO
// are stubbed: what is under test is which requests reach them at all.

const mocks = vi.hoisted(() => {
  const user = {
    id: "us_admin",
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    deactivated: false,
    createdAt: 1_700_000_000_000,
  } as const;
  return {
    user,
    verifyAccessJwt: vi.fn(async () => ({ email: user.email })),
    resolveApiKey: vi.fn(),
  };
});

vi.mock("./access-jwt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./access-jwt.js")>()),
  verifyAccessJwt: mocks.verifyAccessJwt,
}));
vi.mock("./do.js", () => ({
  findUserByEmail: async () => mocks.user,
  resolveMemberEmail: async () => mocks.user,
  findApiKeyByName: async () => null,
  workspace: () => ({ resolveApiKey: mocks.resolveApiKey }),
}));

import { authMiddleware } from "./auth.js";

const ORIGIN = "https://flow.example.com";
const COOKIE = "CF_Authorization=header.payload.sig";
const user = mocks.user as unknown as User;
const key: ApiKey = {
  id: "ak_1",
  userId: user.id,
  name: "script",
  tokenHash: "0".repeat(64),
  createdAt: 1_700_000_000_000,
  lastUsedAt: null,
  revokedAt: null,
};

const env = {
  ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ACCESS_AUD: "aud",
  OWNER_EMAIL: user.email,
} as unknown as Env;

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use("/api/*", authMiddleware);
  app.use("/mcp", authMiddleware);
  app.all("/api/automations", (c) => c.json({ ok: true, via: c.get("auth").actor.via }));
  app.all("/api/inbound/:token", (c) => c.json({ ok: true }));
  app.all("/mcp", (c) => c.json({ ok: true, via: c.get("auth").actor.via }));
  return app;
}

async function send(
  path: string,
  init: { method?: string; headers?: Record<string, string>; env?: Env } = {}
) {
  return makeApp().request(
    `${ORIGIN}${path}`,
    { method: init.method ?? "POST", headers: init.headers, body: init.method === "GET" ? undefined : "{}" },
    init.env ?? env
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue({ user, key });
});

describe("authMiddleware — CSRF gate for cookie and Access-header sessions", () => {
  it.each(["POST", "PATCH", "PUT", "DELETE"])("403s a cross-origin cookie %s", async (method) => {
    const res = await send("/api/automations", {
      method,
      headers: { Cookie: COOKIE, Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("cross-origin request refused");
    // Refused before the JWT is even verified.
    expect(mocks.verifyAccessJwt).not.toHaveBeenCalled();
  });

  it("lets a same-origin cookie POST through", async () => {
    const res = await send("/api/automations", { headers: { Cookie: COOKIE, Origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, via: "ui" });
  });

  it("falls back to Sec-Fetch-Site when Origin is absent", async () => {
    const res = await send("/api/automations", {
      headers: { Cookie: COOKIE, "Sec-Fetch-Site": "same-origin" },
    });
    expect(res.status).toBe(200);
  });

  it.each(["cross-site", "same-site"])("403s Sec-Fetch-Site %s without an Origin", async (site) => {
    const res = await send("/api/automations", {
      headers: { Cookie: COOKIE, "Sec-Fetch-Site": site },
    });
    expect(res.status).toBe(403);
  });

  it("403s a cookie POST carrying neither Origin nor Sec-Fetch-Site", async () => {
    const res = await send("/api/automations", { headers: { Cookie: COOKIE } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("Sec-Fetch-Site");
  });

  it("403s the opaque Origin a sandboxed frame sends", async () => {
    const res = await send("/api/automations", { headers: { Cookie: COOKIE, Origin: "null" } });
    expect(res.status).toBe(403);
  });

  it("applies the same gate to the Access JWT header", async () => {
    const jwt = { "Cf-Access-Jwt-Assertion": "header.payload.sig" };
    const cross = await send("/api/automations", {
      headers: { ...jwt, Origin: "https://evil.example" },
    });
    expect(cross.status).toBe(403);
    const same = await send("/api/automations", { headers: { ...jwt, Origin: ORIGIN } });
    expect(same.status).toBe(200);
  });

  it("does not gate a GET, even from a foreign origin", async () => {
    const res = await send("/api/automations", {
      method: "GET",
      headers: { Cookie: COOKIE, Origin: "https://evil.example" },
    });
    expect(res.status).toBe(200);
  });
});

describe("authMiddleware — credentials the gate leaves alone", () => {
  it("lets a bearer api key POST from a foreign origin or with no origin at all", async () => {
    const bearer = { Authorization: `Bearer ${generateApiToken()}` };
    const foreign = await send("/api/automations", {
      headers: { ...bearer, Origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toEqual({ ok: true, via: "api" });
    const bare = await send("/api/automations", { headers: bearer });
    expect(bare.status).toBe(200);
  });

  it("lets a bearer api key through /mcp even with a stray cookie", async () => {
    const res = await send("/mcp", {
      headers: { Authorization: `Bearer ${generateApiToken()}`, Cookie: COOKIE },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, via: "mcp" });
  });

  it("skips /api/inbound/*, which authenticates by its own token", async () => {
    const res = await send("/api/inbound/inb_token", { headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(200);
  });

  it("leaves the DEV_NO_AUTH path ungated", async () => {
    const res = await send("/api/automations", {
      headers: { Origin: "https://evil.example" },
      env: { ...env, DEV_NO_AUTH: "true" } as Env,
    });
    expect(res.status).toBe(200);
  });
});
