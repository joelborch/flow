import { mergeNotificationPrefs, type Actor, type NotificationPref, type Task } from "@flow/shared";
import { drainAutomations, loadTaskFacts } from "./automation-apply.js";
import type { AutomationDelta, SideEffectPayload, TaskFacts } from "./automation/types.js";
import {
  type WorkspaceHost,
  hasRealEmail,
  markEmailReply,
  recordDeliveryFailure,
  spaceIdForDelta,
  taskRow,
  userById,
} from "./db-helpers.js";
import {
  type NotifyKind,
  PREF_KEY,
  notificationTag,
  readNotificationPrefs,
  recipientsFor,
  renderNotification,
  taskUrl,
  writeNotificationPrefs,
} from "./notifications.js";
import { toTask } from "./rows.js";
import { SIDE_EFFECTS_MESSAGE_BYTES, chunkSideEffects } from "./side-effect-size.js";
import { getStatus } from "./statuses.js";
import { Turn } from "./turn.js";
import { canSeeSpace, isPrivilegedRole, isSpaceMember } from "./visibility.js";
import { broadcastDeltas, resyncForSpaceMoves } from "./ws.js";

// =========================================================================
// Mutation turns
// =========================================================================

export function executeTurn<T>(
  host: WorkspaceHost,
  actor: Actor,
  fn: (t: Turn) => T,
  silent = false
): T {
  // Before anything is written, so a refused turn changes nothing.
  if (host.env.SANDBOX === "true") host.sandboxWrites.take();
  const t = new Turn(host.sql, actor, Date.now(), silent, (entity, entityId, taskId) =>
    spaceIdForDelta(host.sql, entity, entityId, taskId)
  );
  const result = fn(t);
  drainAutomations(host, t);
  // After automations, so a rule that reassigns or moves a task also notifies.
  drainNotifications(host, t);
  // After automations too: a move_to_list rule can carry a task across spaces.
  resyncForSpaceMoves(host, t);
  flushTurn(host, t);
  return result;
}

/**
 * A mutation turn whose result is a Task, re-read after the automation drain.
 *
 * Automations run inline in this same turn, so by the time the turn ends the
 * row may no longer look like what the mutation itself wrote — a rule can have
 * moved the task, changed its status or retagged it. Returning the pre-drain
 * value made `move()` report the status the caller asked for while the board
 * (fed by deltas) showed the automation's. Re-reading closes that gap.
 *
 * The row can only be missing if something deleted the task mid-turn, which
 * nothing does today; the pre-drain value is the honest fallback.
 */
export function executeTaskTurn(host: WorkspaceHost, actor: Actor, fn: (t: Turn) => Task): Task {
  const before = host.runTurn(actor, fn);
  const row = taskRow(host.sql, before.id);
  return row === null ? before : toTask(row);
}

// =========================================================================
// Notification preferences (per user, self-service via the REST layer)
// =========================================================================

export function getNotificationPrefs(sql: SqlStorage, userId: string): NotificationPref {
  return readNotificationPrefs(sql, userId);
}

/** Merge the patch onto the user's current prefs and persist the full set. */
export function setNotificationPrefs(
  sql: SqlStorage,
  userId: string,
  patch: Partial<NotificationPref>
): NotificationPref {
  const current = readNotificationPrefs(sql, userId);
  const next = mergeNotificationPrefs({ ...current, ...patch });
  writeNotificationPrefs(sql, userId, next, Date.now());
  return next;
}

// =========================================================================
// System email notifications
//
// Independent of automation rules: always-on per each recipient's prefs. Runs
// after the automation drain so a rule-driven reassign/move/status change also
// notifies. Silent (import) turns emit no deltas, so — like automations — this
// never fires on import. A recipient is never emailed about their own action.
// =========================================================================

function drainNotifications(host: WorkspaceHost, t: Turn): void {
  if (t.silent) return;
  // Snapshot: notification enqueues never append deltas, but iterate a copy so
  // the loop bound is fixed regardless.
  for (const entry of [...t.entries]) {
    try {
      notifyForDelta(host, t, entry.delta);
    } catch (err) {
      console.error("notification failed", entry.delta.entity, entry.delta.id, err);
    }
  }
}

function notifyForDelta(host: WorkspaceHost, t: Turn, delta: AutomationDelta): void {
  const actorId = delta.actorUserId;
  const data = delta.data ?? {};

  // A new handoff tells its recipient. Only handoffs: an ordinary task
  // created with an assignee has never emailed anyone (assignment
  // notifications ride the update path below), and changing that for every
  // create is a separate decision from filing a request for a teammate.
  if (delta.entity === "task" && delta.op === "create") {
    if (data["handoff"] == null) return;
    const facts = loadTaskFacts(host.sql, delta.id);
    if (facts === null) return;
    const newAssigneeId = (data["assigneeId"] as string | null) ?? null;
    for (const rid of recipientsFor("assigned", { assigneeId: null, creatorId: facts.task.createdBy, newAssigneeId }, actorId)) {
      sendNotification(host, t, "assigned", facts, rid, actorId, {});
    }
    return;
  }

  if (delta.entity === "task" && delta.op === "update") {
    const facts = loadTaskFacts(host.sql, delta.id);
    if (facts === null) return;

    if ("assigneeId" in data) {
      const newAssigneeId = (data["assigneeId"] as string | null) ?? null;
      for (const rid of recipientsFor("assigned", { assigneeId: null, creatorId: facts.task.createdBy, newAssigneeId }, actorId)) {
        sendNotification(host, t, "assigned", facts, rid, actorId, {});
      }
    }
    // The ball landing on someone tells them, unless the same change also
    // assigned them (one email, not two) or the task is closed.
    if ("waitingOn" in data && facts.task.closedAt === null) {
      const newWaitingOn = (data["waitingOn"] as string | null) ?? null;
      const alreadyTold = "assigneeId" in data && data["assigneeId"] === newWaitingOn;
      if (!alreadyTold) {
        const commentBody = turnCommentBody(t, delta.id, actorId);
        for (const rid of recipientsFor("turn", { assigneeId: null, creatorId: facts.task.createdBy, newWaitingOn }, actorId)) {
          sendNotification(host, t, "turn", facts, rid, actorId, commentBody === null ? {} : { commentBody });
        }
      }
    }
    if ("statusId" in data) {
      const statusName = getStatus(host.sql, String(data["statusId"]))?.name ?? facts.statusName;
      // Status ids are per-list: a cross-list move from "Done" to "Done" swaps
      // the id but is not a status change anyone should be emailed about.
      const prevStatusId = delta.prev?.["statusId"];
      const prevName =
        typeof prevStatusId === "string" ? getStatus(host.sql, prevStatusId)?.name : undefined;
      if (prevName?.toLowerCase() !== statusName.toLowerCase()) {
        for (const rid of recipientsFor("status", { assigneeId: facts.task.assigneeId, creatorId: facts.task.createdBy }, actorId)) {
          sendNotification(host, t, "status", facts, rid, actorId, { statusName });
        }
      }
    }
    return;
  }

  if (delta.entity === "comment" && delta.op === "create") {
    const taskId = (delta.taskId ?? (data["taskId"] as string | undefined)) ?? undefined;
    if (taskId === undefined) return;
    const facts = loadTaskFacts(host.sql, taskId);
    if (facts === null) return;
    const commentBody = String(data["body"] ?? "");
    // Whoever this same change passed the turn to reads the comment in their
    // "Your turn" email, so they aren't sent it twice.
    const toldByTurn = turnEmailRecipient(host.sql, t, taskId, actorId, facts);
    for (const rid of recipientsFor("comment", { assigneeId: facts.task.assigneeId, creatorId: facts.task.createdBy }, actorId)) {
      if (rid === toldByTurn) continue;
      sendNotification(host, t, "comment", facts, rid, actorId, { commentBody });
    }
  }
}

/** The actor's latest comment on the task in this turn: the note that came with a pass. */
function turnCommentBody(t: Turn, taskId: string, actorId: string): string | null {
  let body: string | null = null;
  for (const { delta } of t.entries) {
    if (delta.entity !== "comment" || delta.op !== "create" || delta.actorUserId !== actorId) continue;
    const owner = (delta as AutomationDelta).taskId ?? (delta.data?.["taskId"] as string | undefined);
    if (owner === taskId) body = String(delta.data?.["body"] ?? "");
  }
  return body;
}

/**
 * Who this turn's changes send a "Your turn" email to for the task, or null.
 * Mirrors the turn branch of notifyForDelta, including the preference gate,
 * so a comment is only held back from someone who really gets that email.
 */
function turnEmailRecipient(
  sql: SqlStorage,
  t: Turn,
  taskId: string,
  actorId: string,
  facts: TaskFacts
): string | null {
  if (facts.task.closedAt !== null) return null;
  let recipient: string | null = null;
  for (const { delta } of t.entries) {
    if (delta.entity !== "task" || delta.op !== "update" || delta.id !== taskId) continue;
    if (delta.actorUserId !== actorId) continue;
    const data = delta.data ?? {};
    if (!("waitingOn" in data)) continue;
    const newWaitingOn = (data["waitingOn"] as string | null) ?? null;
    if ("assigneeId" in data && data["assigneeId"] === newWaitingOn) continue;
    recipient = newWaitingOn === actorId ? null : newWaitingOn;
  }
  if (recipient === null) return null;
  return readNotificationPrefs(sql, recipient)[PREF_KEY.turn] ? recipient : null;
}

/**
 * Resolve one recipient, gate on their prefs and a real email, render the
 * template and enqueue a kind:"email" side effect. Dry-run is applied
 * transitively by the queue consumer (EMAIL_DRY_RUN).
 */
function sendNotification(
  host: WorkspaceHost,
  t: Turn,
  kind: NotifyKind,
  facts: TaskFacts,
  recipientId: string,
  actorId: string,
  extra: { statusName?: string; commentBody?: string }
): void {
  const { sql, env } = host;
  const recipient = userById(sql, recipientId);
  // No user, deactivated, or no real (non-placeholder) email => skip.
  if (recipient === null || recipient.deactivated || !hasRealEmail(recipient.email)) return;

  // Space gate: a stakeholder (task creator / assignee) who can no longer
  // see the task's space — removed from a private space's membership — must
  // not be emailed its titles, statuses or comment bodies. Owners/admins
  // pass unconditionally via canSeeSpace's privileged short-circuit. A
  // space row that has gone missing is treated as private (fail closed).
  if (!isPrivilegedRole(recipient.role)) {
    const visibility =
      sql
        .exec<{ visibility: string }>("SELECT visibility FROM spaces WHERE id = ?", facts.space.id)
        .toArray()[0]?.visibility ?? "private";
    const access = {
      visibility: visibility === "private" ? ("private" as const) : ("workspace" as const),
      isMember: isSpaceMember(sql, facts.space.id, recipientId),
    };
    if (!canSeeSpace(recipient.role, access)) return;
  }

  const prefs = readNotificationPrefs(sql, recipientId);
  if (!prefs[PREF_KEY[kind]]) return;

  const actor = userById(sql, actorId);
  const rendered = renderNotification(kind, {
    taskTitle: facts.task.title,
    // APP_HOSTNAME is required deployment config; "localhost" keeps links
    // well-formed (never a real domain) if a deployment forgets to set it.
    taskUrl: taskUrl(env.APP_HOSTNAME ?? "localhost", facts.task.id),
    actorName: actor?.name ?? "Someone",
    ...(extra.statusName !== undefined ? { statusName: extra.statusName } : {}),
    ...(extra.commentBody !== undefined ? { commentBody: extra.commentBody } : {}),
  });

  const payload: SideEffectPayload = {
    kind: "email",
    to: [recipient.email],
    cc: [],
    bcc: [],
    subject: rendered.subject,
    body: rendered.body,
    ruleId: notificationTag(kind),
    taskId: facts.task.id,
  };
  t.enqueue(payload);
}

function flushTurn(host: WorkspaceHost, t: Turn): void {
  broadcastDeltas(host, t.scopedBroadcastable());

  // Queues' sendBatch caps at 100 messages / 256KB, and each message at
  // 128KB. A single bulk operation (e.g. a bulk status change firing a
  // webhook rule) can enqueue far more than that in one turn, and one big
  // task description can blow the per-message cap, so chunkSideEffects
  // truncates oversized payloads and chunks on both batch limits rather than
  // let sendBatch throw the whole chunk away. Anything that still never
  // reaches the queue gets an ok:false run-log row, because the engine
  // already logged it as "queued".
  const chunks = chunkSideEffects(t.sideEffects, (payload, bytes) =>
    recordEnqueueFailures(
      host,
      [payload],
      `not sent: payload is ${bytes} bytes even after truncation, over the ${SIDE_EFFECTS_MESSAGE_BYTES}-byte queue message budget`
    )
  );
  for (const chunk of chunks) {
    const batch = chunk.map((body) => ({ body }));
    host.ctx.waitUntil(
      host.env.SIDE_EFFECTS.sendBatch(batch).catch((err: unknown) => {
        console.error("side effect enqueue failed", { messages: chunk.length }, err);
        recordEnqueueFailures(
          host,
          chunk,
          `not sent: queue rejected the batch (${err instanceof Error ? err.message : String(err)})`
        );
      })
    );
  }

  // Cheap indexed MIN; only re-arms when an automation queued a new job.
  const { next } = host.sql
    .exec<{ next: number | null }>("SELECT MIN(run_at) AS next FROM scheduled_jobs")
    .one();
  if (next !== null && next !== host.armedAlarm) host.ctx.waitUntil(host.armAlarm());
}

/**
 * Same ok:false row the queue consumer writes for a failed delivery, for
 * side effects that never made it onto the queue at all. Only automation
 * payloads have a rule to log against; notification emails (ruleId
 * "notify:*") get the console line alone. An emailed comment that never
 * reached the queue is marked failed on its card, in a turn of its own
 * because this can run while the turn that wrote it is still flushing.
 */
function recordEnqueueFailures(host: WorkspaceHost, payloads: readonly unknown[], detail: string): void {
  for (const payload of payloads) {
    const p = payload as { kind?: unknown; ruleId?: unknown; taskId?: unknown; url?: unknown; commentId?: unknown };
    if (p.kind === "email-reply" && typeof p.commentId === "string") {
      const commentId = p.commentId;
      host.ctx.waitUntil(Promise.resolve().then(() => markEmailReply(host, commentId, "failed")));
      continue;
    }
    if (p.kind !== "webhook" && p.kind !== "email") continue;
    if (typeof p.ruleId !== "string" || typeof p.taskId !== "string") continue;
    if (p.ruleId.startsWith("notify:")) continue;
    const target = p.kind === "webhook" ? `webhook ${String(p.url)}` : "email";
    recordDeliveryFailure(host.sql, {
      ruleId: p.ruleId,
      taskId: p.taskId,
      kind: p.kind,
      detail: `${target} ${detail}`,
    });
  }
}
