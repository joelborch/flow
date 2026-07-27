import { z } from "zod";
import { Id, Priority, Ts } from "./entities.js";

// ---------------------------------------------------------------------------
// Automation rules: trigger -> conditions (AND) -> actions (in order).
// Rules are evaluated inline in the DO mutation turn; outbound side effects
// (webhook, email) are enqueued, never awaited inline.
// Vocabulary is modeled on common real-world rules: status_changed,
// tag_added, task_created, all_subtasks_done, due_date_approaching.
// ---------------------------------------------------------------------------

export const Trigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task_created") }),
  z.object({
    kind: z.literal("status_changed"),
    // Status NAMES (case-insensitive match), not ids, so one rule can apply
    // across lists sharing a status set. Empty/undefined = any.
    from: z.array(z.string()).optional(),
    to: z.array(z.string()).optional(),
  }),
  z.object({ kind: z.literal("tag_added"), tags: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("assignee_changed"), toUserId: Id.optional() }),
  z.object({ kind: z.literal("all_subtasks_done") }),
  z.object({
    kind: z.literal("due_date_approaching"),
    daysBefore: z.number().int().min(0).max(60),
  }),
]);
export type Trigger = z.infer<typeof Trigger>;

export const Condition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status_is"), names: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("has_tag"), tags: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("assignee_is"), userIds: z.array(Id).min(1) }),
  z.object({ kind: z.literal("priority_is"), priorities: z.array(Priority).min(1) }),
]);
export type Condition = z.infer<typeof Condition>;

// Template strings in email/webhook/subtask actions support {{task.title}},
// {{task.status}}, {{task.url}}, {{task.assignee}}, {{task.dueDate}},
// {{task.description}}, {{list.name}}, {{space.name}}.
export const Action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set_status"), statusName: z.string() }),
  z.object({ kind: z.literal("set_assignee"), userId: Id.nullable() }),
  z.object({ kind: z.literal("set_priority"), priority: Priority.nullable() }),
  z.object({ kind: z.literal("add_tags"), tags: z.array(z.string()).min(1) }),
  z.object({
    kind: z.literal("create_subtask"),
    title: z.string(), // template string
    assigneeId: Id.nullable().default(null),
    dueInDays: z.number().int().nullable().default(null),
  }),
  z.object({ kind: z.literal("move_to_list"), listId: Id }),
  z.object({
    kind: z.literal("call_webhook"),
    url: z.string().url(),
    // Payload is always the standard event envelope + full task snapshot.
    secret: z.string().nullable().default(null), // HMAC-SHA256 signature key
  }),
  z.object({
    kind: z.literal("send_email"),
    to: z.array(z.string()).min(1), // email addresses or "{{task.assignee}}"
    subject: z.string(), // template string
    body: z.string(), // template string, markdown -> rendered to HTML
  }),
]);
export type Action = z.infer<typeof Action>;

export const AutomationRule = z.object({
  id: Id,
  name: z.string().min(1),
  enabled: z.boolean().default(false), // seeded rules ship disabled until an operator enables them
  // Scope: a specific list, or a whole space (all its lists).
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("list"), listId: Id }),
    z.object({ kind: z.literal("space"), spaceId: Id }),
  ]),
  trigger: Trigger,
  conditions: z.array(Condition).default([]),
  actions: z.array(Action).min(1),
  createdAt: Ts,
  updatedAt: Ts,
});
export type AutomationRule = z.infer<typeof AutomationRule>;

// Hard cap on automation-triggering-automation depth.
export const AUTOMATION_MAX_DEPTH = 5;

// Global email dry-run: when true (default), send_email actions log to the
// audit trail instead of sending. Flipped by the operator when ready.
export const EMAIL_DRY_RUN_DEFAULT = true;

export const AutomationRunLog = z.object({
  id: z.number().int(),
  ruleId: Id,
  taskId: Id,
  trigger: z.string(),
  // One entry per action: what ran, or what WOULD run in dry-run mode.
  results: z.array(
    z.object({
      action: z.string(),
      ok: z.boolean(),
      dryRun: z.boolean().default(false),
      detail: z.string().nullable(),
    })
  ),
  depth: z.number().int(),
  at: Ts,
});
export type AutomationRunLog = z.infer<typeof AutomationRunLog>;
