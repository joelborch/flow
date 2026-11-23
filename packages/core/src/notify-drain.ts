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

export function executeTurn<T>(
  host: WorkspaceHost,
  actor: Actor,
  fn: (t: Turn) => T,
  silent = false
): T {
  if (host.env.SANDBOX === "true") host.sandboxWrites.take();
  const t = new Turn(host.sql, actor, Date.now(), silent, (entity, entityId, taskId) =>
    spaceIdForDelta(host.sql, entity, entityId, taskId)
  );
  const result = fn(t);
  drainAutomations(host, t);
  drainNotifications(host, t);
  resyncForSpaceMoves(host, t);
  flushTurn(host, t);
  return result;
}

export function executeTaskTurn(host: WorkspaceHost, actor: Actor, fn: (t: Turn) => Task): Task {
  const before = host.runTurn(actor, fn);
  const row = taskRow(host.sql, before.id);
  return row === null ? before : toTask(row);
}

export function getNotificationPrefs(sql: SqlStorage, userId: string): NotificationPref {
  return readNotificationPrefs(sql, userId);
}

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

function drainNotifications(host: WorkspaceHost, t: Turn): void {
  if (t.silent) return;
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
    const toldByTurn = turnEmailRecipient(host.sql, t, taskId, actorId, facts);
    for (const rid of recipientsFor("comment", { assigneeId: facts.task.assigneeId, creatorId: facts.task.createdBy }, actorId)) {
      if (rid === toldByTurn) continue;
      sendNotification(host, t, "comment", facts, rid, actorId, { commentBody });
    }
  }
}

function turnCommentBody(t: Turn, taskId: string, actorId: string): string | null {
  let body: string | null = null;
  for (const { delta } of t.entries) {
    if (delta.entity !== "comment" || delta.op !== "create" || delta.actorUserId !== actorId) continue;
    const owner = (delta as AutomationDelta).taskId ?? (delta.data?.["taskId"] as string | undefined);
    if (owner === taskId) body = String(delta.data?.["body"] ?? "");
  }
  return body;
}

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
  if (recipient === null || recipient.deactivated || !hasRealEmail(recipient.email)) return;

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

  const { next } = host.sql
    .exec<{ next: number | null }>("SELECT MIN(run_at) AS next FROM scheduled_jobs")
    .one();
  if (next !== null && next !== host.armedAlarm) host.ctx.waitUntil(host.armAlarm());
}

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
