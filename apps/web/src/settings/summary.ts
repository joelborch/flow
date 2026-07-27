// Turning the automation contract into English.
//
// Rules are authored by agents and by the API, never in this UI, so the whole
// job here is legibility: someone glancing at the table should be able to say
// "that one moves QA bugs to the on-call owner" without reading JSON.
import type { Action, AutomationRule, Condition, Trigger } from "@flow/shared";

/** Id -> display name, supplied by the caller from the store's lookup maps. */
export type Names = {
  user: (id: string | null | undefined) => string;
  list: (id: string) => string;
  space: (id: string) => string;
};

function quoteList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(", ");
}

/** "Status → 'needs review'", "Tag added: qa". */
export function triggerSummary(trigger: Trigger, names: Names): string {
  switch (trigger.kind) {
    case "task_created":
      return "Task created";
    case "status_changed": {
      const from = trigger.from?.length ? quoteList(trigger.from) : null;
      const to = trigger.to?.length ? quoteList(trigger.to) : null;
      if (from && to) return `Status ${from} → ${to}`;
      if (to) return `Status → ${to}`;
      if (from) return `Status leaves ${from}`;
      return "Status changed";
    }
    case "tag_added":
      return `Tag added: ${trigger.tags.join(", ")}`;
    case "assignee_changed":
      return trigger.toUserId
        ? `Assignee → ${names.user(trigger.toUserId)}`
        : "Assignee changed";
    case "all_subtasks_done":
      return "All subtasks done";
    case "due_date_approaching":
      return trigger.daysBefore === 0
        ? "Due today"
        : `Due in ${trigger.daysBefore} day${trigger.daysBefore === 1 ? "" : "s"}`;
  }
}

export function conditionSummary(condition: Condition, names: Names): string {
  switch (condition.kind) {
    case "status_is":
      return `Status is ${quoteList(condition.names)}`;
    case "has_tag":
      return `Has tag ${quoteList(condition.tags)}`;
    case "assignee_is":
      return `Assignee is ${condition.userIds.map((id) => names.user(id)).join(", ")}`;
    case "priority_is":
      return `Priority is ${condition.priorities.join(", ")}`;
  }
}

/** Short enough for a chip in the table row. */
export function actionChip(action: Action, names: Names): string {
  switch (action.kind) {
    case "set_status":
      return `→ ${action.statusName}`;
    case "set_assignee":
      return action.userId ? `assign ${names.user(action.userId)}` : "unassign";
    case "set_priority":
      return action.priority ? `priority ${action.priority}` : "clear priority";
    case "add_tags":
      return `+${action.tags.join(" +")}`;
    case "create_subtask":
      return "subtask";
    case "move_to_list":
      return `move → ${names.list(action.listId)}`;
    case "call_webhook":
      return "webhook";
    case "send_email":
      return "email";
  }
}

/** The full sentence, for the expanded breakdown. */
export function actionSummary(action: Action, names: Names): string {
  switch (action.kind) {
    case "set_status":
      return `Set status to '${action.statusName}'`;
    case "set_assignee":
      return action.userId ? `Assign to ${names.user(action.userId)}` : "Clear the assignee";
    case "set_priority":
      return action.priority ? `Set priority to ${action.priority}` : "Clear the priority";
    case "add_tags":
      return `Add tags ${quoteList(action.tags)}`;
    case "create_subtask": {
      const who = action.assigneeId ? `, assigned to ${names.user(action.assigneeId)}` : "";
      const when =
        action.dueInDays === null ? "" : `, due in ${action.dueInDays} day${action.dueInDays === 1 ? "" : "s"}`;
      return `Create subtask '${action.title}'${who}${when}`;
    }
    case "move_to_list":
      return `Move the task to ${names.list(action.listId)}`;
    case "call_webhook":
      return `POST the event envelope to ${hostOf(action.url)}${action.secret ? " (HMAC signed)" : ""}`;
    case "send_email":
      return `Email ${action.to.join(", ")} — "${action.subject}"`;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** "Client intake" for a list rule, "Operations (whole space)" for a space one. */
export function scopeSummary(rule: AutomationRule, names: Names): string {
  return rule.scope.kind === "list"
    ? names.list(rule.scope.listId)
    : `${names.space(rule.scope.spaceId)} — whole space`;
}

/** The action kind as it appears in a run-log row, humanised. */
export function actionKindLabel(kind: string): string {
  if (kind === "*") return "rule";
  return kind.replace(/_/g, " ");
}
