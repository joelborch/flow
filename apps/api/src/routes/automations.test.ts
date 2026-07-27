import { describe, expect, it } from "vitest";
import type { AutomationRunLog } from "@flow/shared";
import { RunsQuery, runsPage } from "./automations.js";

const run = (id: number): AutomationRunLog => ({
  id,
  ruleId: "ar_1",
  taskId: "tk_1",
  trigger: "status_changed",
  results: [{ action: "send_email", ok: true, dryRun: true, detail: "queued to a@b.c" }],
  depth: 0,
  at: 1_700_000_000_000,
});

describe("RunsQuery", () => {
  it("defaults to a 100-run page with no cursor", () => {
    const parsed = RunsQuery.parse({});
    expect(parsed).toEqual({ limit: 100 });
  });

  it("coerces limit and before from query strings", () => {
    expect(RunsQuery.parse({ limit: "25", before: "41823" })).toEqual({
      limit: 25,
      before: 41823,
    });
  });

  it("refuses a limit outside 1..500 rather than silently clamping", () => {
    expect(RunsQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(RunsQuery.safeParse({ limit: "501" }).success).toBe(false);
    expect(RunsQuery.safeParse({ limit: "500" }).success).toBe(true);
  });

  it("takes an optional taskId filter", () => {
    expect(RunsQuery.parse({ taskId: "tk_abc123" }).taskId).toBe("tk_abc123");
  });

  it("rejects a non-numeric or non-positive cursor", () => {
    expect(RunsQuery.safeParse({ before: "abc" }).success).toBe(false);
    expect(RunsQuery.safeParse({ before: "0" }).success).toBe(false);
  });
});

describe("runsPage", () => {
  it("hands back a cursor when the page came back full", () => {
    const page = runsPage([run(30), run(29), run(28)], 3);
    expect(page.cursor).toBe(28);
    expect(page.runs).toHaveLength(3);
  });

  it("has no cursor on a short page — that is the end of the log", () => {
    expect(runsPage([run(30), run(29)], 3).cursor).toBeNull();
  });

  it("has no cursor on an empty page", () => {
    expect(runsPage([], 3)).toEqual({ runs: [], cursor: null });
  });

  it("keeps the per-action results intact — dry runs are only visible here", () => {
    const page = runsPage([run(30)], 100);
    expect(page.runs[0]?.results).toEqual([
      { action: "send_email", ok: true, dryRun: true, detail: "queued to a@b.c" },
    ]);
  });
});
