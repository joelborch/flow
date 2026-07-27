import { z } from "zod";
import { Id } from "./entities.js";

// ---------------------------------------------------------------------------
// User-facing email notifications (system notifications, not automation rules).
//
// These are always-on per the recipient's per-user preferences below, fire
// inside the DO mutation turn after a mutation commits, and reuse the existing
// SIDE_EFFECTS queue + email side-effect path (EMAIL_DRY_RUN honored there).
// ---------------------------------------------------------------------------

/** The events a user can subscribe to. `mention` is wired but not yet emitted. */
export const NOTIFICATION_EVENTS = [
  // A task's assignee becomes me.
  "assigned_to_me",
  // Someone comments on a task I'm assigned to or created.
  "comment_on_my_task",
  // A task I'm assigned to or created changes status.
  "status_change_on_my_task",
  // Someone @-mentions me. TODO: mentions aren't parsed yet — no delta carries
  // mention data, so nothing emits this event. The pref exists so the UI and
  // storage are ready the day mention parsing lands.
  "mention",
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/**
 * Per-user booleans, one per event. All default ON except status changes, which
 * default OFF: a busy task can move through several statuses a day and that is
 * the noisiest signal, so a user opts in rather than out.
 */
export const NotificationPref = z.object({
  assigned_to_me: z.boolean().default(true),
  comment_on_my_task: z.boolean().default(true),
  status_change_on_my_task: z.boolean().default(false),
  mention: z.boolean().default(true),
});
export type NotificationPref = z.infer<typeof NotificationPref>;

/** The canonical default set. A fresh object each call — never share state. */
export function defaultNotificationPrefs(): NotificationPref {
  return {
    assigned_to_me: true,
    comment_on_my_task: true,
    status_change_on_my_task: false,
    mention: true,
  };
}

/**
 * Merge a possibly-partial, possibly-unknown stored/patch value onto the
 * defaults. Unknown keys are dropped; missing keys fall back to the default;
 * non-booleans are ignored. Used both to read a stored row and to apply a PUT.
 */
export function mergeNotificationPrefs(patch: unknown): NotificationPref {
  const base = defaultNotificationPrefs();
  if (typeof patch !== "object" || patch === null) return base;
  const p = patch as Record<string, unknown>;
  for (const key of NOTIFICATION_EVENTS) {
    if (typeof p[key] === "boolean") base[key] = p[key] as boolean;
  }
  return base;
}

/** Accepted body for PUT /api/notifications/prefs: any subset of the booleans. */
export const NotificationPrefPatch = NotificationPref.partial();
export type NotificationPrefPatch = z.infer<typeof NotificationPrefPatch>;

/**
 * The GET/PUT response shape: the resolved prefs plus the per-user email derived
 * from the user record. `email` is null when the user has no real address (e.g.
 * an import placeholder) — the same condition under which no mail is sent.
 */
export const NotificationSettings = z.object({
  userId: Id,
  email: z.string().nullable(),
  prefs: NotificationPref,
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;
