// Tiny mustache-ish renderer — no dependency.

import type { TaskView } from "./types.js";

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** YYYY-MM-DD in UTC. Empty string for null. */
export function formatDueDate(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

export function taskUrl(appHostname: string, taskId: string): string {
  return `https://${appHostname}/t/${taskId}`;
}

/**
 * The variable map every template resolves against.
 *
 * `assigneeAs` picks what {{task.assignee}} means: "name" for prose (subjects,
 * bodies, subtask titles) and "email" for send_email recipient lists.
 */
export function buildVars(
  view: TaskView,
  assigneeAs: "name" | "email" = "name"
): Record<string, string> {
  const assignee = view.assignee
    ? assigneeAs === "email"
      ? view.assignee.email
      : view.assignee.name
    : "";
  return {
    "task.title": view.task.title,
    "task.status": view.statusName,
    "task.url": taskUrl(view.appHostname, view.task.id),
    "task.assignee": assignee,
    "task.dueDate": formatDueDate(view.task.dueDate),
    "task.description": view.task.description,
    "list.name": view.list.name,
    "space.name": view.space.name,
  };
}

/**
 * Substitute {{key}} placeholders. Unknown keys are left verbatim so a typo in
 * a rule is visible in the run log instead of silently vanishing.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (whole, key: string) => {
    const value = vars[key];
    return value === undefined ? whole : value;
  });
}

/** Convenience: render against a view. */
export function render(
  template: string,
  view: TaskView,
  assigneeAs: "name" | "email" = "name"
): string {
  return renderTemplate(template, buildVars(view, assigneeAs));
}
