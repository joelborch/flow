import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupStatus } from "@flow/core";
import { HEALTH_CACHE_MS, cachedBackupHealth, resetHealthCache } from "./do.js";
import type { Env } from "./env.js";

// /api/health is unauthenticated, so it must report backup freshness without
// leaking the error text or the bucket key that GET /api/admin/backup carries.
// The entrypoint pulls in the DO class, whose base class only exists in workerd.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));

const STATUS: BackupStatus = {
  lastSuccessAt: 1_758_690_000_000,
  lastSuccess: { key: "backups/2026-09-24.ndjson.gz", rows: 1234, bytes: 56_789 },
  lastFailureAt: 1_758_600_000_000,
  lastFailureError: "R2 put failed: bucket flow-attachments returned 503",
  stale: false,
};

function envWith(getBackupStatus: () => Promise<BackupStatus>): Env {
  return {
    WORKSPACE: {
      idFromName: vi.fn().mockReturnValue({}),
      get: vi.fn().mockReturnValue({ getBackupStatus }),
    },
  } as unknown as Env;
}

async function getHealth(env: Env): Promise<Response> {
  const { default: worker } = await import("./index.js");
  const ctx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
  return worker.fetch(new Request("https://flow.example/api/health"), env, ctx);
}

describe("GET /api/health", () => {
  beforeEach(() => resetHealthCache());

  it("reports backup times and staleness, and nothing an anonymous caller shouldn't see", async () => {
    const res = await getHealth(envWith(async () => STATUS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.backup).toEqual({
      lastSuccessAt: STATUS.lastSuccessAt,
      lastFailureAt: STATUS.lastFailureAt,
      stale: false,
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("R2 put failed");
    expect(raw).not.toContain("backups/");
  });

  it("stays ok:true with stale:true when the backup is overdue — the app itself is up", async () => {
    const res = await getHealth(envWith(async () => ({ ...STATUS, stale: true })));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; backup: { stale: boolean } };
    expect(body.ok).toBe(true);
    expect(body.backup.stale).toBe(true);
  });

  it("is a 503 with ok:false when the workspace DO can't be reached", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await getHealth(
        envWith(async () => {
          throw new Error("Durable Object reset because its code was updated.");
        })
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; backup: unknown };
      expect(body).toMatchObject({ ok: false, backup: null });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("reuses a good answer for a minute, so uptime pings don't all reach the DO", async () => {
    const getBackupStatus = vi.fn(async () => STATUS);
    const env = envWith(getBackupStatus);
    await cachedBackupHealth(env, 1_000);
    await cachedBackupHealth(env, 1_000 + HEALTH_CACHE_MS - 1);
    expect(getBackupStatus).toHaveBeenCalledTimes(1);
    await cachedBackupHealth(env, 1_000 + HEALTH_CACHE_MS);
    expect(getBackupStatus).toHaveBeenCalledTimes(2);
  });

  it("never caches a failure, so an unreachable DO is re-checked on the next call", async () => {
    const getBackupStatus = vi
      .fn<() => Promise<BackupStatus>>()
      .mockRejectedValueOnce(new Error("reset"))
      .mockResolvedValueOnce(STATUS);
    const env = envWith(getBackupStatus);
    await expect(cachedBackupHealth(env, 1_000)).rejects.toThrow("reset");
    await expect(cachedBackupHealth(env, 1_001)).resolves.toMatchObject({ stale: false });
  });
});
