import { AUTOMATION_MAX_DEPTH, type Action, type Actor, type AutomationRule, type AutomationRunLog } from "@flow/shared";
import { evaluateAutomations } from "./automation/engine.js";
import { dueDateWithCutoff, nextRecurringDue } from "./automation/recurrence.js";
import type { AutomationContext, SideEffectPayload, TaskFacts } from "./automation/types.js";
import {
  DAY_MS,
  LIST_COLUMNS,
  SPACE_COLUMNS,
  TASK_COLUMNS,
  type WorkspaceHost,
  requireListRow,
  requireSpace,
  requireTaskRow,
  taskRow,
} from "./db-helpers.js";
import { id } from "./id.js";
import { type ListRow, type RuleRow, type SpaceRow, type TaskRowSql, toRule, toTask } from "./rows.js";
import { getStatus } from "./statuses.js";
import { applySubtaskCreate, applyTaskCreate, applyTaskMove, applyTaskUpdate } from "./task-mutations.js";
import { type Turn, toActor } from "./turn.js";

export function automationContext(host: WorkspaceHost, t: Turn, depth: number): AutomationContext {
  const { sql, env } = host;
  return {
    sql,
    now: t.now,
    appHostname: env.APP_HOSTNAME ?? "localhost",
    depth,
    emailDryRun: env.EMAIL_DRY_RUN !== "false",
    loadTaskFacts: (taskId: string) => loadTaskFacts(sql, taskId),
    statusNameById: (statusId: string) => getStatus(sql, statusId)?.name ?? null,
    applyAction: (action: Action, taskId: string, d: number, ruleId?: string) =>
      applyAction(host, t, action, taskId, d, ruleId),
    enqueueSideEffect: (payload: SideEffectPayload) => t.enqueue(payload),
  };
}

export function loadTaskFacts(sql: SqlStorage, taskId: string): TaskFacts | null {
  const row = taskRow(sql, taskId);
  if (row === null) return null;
  const task = toTask(row);
  const listRow = sql
    .exec<ListRow>(`SELECT ${LIST_COLUMNS} FROM lists WHERE id = ?`, task.listId)
    .toArray()[0];
  if (!listRow) return null;
  const spaceRow = sql
    .exec<SpaceRow>(`SELECT ${SPACE_COLUMNS} FROM spaces WHERE id = ?`, listRow.space_id)
    .toArray()[0];

  const assigneeRow =
    task.assigneeId === null
      ? undefined
      : sql
          .exec<{ id: string; name: string; email: string }>(
            "SELECT id, name, email FROM users WHERE id = ?",
            task.assigneeId
          )
          .toArray()[0];

  const counts = sql
    .exec<{ total: number; done: number }>(
      "SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM subtasks WHERE task_id = ?",
      taskId
    )
    .one();

  return {
    task,
    statusName: getStatus(sql, task.statusId)?.name ?? "",
    list: { id: listRow.id, name: listRow.name, spaceId: listRow.space_id },
    space: { id: listRow.space_id, name: spaceRow?.name ?? "" },
    assignee: assigneeRow
      ? { id: assigneeRow.id, name: assigneeRow.name, email: assigneeRow.email }
      : null,
    subtaskTotal: counts.total,
    subtaskDone: counts.done,
  };
}

export function applyAction(
  host: WorkspaceHost,
  t: Turn,
  action: Action,
  taskId: string,
  depth: number,
  ruleId?: string
): void {
  const { sql } = host;
  if (depth > AUTOMATION_MAX_DEPTH) {
    throw new Error(
      `Automation depth cap of ${AUTOMATION_MAX_DEPTH} reached for task ${taskId}; ` +
        `action not applied (likely a rule loop).`
    );
  }
  const outer = t.depth;
  const outerRule = t.automationRuleId;
  t.depth = depth;
  t.automationRuleId = ruleId ?? outerRule;
  try {
    switch (action.kind) {
      case "set_status":
        applyTaskUpdate(host, t, { taskId, status: action.statusName }, "automation.set_status");
        break;
      case "set_assignee":
        applyTaskUpdate(host, t, { taskId, assigneeId: action.userId }, "automation.set_assignee");
        break;
      case "set_priority":
        applyTaskUpdate(host, t, { taskId, priority: action.priority }, "automation.set_priority");
        break;
      case "set_due_date": {
        const dueDate = dueDateWithCutoff(t.now, action.cutoffHour, action.timeZone, action.businessDays);
        applyTaskUpdate(host, t, { taskId, dueDate }, "automation.set_due_date");
        break;
      }
      case "add_tags": {
        const current = toTask(requireTaskRow(sql, taskId)).tags;
        const seen = new Set(current.map((x) => x.toLowerCase()));
        const merged = [...current];
        for (const tag of action.tags) {
          const clean = tag.trim();
          if (clean !== "" && !seen.has(clean.toLowerCase())) {
            seen.add(clean.toLowerCase());
            merged.push(clean);
          }
        }
        if (merged.length !== current.length) {
          applyTaskUpdate(host, t, { taskId, tags: merged }, "automation.add_tags");
        }
        break;
      }
      case "remove_tags": {
        const current = toTask(requireTaskRow(sql, taskId)).tags;
        const removed = new Set(action.tags.map((tag) => tag.trim().toLowerCase()));
        const filtered = current.filter((tag) => !removed.has(tag.toLowerCase()));
        if (filtered.length !== current.length) {
          applyTaskUpdate(host, t, { taskId, tags: filtered }, "automation.remove_tags");
        }
        break;
      }
      case "create_next_recurring_task": {
        const source = toTask(requireTaskRow(sql, taskId));
        if (source.dueDate === null) {
          throw new Error(`Recurring task ${taskId} has no due date.`);
        }
        if (!source.tags.some((tag) => tag.toLowerCase() === action.identityTag.toLowerCase())) {
          throw new Error(
            `Recurring task ${taskId} is missing identity tag ${action.identityTag}.`
          );
        }
        const dueDate = nextRecurringDue(source.dueDate, action.recurrence, action.timeZone);
        const duplicate = sql
          .exec<TaskRowSql>(
            `SELECT ${TASK_COLUMNS} FROM tasks WHERE list_id = ? AND due_date = ?`,
            source.listId,
            dueDate
          )
          .toArray()
          .map(toTask)
          .some((task) =>
            task.tags.some((tag) => tag.toLowerCase() === action.identityTag.toLowerCase())
          );
        if (!duplicate) {
          applyTaskCreate(host, t, {
            listId: source.listId,
            title: source.title,
            description: source.description,
            ...(action.statusName === null ? {} : { status: action.statusName }),
            assigneeId: source.assigneeId,
            priority: source.priority,
            dueDate,
            tags: source.tags,
          });
        }
        break;
      }
      case "create_task":
        applyTaskCreate(host, t, {
          listId: action.listId,
          title: action.title,
          description: action.description,
          ...(action.statusName === null ? {} : { status: action.statusName }),
          assigneeId: action.assigneeId,
          priority: action.priority,
          dueDate: action.dueInDays === null ? null : t.now + action.dueInDays * DAY_MS,
          tags: action.tags,
        });
        break;
      case "create_subtask":
        applySubtaskCreate(host, t, {
          taskId,
          title: action.title,
          assigneeId: action.assigneeId,
          dueDate:
            action.dueInDays === null || action.dueInDays === undefined
              ? null
              : t.now + action.dueInDays * DAY_MS,
        });
        break;
      case "move_to_list":
        applyTaskMove(host, t, { taskId, listId: action.listId }, "automation.move_to_list");
        break;
      case "call_webhook":
      case "send_email":
        console.error("applyAction received an outbound action", action.kind);
        break;
    }
  } finally {
    t.depth = outer;
    t.automationRuleId = outerRule;
  }
}

export function drainAutomations(host: WorkspaceHost, t: Turn): void {
  if (t.silent) return;
  const HARD_CAP = 5_000;
  let i = 0;
  let evaluated = 0;
  while (i < t.entries.length) {
    const entry = t.entries[i]!;
    i++;
    if (entry.evaluated) continue;
    entry.evaluated = true;
    if (++evaluated > HARD_CAP) {
      console.error("automation fan-out cap reached; stopping evaluation for this turn");
      break;
    }
    try {
      evaluateAutomations(automationContext(host, t, entry.depth), entry.delta);
    } catch (err) {
      console.error("automation evaluation failed", entry.delta.entity, entry.delta.id, err);
    }
  }
}

export function listAutomationRuns(
  sql: SqlStorage,
  filter: { ruleId?: string; taskId?: string; before?: number; limit?: number } = {}
): AutomationRunLog[] {
  const where: string[] = [];
  const params: SqlStorageValue[] = [];
  if (filter.ruleId !== undefined) {
    where.push("rule_id = ?");
    params.push(filter.ruleId);
  }
  if (filter.taskId !== undefined) {
    where.push("task_id = ?");
    params.push(filter.taskId);
  }
  if (filter.before !== undefined) {
    where.push("id < ?");
    params.push(filter.before);
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  return sql
    .exec<{
      id: number;
      rule_id: string;
      task_id: string;
      trigger: string;
      results: string;
      depth: number;
      at: number;
    }>(
      `SELECT id, rule_id, task_id, trigger, results, depth, at FROM automation_runs
       ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
       ORDER BY id DESC LIMIT ?`,
      ...params,
      limit
    )
    .toArray()
    .map((r) => ({
      id: r.id,
      ruleId: r.rule_id,
      taskId: r.task_id,
      trigger: r.trigger,
      results: JSON.parse(r.results) as AutomationRunLog["results"],
      depth: r.depth,
      at: r.at,
    }));
}

export function upsertAutomation(
  host: WorkspaceHost,
  input: Parameters<typeof import("./rows.js").toRule>[0] extends never ? never : import("@flow/shared").UpsertAutomationInput,
  actor: string | Actor
): AutomationRule {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    const scope = input.scope;
    if (scope.kind === "list") requireListRow(sql, scope.listId);
    else requireSpace(sql, scope.spaceId);

    const existingId = input.id;
    const isUpdate =
      existingId !== undefined &&
      sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM automation_rules WHERE id = ?", existingId).one().n > 0;

    const ruleId = isUpdate && existingId !== undefined ? existingId : id("ar_");
    const scopeId = scope.kind === "list" ? scope.listId : scope.spaceId;

    if (isUpdate) {
      sql.exec(
        `UPDATE automation_rules SET name = ?, enabled = ?, scope = ?, scope_kind = ?, scope_id = ?,
           trigger = ?, trigger_kind = ?, conditions = ?, actions = ?, updated_at = ?
         WHERE id = ?`,
        input.name,
        input.enabled ? 1 : 0,
        JSON.stringify(scope),
        scope.kind,
        scopeId,
        JSON.stringify(input.trigger),
        input.trigger.kind,
        JSON.stringify(input.conditions),
        JSON.stringify(input.actions),
        t.now,
        ruleId
      );
    } else {
      sql.exec(
        `INSERT INTO automation_rules
           (id, name, enabled, scope, scope_kind, scope_id, trigger, trigger_kind,
            conditions, actions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ruleId,
        input.name,
        input.enabled ? 1 : 0,
        JSON.stringify(scope),
        scope.kind,
        scopeId,
        JSON.stringify(input.trigger),
        input.trigger.kind,
        JSON.stringify(input.conditions),
        JSON.stringify(input.actions),
        t.now,
        t.now
      );
    }

    const rule = toRule(
      sql
        .exec<RuleRow>(
          `SELECT id, name, enabled, scope, trigger, conditions, actions, created_at, updated_at
           FROM automation_rules WHERE id = ?`,
          ruleId
        )
        .one()
    );
    t.emit(isUpdate ? "update" : "create", "automation_rule", rule.id, rule as unknown as Record<string, unknown>);
    t.audit(isUpdate ? "automation.update" : "automation.create", rule.id, { name: rule.name });
    return rule;
  });
}

export function deleteAutomation(
  host: WorkspaceHost,
  ruleId: string,
  actor: string | Actor
): { ok: true } {
  return host.runTurn(toActor(actor), (t) => {
    const row = host.sql
      .exec<{ name: string }>("SELECT name FROM automation_rules WHERE id = ?", ruleId)
      .toArray()[0];
    if (!row) throw new Error(`Automation rule ${ruleId} not found.`);
    host.sql.exec("DELETE FROM automation_rules WHERE id = ?", ruleId);
    t.emit("delete", "automation_rule", ruleId, null);
    t.audit("automation.delete", ruleId, { name: row.name });
    return { ok: true } as const;
  });
}
