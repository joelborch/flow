import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FlowClient } from "./flow-client.js";
import { runLoad } from "./load.js";
import { FLOW, makePaths, readJson, writeJson } from "./paths.js";

describe("importer per-row error tracking", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "flow-load-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("FlowClient.postBatch returns BatchResponse directly with errors", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        counts: { tasks: 2 },
        errors: [{ ref: "task-2", error: "Duplicate key" }],
      }),
    });

    const client = new FlowClient({
      apiBase: "https://api.example.com",
      apiKey: "test-key",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const res = await client.postBatch("tasks", [
      { id: "task-1" },
      { id: "task-2" },
      { id: "task-3" },
    ]);

    expect(res).toEqual({
      ok: true,
      counts: { tasks: 2 },
      errors: [{ ref: "task-2", error: "Duplicate key" }],
    });
  });

  it("adds only successful IDs to loaded.ids[kind] and omits failed IDs when postBatch returns errors", async () => {
    const paths = makePaths(tmpDir);
    writeJson(paths.flowFile(FLOW.users), []);
    writeJson(paths.flowFile(FLOW.spaces), []);
    writeJson(paths.flowFile(FLOW.lists), []);
    writeJson(paths.flowFile(FLOW.tasks), [
      { id: "task-1" },
      { id: "task-2" },
      { id: "task-3" },
    ]);
    writeJson(paths.flowFile(FLOW.subtasks), []);
    writeJson(paths.flowFile(FLOW.comments), []);
    writeJson(paths.flowFile(FLOW.attachments), []);

    // Mock global fetch
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      if (url.endsWith("/api/import/batch")) {
        const body = JSON.parse(String(init?.body)) as { tasks?: { id: string }[] };
        if (body.tasks) {
          return new Response(
            JSON.stringify({
              ok: true,
              counts: { tasks: 2 },
              errors: [{ ref: "task-2", error: "Invalid status ID" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await runLoad({
      dataDir: tmpDir,
      apiBase: "https://api.flow.local",
      apiKey: "test-api-key",
      batchSize: 10,
      dryRun: false,
      skipAttachments: true,
    });

    const loaded = readJson<{ ids: Record<string, string[]> }>(paths.flowFile(FLOW.loaded));
    expect(loaded.ids.tasks).toEqual(["task-1", "task-3"]);
    expect(loaded.ids.tasks).not.toContain("task-2");
  });
});
