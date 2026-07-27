// System email notifications: recipient resolution + templates + pref storage.
//
// Pure and dependency-free except for @flow/shared and the tiny taskUrl helper
// shared with automations (so notification links match automation links). The
// DO (packages/core/src/index.ts) is the only caller of the I/O-touching pref
// helpers; the resolution and template functions are pure and unit-tested.
//
// These are NOT automation rules. They evaluate for every committed mutation
// turn, gated only by each recipient's NotificationPref, and reuse the existing
// kind:"email" side-effect (which honors EMAIL_DRY_RUN in the queue consumer).
// The import path never opens a Turn (it writes SQL directly and emits no
// deltas), so — exactly like automations — notifications never fire on import.

import {
  type NotificationEvent,
  type NotificationPref,
  mergeNotificationPrefs,
} from "@flow/shared";
import { taskUrl } from "./automation/template.js";

export { taskUrl };

/** The three deltas that produce a notification today. `mention` is not here. */
export type NotifyKind = "assigned" | "comment" | "status";

/** Which per-user pref gates each notification kind. */
export const PREF_KEY: Record<NotifyKind, keyof NotificationPref> = {
  assigned: "assigned_to_me",
  comment: "comment_on_my_task",
  status: "status_change_on_my_task",
};

// ---------------------------------------------------------------------------
// Recipient resolution (pure). Every path drops the actor: you are never
// emailed about your own action, whoever set the change off.
// ---------------------------------------------------------------------------

/**
 * Assignment: only the task's NEW assignee is notified, and never when that is
 * the actor (assigning a task to yourself sends nothing). Unassigning (null)
 * notifies no one.
 */
export function assignedRecipients(
  newAssigneeId: string | null,
  actorId: string
): string[] {
  if (newAssigneeId === null || newAssigneeId === actorId) return [];
  return [newAssigneeId];
}

/**
 * Comments and status changes go to the task's stakeholders — its current
 * assignee and its creator — minus the actor, de-duplicated, with nulls
 * dropped. Assignee-is-also-creator collapses to one recipient; actor-is-one-of
 * -them drops that recipient.
 */
export function stakeholderRecipients(
  assigneeId: string | null,
  creatorId: string,
  actorId: string
): string[] {
  const out: string[] = [];
  for (const candidate of [assigneeId, creatorId]) {
    if (candidate === null) continue;
    if (candidate === actorId) continue;
    if (out.includes(candidate)) continue;
    out.push(candidate);
  }
  return out;
}

/** Recipients for one delta kind. Convenience over the two functions above. */
export function recipientsFor(
  kind: NotifyKind,
  facts: { assigneeId: string | null; creatorId: string; newAssigneeId?: string | null },
  actorId: string
): string[] {
  if (kind === "assigned") {
    return assignedRecipients(facts.newAssigneeId ?? null, actorId);
  }
  return stakeholderRecipients(facts.assigneeId, facts.creatorId, actorId);
}

// ---------------------------------------------------------------------------
// Templates (pure). Markdown bodies; the side-effect consumer renders HTML.
// ---------------------------------------------------------------------------

export interface RenderedEmail {
  subject: string;
  body: string;
}

export interface NotificationInput {
  taskTitle: string;
  taskUrl: string;
  /** Who set the change off (assigner / commenter / mover). */
  actorName: string;
  /** New status display name — status changes only. */
  statusName?: string;
  /** The comment's markdown body — comments only. */
  commentBody?: string;
}

/** As markdown so a `#hash` title or `*stars*` never break the layout. */
function asQuote(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function footer(url: string): string {
  return `[Open the task](${url})`;
}

export function renderAssigned(input: NotificationInput): RenderedEmail {
  return {
    subject: `You were assigned: ${input.taskTitle}`,
    body: [
      `**${input.actorName}** assigned you to **${input.taskTitle}**.`,
      footer(input.taskUrl),
    ].join("\n\n"),
  };
}

export function renderComment(input: NotificationInput): RenderedEmail {
  return {
    subject: `New comment on ${input.taskTitle}`,
    body: [
      `**${input.actorName}** commented on **${input.taskTitle}**:`,
      asQuote(input.commentBody ?? ""),
      footer(input.taskUrl),
    ].join("\n\n"),
  };
}

export function renderStatus(input: NotificationInput): RenderedEmail {
  const status = input.statusName ?? "";
  return {
    subject: `${input.taskTitle} moved to ${status}`,
    body: [
      `**${input.actorName}** moved **${input.taskTitle}** to **${status}**.`,
      footer(input.taskUrl),
    ].join("\n\n"),
  };
}

/** Dispatch to the per-kind renderer. */
export function renderNotification(kind: NotifyKind, input: NotificationInput): RenderedEmail {
  switch (kind) {
    case "assigned":
      return renderAssigned(input);
    case "comment":
      return renderComment(input);
    case "status":
      return renderStatus(input);
  }
}

/** The event name recorded on the queued payload's `ruleId` slot, for logs. */
export function notificationTag(kind: NotifyKind): string {
  const event: Record<NotifyKind, NotificationEvent> = {
    assigned: "assigned_to_me",
    comment: "comment_on_my_task",
    status: "status_change_on_my_task",
  };
  return `notify:${event[kind]}`;
}

// ---------------------------------------------------------------------------
// Pref storage. The `notification_prefs` table is (user_id PK, prefs JSON,
// updated_at). A missing row means "defaults" — reads never require a prior
// write, and a write stores the fully-merged set.
// ---------------------------------------------------------------------------

/** Read one user's prefs, merged onto the defaults. Missing row => defaults. */
export function readNotificationPrefs(sql: SqlStorage, userId: string): NotificationPref {
  const row = sql
    .exec<{ prefs: string }>("SELECT prefs FROM notification_prefs WHERE user_id = ?", userId)
    .toArray()[0];
  if (!row) return mergeNotificationPrefs(undefined);
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.prefs);
  } catch {
    parsed = undefined;
  }
  return mergeNotificationPrefs(parsed);
}

/** Upsert one user's prefs (already merged onto defaults by the caller). */
export function writeNotificationPrefs(
  sql: SqlStorage,
  userId: string,
  prefs: NotificationPref,
  now: number
): void {
  sql.exec(
    `INSERT INTO notification_prefs (user_id, prefs, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`,
    userId,
    JSON.stringify(prefs),
    now
  );
}
