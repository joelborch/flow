import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupStatus } from "@flow/core";
import type { Env } from "./env.js";
import { assertProductionConfig, isProductionEnv, missingProductionEmailVars } from "./startup-config.js";

// Importing index.ts pulls in the Workspace DO class, whose base class only exists in workerd.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));

const VALID_AUD = "a".repeat(64);
const PROD_EMAIL_VARS = {
  EMAIL_FROM: "flow@acme.test",
  EMAIL_FROM_NAME: "Acme",
  EMAIL_BRAND_NAME: "Acme",
  EMAIL_REQUESTER_FROM_NAME: "Acme Support",
};

const BACKUP_STATUS: BackupStatus = {
  lastSuccessAt: 1_758_690_000_000,
  lastSuccess: { key: "backups/2026-09-24.ndjson.gz", rows: 123, bytes: 456 },
  lastFailureAt: null,
  lastFailureError: null,
  stale: false,
};

function accessEnv(over: Partial<Env> = {}): Env {
  return {
    ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com",
    ACCESS_AUD: VALID_AUD,
    EMAIL_DRY_RUN: "true",
    WORKSPACE: {
      idFromName: vi.fn().mockReturnValue({}),
      get: vi.fn().mockReturnValue({ getBackupStatus: vi.fn().mockResolvedValue(BACKUP_STATUS) }),
    },
    ...over,
  } as unknown as Env;
}

describe("startup production config validation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("identifies production when Access is configured or EMAIL_DRY_RUN is false, excluding dev/sandbox", () => {
    expect(isProductionEnv(accessEnv())).toBe(true);
    expect(isProductionEnv({ EMAIL_DRY_RUN: "false" })).toBe(true);
    expect(isProductionEnv({ ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", EMAIL_DRY_RUN: "true" })).toBe(false);
    expect(isProductionEnv(accessEnv({ DEV_NO_AUTH: "true" }))).toBe(false);
    expect(isProductionEnv(accessEnv({ SANDBOX: "true" }))).toBe(false);
  });

  it("reports all four missing vars in production", () => {
    expect(missingProductionEmailVars(accessEnv())).toEqual([
      "EMAIL_FROM",
      "EMAIL_FROM_NAME",
      "EMAIL_BRAND_NAME",
      "EMAIL_REQUESTER_FROM_NAME",
    ]);
  });

  it("refuses worker fetch, queue, and email entrypoints when production misses email branding vars", async () => {
    const { default: worker } = await import("./index.js");
    const env = accessEnv();
    const ctx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;

    await expect(
      worker.fetch(new Request("https://flow.acme.test/api/health"), env, ctx)
    ).rejects.toThrow(/EMAIL_FROM.*EMAIL_FROM_NAME.*EMAIL_BRAND_NAME.*EMAIL_REQUESTER_FROM_NAME/);

    await expect(
      worker.queue({ queue: "flow-side-effects", messages: [] } as unknown as MessageBatch, env)
    ).rejects.toThrow(/Flow startup refused/);

    await expect(
      worker.email({ from: "a@b.test", to: "help@acme.test" } as unknown as ForwardableEmailMessage, env, ctx)
    ).rejects.toThrow(/Flow startup refused/);
  });

  it("refuses when any single var is missing, blank whitespace, or EMAIL_FROM uses mail.example.com", () => {
    for (const key of [
      "EMAIL_FROM",
      "EMAIL_FROM_NAME",
      "EMAIL_BRAND_NAME",
      "EMAIL_REQUESTER_FROM_NAME",
    ] as const) {
      expect(() =>
        assertProductionConfig(accessEnv({ ...PROD_EMAIL_VARS, [key]: "   " }))
      ).toThrow(new RegExp(key));
    }

    expect(() =>
      assertProductionConfig(accessEnv({ ...PROD_EMAIL_VARS, EMAIL_FROM: "flow@mail.example.com" }))
    ).toThrow(/flow@mail\.example\.com/);

    expect(() => assertProductionConfig({ EMAIL_DRY_RUN: "false" })).toThrow(/EMAIL_FROM/);
  });

  it("allows production requests once all four email branding vars are explicitly configured", async () => {
    const { default: worker } = await import("./index.js");
    const env = accessEnv(PROD_EMAIL_VARS);
    const ctx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;

    const res = await worker.fetch(new Request("https://flow.acme.test/api/health"), env, ctx);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it("allows DEV_NO_AUTH, SANDBOX, and unconfigured one-click templates without email branding vars", () => {
    expect(() => assertProductionConfig(accessEnv({ DEV_NO_AUTH: "true" }))).not.toThrow();
    expect(() => assertProductionConfig(accessEnv({ SANDBOX: "true" }))).not.toThrow();
    expect(() =>
      assertProductionConfig({ ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", EMAIL_DRY_RUN: "true" })
    ).not.toThrow();
  });
});
