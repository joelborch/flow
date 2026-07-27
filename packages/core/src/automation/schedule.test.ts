import { describe, expect, it } from "vitest";
import { DAY_MS, sweepDueDateAutomations } from "./schedule.js";
import { makeCtx, makeFacts, makeRule, makeTask } from "./testkit.js";

const NOW = 1_700_000_100_000;

const dueRule = (daysBefore: number, extras: Parameters<typeof makeRule>[0] = {}) =>
  makeRule({
    id: "ar_due",
    trigger: { kind: "due_date_approaching", daysBefore },
    actions: [{ kind: "add_tags", tags: ["due-soon"] }],
    ...extras,
  });

const dueFacts = (dueDate: number, statusId = "st_todo") =>
  makeFacts({ task: makeTask({ dueDate, statusId }) });

describe("sweepDueDateAutomations", () => {
  it("fires once for a task inside the window", () => {
    const ctx = makeCtx({
      rules: [dueRule(2)],
      facts: dueFacts(NOW + DAY_MS),
      dueTaskIds: ["tk_1"],
    });
    const result = sweepDueDateAutomations(ctx, NOW);

    expect(result.rulesConsidered).toBe(1);
    expect(result.firings).toEqual([{ ruleId: "ar_due", taskId: "tk_1", dueDate: NOW + DAY_MS }]);
    expect(ctx.applied.map((a) => a.action.kind)).toEqual(["add_tags"]);
    expect(ctx.runs[0]?.trigger).toBe("task.due_date_approaching");
  });

  it("does not fire twice for the same task + due date", () => {
    const ctx = makeCtx({
      rules: [dueRule(2)],
      facts: dueFacts(NOW + DAY_MS),
      dueTaskIds: ["tk_1"],
    });
    sweepDueDateAutomations(ctx, NOW);
    const second = sweepDueDateAutomations(ctx, NOW + 60_000);

    expect(second.firings).toEqual([]);
    expect(ctx.applied).toHaveLength(1);
  });

  it("arms again when the due date moves", () => {
    const ctx = makeCtx({ rules: [dueRule(2)], facts: dueFacts(NOW + DAY_MS), dueTaskIds: ["tk_1"] });
    sweepDueDateAutomations(ctx, NOW);
    // Same task, new deadline -> new guard key.
    ctx.loadTaskFacts = () => dueFacts(NOW + 2 * DAY_MS - 1);
    const second = sweepDueDateAutomations(ctx, NOW);
    expect(second.firings).toHaveLength(1);
    expect(ctx.applied).toHaveLength(2);
  });

  it("ignores tasks outside the daysBefore window", () => {
    const ctx = makeCtx({
      rules: [dueRule(1)],
      facts: dueFacts(NOW + 5 * DAY_MS),
      dueTaskIds: ["tk_1"],
    });
    expect(sweepDueDateAutomations(ctx, NOW).firings).toEqual([]);
    expect(ctx.applied).toEqual([]);
  });

  it("ignores tasks already past due", () => {
    const ctx = makeCtx({
      rules: [dueRule(3)],
      facts: dueFacts(NOW - DAY_MS),
      dueTaskIds: ["tk_1"],
    });
    expect(sweepDueDateAutomations(ctx, NOW).firings).toEqual([]);
  });

  it("respects conditions and leaves the guard unset so it can fire later", () => {
    const ctx = makeCtx({
      rules: [dueRule(2, { conditions: [{ kind: "status_is", names: ["IN REVIEW"] }] })],
      facts: dueFacts(NOW + DAY_MS, "st_todo"),
      dueTaskIds: ["tk_1"],
    });
    expect(sweepDueDateAutomations(ctx, NOW).firings).toEqual([]);
    expect(ctx.dueFires.size).toBe(0);

    ctx.loadTaskFacts = () => dueFacts(NOW + DAY_MS, "st_review");
    expect(sweepDueDateAutomations(ctx, NOW).firings).toHaveLength(1);
  });

  it("does nothing when no due_date_approaching rule is enabled", () => {
    const ctx = makeCtx({ rules: [makeRule()], facts: dueFacts(NOW + DAY_MS), dueTaskIds: ["tk_1"] });
    const result = sweepDueDateAutomations(ctx, NOW);
    expect(result.rulesConsidered).toBe(0);
    expect(ctx.applied).toEqual([]);
  });

  it("skips a rule whose scope query blows up rather than aborting the sweep", () => {
    const ctx = makeCtx({ rules: [dueRule(2)], facts: dueFacts(NOW + DAY_MS) });
    ctx.listTaskIdsDueBetween = () => {
      throw new Error("bad scope");
    };
    expect(() => sweepDueDateAutomations(ctx, NOW)).not.toThrow();
  });
});
