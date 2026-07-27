// Test-only fixtures/fakes. Not exported from
// ./index.ts and never imported by runtime code.

import type { Action, AutomationRule, Task } from "@flow/shared";
import type {
  AutomationContext,
  AutomationDelta,
  AutomationScheduleContext,
  SideEffectPayload,
  TaskFacts,
} from "./types.js";

export const HOSTNAME = "flow.example.com";

export const STATUS_NAMES: Record<string, string> = {
  st_todo: "To Do",
  st_editing: "EDITING",
  st_sent: "SENT TO CLIENT",
  st_review: "IN REVIEW",
  st_publish: "APPROVED",
  st_ready: "DONE",
};

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "tk_1",
    listId: "ls_1",
    title: "Write the launch article",
    description: "Body **copy** here",
    statusId: "st_todo",
    assigneeId: null,
    priority: null,
    dueDate: null,
    startDate: null,
    snoozedUntil: null,
    blockedNote: null,
    tags: [],
    position: 1,
    createdBy: "us_alice",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    closedAt: null,
    clickupId: null,
    ...overrides,
  };
}

export function makeFacts(overrides: Partial<TaskFacts> = {}): TaskFacts {
  const task = overrides.task ?? makeTask();
  return {
    task,
    statusName: STATUS_NAMES[task.statusId] ?? "To Do",
    list: { id: task.listId, name: "Content Cycle", spaceId: "sp_1" },
    space: { id: "sp_1", name: "Marketing" },
    assignee: null,
    subtaskTotal: 0,
    subtaskDone: 0,
    ...overrides,
  };
}

export function taskDelta(
  data: Record<string, unknown> | null,
  prev: Record<string, unknown> | null = null,
  op: AutomationDelta["op"] = "update"
): AutomationDelta {
  return {
    seq: 1,
    op,
    entity: "task",
    id: "tk_1",
    data,
    prev,
    actorUserId: "us_alice",
    at: 1_700_000_100_000,
  };
}

export function subtaskDelta(taskId = "tk_1"): AutomationDelta {
  return {
    seq: 2,
    op: "update",
    entity: "subtask",
    id: "sb_1",
    data: { done: true },
    prev: { done: false },
    taskId,
    actorUserId: "us_alice",
    at: 1_700_000_100_000,
  };
}

export function makeRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: "ar_1",
    name: "test rule",
    enabled: true,
    scope: { kind: "list", listId: "ls_1" },
    trigger: { kind: "task_created" },
    conditions: [],
    actions: [{ kind: "add_tags", tags: ["touched"] }],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export interface FakeCtx extends AutomationScheduleContext {
  applied: { action: Action; taskId: string; depth: number; ruleId?: string }[];
  queued: SideEffectPayload[];
  runs: { ruleId: string; taskId: string; trigger: string; results: unknown; depth: number }[];
  dueFires: Set<string>;
}

/**
 * An AutomationContext backed by plain objects: rules come from an array, writes
 * land in in-memory collections. Enough to exercise the engine end to end
 * without a Durable Object.
 */
export function makeCtx(
  opts: {
    rules?: AutomationRule[];
    facts?: TaskFacts;
    depth?: number;
    emailDryRun?: boolean;
    dueTaskIds?: string[];
  } = {}
): FakeCtx {
  const rules = opts.rules ?? [];
  const facts = opts.facts ?? makeFacts();
  const applied: FakeCtx["applied"] = [];
  const queued: SideEffectPayload[] = [];
  const runs: FakeCtx["runs"] = [];
  const dueFires = new Set<string>();

  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      if (query.includes("FROM automation_rules")) {
        // Mirrors the DO's columnar layout: each sub-object its own JSON blob.
        return {
          toArray: () =>
            rules
              .filter((r) => r.enabled)
              .map((r) => ({
                id: r.id,
                name: r.name,
                enabled: r.enabled ? 1 : 0,
                scope: JSON.stringify(r.scope),
                trigger: JSON.stringify(r.trigger),
                conditions: JSON.stringify(r.conditions),
                actions: JSON.stringify(r.actions),
                created_at: r.createdAt,
                updated_at: r.updatedAt,
              })),
        };
      }
      if (query.startsWith("INSERT INTO automation_runs")) {
        runs.push({
          ruleId: String(bindings[0]),
          taskId: String(bindings[1]),
          trigger: String(bindings[2]),
          results: JSON.parse(String(bindings[3])),
          depth: Number(bindings[4]),
        });
        return { toArray: () => [] };
      }
      if (query.includes("FROM automation_due_fires")) {
        const key = `${String(bindings[0])}|${String(bindings[1])}|${String(bindings[2])}`;
        return { toArray: () => [{ n: dueFires.has(key) ? 1 : 0 }] };
      }
      if (query.includes("INTO automation_due_fires")) {
        dueFires.add(`${String(bindings[0])}|${String(bindings[1])}|${String(bindings[2])}`);
        return { toArray: () => [] };
      }
      return { toArray: () => [] };
    },
  } as unknown as SqlStorage;

  const ctx: FakeCtx = {
    sql,
    now: 1_700_000_100_000,
    appHostname: HOSTNAME,
    depth: opts.depth ?? 0,
    emailDryRun: opts.emailDryRun,
    loadTaskFacts: () => facts,
    statusNameById: (id) => STATUS_NAMES[id] ?? null,
    applyAction: (action, taskId, depth, ruleId) =>
      applied.push({ action, taskId, depth, ruleId }),
    enqueueSideEffect: (payload) => queued.push(payload),
    listTaskIdsDueBetween: () => opts.dueTaskIds ?? [],
    applied,
    queued,
    runs,
    dueFires,
  };
  return ctx;
}

/** Narrow AutomationContext back to FakeCtx in assertions. */
export function asCtx(ctx: FakeCtx): AutomationContext {
  return ctx;
}
