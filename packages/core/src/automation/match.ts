// Pure trigger/condition/scope logic — no I/O, no
// SQL, no Workers runtime. Everything here is directly unit-testable.

import type { AutomationRule, Condition, Trigger } from "@flow/shared";
import type { AutomationDelta, TaskFacts, TaskView } from "./types.js";

const lower = (s: string) => s.trim().toLowerCase();

/**
 * Sentinel key the DO puts on a synthetic, never-persisted delta to say "this
 * isn't a real mutation, it's a scheduled trigger". Must stay in sync with
 * FLOW_TRIGGER in packages/core/src/index.ts.
 *
 * Supporting it lets the DO drive due_date_approaching from its own alarm turn
 * (see Workspace.runDueDateCheck) as an alternative to the sweep helper in
 * ./schedule.ts. Both paths end up in the same runRule().
 */
export const SYNTHETIC_TRIGGER_KEY = "__flowTrigger";

function eqCI(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return lower(a) === lower(b);
}

function includesCI(haystack: readonly string[] | undefined, needle: string | null): boolean {
  if (!haystack || haystack.length === 0) return false;
  if (needle === null) return false;
  return haystack.some((h) => eqCI(h, needle));
}

/** Task id a delta is about, or null when it isn't about a task at all. */
export function deltaTaskId(delta: AutomationDelta): string | null {
  if (delta.entity === "task") return delta.id;
  return delta.taskId ?? null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Fold TaskFacts + the delta into the flat view used by matching, conditions
 * and templates.
 */
export function buildTaskView(
  facts: TaskFacts,
  delta: AutomationDelta | null,
  appHostname: string,
  statusNameById: (statusId: string) => string | null
): TaskView {
  const data = delta?.data ?? null;
  const prev = delta?.prev ?? null;

  let prevStatusName: string | null = null;
  if (data && "statusId" in data && prev && typeof prev["statusId"] === "string") {
    prevStatusName = statusNameById(prev["statusId"]);
  }

  let prevAssigneeId: string | null = null;
  if (prev && typeof prev["assigneeId"] === "string") prevAssigneeId = prev["assigneeId"];

  let addedTags: string[] = [];
  if (data && "tags" in data) {
    const next = asStringArray(data["tags"]) ?? facts.task.tags;
    const before = prev ? asStringArray(prev["tags"]) ?? [] : [];
    const beforeSet = new Set(before.map(lower));
    addedTags = next.filter((t) => !beforeSet.has(lower(t)));
  } else if (delta?.entity === "task" && delta.op === "create") {
    addedTags = [...facts.task.tags];
  }

  return {
    ...facts,
    prevStatusName,
    prevAssigneeId,
    addedTags,
    appHostname,
  };
}

/** Does the rule's scope cover this task's list/space? */
export function ruleAppliesToScope(rule: AutomationRule, view: TaskView): boolean {
  if (rule.scope.kind === "list") return rule.scope.listId === view.list.id;
  return rule.scope.spaceId === view.space.id;
}

/**
 * Trigger matching. `due_date_approaching` never matches a delta — it is fired
 * exclusively by the alarm sweep in ./schedule.ts.
 */
export function matchesTrigger(
  trigger: Trigger,
  delta: AutomationDelta,
  view: TaskView
): boolean {
  const data = delta.data;
  switch (trigger.kind) {
    case "task_created":
      return delta.entity === "task" && delta.op === "create";

    case "status_changed": {
      if (delta.entity !== "task" || delta.op !== "update") return false;
      if (!data || !("statusId" in data)) return false;
      const prevStatusId = delta.prev?.["statusId"];
      if (typeof prevStatusId === "string" && prevStatusId === view.task.statusId) return false;
      if (trigger.from && trigger.from.length > 0) {
        if (!includesCI(trigger.from, view.prevStatusName)) return false;
      }
      if (trigger.to && trigger.to.length > 0) {
        if (!includesCI(trigger.to, view.statusName)) return false;
      }
      return true;
    }

    case "tag_added": {
      if (delta.entity !== "task") return false;
      if (delta.op === "delete") return false;
      if (view.addedTags.length === 0) return false;
      return view.addedTags.some((t) => includesCI(trigger.tags, t));
    }

    case "assignee_changed": {
      if (delta.entity !== "task" || delta.op !== "update") return false;
      if (!data || !("assigneeId" in data)) return false;
      const next = view.task.assigneeId;
      if (view.prevAssigneeId !== null && view.prevAssigneeId === next) return false;
      if (trigger.toUserId !== undefined) return next === trigger.toUserId;
      return true;
    }

    case "all_subtasks_done": {
      // Only a subtask-level change can complete the checklist; requiring that
      // keeps unrelated task edits from re-firing the rule forever.
      if (delta.entity !== "subtask") return false;
      if (delta.op === "create") return false;
      if (view.subtaskTotal === 0) return false;
      return view.subtaskDone >= view.subtaskTotal;
    }

    case "due_date_approaching": {
      // Never fires off a real mutation — a deadline getting closer changes
      // nothing. Only a synthetic delta from the alarm carries it, and the
      // window (daysBefore) must be the one the scheduler selected.
      if (!data) return false;
      if (data[SYNTHETIC_TRIGGER_KEY] !== "due_date_approaching") return false;
      return data["daysBefore"] === trigger.daysBefore;
    }
  }
}

/** All conditions must hold (AND). An empty list always holds. */
export function evaluateConditions(conditions: readonly Condition[], view: TaskView): boolean {
  return conditions.every((c) => evaluateCondition(c, view));
}

export function evaluateCondition(condition: Condition, view: TaskView): boolean {
  switch (condition.kind) {
    case "status_is":
      return includesCI(condition.names, view.statusName);
    case "has_tag": {
      const owned = new Set(view.task.tags.map(lower));
      return condition.tags.some((t) => owned.has(lower(t)));
    }
    case "assignee_is": {
      const a = view.task.assigneeId;
      return a !== null && condition.userIds.includes(a);
    }
    case "priority_is": {
      const p = view.task.priority;
      return p !== null && condition.priorities.includes(p);
    }
  }
}

/** Webhook envelope `event` string for a trigger. */
export function eventNameForTrigger(trigger: Trigger): string {
  switch (trigger.kind) {
    case "task_created":
      return "task.created";
    case "status_changed":
      return "task.status_changed";
    case "tag_added":
      return "task.tag_added";
    case "assignee_changed":
      return "task.assignee_changed";
    case "all_subtasks_done":
      return "task.all_subtasks_done";
    case "due_date_approaching":
      return "task.due_date_approaching";
  }
}
