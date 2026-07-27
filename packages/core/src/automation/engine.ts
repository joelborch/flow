// //
// The automation engine. Called by the workspace DO from inside every committed
// mutation turn, once per appended delta:
//
//   evaluateAutomations({ sql, now, appHostname, depth, ...accessors }, delta)
//
// Flow: load enabled rules scoped to the task's list or space -> match the
// trigger against the delta -> evaluate conditions (AND) -> run actions in
// order. In-workspace actions re-enter the DO through ctx.applyAction at
// depth + 1; outbound actions render their templates and get queued. Every
// firing writes one automation_runs row.

import { AUTOMATION_MAX_DEPTH, AutomationRule, type Action, type Delta } from "@flow/shared";
import {
  buildTaskView,
  deltaTaskId,
  evaluateConditions,
  eventNameForTrigger,
  matchesTrigger,
  ruleAppliesToScope,
} from "./match.js";
import { render } from "./template.js";
import type {
  ActionResult,
  AutomationContext,
  AutomationDelta,
  SideEffectPayload,
  TaskView,
} from "./types.js";

export type { AutomationContext, AutomationDelta, TaskView, TaskFacts, ActionResult, SideEffectPayload, AutomationScheduleContext } from "./types.js";
export { AUTOMATION_MAX_DEPTH };

const INTERNAL_ACTIONS = new Set<Action["kind"]>([
  "set_status",
  "set_assignee",
  "set_priority",
  "add_tags",
  "create_subtask",
  "move_to_list",
]);

/** True when we've hit the automation-triggering-automation ceiling. */
export function isDepthExceeded(depth: number): boolean {
  return depth >= AUTOMATION_MAX_DEPTH;
}

interface RuleColumns {
  [column: string]: SqlStorageValue;
  id: string;
  name: string;
  enabled: number;
  scope: string;
  trigger: string;
  conditions: string;
  actions: string;
  created_at: number;
  updated_at: number;
}

/**
 * All enabled rules, oldest first (rule order is action order when two rules
 * match the same delta).
 *
 * The DO stores each rule's sub-objects as separate JSON TEXT columns
 * (scope/trigger/conditions/actions); a single `json` column holding the whole
 * AutomationRule is accepted as a fallback so either layout works.
 */
export function loadEnabledRules(sql: SqlStorage): AutomationRule[] {
  const raw = readRuleObjects(sql);
  const rules: AutomationRule[] = [];
  for (const candidate of raw) {
    const parsed = AutomationRule.safeParse(candidate);
    if (!parsed.success) {
      console.error("automation: skipping malformed rule", parsed.error.message);
      continue;
    }
    if (parsed.data.enabled) rules.push(parsed.data);
  }
  return rules;
}

function readRuleObjects(sql: SqlStorage): unknown[] {
  try {
    return sql
      .exec<RuleColumns>(
        `SELECT id, name, enabled, scope, trigger, conditions, actions, created_at, updated_at
         FROM automation_rules WHERE enabled = 1 ORDER BY created_at`
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        name: r.name,
        enabled: r.enabled !== 0,
        scope: parseJson(r.scope),
        trigger: parseJson(r.trigger),
        conditions: parseJson(r.conditions) ?? [],
        actions: parseJson(r.actions) ?? [],
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
  } catch (columnarErr) {
    try {
      return sql
        .exec<{ json: string }>("SELECT json FROM automation_rules ORDER BY id")
        .toArray()
        .map((r) => parseJson(r.json));
    } catch {
      console.error("automation: cannot read automation_rules", columnarErr);
      return [];
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Called by the DO inside every committed mutation turn. */
export function evaluateAutomations(ctx: AutomationContext, delta: Delta): void {
  try {
    evaluateAutomationsInner(ctx, delta as AutomationDelta);
  } catch (err) {
    // An automation must never take down the mutation that triggered it.
    console.error("automation: evaluate failed", err);
  }
}

function evaluateAutomationsInner(ctx: AutomationContext, delta: AutomationDelta): void {
  const taskId = deltaTaskId(delta);
  if (taskId === null) return;

  const rules = loadEnabledRules(ctx.sql);
  if (rules.length === 0) return;

  const facts = ctx.loadTaskFacts(taskId);
  if (facts === null) return;

  const view = buildTaskView(facts, delta, ctx.appHostname, (id) => ctx.statusNameById(id));

  for (const rule of rules) {
    if (!ruleAppliesToScope(rule, view)) continue;
    if (!matchesTrigger(rule.trigger, delta, view)) continue;
    if (!evaluateConditions(rule.conditions, view)) continue;
    runRule(ctx, rule, view, delta);
  }
}

/**
 * Execute one already-matched rule. Shared by the delta path and the alarm
 * sweep in ./schedule.ts.
 */
export function runRule(
  ctx: AutomationContext,
  rule: AutomationRule,
  view: TaskView,
  delta: AutomationDelta
): ActionResult[] {
  const triggerName = eventNameForTrigger(rule.trigger);

  if (isDepthExceeded(ctx.depth)) {
    const capped: ActionResult[] = [
      {
        action: "*",
        ok: false,
        dryRun: false,
        detail:
          `automation depth cap (${AUTOMATION_MAX_DEPTH}) reached at depth ${ctx.depth}; ` +
          `${rule.actions.length} action(s) skipped`,
      },
    ];
    writeRunLog(ctx, rule.id, view.task.id, triggerName, capped);
    return capped;
  }

  const results: ActionResult[] = [];
  for (const action of rule.actions) {
    results.push(runAction(ctx, rule, view, delta, action, triggerName));
  }
  writeRunLog(ctx, rule.id, view.task.id, triggerName, results);
  return results;
}

function runAction(
  ctx: AutomationContext,
  rule: AutomationRule,
  view: TaskView,
  delta: AutomationDelta,
  action: Action,
  triggerName: string
): ActionResult {
  try {
    if (INTERNAL_ACTIONS.has(action.kind)) {
      const prepared: Action =
        action.kind === "create_subtask" ? { ...action, title: render(action.title, view) } : action;
      // The rule id goes with the action so the DO can attribute the audit row
      // to this rule rather than to whoever tripped the trigger.
      ctx.applyAction(prepared, view.task.id, ctx.depth + 1, rule.id);
      return { action: action.kind, ok: true, dryRun: false, detail: describe(prepared) };
    }

    if (action.kind === "call_webhook") {
      const payload: SideEffectPayload = {
        kind: "webhook",
        url: action.url,
        secret: action.secret,
        body: {
          event: triggerName,
          delta: toWireDelta(delta),
          task: view.task,
          workspace: view.appHostname,
        },
        ruleId: rule.id,
        taskId: view.task.id,
      };
      ctx.enqueueSideEffect(payload);
      return {
        action: "call_webhook",
        ok: true,
        dryRun: false,
        detail: `queued POST ${action.url}${action.secret ? " (signed)" : ""}`,
      };
    }

    if (action.kind === "send_email") {
      const to = action.to
        .map((addr) => render(addr, view, "email").trim())
        .filter((addr) => addr.length > 0 && addr.includes("@"));
      if (to.length === 0) {
        return { action: "send_email", ok: false, dryRun: false, detail: "no resolvable recipients" };
      }
      const dryRun = ctx.emailDryRun !== false;
      const payload: SideEffectPayload = {
        kind: "email",
        to,
        subject: render(action.subject, view),
        body: render(action.body, view),
        ruleId: rule.id,
        taskId: view.task.id,
      };
      ctx.enqueueSideEffect(payload);
      return {
        action: "send_email",
        ok: true,
        dryRun,
        detail: `queued to ${to.join(", ")}${dryRun ? " (EMAIL_DRY_RUN)" : ""}`,
      };
    }

    return { action: action.kind, ok: false, dryRun: false, detail: "unknown action" };
  } catch (err) {
    return {
      action: action.kind,
      ok: false,
      dryRun: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Strip the automation-only extras before the delta leaves the workspace. */
function toWireDelta(delta: AutomationDelta): Delta {
  const { prev: _prev, taskId: _taskId, ...wire } = delta;
  return wire;
}

function describe(action: Action): string {
  switch (action.kind) {
    case "set_status":
      return `status -> ${action.statusName}`;
    case "set_assignee":
      return `assignee -> ${action.userId ?? "unassigned"}`;
    case "set_priority":
      return `priority -> ${action.priority ?? "none"}`;
    case "add_tags":
      return `tags += ${action.tags.join(", ")}`;
    case "create_subtask":
      return `subtask "${action.title}"`;
    case "move_to_list":
      return `move -> ${action.listId}`;
    default:
      return action.kind;
  }
}

export function writeRunLog(
  ctx: AutomationContext,
  ruleId: string,
  taskId: string,
  trigger: string,
  results: ActionResult[]
): void {
  try {
    ctx.sql.exec(
      `INSERT INTO automation_runs (rule_id, task_id, trigger, results, depth, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ruleId,
      taskId,
      trigger,
      JSON.stringify(results),
      ctx.depth,
      ctx.now
    );
  } catch (err) {
    console.error("automation: cannot write automation_runs", err);
  }
}
