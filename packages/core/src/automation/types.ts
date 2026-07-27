// //
// The contract between the workspace Durable Object (do-core agent) and the
// automation engine. Everything the engine needs to know about the workspace
// arrives through AutomationContext, so the engine holds no knowledge of the
// DO's table layout except the two tables it owns (see ./migrations.ts).

import type { Action, AutomationRule, Delta, Task, WebhookPayload } from "@flow/shared";

/**
 * A Delta plus the two extra bits automations need that a plain Delta can't
 * carry: the pre-mutation values (a Delta's `data` holds changed fields only,
 * so "EDITING -> SENT TO CLIENT" is unknowable without it) and, for deltas on
 * child entities like subtasks, the owning task id.
 *
 * A plain `Delta` is assignable to this — both extras are optional — so the DO
 * can pass any delta it appends. Rules that need the extras simply won't match
 * when they're absent.
 */
export interface AutomationDelta extends Delta {
  /** Field values as they were BEFORE this delta was applied. */
  prev?: Record<string, unknown> | null;
  /** Owning task id. Required when `entity` is not "task". */
  taskId?: string;
}

/**
 * Everything the engine needs about one task, resolved by the DO. Names, not
 * ids, because rules and templates speak in names.
 */
export interface TaskFacts {
  task: Task;
  /** Display name of task.statusId. */
  statusName: string;
  list: { id: string; name: string; spaceId: string };
  space: { id: string; name: string };
  assignee: { id: string; name: string; email: string } | null;
  subtaskTotal: number;
  subtaskDone: number;
}

/**
 * The flat, pure view that trigger matching, condition evaluation and template
 * rendering all read from. Derived from TaskFacts + the delta; no I/O.
 */
export interface TaskView extends TaskFacts {
  /** Status name before the delta, when the delta changed the status. */
  prevStatusName: string | null;
  /** Assignee id before the delta, when the delta changed the assignee. */
  prevAssigneeId: string | null;
  /** Tags present after the delta that weren't present before. */
  addedTags: string[];
  /** For {{task.url}}. */
  appHostname: string;
}

/** Queue message bodies. Consumed by apps/api/src/side-effects. */
export type SideEffectPayload =
  | {
      kind: "webhook";
      url: string;
      /** HMAC-SHA256 key for the X-Flow-Signature header; null = unsigned. */
      secret: string | null;
      body: WebhookPayload;
      ruleId: string;
      taskId: string;
    }
  | {
      kind: "email";
      to: string[];
      subject: string;
      /** Markdown; rendered to HTML by the consumer. */
      body: string;
      ruleId: string;
      taskId: string;
    };

/**
 * Provided by the DO for every mutation turn that appends a delta.
 * The engine only ever reads — all writes go back through applyAction (for
 * in-workspace effects) or enqueueSideEffect (for outbound ones), except the
 * automation_runs / automation_due_fires bookkeeping it does via `sql`.
 */
export interface AutomationContext {
  /** DO SQLite handle. Used only for the two automation-owned tables + reads of automation_rules. */
  sql: SqlStorage;
  /** Wall clock for this turn, ms. */
  now: number;
  /** e.g. "flow.example.com" — builds {{task.url}}. */
  appHostname: string;
  /** 0 for a user-initiated mutation; incremented by each automation hop. */
  depth: number;
  /** env.EMAIL_DRY_RUN !== "false". Only affects the dryRun flag in run logs. */
  emailDryRun?: boolean;

  /** Resolve a task and its surroundings. Return null if the task is gone. */
  loadTaskFacts(taskId: string): TaskFacts | null;
  /** Resolve a status id to its display name (for pre-mutation status). */
  statusNameById(statusId: string): string | null;

  /**
   * Re-entrant mutation entry point. The engine always passes ctx.depth + 1;
   * the DO must thread that into the nested evaluateAutomations call so the
   * depth cap actually caps.
   *
   * `ruleId` names the rule whose action this is. It is optional so older
   * implementations of this interface still satisfy it, but the DO uses it to
   * write `via: "automation"` and `automationRuleId` onto the resulting audit
   * rows — without it the trail claims the triggering user made the change by
   * hand through the API.
   */
  applyAction(action: Action, taskId: string, depth: number, ruleId?: string): void;
  /** Push a message onto the SIDE_EFFECTS queue. Fire-and-forget. */
  enqueueSideEffect(payload: SideEffectPayload): void;
}

/** Extra capability the alarm-driven due-date sweep needs. */
export interface AutomationScheduleContext extends AutomationContext {
  /**
   * Task ids in `scope` whose dueDate falls in [fromMs, toMs] and which are
   * not closed. Ordering doesn't matter.
   */
  listTaskIdsDueBetween(
    scope: AutomationRule["scope"],
    fromMs: number,
    toMs: number
  ): string[];
}

/** One row of AutomationRunLog.results. */
export interface ActionResult {
  action: string;
  ok: boolean;
  dryRun: boolean;
  detail: string | null;
}
