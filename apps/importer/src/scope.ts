import { isClosedStatusType, parseTs } from "./clickup-types.js";
import type { CuTask } from "./clickup-types.js";

export const DEFAULT_SCOPE_DAYS = 120;

export type ScopeConfig = {
  /** Epoch ms; tasks closed or updated at/after this are in scope. */
  cutoffMs: number;
};

export function makeScope(days = DEFAULT_SCOPE_DAYS, now = Date.now()): ScopeConfig {
  return { cutoffMs: now - days * 86_400_000 };
}

/**
 * Scope rule, applied client-side after fetching: keep every task in a
 * non-closed status, plus any closed task that closed or changed inside the
 * window. ClickUp cannot express this as a query — its date_updated_gt filter
 * can't be OR'd with "status is open" — hence the local filter.
 *
 * date_closed and date_done disagree on a handful of tasks in practice, so
 * both count.
 */
export function isTaskInScope(task: CuTask, scope: ScopeConfig): boolean {
  if (!isClosedStatusType(task.status.type)) return true;
  const closed = parseTs(task.date_closed);
  const done = parseTs(task.date_done);
  const updated = parseTs(task.date_updated);
  const newest = Math.max(closed ?? 0, done ?? 0, updated ?? 0);
  return newest >= scope.cutoffMs;
}

/**
 * Expands the in-scope set so a kept parent keeps all its subtasks, even stale
 * ones. Dropping a done subtask off an open parent would silently rewrite the
 * task's checklist, which is worse than importing an old row.
 */
export function selectInScope(tasks: CuTask[], scope: ScopeConfig): Set<string> {
  const keep = new Set<string>();
  for (const t of tasks) if (isTaskInScope(t, scope)) keep.add(t.id);

  // Parents of kept subtasks come along, otherwise the subtask has nowhere to
  // live; children of kept parents come along for the reason above.
  for (const t of tasks) {
    if (t.parent && keep.has(t.id)) keep.add(t.parent);
  }
  for (const t of tasks) {
    if (t.parent && keep.has(t.parent)) keep.add(t.id);
  }
  return keep;
}
