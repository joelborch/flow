import { describe, expect, it, vi } from "vitest";
import { adminRoutes } from "./admin.js";
import { authedApp, workspaceEnv } from "./testkit.js";

describe("GET /admin/backup", () => {
  const status = {
    lastSuccessAt: 1_758_690_000_000,
    lastSuccess: { key: "backups/2026-09-24.ndjson.gz", rows: 1234, bytes: 56_789 },
    lastFailureAt: 1_758_600_000_000,
    lastFailureError: "R2 put failed: 503",
    stale: false,
  };

  function appAs(role: "owner" | "member") {
    const app = authedApp(role, adminRoutes);
    const getBackupStatus = vi.fn().mockResolvedValue(status);
    const runBackupNow = vi.fn().mockResolvedValue({ key: "backups/2026-09-24.ndjson.gz", rows: 10, bytes: 123 });
    const env = workspaceEnv({ getBackupStatus, runBackupNow });
    const get = () => app.fetch(new Request("https://flow.example/api/admin/backup"), env);
    const post = () => app.fetch(new Request("https://flow.example/api/admin/backup", { method: "POST" }), env);
    return { get, post, getBackupStatus, runBackupNow };
  }

  it("gives admins the full status, including the error and object key /api/health leaves out", async () => {
    const { get, post, runBackupNow } = appAs("owner");
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);

    const trigger = await post();
    expect(trigger.status).toBe(200);
    expect(runBackupNow).toHaveBeenCalledOnce();
  });

  it("refuses members without reading the status", async () => {
    const { get, post, getBackupStatus, runBackupNow } = appAs("member");
    expect((await get()).status).toBe(403);
    expect((await post()).status).toBe(403);
    expect(getBackupStatus).not.toHaveBeenCalled();
    expect(runBackupNow).not.toHaveBeenCalled();
  });
});
