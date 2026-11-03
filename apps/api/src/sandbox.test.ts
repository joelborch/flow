import { describe, expect, it, vi } from "vitest";
import { SANDBOX_MEMBER_ID } from "@flow/core";
import sandbox, { ensureSeeded, wipeOldWorkspaces } from "./sandbox.js";
import { SANDBOX_PERIOD_MS, workspaceName, type Env } from "./env.js";

// The public sandbox wrapper (src/sandbox.ts). The DO is a stub keyed by
// workspace name, so these check which workspace each call reaches as well as
// what it does. The seed itself is tested against the real Workspace in
// packages/core/src/sandbox-seed.test.ts.

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));

const TOKEN = "flow_sandbox_public_key_for_tests_only";
const HOUR = 500_000; // an arbitrary hour number
const NOW = HOUR * SANDBOX_PERIOD_MS + 1_000;

function stubWorkspace() {
  let hasKey = false;
  return {
    resolveApiKey: vi.fn(async () => (hasKey ? { key: {}, user: {} } : null)),
    listUsers: vi.fn(async () => [{ id: "us_owner", role: "owner" }]),
    importBatch: vi.fn(async (_batch: unknown, _actor: string) => ({ errors: [] })),
    createApiKey: vi.fn(async () => {
      hasKey = true;
      return {};
    }),
    wipeSandbox: vi.fn(async () => ({ ok: true })),
    setHasKey: (v: boolean) => {
      hasKey = v;
    },
  };
}

function setup(overrides: Partial<Env> = {}) {
  const stubs = new Map<string, ReturnType<typeof stubWorkspace>>();
  const stubFor = (name: string) => {
    if (!stubs.has(name)) stubs.set(name, stubWorkspace());
    return stubs.get(name)!;
  };
  const limit = vi.fn(async () => ({ success: true }));
  const env = {
    SANDBOX: "true",
    SANDBOX_TOKEN: TOKEN,
    SANDBOX_RATE_LIMIT: { limit },
    WORKSPACE: {
      idFromName: (name: string) => name,
      get: (name: string) => stubFor(name),
    },
    ...overrides,
  } as unknown as Env;
  return { env, stubFor, limit };
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = (env: Env, path: string, init?: RequestInit) =>
  sandbox.fetch(new Request(`https://sandbox.example.com${path}`, init), env, ctx);

describe("workspaceName", () => {
  it("is always main outside the sandbox and a new name every hour inside it", () => {
    expect(workspaceName({}, NOW)).toBe("main");
    expect(workspaceName({ SANDBOX: "false" }, NOW)).toBe("main");
    expect(workspaceName({ SANDBOX: "true" }, NOW)).toBe(`sandbox-${HOUR}`);
    expect(workspaceName({ SANDBOX: "true" }, NOW + SANDBOX_PERIOD_MS)).toBe(`sandbox-${HOUR + 1}`);
  });
});

describe("sandbox fetch", () => {
  it("refuses to run without SANDBOX, so it can never seed a real workspace", async () => {
    const { env, stubFor } = setup({ SANDBOX: undefined });
    const res = await call(env, "/api/me");
    expect(res.status).toBe(500);
    expect(stubFor("main").importBatch).not.toHaveBeenCalled();
  });

  it("serves the front page with the published key and connect instructions", async () => {
    const { env } = setup();
    const res = await call(env, "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(TOKEN);
    expect(html).toContain("claude mcp add --transport http flow-sandbox https://sandbox.example.com/mcp");
  });

  it("rate-limits /api and /mcp per IP", async () => {
    const { env, limit } = setup();
    limit.mockResolvedValueOnce({ success: false });
    const res = await call(env, "/mcp", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.9" } });
    expect(res.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: "203.0.113.9" });
  });

  it("refuses attachment uploads before they reach the app", async () => {
    const { env, stubFor } = setup();
    const res = await call(env, "/api/tasks/tk_sb_cls/attachments", { method: "POST", body: "x" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("uploads are off");
    expect(stubFor(`sandbox-${Math.floor(Date.now() / SANDBOX_PERIOD_MS)}`).importBatch).not.toHaveBeenCalled();
  });
});

describe("ensureSeeded", () => {
  it("seeds a fresh hour once, as the owner, with the key acting as the sandbox member", async () => {
    const { env, stubFor } = setup();
    const at = NOW + 10 * SANDBOX_PERIOD_MS;
    await Promise.all([ensureSeeded(env, at), ensureSeeded(env, at)]);
    const ws = stubFor(workspaceName(env, at));
    expect(ws.importBatch).toHaveBeenCalledTimes(1);
    expect(ws.importBatch.mock.calls[0]![1]).toBe("us_owner");
    expect(ws.createApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ userId: SANDBOX_MEMBER_ID, tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      "us_owner"
    );
  });

  it("leaves an hour another isolate already seeded alone", async () => {
    const { env, stubFor } = setup();
    const at = NOW + 20 * SANDBOX_PERIOD_MS;
    stubFor(workspaceName(env, at)).setHasKey(true);
    await ensureSeeded(env, at);
    expect(stubFor(workspaceName(env, at)).importBatch).not.toHaveBeenCalled();
  });

  it("accepts losing the race for the key insert", async () => {
    const { env, stubFor } = setup();
    const at = NOW + 30 * SANDBOX_PERIOD_MS;
    const ws = stubFor(workspaceName(env, at));
    ws.createApiKey.mockImplementationOnce(async () => {
      ws.setHasKey(true);
      throw new Error("UNIQUE constraint failed: api_keys.token_hash");
    });
    await expect(ensureSeeded(env, at)).resolves.toBeUndefined();
  });
});

describe("scheduled and queue", () => {
  it("wipes the two hours just gone and never the current one", async () => {
    const { env, stubFor } = setup();
    await wipeOldWorkspaces(env, NOW);
    expect(stubFor(`sandbox-${HOUR - 1}`).wipeSandbox).toHaveBeenCalledTimes(1);
    expect(stubFor(`sandbox-${HOUR - 2}`).wipeSandbox).toHaveBeenCalledTimes(1);
    expect(stubFor(`sandbox-${HOUR}`).wipeSandbox).not.toHaveBeenCalled();
  });

  it("drains the side-effects queue without delivering anything", async () => {
    const ackAll = vi.fn();
    await sandbox.queue({ ackAll, messages: [{ body: { kind: "webhook" } }] } as unknown as MessageBatch);
    expect(ackAll).toHaveBeenCalledTimes(1);
  });
});
