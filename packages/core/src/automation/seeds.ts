// //
// Example automation seeds demonstrating the rule vocabulary. Every rule ships
// `enabled: false` — an importer or setup script writes them, and an admin
// flips them on one at a time once the placeholder ids are bound.
//
// Scope ids and the assignee id are PLACEHOLDERS. Bind them with
// bindSeedScopes() once real ids exist; unbound placeholders are deliberately
// obvious in logs and the UI.

import type { AutomationRule } from "@flow/shared";

/** A seed rule: an AutomationRule minus the fields the DO assigns on insert. */
export type SeedAutomationRule = Omit<AutomationRule, "id" | "createdAt" | "updatedAt"> & {
  /** Stable key for idempotent re-import; not part of the stored rule. */
  key: string;
};

// --- placeholders -----------------------------------------------------------

export const SEED_LIST_PLACEHOLDERS = {
  ourProjects: "ls_SEED_OUR_PROJECTS",
  contentCycle: "ls_SEED_CONTENT_CYCLE",
} as const;

export const SEED_SPACE_PLACEHOLDERS = {
  marketing: "sp_SEED_MARKETING",
} as const;

export const SEED_USER_PLACEHOLDERS = {
  publisher: "us_SEED_PUBLISHER",
} as const;

/** Every placeholder token, for the importer to assert full binding. */
export const SEED_PLACEHOLDERS: readonly string[] = [
  ...Object.values(SEED_LIST_PLACEHOLDERS),
  ...Object.values(SEED_SPACE_PLACEHOLDERS),
  ...Object.values(SEED_USER_PLACEHOLDERS),
];

// --- webhook endpoints ------------------------------------------------------

// Example endpoint only — replace with your own webhook receiver before
// enabling any rule that calls it.
export const WEBHOOK_EXAMPLE_URL = "https://hooks.example.com/flow";

// --- helpers ----------------------------------------------------------------

const webhook = (url: string) =>
  ({ kind: "call_webhook", url, secret: null }) satisfies AutomationRule["actions"][number];

const subtask = (
  title: string,
  assigneeId: string | null = null,
  dueInDays: number | null = null
) => ({ kind: "create_subtask", title, assigneeId, dueInDays }) satisfies AutomationRule["actions"][number];

// --- the example inventory --------------------------------------------------

export const SEED_AUTOMATION_RULES: SeedAutomationRule[] = [
  // Notify a shared inbox by email whenever a task's status changes.
  {
    key: "content-cycle/notify-ops-on-status-change",
    name: "Content Cycle — status change → email ops",
    enabled: false,
    scope: { kind: "list", listId: SEED_LIST_PLACEHOLDERS.contentCycle },
    trigger: { kind: "status_changed" },
    conditions: [],
    actions: [
      {
        kind: "send_email",
        to: ["ops@example.com"],
        subject: "Status changed: {{task.title}}",
        body: "{{task.title}} is now {{task.status}}.\n\n{{task.url}}",
      },
    ],
  },

  // Call an external webhook when a task lands in DONE.
  {
    key: "our-projects/webhook-on-done",
    name: "Our Projects — moved to DONE → call webhook",
    enabled: false,
    scope: { kind: "list", listId: SEED_LIST_PLACEHOLDERS.ourProjects },
    trigger: { kind: "status_changed", to: ["DONE"] },
    conditions: [],
    actions: [webhook(WEBHOOK_EXAMPLE_URL)],
  },

  // Create a launch-checklist subtask when a task becomes APPROVED.
  {
    key: "content-cycle/launch-checklist",
    name: "Content Cycle — → APPROVED → publish checklist subtask",
    enabled: false,
    scope: { kind: "list", listId: SEED_LIST_PLACEHOLDERS.contentCycle },
    trigger: { kind: "status_changed", to: ["APPROVED"] },
    conditions: [],
    actions: [subtask("publish {{task.title}}", SEED_USER_PLACEHOLDERS.publisher, 0)],
  },

  // Space-wide: tag "qa" routes the task to an external QA webhook.
  {
    key: "marketing/qa",
    name: "Marketing (space) — tag \"qa\" → QA webhook",
    enabled: false,
    scope: { kind: "space", spaceId: SEED_SPACE_PLACEHOLDERS.marketing },
    trigger: { kind: "tag_added", tags: ["qa"] },
    conditions: [],
    actions: [webhook(WEBHOOK_EXAMPLE_URL)],
  },

  // Tag "assign" mirrors the task into a subtask so it shows up on the
  // assignee's plate without moving the parent.
  {
    key: "our-projects/assign",
    name: "Our Projects — tag \"assign\" → mirror subtask",
    enabled: false,
    scope: { kind: "list", listId: SEED_LIST_PLACEHOLDERS.ourProjects },
    trigger: { kind: "tag_added", tags: ["assign"] },
    conditions: [],
    actions: [subtask("{{task.title}}")],
  },

  // When every subtask on a IN REVIEW task is done, advance the status and
  // mirror the task title into a fresh subtask for the publisher.
  {
    key: "content-cycle/review-to-ready",
    name: "Content Cycle — all subtasks done on IN REVIEW → APPROVED",
    enabled: false,
    scope: { kind: "list", listId: SEED_LIST_PLACEHOLDERS.contentCycle },
    trigger: { kind: "all_subtasks_done" },
    conditions: [{ kind: "status_is", names: ["IN REVIEW"] }],
    actions: [
      { kind: "set_status", statusName: "APPROVED" },
      subtask("{{task.title}}", SEED_USER_PLACEHOLDERS.publisher),
    ],
  },
];

/**
 * Replace placeholder ids with real ones. Substitution is textual over the
 * serialized rule, so it catches scope ids, action listIds and assigneeIds in
 * one pass.
 *
 * Throws if any placeholder survives, so a half-bound import fails loudly
 * instead of writing rules that point at nothing.
 */
export function bindSeedScopes(
  rules: readonly SeedAutomationRule[],
  bindings: Readonly<Record<string, string>>
): SeedAutomationRule[] {
  const bound = rules.map((rule) => {
    let json = JSON.stringify(rule);
    for (const [placeholder, real] of Object.entries(bindings)) {
      json = json.split(placeholder).join(real);
    }
    return JSON.parse(json) as SeedAutomationRule;
  });

  const unbound = new Set<string>();
  const serialized = JSON.stringify(bound);
  for (const placeholder of SEED_PLACEHOLDERS) {
    if (serialized.includes(placeholder)) unbound.add(placeholder);
  }
  if (unbound.size > 0) {
    throw new Error(`bindSeedScopes: unbound placeholders: ${[...unbound].join(", ")}`);
  }
  return bound;
}
