// //
// The due_date_approaching path. This trigger can't come from a delta — nothing
// mutates when a deadline gets closer — so the DO's alarm calls
// sweepDueDateAutomations() on a schedule (hourly is plenty; the fired-guard
// makes it idempotent, so running it more often is harmless).

import type { AutomationRule, Delta } from "@flow/shared";
import { loadEnabledRules, runRule } from "./engine.js";
import { buildTaskView, evaluateConditions, SYNTHETIC_TRIGGER_KEY } from "./match.js";
import type { AutomationDelta, AutomationScheduleContext } from "./types.js";

export const DAY_MS = 86_400_000;

/** Synthetic actor for automation-initiated, non-user-initiated activity. */
export const AUTOMATION_ACTOR_ID = "us_automation";

export interface DueSweepFiring {
  ruleId: string;
  taskId: string;
  dueDate: number;
}

export interface DueSweepResult {
  /** Rules with a due_date_approaching trigger that were enabled and considered. */
  rulesConsidered: number;
  /** Tasks inspected across all rules (duplicates counted once per rule). */
  candidatesInspected: number;
  firings: DueSweepFiring[];
}

/**
 * Fire every enabled `due_date_approaching` rule whose window now contains a
 * task's due date, once per (rule, task, dueDate).
 *
 * Call from the DO alarm:
 *   sweepDueDateAutomations({ ...automationContext, listTaskIdsDueBetween }, Date.now())
 *
 * `ctx.depth` should be 0 — actions taken here are the start of a chain, and a
 * chain they may well be (set_status can trigger a status_changed rule).
 */
export function sweepDueDateAutomations(
  ctx: AutomationScheduleContext,
  now: number
): DueSweepResult {
  const result: DueSweepResult = { rulesConsidered: 0, candidatesInspected: 0, firings: [] };

  const rules = loadEnabledRules(ctx.sql).filter(
    (r): r is AutomationRule & { trigger: { kind: "due_date_approaching"; daysBefore: number } } =>
      r.trigger.kind === "due_date_approaching"
  );
  if (rules.length === 0) return result;
  result.rulesConsidered = rules.length;

  for (const rule of rules) {
    const windowEnd = now + rule.trigger.daysBefore * DAY_MS;
    let taskIds: string[];
    try {
      taskIds = ctx.listTaskIdsDueBetween(rule.scope, now, windowEnd);
    } catch (err) {
      console.error("automation: due sweep scope query failed", rule.id, err);
      continue;
    }

    for (const taskId of taskIds) {
      result.candidatesInspected += 1;
      try {
        const facts = ctx.loadTaskFacts(taskId);
        if (facts === null) continue;
        const dueDate = facts.task.dueDate;
        if (dueDate === null) continue;
        // Trust our own window over the caller's query.
        if (dueDate < now || dueDate > windowEnd) continue;
        if (hasFired(ctx, rule.id, taskId, dueDate)) continue;

        const delta = syntheticDelta(taskId, now, rule.trigger.daysBefore);
        const view = buildTaskView(facts, delta, ctx.appHostname, (id) => ctx.statusNameById(id));
        if (!evaluateConditions(rule.conditions, view)) continue;

        // Guard first: if an action throws we still don't want a retry storm on
        // the next alarm. runRule already records per-action failures.
        markFired(ctx, rule.id, taskId, dueDate, now);
        runRule(ctx, rule, view, delta);
        result.firings.push({ ruleId: rule.id, taskId, dueDate });
      } catch (err) {
        console.error("automation: due sweep failed", rule.id, taskId, err);
      }
    }
  }

  return result;
}

/**
 * Marked with SYNTHETIC_TRIGGER_KEY so it is recognisable as a scheduled
 * trigger rather than a mutation — the DO must never persist or broadcast it.
 */
function syntheticDelta(taskId: string, now: number, daysBefore: number): AutomationDelta {
  const delta: Delta = {
    seq: 0,
    op: "update",
    entity: "task",
    id: taskId,
    data: { [SYNTHETIC_TRIGGER_KEY]: "due_date_approaching", daysBefore },
    actorUserId: AUTOMATION_ACTOR_ID,
    at: now,
  };
  return delta;
}

export function hasFired(
  ctx: AutomationScheduleContext,
  ruleId: string,
  taskId: string,
  dueDate: number
): boolean {
  const rows = ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM automation_due_fires
        WHERE rule_id = ? AND task_id = ? AND due_date = ?`,
      ruleId,
      taskId,
      dueDate
    )
    .toArray();
  const first = rows[0];
  return first !== undefined && first.n > 0;
}

export function markFired(
  ctx: AutomationScheduleContext,
  ruleId: string,
  taskId: string,
  dueDate: number,
  now: number
): void {
  ctx.sql.exec(
    `INSERT OR REPLACE INTO automation_due_fires (rule_id, task_id, due_date, fired_at)
     VALUES (?, ?, ?, ?)`,
    ruleId,
    taskId,
    dueDate,
    now
  );
}

/**
 * Housekeeping for the alarm: drop guard rows for due dates well in the past so
 * the table doesn't grow forever. Safe to call on every sweep.
 */
export function pruneDueFires(ctx: AutomationScheduleContext, now: number, olderThanDays = 90): void {
  try {
    ctx.sql.exec(
      "DELETE FROM automation_due_fires WHERE due_date < ?",
      now - olderThanDays * DAY_MS
    );
  } catch (err) {
    console.error("automation: prune due fires failed", err);
  }
}
