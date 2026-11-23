import type {
  Actor,
  Attachment,
  BulkResult,
  BulkUpdateInput,
  Comment,
  CreateTaskInput,
  Handoff,
  MoveTaskInput,
  Status,
  Subtask,
  Task,
  UpdateTaskInput,
} from "@flow/shared";
import type { SideEffectPayload } from "./automation/types.js";
import {
  type CreateAttachmentInput,
  type ParsedCommentInput,
  type ParsedSubtaskInput,
  type ParsedToggleInput,
  type SetAttachmentDriveStorageInput,
  TASK_DIFF_KEYS,
  type WorkspaceHost,
  assertListWritable,
  assertSpaceWritable,
  assertTaskWritable,
  emailReplyTarget,
  getAttachment,
  handoffValues,
  humanAssigner,
  insertTaskRow,
  normalizeTags,
  prevOf,
  requireListRow,
  requirePrivileged,
  requireSubtask,
  requireTaskRow,
  spaceIdForTask,
  sqlPatch,
  taskRow,
} from "./db-helpers.js";
import { replySubject, type EmailReplyTarget } from "./email-intake.js";
import { handoffStateForStatusMove, handoffTurnHolder } from "./handoffs.js";
import { id } from "./id.js";
import {
  columnHasCollapsed,
  needsRebalance,
  nextSubtaskPosition,
  nextTaskPosition,
  rebalanceTaskColumn,
} from "./position.js";
import { type CommentRow, toAttachment, tagsText, toComment, toSubtask, toTask } from "./rows.js";
import { wakesOnComment } from "./snooze.js";
import { getStatus, listStatuses, openStatus, resolveStatusName } from "./statuses.js";
import { type Turn, diffOf, toActor } from "./turn.js";
import { requireAssignee } from "./users.js";

function impliedHandoff(t: Turn, before: Task, nowClosed: boolean): Handoff | undefined {
  if (before.handoff === null) return undefined;
  const next = handoffStateForStatusMove(before.handoff.state, before.closedAt !== null, nowClosed);
  return next === null ? undefined : { ...before.handoff, state: next, stateChangedAt: t.now };
}

export function createTask(host: WorkspaceHost, input: CreateTaskInput, actor: string | Actor): Task {
  return host.runTaskTurn(toActor(actor), (t) => {
    assertListWritable(host.sql, t.actor, input.listId);
    return applyTaskCreate(host, t, input);
  });
}

export function applyTaskCreate(
  host: WorkspaceHost,
  t: Turn,
  input: CreateTaskInput,
  handoff: Handoff | null = null
): Task {
  const { sql } = host;
  const listRow = requireListRow(sql, input.listId);
  const status =
    input.status === undefined
      ? openStatus(sql, listRow.id)
      : resolveStatusName(sql, listRow.id, input.status);

  requireAssignee(sql, input.assigneeId);
  requireAssignee(sql, input.waitingOn, "waitingOn");
  for (const sub of input.subtasks ?? []) requireAssignee(sql, sub.assigneeId);

  const tags = normalizeTags(input.tags ?? []);
  const taskId = id("tk_");
  const assigneeId = input.assigneeId ?? null;
  const assignedBy = humanAssigner(t, assigneeId);
  const task: Task = {
    id: taskId,
    listId: listRow.id,
    title: input.title,
    description: input.description,
    statusId: status.id,
    assigneeId,
    assignedBy,
    assignedAt: assignedBy === null ? null : t.now,
    waitingOn:
      status.type === "closed"
        ? null
        : (input.waitingOn ??
          (handoff === null ? null : handoffTurnHolder(handoff.state, assigneeId, handoff.requestedBy))),
    priority: input.priority ?? null,
    dueDate: input.dueDate ?? null,
    startDate: input.startDate ?? null,
    snoozedUntil: null,
    blockedNote: null,
    tags,
    position: nextTaskPosition(sql, listRow.id, status.id),
    createdBy: t.actor.userId,
    createdAt: t.now,
    updatedAt: t.now,
    closedAt: status.type === "closed" ? t.now : null,
    clickupId: null,
    handoff,
  };

  insertTaskRow(sql, task);
  t.emit("create", "task", taskId, task as unknown as Record<string, unknown>);
  t.audit("task.create", taskId, { listId: task.listId, title: task.title });

  for (const sub of input.subtasks ?? []) {
    applySubtaskCreate(host, t, {
      taskId,
      title: sub.title,
      assigneeId: sub.assigneeId ?? null,
      dueDate: null,
    });
  }
  return task;
}

export function updateTask(host: WorkspaceHost, input: UpdateTaskInput, actor: string | Actor): Task {
  return host.runTaskTurn(toActor(actor), (t) => {
    assertTaskWritable(host.sql, t.actor, input.taskId);
    return applyTaskUpdate(host, t, input, "task.update");
  });
}

export function applyTaskUpdate(
  host: WorkspaceHost,
  t: Turn,
  input: UpdateTaskInput,
  action: string,
  explicitHandoff?: Handoff
): Task {
  const { sql } = host;
  const row = requireTaskRow(sql, input.taskId);
  const before = toTask(row);
  let handoff = explicitHandoff;

  const p = sqlPatch();
  p.setIf(input.title, before.title, "title");
  p.setIf(input.description, before.description, "description");
  if (input.assigneeId !== undefined && (input.assigneeId ?? null) !== before.assigneeId) {
    requireAssignee(sql, input.assigneeId);
    const assigneeId = input.assigneeId ?? null;
    const assignedBy = humanAssigner(t, assigneeId);
    p.set("assignee_id", assigneeId);
    p.set("assigned_by", assignedBy);
    p.set("assigned_at", assignedBy === null ? null : t.now);
  }
  if (input.waitingOn !== undefined) requireAssignee(sql, input.waitingOn, "waitingOn");
  let endsClosed = before.closedAt !== null;
  p.setNullable(input.priority, before.priority, "priority");
  p.setNullable(input.dueDate, before.dueDate, "due_date");
  p.setNullable(input.startDate, before.startDate, "start_date");
  p.setNullable(input.snoozedUntil, before.snoozedUntil, "snoozed_until");
  p.setNullable(input.blockedNote, before.blockedNote, "blocked_note");
  if (input.tags !== undefined) {
    const tags = normalizeTags(input.tags);
    if (JSON.stringify(tags) !== JSON.stringify(before.tags)) {
      p.set("tags", JSON.stringify(tags));
      p.set("tags_text", tagsText(tags));
    }
  }
  if (input.status !== undefined) {
    const status = resolveStatusName(sql, before.listId, input.status);
    if (status.id !== before.statusId) {
      p.set("status_id", status.id);
      if (status.type === "closed" && before.closedAt === null) p.set("closed_at", t.now);
      else if (status.type !== "closed" && before.closedAt !== null) p.set("closed_at", null);
      endsClosed = status.type === "closed";
      p.set("position", nextTaskPosition(sql, before.listId, status.id));
      if (handoff === undefined) handoff = impliedHandoff(t, before, status.type === "closed");
    }
  }

  const finalAssigneeId = input.assigneeId !== undefined ? (input.assigneeId ?? null) : before.assigneeId;
  const finalHandoff = handoff ?? before.handoff;
  const assigneeChanged = finalAssigneeId !== before.assigneeId;
  const handoffMoved = finalHandoff !== null && finalHandoff.state !== before.handoff?.state;
  let wantedWaitingOn = before.waitingOn;
  if (input.waitingOn !== undefined) {
    wantedWaitingOn = input.waitingOn ?? null;
  } else if (finalHandoff !== null && (handoffMoved || assigneeChanged)) {
    wantedWaitingOn = handoffTurnHolder(finalHandoff.state, finalAssigneeId, finalHandoff.requestedBy);
  } else if (assigneeChanged) {
    wantedWaitingOn = null;
  }
  const nextWaitingOn = endsClosed ? null : wantedWaitingOn;
  if (nextWaitingOn !== before.waitingOn) p.set("waiting_on", nextWaitingOn);

  if (input.turnNote !== undefined && (nextWaitingOn === null || nextWaitingOn === before.waitingOn)) {
    throw new Error(
      nextWaitingOn === null
        ? "turnNote needs waitingOn set to a person in the same update (and the task left open)."
        : `The turn is already on ${nextWaitingOn}, so there is nothing to pass. Use a comment to add a note.`
    );
  }
  if (handoff !== undefined && JSON.stringify(handoff) !== JSON.stringify(before.handoff)) {
    const [requestedBy, state, returnFormat, context, stateChangedAt] = handoffValues(handoff);
    p.set("handoff_requested_by", requestedBy);
    p.set("handoff_state", state);
    p.set("handoff_return", returnFormat);
    p.set("handoff_context", context);
    p.set("handoff_state_changed_at", stateChangedAt);
  }

  if (p.sets.length === 0) return before;

  p.set("updated_at", t.now);
  sql.exec(`UPDATE tasks SET ${p.sets.join(", ")} WHERE id = ?`, ...p.params, before.id);

  const after = toTask(requireTaskRow(sql, before.id));
  const patch = diffOf(
    before as unknown as Record<string, unknown>,
    after as unknown as Record<string, unknown>,
    TASK_DIFF_KEYS
  );
  patch.updatedAt = after.updatedAt;
  t.emit("update", "task", after.id, patch, { prev: prevOf(before as unknown as Record<string, unknown>, patch) });
  t.audit(action, after.id, patch);
  if (input.turnNote !== undefined) applyCommentCreate(host, t, { taskId: after.id, body: input.turnNote });
  return after;
}

export function moveTask(host: WorkspaceHost, input: MoveTaskInput, actor: string | Actor): Task {
  return host.runTaskTurn(toActor(actor), (t) => {
    assertTaskWritable(host.sql, t.actor, input.taskId);
    if (input.listId !== undefined) assertListWritable(host.sql, t.actor, input.listId);
    return applyTaskMove(host, t, input, "task.move");
  });
}

export function applyTaskMove(
  host: WorkspaceHost,
  t: Turn,
  input: MoveTaskInput,
  action: string
): Task {
  const { sql } = host;
  const row = requireTaskRow(sql, input.taskId);
  const before = toTask(row);
  const targetListId = input.listId ?? before.listId;
  if (input.listId !== undefined) requireListRow(sql, input.listId);

  let status: Status;
  if (input.status !== undefined) {
    status = resolveStatusName(sql, targetListId, input.status);
  } else if (targetListId !== before.listId) {
    const old = getStatus(sql, before.statusId);
    const candidates = listStatuses(sql, targetListId);
    status =
      (old ? candidates.find((s) => s.name.toLowerCase() === old.name.toLowerCase()) : undefined) ??
      openStatus(sql, targetListId);
  } else {
    status = getStatus(sql, before.statusId) ?? openStatus(sql, targetListId);
  }

  let position: number;
  if (input.position !== undefined) {
    position = input.position;
  } else {
    if (columnHasCollapsed(sql, targetListId, status.id)) {
      rebalanceTaskColumn(sql, targetListId, status.id);
    }
    position = nextTaskPosition(sql, targetListId, status.id);
  }

  const closedAt = status.type === "closed" ? (before.closedAt ?? t.now) : null;
  const nextHandoff = impliedHandoff(t, before, status.type === "closed");
  if (nextHandoff !== undefined) {
    const [, state, , , stateChangedAt] = handoffValues(nextHandoff);
    sql.exec(
      "UPDATE tasks SET handoff_state = ?, handoff_state_changed_at = ?, waiting_on = ? WHERE id = ?",
      state,
      stateChangedAt,
      handoffTurnHolder(nextHandoff.state, before.assigneeId, nextHandoff.requestedBy),
      before.id
    );
  }

  sql.exec(
    `UPDATE tasks SET list_id = ?, status_id = ?, position = ?, closed_at = ?, updated_at = ?,
       waiting_on = CASE WHEN ? = 1 THEN NULL ELSE waiting_on END
     WHERE id = ?`,
    targetListId,
    status.id,
    position,
    closedAt,
    t.now,
    status.type === "closed" ? 1 : 0,
    before.id
  );

  const neighbours = sql
    .exec<{ prev: number | null; next: number | null }>(
      `SELECT (SELECT MAX(position) FROM tasks WHERE list_id = ? AND status_id = ? AND position < ?) AS prev,
              (SELECT MIN(position) FROM tasks WHERE list_id = ? AND status_id = ? AND position > ?) AS next`,
      targetListId,
      status.id,
      position,
      targetListId,
      status.id,
      position
    )
    .one();
  if (needsRebalance(neighbours.prev, position) || needsRebalance(position, neighbours.next)) {
    rebalanceTaskColumn(sql, targetListId, status.id);
  }

  const after = toTask(requireTaskRow(sql, before.id));
  const patch = diffOf(
    before as unknown as Record<string, unknown>,
    after as unknown as Record<string, unknown>,
    TASK_DIFF_KEYS
  );
  if (Object.keys(patch).length === 0) return after;
  patch.updatedAt = after.updatedAt;
  t.emit("update", "task", after.id, patch, { prev: prevOf(before as unknown as Record<string, unknown>, patch) });
  t.audit(action, after.id, patch);
  return after;
}

export function bulkUpdate(
  host: WorkspaceHost,
  input: BulkUpdateInput,
  actor: string | Actor
): BulkResult {
  return host.runTurn(toActor(actor), (t) => {
    const results: BulkResult["results"] = [];
    for (const update of input.updates) {
      try {
        assertTaskWritable(host.sql, t.actor, update.taskId);
        const task = applyTaskUpdate(host, t, update, "task.bulk_update");
        results.push({ taskId: task.id, ok: true, error: null });
      } catch (err) {
        results.push({
          taskId: update.taskId ?? null,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { results };
  });
}

export function deleteTask(
  host: WorkspaceHost,
  taskId: string,
  actor: string | Actor
): { ok: true; r2Keys: string[] } {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    const row = requireTaskRow(sql, taskId);
    const spaceId = spaceIdForTask(sql, taskId);
    assertSpaceWritable(sql, t.actor, spaceId);
    const subtaskIds = sql
      .exec<{ id: string }>("SELECT id FROM subtasks WHERE task_id = ?", taskId)
      .toArray()
      .map((r) => r.id);
    const r2Keys = sql
      .exec<{ r2_key: string }>("SELECT r2_key FROM attachments WHERE task_id = ?", taskId)
      .toArray()
      .map((r) => r.r2_key);
    for (const r2Key of r2Keys) {
      sql.exec("INSERT OR IGNORE INTO pending_object_deletes (r2_key, enqueued_at) VALUES (?, ?)", r2Key, t.now);
    }

    sql.exec("DELETE FROM subtasks WHERE task_id = ?", taskId);
    sql.exec("DELETE FROM comments WHERE task_id = ?", taskId);
    sql.exec("DELETE FROM attachments WHERE task_id = ?", taskId);
    sql.exec("DELETE FROM automation_due_fires WHERE task_id = ?", taskId);
    sql.exec("DELETE FROM tasks WHERE id = ?", taskId);

    for (const sid of subtaskIds) t.emit("delete", "subtask", sid, null, { taskId, spaceId });
    t.emit("delete", "task", taskId, null, { spaceId });
    t.audit("task.delete", taskId, { listId: row.list_id, title: row.title });
    return { ok: true, r2Keys } as const;
  });
}

export function clearPendingObjectDeletes(
  sql: SqlStorage,
  r2Keys: string[]
): { ok: true; cleared: number } {
  for (const r2Key of r2Keys) {
    sql.exec("DELETE FROM pending_object_deletes WHERE r2_key = ?", r2Key);
  }
  return { ok: true, cleared: r2Keys.length };
}

export function createSubtask(
  host: WorkspaceHost,
  input: ParsedSubtaskInput,
  actor: string | Actor
): Subtask {
  return host.runTurn(toActor(actor), (t) => {
    assertTaskWritable(host.sql, t.actor, input.taskId);
    return applySubtaskCreate(host, t, {
      taskId: input.taskId,
      title: input.title,
      assigneeId: input.assigneeId ?? null,
      dueDate: input.dueDate ?? null,
      note: input.note ?? null,
    });
  });
}

export function applySubtaskCreate(
  host: WorkspaceHost,
  t: Turn,
  input: { taskId: string; title: string; assigneeId: string | null; dueDate: number | null; note?: string | null }
): Subtask {
  const { sql } = host;
  requireTaskRow(sql, input.taskId);
  requireAssignee(sql, input.assigneeId);
  const assignedBy = humanAssigner(t, input.assigneeId);
  const subtask: Subtask = {
    id: id("sb_"),
    taskId: input.taskId,
    title: input.title,
    done: false,
    assigneeId: input.assigneeId,
    assignedBy,
    assignedAt: assignedBy === null ? null : t.now,
    dueDate: input.dueDate,
    note: input.note ?? null,
    position: nextSubtaskPosition(sql, input.taskId),
    createdAt: t.now,
  };
  sql.exec(
    `INSERT INTO subtasks (id, task_id, title, done, assignee_id, assigned_by, assigned_at,
                           due_date, note, position, created_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    subtask.id,
    subtask.taskId,
    subtask.title,
    subtask.assigneeId,
    subtask.assignedBy,
    subtask.assignedAt,
    subtask.dueDate,
    subtask.note,
    subtask.position,
    subtask.createdAt
  );
  t.emit("create", "subtask", subtask.id, subtask as unknown as Record<string, unknown>, {
    taskId: subtask.taskId,
  });
  t.audit("subtask.create", subtask.id, { taskId: subtask.taskId, title: subtask.title });
  return subtask;
}

export function updateSubtask(
  host: WorkspaceHost,
  input: {
    subtaskId: string;
    title?: string;
    assigneeId?: string | null;
    dueDate?: number | null;
    note?: string | null;
    position?: number;
  },
  actor: string | Actor
): Subtask {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    const before = requireSubtask(sql, input.subtaskId);
    assertTaskWritable(sql, t.actor, before.taskId);
    const p = sqlPatch();
    p.setIf(input.title, before.title, "title");
    if (input.assigneeId !== undefined && (input.assigneeId ?? null) !== before.assigneeId) {
      requireAssignee(sql, input.assigneeId);
      const assigneeId = input.assigneeId ?? null;
      const assignedBy = humanAssigner(t, assigneeId);
      p.set("assignee_id", assigneeId);
      p.set("assigned_by", assignedBy);
      p.set("assigned_at", assignedBy === null ? null : t.now);
    }
    p.setNullable(input.dueDate, before.dueDate, "due_date");
    p.setNullable(input.note, before.note, "note");
    p.setIf(input.position, before.position, "position");
    if (p.sets.length === 0) return before;
    sql.exec(`UPDATE subtasks SET ${p.sets.join(", ")} WHERE id = ?`, ...p.params, before.id);
    const after = requireSubtask(sql, before.id);
    const patch = diffOf(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
      ["title", "assigneeId", "assignedBy", "assignedAt", "dueDate", "note", "position", "done"]
    );
    t.emit("update", "subtask", after.id, patch, { taskId: after.taskId });
    t.audit("subtask.update", after.id, patch);
    return after;
  });
}

export function toggleSubtask(
  host: WorkspaceHost,
  input: ParsedToggleInput,
  actor: string | Actor
): Subtask {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    const before = requireSubtask(sql, input.subtaskId);
    assertTaskWritable(sql, t.actor, before.taskId);
    if (before.done === input.done) return before;
    sql.exec("UPDATE subtasks SET done = ? WHERE id = ?", input.done ? 1 : 0, before.id);
    const after = requireSubtask(sql, before.id);
    t.emit("update", "subtask", after.id, { done: after.done }, { taskId: after.taskId });
    t.audit("subtask.toggle", after.id, { done: after.done, taskId: after.taskId });
    return after;
  });
}

export function deleteSubtask(
  host: WorkspaceHost,
  subtaskId: string,
  actor: string | Actor
): { ok: true } {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    const before = requireSubtask(sql, subtaskId);
    assertTaskWritable(sql, t.actor, before.taskId);
    const spaceId = spaceIdForTask(sql, before.taskId);
    sql.exec("DELETE FROM subtasks WHERE id = ?", subtaskId);
    t.emit("delete", "subtask", subtaskId, null, { taskId: before.taskId, spaceId });
    t.audit("subtask.delete", subtaskId, { taskId: before.taskId });
    return { ok: true } as const;
  });
}

export function createComment(
  host: WorkspaceHost,
  input: ParsedCommentInput,
  actor: string | Actor
): Comment {
  return host.runTurn(toActor(actor), (t) => {
    assertTaskWritable(host.sql, t.actor, input.taskId);
    const reply = input.emailToRequester === true ? requireEmailReply(host, t.actor, input.taskId) : null;
    const comment = applyCommentCreate(host, t, input, reply?.target.to ?? null);
    if (reply !== null) {
      const payload: SideEffectPayload = {
        kind: "email-reply",
        to: reply.target.to,
        alias: reply.target.alias,
        subject: replySubject(reply.title),
        body: comment.body,
        inReplyTo: reply.target.inReplyTo,
        references: reply.target.references,
        taskId: comment.taskId,
        commentId: comment.id,
      };
      t.enqueue(payload);
      t.audit("comment.email_reply", comment.id, { taskId: comment.taskId, to: reply.target.to });
    }
    return comment;
  });
}

function requireEmailReply(
  host: WorkspaceHost,
  actor: Actor,
  taskId: string
): { target: EmailReplyTarget; title: string } {
  if (!mayEmailRequesters(host.sql, actor)) {
    throw new Error(
      "Email replies need an API key allowed to email requesters (PATCH /api/api-keys/:id), and never go over MCP."
    );
  }
  if (host.env.EMAIL_INTAKE_REPLY !== "true") throw new Error("Email replies are turned off.");
  const task = toTask(requireTaskRow(host.sql, taskId));
  const target = emailReplyTarget(host, task);
  if (target === null) {
    throw new Error(`Task ${taskId} has no email sender to reply to.`);
  }
  return { target, title: task.title };
}

function mayEmailRequesters(sql: SqlStorage, actor: Actor): boolean {
  if (actor.via === "ui") return actor.apiKeyId === null;
  if (actor.via !== "api" || actor.apiKeyId === null) return false;
  const row = sql
    .exec<{ can_email_requesters: number; revoked_at: number | null }>(
      "SELECT can_email_requesters, revoked_at FROM api_keys WHERE id = ?",
      actor.apiKeyId
    )
    .toArray()[0];
  return row !== undefined && row.revoked_at === null && row.can_email_requesters === 1;
}

export function applyCommentCreate(
  host: WorkspaceHost,
  t: Turn,
  input: ParsedCommentInput,
  emailTo: string | null = null
): Comment {
  const { sql } = host;
  const tRow = requireTaskRow(sql, input.taskId);
  const comment: Comment = {
    id: id("cm_"),
    taskId: input.taskId,
    authorId: t.actor.userId,
    body: input.body,
    createdAt: t.now,
    via: t.actor.via,
    emailTo,
    emailStatus: emailTo === null ? null : "sending",
  };
  sql.exec(
    `INSERT INTO comments (id, task_id, author_id, body, created_at, via, email_to, email_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    comment.id,
    comment.taskId,
    comment.authorId,
    comment.body,
    comment.createdAt,
    comment.via,
    comment.emailTo,
    comment.emailStatus
  );
  t.emit("create", "comment", comment.id, comment as unknown as Record<string, unknown>, {
    taskId: comment.taskId,
  });
  t.audit("comment.create", comment.id, { taskId: comment.taskId });
  if (wakesOnComment(tRow.snoozed_until ?? null)) {
    applyTaskUpdate(host, t, { taskId: comment.taskId, snoozedUntil: null }, "task.wake");
  }
  return comment;
}

export function deleteComment(
  host: WorkspaceHost,
  commentId: string,
  actor: string | Actor
): { ok: true } {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    const row = sql
      .exec<CommentRow>("SELECT id, task_id, author_id, body, created_at, via, email_to, email_status FROM comments WHERE id = ?", commentId)
      .toArray()[0];
    if (!row) throw new Error(`Comment ${commentId} not found.`);
    assertTaskWritable(sql, t.actor, row.task_id);
    const spaceId = spaceIdForTask(sql, row.task_id);
    sql.exec("DELETE FROM comments WHERE id = ?", commentId);
    t.emit("delete", "comment", commentId, null, { spaceId });
    t.audit("comment.delete", commentId, { taskId: row.task_id });
    return { ok: true } as const;
  });
}

export function createAttachment(
  host: WorkspaceHost,
  input: CreateAttachmentInput,
  actor: string | Actor
): Attachment {
  return host.runTurn(toActor(actor), (t) => {
    requireTaskRow(host.sql, input.taskId);
    assertTaskWritable(host.sql, t.actor, input.taskId);
    return applyAttachmentCreate(host, t, input);
  });
}

export function applyAttachmentCreate(
  host: WorkspaceHost,
  t: Turn,
  input: CreateAttachmentInput
): Attachment {
  const attachment: Attachment = {
    id: input.id ?? id("at_"),
    taskId: input.taskId,
    filename: input.filename,
    r2Key: input.r2Key,
    storageProvider: "r2",
    driveFileId: null,
    driveWebViewLink: null,
    driveDestination: null,
    migrationState: "r2",
    size: input.size,
    mimeType: input.mimeType,
    uploadedBy: t.actor.userId,
    createdAt: t.now,
  };
  host.sql.exec(
    `INSERT INTO attachments (id, task_id, filename, r2_key, size, mime_type, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    attachment.id,
    attachment.taskId,
    attachment.filename,
    attachment.r2Key,
    attachment.size,
    attachment.mimeType,
    attachment.uploadedBy,
    attachment.createdAt
  );
  t.emit("create", "attachment", attachment.id, attachment as unknown as Record<string, unknown>, {
    taskId: attachment.taskId,
  });
  t.audit("attachment.create", attachment.id, {
    taskId: attachment.taskId,
    filename: attachment.filename,
  });
  return attachment;
}

export function setAttachmentDriveStorage(
  host: WorkspaceHost,
  input: SetAttachmentDriveStorageInput,
  actor: string | Actor
): Attachment {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    requirePrivileged(sql, t.actor, "Finalizing Drive attachment storage");
    const before = getAttachment(sql, input.attachmentId);
    if (!before) throw new Error(`Attachment ${input.attachmentId} not found.`);
    if (before.storageProvider === "drive") {
      if (
        before.driveFileId !== input.driveFileId ||
        before.driveWebViewLink !== input.driveWebViewLink ||
        before.driveDestination !== input.driveDestination
      ) {
        throw new Error(`Attachment ${input.attachmentId} already points at a different Drive file.`);
      }
      return before;
    }
    sql.exec(
      `UPDATE attachments
       SET storage_provider = 'drive',
           drive_file_id = ?,
           drive_web_view_link = ?,
           drive_destination = ?,
           migration_state = 'cleanup_pending'
       WHERE id = ?`,
      input.driveFileId,
      input.driveWebViewLink,
      input.driveDestination,
      input.attachmentId
    );
    const after = getAttachment(sql, input.attachmentId);
    if (!after) throw new Error(`Attachment ${input.attachmentId} disappeared after update.`);
    t.emit("update", "attachment", after.id, after as unknown as Record<string, unknown>, {
      taskId: after.taskId,
    });
    t.audit("attachment.storage.drive", after.id, {
      taskId: after.taskId,
      driveFileId: after.driveFileId,
      driveDestination: after.driveDestination,
      migrationState: after.migrationState,
    });
    return after;
  });
}

export function markAttachmentDriveCleanupComplete(
  host: WorkspaceHost,
  attachmentId: string,
  driveFileId: string,
  actor: string | Actor
): Attachment {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    requirePrivileged(sql, t.actor, "Completing Drive attachment cleanup");
    const before = getAttachment(sql, attachmentId);
    if (!before) throw new Error(`Attachment ${attachmentId} not found.`);
    if (before.storageProvider !== "drive" || before.driveFileId !== driveFileId) {
      throw new Error(`Attachment ${attachmentId} does not match Drive file ${driveFileId}.`);
    }
    if (before.migrationState === "complete") return before;
    if (before.migrationState !== "cleanup_pending") {
      throw new Error(`Attachment ${attachmentId} is not awaiting R2 cleanup.`);
    }
    sql.exec("UPDATE attachments SET migration_state = 'complete' WHERE id = ?", attachmentId);
    const after = getAttachment(sql, attachmentId);
    if (!after) throw new Error(`Attachment ${attachmentId} disappeared after cleanup.`);
    t.emit("update", "attachment", after.id, after as unknown as Record<string, unknown>, {
      taskId: after.taskId,
    });
    t.audit("attachment.storage.r2_deleted", after.id, {
      taskId: after.taskId,
      driveFileId,
      r2Key: after.r2Key,
    });
    return after;
  });
}

export function deleteAttachment(
  host: WorkspaceHost,
  attachmentId: string,
  actor: string | Actor
): { ok: true; r2Key: string } {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    const before = getAttachment(sql, attachmentId);
    if (!before) throw new Error(`Attachment ${attachmentId} not found.`);
    assertTaskWritable(sql, t.actor, before.taskId);
    const spaceId = spaceIdForTask(sql, before.taskId);
    sql.exec("INSERT OR IGNORE INTO pending_object_deletes (r2_key, enqueued_at) VALUES (?, ?)", before.r2Key, t.now);
    sql.exec("DELETE FROM attachments WHERE id = ?", attachmentId);
    t.emit("delete", "attachment", attachmentId, null, { spaceId });
    t.audit("attachment.delete", attachmentId, { taskId: before.taskId });
    return { ok: true as const, r2Key: before.r2Key };
  });
}
