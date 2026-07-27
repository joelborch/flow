import { describe, expect, it } from "vitest";
import type { Condition, Trigger } from "@flow/shared";
import {
  buildTaskView,
  deltaTaskId,
  evaluateConditions,
  eventNameForTrigger,
  matchesTrigger,
  ruleAppliesToScope,
  SYNTHETIC_TRIGGER_KEY,
} from "./match.js";
import type { AutomationDelta, TaskFacts } from "./types.js";
import {
  HOSTNAME,
  makeFacts,
  makeRule,
  makeTask,
  STATUS_NAMES,
  subtaskDelta,
  taskDelta,
} from "./testkit.js";

const view = (facts: TaskFacts, delta: AutomationDelta | null) =>
  buildTaskView(facts, delta, HOSTNAME, (id) => STATUS_NAMES[id] ?? null);

const match = (trigger: Trigger, facts: TaskFacts, delta: AutomationDelta) =>
  matchesTrigger(trigger, delta, view(facts, delta));

describe("deltaTaskId", () => {
  it("uses the delta id for task deltas and taskId for child entities", () => {
    expect(deltaTaskId(taskDelta({ title: "x" }))).toBe("tk_1");
    expect(deltaTaskId(subtaskDelta("tk_7"))).toBe("tk_7");
  });

  it("returns null when a child delta carries no owning task", () => {
    const d = subtaskDelta();
    delete d.taskId;
    expect(deltaTaskId(d)).toBeNull();
  });
});

describe("trigger: task_created", () => {
  it("matches only a task create delta", () => {
    const facts = makeFacts();
    expect(match({ kind: "task_created" }, facts, taskDelta(null, null, "create"))).toBe(true);
    expect(match({ kind: "task_created" }, facts, taskDelta({ title: "x" }))).toBe(false);
  });
});

describe("trigger: status_changed", () => {
  const facts = makeFacts({ task: makeTask({ statusId: "st_sent" }) });
  const delta = taskDelta({ statusId: "st_sent" }, { statusId: "st_editing" });

  it("matches from/to by name, case-insensitively", () => {
    expect(match({ kind: "status_changed", from: ["editing"], to: ["sent to client"] }, facts, delta)).toBe(true);
    expect(match({ kind: "status_changed", from: ["EDITING"], to: ["SENT TO CLIENT"] }, facts, delta)).toBe(true);
  });

  it("treats omitted from/to as any", () => {
    expect(match({ kind: "status_changed" }, facts, delta)).toBe(true);
    expect(match({ kind: "status_changed", to: ["SENT TO CLIENT"] }, facts, delta)).toBe(true);
  });

  it("rejects a non-matching from or to", () => {
    expect(match({ kind: "status_changed", from: ["IN REVIEW"] }, facts, delta)).toBe(false);
    expect(match({ kind: "status_changed", to: ["APPROVED"] }, facts, delta)).toBe(false);
  });

  it("ignores deltas that didn't touch the status", () => {
    expect(match({ kind: "status_changed" }, facts, taskDelta({ title: "x" }))).toBe(false);
  });

  it("ignores a no-op status write", () => {
    const noop = taskDelta({ statusId: "st_sent" }, { statusId: "st_sent" });
    expect(match({ kind: "status_changed" }, facts, noop)).toBe(false);
  });

  it("does not match on task creation", () => {
    expect(match({ kind: "status_changed" }, facts, taskDelta({ statusId: "st_sent" }, null, "create"))).toBe(false);
  });
});

describe("trigger: tag_added", () => {
  const facts = makeFacts({ task: makeTask({ tags: ["urgent", "QA"] }) });
  const delta = taskDelta({ tags: ["urgent", "QA"] }, { tags: ["urgent"] });

  it("matches a newly added tag case-insensitively", () => {
    expect(match({ kind: "tag_added", tags: ["qa"] }, facts, delta)).toBe(true);
  });

  it("ignores tags that were already there", () => {
    expect(match({ kind: "tag_added", tags: ["urgent"] }, facts, delta)).toBe(false);
  });

  it("ignores unrelated tag changes", () => {
    expect(match({ kind: "tag_added", tags: ["needs review"] }, facts, delta)).toBe(false);
  });

  it("fires for tags present at creation", () => {
    const created = taskDelta(null, null, "create");
    expect(match({ kind: "tag_added", tags: ["qa"] }, facts, created)).toBe(true);
  });
});

describe("trigger: assignee_changed", () => {
  const facts = makeFacts({ task: makeTask({ assigneeId: "us_bob" }) });
  const delta = taskDelta({ assigneeId: "us_bob" }, { assigneeId: "us_alice" });

  it("matches any reassignment when toUserId is omitted", () => {
    expect(match({ kind: "assignee_changed" }, facts, delta)).toBe(true);
  });

  it("matches a specific new assignee", () => {
    expect(match({ kind: "assignee_changed", toUserId: "us_bob" }, facts, delta)).toBe(true);
    expect(match({ kind: "assignee_changed", toUserId: "us_alice" }, facts, delta)).toBe(false);
  });

  it("ignores a no-op reassignment", () => {
    const noop = taskDelta({ assigneeId: "us_bob" }, { assigneeId: "us_bob" });
    expect(match({ kind: "assignee_changed" }, facts, noop)).toBe(false);
  });
});

describe("trigger: all_subtasks_done", () => {
  it("matches when a subtask change leaves every subtask done", () => {
    const facts = makeFacts({ subtaskTotal: 3, subtaskDone: 3 });
    expect(match({ kind: "all_subtasks_done" }, facts, subtaskDelta())).toBe(true);
  });

  it("does not match while subtasks remain open", () => {
    const facts = makeFacts({ subtaskTotal: 3, subtaskDone: 2 });
    expect(match({ kind: "all_subtasks_done" }, facts, subtaskDelta())).toBe(false);
  });

  it("does not match a task with no subtasks at all", () => {
    const facts = makeFacts({ subtaskTotal: 0, subtaskDone: 0 });
    expect(match({ kind: "all_subtasks_done" }, facts, subtaskDelta())).toBe(false);
  });

  it("does not match on task-level deltas, so it can't re-fire on every edit", () => {
    const facts = makeFacts({ subtaskTotal: 1, subtaskDone: 1 });
    expect(match({ kind: "all_subtasks_done" }, facts, taskDelta({ title: "x" }))).toBe(false);
  });

  it("does not match when a subtask is merely created", () => {
    const facts = makeFacts({ subtaskTotal: 1, subtaskDone: 1 });
    const created = { ...subtaskDelta(), op: "create" as const };
    expect(match({ kind: "all_subtasks_done" }, facts, created)).toBe(false);
  });
});

describe("trigger: due_date_approaching", () => {
  const facts = makeFacts({ task: makeTask({ dueDate: 1_700_000_000_000 }) });
  const trigger: Trigger = { kind: "due_date_approaching", daysBefore: 3 };

  it("never matches a real mutation, not even one that sets the due date", () => {
    expect(match(trigger, facts, taskDelta({ dueDate: 1 }, { dueDate: null }))).toBe(false);
    expect(match(trigger, facts, taskDelta(null, null, "create"))).toBe(false);
  });

  it("matches the scheduler's synthetic delta for its own window", () => {
    const synthetic = taskDelta({ [SYNTHETIC_TRIGGER_KEY]: "due_date_approaching", daysBefore: 3 });
    expect(match(trigger, facts, synthetic)).toBe(true);
  });

  it("ignores a synthetic delta for a different daysBefore window", () => {
    const synthetic = taskDelta({ [SYNTHETIC_TRIGGER_KEY]: "due_date_approaching", daysBefore: 7 });
    expect(match(trigger, facts, synthetic)).toBe(false);
  });

  it("does not let other triggers fire off a synthetic delta", () => {
    const synthetic = taskDelta({ [SYNTHETIC_TRIGGER_KEY]: "due_date_approaching", daysBefore: 3 });
    expect(match({ kind: "status_changed" }, facts, synthetic)).toBe(false);
    expect(match({ kind: "task_created" }, facts, synthetic)).toBe(false);
    expect(match({ kind: "tag_added", tags: ["qa"] }, facts, synthetic)).toBe(false);
  });
});

describe("conditions (AND)", () => {
  const facts = makeFacts({
    task: makeTask({ statusId: "st_review", tags: ["QA"], assigneeId: "us_bob", priority: "high" }),
  });
  const v = view(facts, null);

  it("holds vacuously when empty", () => {
    expect(evaluateConditions([], v)).toBe(true);
  });

  it("matches status by name, case-insensitively", () => {
    expect(evaluateConditions([{ kind: "status_is", names: ["in review"] }], v)).toBe(true);
    expect(evaluateConditions([{ kind: "status_is", names: ["EDITING"] }], v)).toBe(false);
  });

  it("matches tags case-insensitively", () => {
    expect(evaluateConditions([{ kind: "has_tag", tags: ["qa"] }], v)).toBe(true);
    expect(evaluateConditions([{ kind: "has_tag", tags: ["nope"] }], v)).toBe(false);
  });

  it("matches assignee and priority", () => {
    expect(evaluateConditions([{ kind: "assignee_is", userIds: ["us_bob"] }], v)).toBe(true);
    expect(evaluateConditions([{ kind: "assignee_is", userIds: ["us_alice"] }], v)).toBe(false);
    expect(evaluateConditions([{ kind: "priority_is", priorities: ["high"] }], v)).toBe(true);
    expect(evaluateConditions([{ kind: "priority_is", priorities: ["low"] }], v)).toBe(false);
  });

  it("ANDs — one failure sinks the set", () => {
    const all: Condition[] = [
      { kind: "status_is", names: ["IN REVIEW"] },
      { kind: "has_tag", tags: ["QA"] },
      { kind: "priority_is", priorities: ["low"] },
    ];
    expect(evaluateConditions(all, v)).toBe(false);
    expect(evaluateConditions(all.slice(0, 2), v)).toBe(true);
  });

  it("never matches null assignee or priority", () => {
    const bare = view(makeFacts(), null);
    expect(evaluateConditions([{ kind: "assignee_is", userIds: ["us_bob"] }], bare)).toBe(false);
    expect(evaluateConditions([{ kind: "priority_is", priorities: ["high"] }], bare)).toBe(false);
  });
});

describe("scope", () => {
  const v = view(makeFacts(), null); // list ls_1 in space sp_1

  it("matches the task's own list", () => {
    expect(ruleAppliesToScope(makeRule({ scope: { kind: "list", listId: "ls_1" } }), v)).toBe(true);
    expect(ruleAppliesToScope(makeRule({ scope: { kind: "list", listId: "ls_2" } }), v)).toBe(false);
  });

  it("matches the task's containing space", () => {
    expect(ruleAppliesToScope(makeRule({ scope: { kind: "space", spaceId: "sp_1" } }), v)).toBe(true);
    expect(ruleAppliesToScope(makeRule({ scope: { kind: "space", spaceId: "sp_2" } }), v)).toBe(false);
  });
});

describe("eventNameForTrigger", () => {
  it("maps every trigger kind to a webhook event name", () => {
    expect(eventNameForTrigger({ kind: "task_created" })).toBe("task.created");
    expect(eventNameForTrigger({ kind: "status_changed" })).toBe("task.status_changed");
    expect(eventNameForTrigger({ kind: "tag_added", tags: ["qa"] })).toBe("task.tag_added");
    expect(eventNameForTrigger({ kind: "assignee_changed" })).toBe("task.assignee_changed");
    expect(eventNameForTrigger({ kind: "all_subtasks_done" })).toBe("task.all_subtasks_done");
    expect(eventNameForTrigger({ kind: "due_date_approaching", daysBefore: 1 })).toBe(
      "task.due_date_approaching"
    );
  });
});
