import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv, Env } from "../env.js";
import { onError } from "../errors.js";
import { handleWebSocketUpgrade } from "./ws.js";

const mockResolveAuth = vi.fn();
vi.mock("../auth.js", () => ({
  resolveAuth: (c: unknown) => mockResolveAuth(c),
}));

describe("GET /ws — WebSocket upgrade origin check", () => {
  const APP_HOSTNAME = "flow.example.com";
  let stubFetch: ReturnType<typeof vi.fn>;
  let env: Env;
  let app: Hono<AppEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    stubFetch = vi.fn(async (_req: Request) => new Response("do-upgrade-response", { status: 200 }));
    env = {
      APP_HOSTNAME,
      WORKSPACE: {
        idFromName: () => "main-id",
        get: () => ({ fetch: stubFetch }),
      },
    } as unknown as Env;

    mockResolveAuth.mockResolvedValue({
      user: {
        id: "us_test",
        email: "test@example.com",
        name: "Test User",
        role: "member",
        deactivated: false,
        createdAt: 0,
      },
      actor: { userId: "us_test", via: "ui", apiKeyId: null, automationRuleId: null },
      apiKey: null,
    });

    app = new Hono<AppEnv>();
    app.onError(onError);
    app.get("/ws", handleWebSocketUpgrade);
  });

  it("passes to DO stub when Origin matches https://${APP_HOSTNAME}", async () => {
    const req = new Request("https://flow.example.com/ws", {
      headers: {
        Upgrade: "websocket",
        Origin: `https://${APP_HOSTNAME}`,
      },
    });

    const res = await app.fetch(req, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("do-upgrade-response");
    expect(stubFetch).toHaveBeenCalledTimes(1);
  });

  // Dev: Vite on :5173 proxies /ws to the Worker on localhost:8787, so the
  // origin and the host the request arrived on are the same machine.
  it("passes to DO stub when a localhost Origin reaches the Worker on localhost", async () => {
    const req = new Request("http://localhost:8787/ws", {
      headers: {
        Upgrade: "websocket",
        Origin: "http://localhost:5173",
      },
    });

    const res = await app.fetch(req, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("do-upgrade-response");
    expect(stubFetch).toHaveBeenCalledTimes(1);
  });

  // The same origin against the deployed host is the residual CSWSH vector: a
  // page served from the victim's own localhost. Rejected, because the request
  // did not arrive on localhost.
  it("rejects a localhost Origin against the deployed hostname", async () => {
    const req = new Request("https://flow.example.com/ws", {
      headers: {
        Upgrade: "websocket",
        Origin: "http://localhost:5173",
      },
    });

    const res = await app.fetch(req, env);
    expect(res.status).toBe(403);
    expect(stubFetch).not.toHaveBeenCalled();
  });

  it("rejects a lookalike origin that merely suffixes the app hostname", async () => {
    const req = new Request("https://flow.example.com/ws", {
      headers: {
        Upgrade: "websocket",
        Origin: `https://${APP_HOSTNAME}.evil.com`,
      },
    });

    const res = await app.fetch(req, env);
    expect(res.status).toBe(403);
    expect(stubFetch).not.toHaveBeenCalled();
  });

  it("passes to DO stub when there is no Origin header", async () => {
    const req = new Request("https://flow.example.com/ws", {
      headers: {
        Upgrade: "websocket",
      },
    });

    const res = await app.fetch(req, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("do-upgrade-response");
    expect(stubFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects foreign Origin https://evil.attacker.com with 403 Forbidden without DO fetch", async () => {
    const req = new Request("https://flow.example.com/ws", {
      headers: {
        Upgrade: "websocket",
        Origin: "https://evil.attacker.com",
      },
    });

    const res = await app.fetch(req, env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("cross-origin websocket connection rejected from https://evil.attacker.com");
    expect(stubFetch).not.toHaveBeenCalled();
  });

  it("rejects invalid Origin header with 403 Forbidden without DO fetch", async () => {
    const req = new Request("https://flow.example.com/ws", {
      headers: {
        Upgrade: "websocket",
        Origin: "not-a-valid-url",
      },
    });

    const res = await app.fetch(req, env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid websocket origin header");
    expect(stubFetch).not.toHaveBeenCalled();
  });
});
