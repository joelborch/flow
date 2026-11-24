import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { fakeCtx } from "./testkit.js";

describe("Workspace.getAuditLog", () => {
  async function seededWorkspace() {
    const { Workspace } = await import("./index.js");
    const db = new DatabaseSync(":memory:");
    const ws = new Workspace(fakeCtx(db), {
      SIDE_EFFECTS: { sendBatch: vi.fn(async () => undefined) },
    } as never);
    return { ws, db };
  }

  it("filters by entity, action, userId, apiKeyId, after (inclusive), and before cursor", async () => {
    const { ws, db } = await seededWorkspace();
    db.prepare(
      `INSERT INTO audit (actor, actor_user_id, api_key_id, action, entity, diff, at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      JSON.stringify({ userId: "us_1", via: "ui", apiKeyId: null, automationRuleId: null }),
      "us_1",
      null,
      "task.create",
      "tk_1",
      "{}",
      1_000
    );
    db.prepare(
      `INSERT INTO audit (actor, actor_user_id, api_key_id, action, entity, diff, at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      JSON.stringify({ userId: "us_1", via: "api", apiKeyId: "ak_1", automationRuleId: null }),
      "us_1",
      "ak_1",
      "task.update",
      "tk_1",
      '{"title":"B"}',
      2_000
    );
    db.prepare(
      `INSERT INTO audit (actor, actor_user_id, api_key_id, action, entity, diff, at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      JSON.stringify({ userId: "us_2", via: "mcp", apiKeyId: "ak_2", automationRuleId: null }),
      "us_2",
      "ak_2",
      "task.update",
      "tk_2",
      '{"title":"C"}',
      3_000
    );

    const sinceTwo = ws.getAuditLog({ after: 2_000 });
    expect(sinceTwo.entries.map((e) => e.at)).toEqual([3_000, 2_000]);
    expect(sinceTwo.nextBefore).toBeNull();

    const paged = ws.getAuditLog({ limit: 2 });
    expect(paged.entries).toHaveLength(2);
    expect(paged.nextBefore).toBe(paged.entries[1]!.id);

    const next = ws.getAuditLog({ before: paged.nextBefore!, limit: 2 });
    expect(next.entries.map((e) => e.at)).toEqual([1_000]);
    expect(next.nextBefore).toBeNull();

    expect(ws.getAuditLog({ entity: "tk_1", action: "task.update" }).entries.map((e) => e.at)).toEqual([2_000]);
    expect(ws.getAuditLog({ userId: "us_2" }).entries.map((e) => e.at)).toEqual([3_000]);
    expect(ws.getAuditLog({ apiKeyId: "ak_1" }).entries.map((e) => e.at)).toEqual([2_000]);
  });
});
