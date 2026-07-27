import { describe, expect, it } from "vitest";
import { LIMITS, Task, UpdateTaskInput } from "@flow/shared";
import { MIGRATIONS } from "./schema.js";
import { type SnoozedRow, isSnoozed, wakeCandidates, wakesOnComment } from "./snooze.js";
import { type TaskRowSql, toTask } from "./rows.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const row = (id: string, snoozedUntil: number | null): SnoozedRow => ({
  id,
  snoozed_until: snoozedUntil,
});

describe("wakeCandidates", () => {
  it("picks exactly the tasks whose snooze has run out", () => {
    const rows = [
      row("tk_past", NOW - HOUR),
      row("tk_future", NOW + HOUR),
      row("tk_long_past", NOW - 40 * HOUR),
    ];
    expect(wakeCandidates(rows, NOW)).toEqual(["tk_past", "tk_long_past"]);
  });

  it("wakes a task whose time is exactly now, so the boundary is never a no-man's-land", () => {
    expect(wakeCandidates([row("tk_1", NOW)], NOW)).toEqual(["tk_1"]);
    expect(isSnoozed(NOW, NOW)).toBe(false);
  });

  it("ignores rows that were never snoozed", () => {
    expect(wakeCandidates([row("tk_1", null), row("tk_2", NOW - 1)], NOW)).toEqual(["tk_2"]);
  });

  it("wakes nothing when every snooze is still in the future", () => {
    expect(wakeCandidates([row("tk_1", NOW + 1), row("tk_2", NOW + HOUR)], NOW)).toEqual([]);
  });

  it("preserves read order, so the sweep's audit and deltas are deterministic", () => {
    const rows = [row("tk_a", NOW - 3), row("tk_b", NOW - 2), row("tk_c", NOW - 1)];
    expect(wakeCandidates(rows, NOW)).toEqual(["tk_a", "tk_b", "tk_c"]);
  });
});

describe("isSnoozed", () => {
  it("is false for an unsnoozed task and true only while the time is ahead", () => {
    expect(isSnoozed(null, NOW)).toBe(false);
    expect(isSnoozed(NOW + 1, NOW)).toBe(true);
    expect(isSnoozed(NOW - 1, NOW)).toBe(false);
  });

  it("never disagrees with wakeCandidates about the same task", () => {
    for (const at of [NOW - 1, NOW, NOW + 1]) {
      const woken = wakeCandidates([row("tk_1", at)], NOW).length === 1;
      expect(isSnoozed(at, NOW)).toBe(!woken);
    }
  });
});

describe("wakesOnComment", () => {
  it("wakes a snoozed task however far off the wake time still is", () => {
    expect(wakesOnComment(NOW + 400 * HOUR)).toBe(true);
  });

  it("is a no-op on a task that was never snoozed", () => {
    expect(wakesOnComment(null)).toBe(false);
  });
});

// --- storage mapping -------------------------------------------------------

const taskRow = (overrides: Partial<TaskRowSql> = {}): TaskRowSql => ({
  id: "tk_1",
  list_id: "ls_1",
  title: "Chase the vendor quote",
  description: "",
  status_id: "st_1",
  assignee_id: null,
  priority: null,
  due_date: null,
  start_date: null,
  snoozed_until: null,
  blocked_note: null,
  tags: "[]",
  position: 1,
  created_by: "us_1",
  created_at: NOW,
  updated_at: NOW,
  closed_at: null,
  clickup_id: null,
  ...overrides,
});

describe("toTask snooze mapping", () => {
  it("carries both columns through to the contract", () => {
    const task = toTask(taskRow({ snoozed_until: NOW + HOUR, blocked_note: "Dr. Patel" }));
    expect(task.snoozedUntil).toBe(NOW + HOUR);
    expect(task.blockedNote).toBe("Dr. Patel");
  });

  it("reads a pre-migration row as awake rather than leaking undefined", () => {
    const legacy = taskRow();
    delete (legacy as Record<string, unknown>)["snoozed_until"];
    delete (legacy as Record<string, unknown>)["blocked_note"];
    const task = toTask(legacy);
    expect(task.snoozedUntil).toBeNull();
    expect(task.blockedNote).toBeNull();
    // And the whole thing still satisfies the contract, defaults included.
    expect(Task.safeParse(task).success).toBe(true);
  });
});

describe("core-0004-snooze", () => {
  it("is registered exactly once, with an id no earlier migration used", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(ids.filter((id) => id === "core-0004-snooze")).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("adds both columns without a default, so existing rows read as awake", () => {
    const m = MIGRATIONS.find((x) => x.id === "core-0004-snooze")!;
    expect(m.statements.some((s) => /ADD COLUMN snoozed_until INTEGER$/.test(s))).toBe(true);
    expect(m.statements.some((s) => /ADD COLUMN blocked_note TEXT$/.test(s))).toBe(true);
    expect(m.statements.some((s) => /DEFAULT/i.test(s))).toBe(false);
  });
});

describe("UpdateTaskInput", () => {
  it("accepts a snooze, a note, and null for either", () => {
    expect(
      UpdateTaskInput.safeParse({ taskId: "tk_1", snoozedUntil: NOW, blockedNote: "the lab" })
        .success
    ).toBe(true);
    expect(
      UpdateTaskInput.safeParse({ taskId: "tk_1", snoozedUntil: null, blockedNote: null }).success
    ).toBe(true);
  });

  it("leaves both alone when they are omitted", () => {
    const parsed = UpdateTaskInput.parse({ taskId: "tk_1", title: "x" });
    expect("snoozedUntil" in parsed).toBe(false);
    expect("blockedNote" in parsed).toBe(false);
  });

  it("caps the note at the shared limit", () => {
    const at = UpdateTaskInput.safeParse({
      taskId: "tk_1",
      blockedNote: "a".repeat(LIMITS.blockedNoteMax),
    });
    expect(at.success).toBe(true);
    const over = UpdateTaskInput.safeParse({
      taskId: "tk_1",
      blockedNote: "a".repeat(LIMITS.blockedNoteMax + 1),
    });
    expect(over.success).toBe(false);
  });
});
