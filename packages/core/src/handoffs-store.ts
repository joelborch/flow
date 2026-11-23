import {
  type Actor,
  type Comment,
  type Handoff,
  type HandoffState,
  ListHandoffsInput as ListHandoffsSchema,
  type ListHandoffsInput,
  ReplyHandoffInput as ReplyHandoffSchema,
  type ReplyHandoffInput,
  RequestHandoffInput as RequestHandoffSchema,
  type RequestHandoffInput,
  type Task,
} from "@flow/shared";
import {
  TASK_COLUMNS,
  type WorkspaceHost,
  assertSpaceWritable,
  assertTaskWritable,
  contractInput,
  listUsers,
  requireListRow,
  requireSpace,
  requireTaskRow,
  spaceIdForTask,
  spaceWriteRefusal,
  taskRow,
  userById,
} from "./db-helpers.js";
import { HANDOFF_TAG, OPEN_HANDOFF_STATES, decideHandoffState, handoffStatusMove } from "./handoffs.js";
import { type TaskRowSql, toTask } from "./rows.js";
import { closedStatus, getStatus, openStatus } from "./statuses.js";
import { applyCommentCreate, applyTaskCreate, applyTaskUpdate } from "./task-mutations.js";
import { toActor } from "./turn.js";
import { canSeeSpace, isPrivilegedRole, isSpaceMember, isSystemActor, roleOf, visibleSpaceIds } from "./visibility.js";

export function requestHandoff(
  host: WorkspaceHost,
  input: RequestHandoffInput,
  actor: string | Actor
): Task {
  const req = contractInput(RequestHandoffSchema.safeParse(input), "handoff request");
  return host.runTaskTurn(toActor(actor), (t) => {
    const list = requireListRow(host.sql, req.listId);
    assertSpaceWritable(host.sql, t.actor, list.space_id);
    requireHandoffRecipient(host.sql, t.actor, req.toUserId, list.space_id);
    const contextTaskIds = requireHandoffContext(host.sql, t.actor, req.toUserId, req.contextTaskIds ?? []);

    const handoff: Handoff = {
      requestedBy: t.actor.userId,
      state: "requested",
      returnFormat:
        req.returnFormat === undefined || req.returnFormat.trim() === "" ? null : req.returnFormat,
      contextTaskIds,
      stateChangedAt: t.now,
    };
    const task = applyTaskCreate(
      host,
      t,
      {
        listId: list.id,
        title: req.title,
        description: req.ask,
        assigneeId: req.toUserId,
        dueDate: req.dueDate ?? null,
        tags: [HANDOFF_TAG],
      },
      handoff
    );
    t.audit("handoff.request", task.id, { toUserId: req.toUserId, contextTaskIds });
    return task;
  });
}

export function replyHandoff(
  host: WorkspaceHost,
  input: ReplyHandoffInput,
  actor: string | Actor
): { task: Task; comment: Comment | null } {
  const reply = contractInput(ReplyHandoffSchema.safeParse(input), "handoff reply");
  const out = host.runTurn(toActor(actor), (t) => {
    const before = toTask(requireTaskRow(host.sql, reply.taskId));
    assertTaskWritable(host.sql, t.actor, before.id);
    const handoff = before.handoff;
    if (handoff === null) {
      throw new Error(
        `Task ${before.id} is not a handoff, so it has no handoff state. ` +
          `Use createComment or updateTask for an ordinary task.`
      );
    }

    const decision = decideHandoffState(handoff.state, reply.state, reply.message !== undefined, {
      recipient: before.assigneeId !== null && before.assigneeId === t.actor.userId,
      requester: handoff.requestedBy === t.actor.userId,
      privileged: isSystemActor(t.actor) || isPrivilegedRole(roleOf(host.sql, t.actor.userId)),
    });
    if (!decision.ok) throw new Error(handoffRefusal(host.sql, decision.reason, before, handoff));
    const next = decision.next;
    const changed = next !== handoff.state;
    const status = changed ? handoffStatusName(host.sql, before, next) : undefined;

    const comment =
      reply.message === undefined
        ? null
        : applyCommentCreate(host, t, { taskId: before.id, body: reply.message });
    if (changed) {
      applyTaskUpdate(
        host,
        t,
        { taskId: before.id, ...(status === undefined ? {} : { status }) },
        "handoff.reply",
        { ...handoff, state: next, stateChangedAt: t.now }
      );
      t.audit("handoff.state", before.id, { from: handoff.state, to: next });
    }
    return { taskId: before.id, comment };
  });
  return { task: toTask(requireTaskRow(host.sql, out.taskId)), comment: out.comment };
}

export function listHandoffs(
  sql: SqlStorage,
  input: ListHandoffsInput,
  actor: string | Actor
): Task[] {
  const query = contractInput(ListHandoffsSchema.safeParse(input), "handoff query");
  const userId = toActor(actor).userId;
  const states = [...new Set(query.states ?? OPEN_HANDOFF_STATES)];
  const column = query.direction === "outgoing" ? "handoff_requested_by" : "assignee_id";

  const where = [`${column} = ?`, `handoff_state IN (${states.map(() => "?").join(", ")})`];
  const params: SqlStorageValue[] = [userId, ...states];
  if (query.states === undefined) where.push("closed_at IS NULL");
  const visible = visibleSpaceIds(sql, userId);
  if (visible !== null) {
    if (visible.size === 0) return [];
    where.push(
      `list_id IN (SELECT id FROM lists WHERE space_id IN (${[...visible].map(() => "?").join(", ")}))`
    );
    params.push(...visible);
  }
  return sql
    .exec<TaskRowSql>(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE handoff_state IS NOT NULL AND ${where.join(" AND ")}
       ORDER BY handoff_state_changed_at DESC, id DESC LIMIT ?`,
      ...params,
      query.limit
    )
    .toArray()
    .map(toTask);
}

function requireHandoffRecipient(sql: SqlStorage, actor: Actor, toUserId: string, spaceId: string): void {
  const recipient = userById(sql, toUserId);
  if (recipient === null) {
    const teammates = listUsers(sql)
      .filter((u) => !u.deactivated && u.id !== actor.userId)
      .map((u) => `${u.id} ("${u.name}")`);
    throw new Error(
      `Unknown toUserId "${toUserId}". Active teammates: ${teammates.join(", ") || "none"}.`
    );
  }
  if (recipient.id === actor.userId) {
    throw new Error(
      `You can't hand off to yourself (${recipient.id}). Pick a teammate, or create an ordinary task.`
    );
  }
  if (recipient.deactivated) {
    throw new Error(
      `${recipient.name} (${recipient.id}) is deactivated and can't receive handoffs. Pick an active teammate.`
    );
  }
  const space = requireSpace(sql, spaceId);
  const canSee = canSeeSpace(recipient.role, {
    visibility: space.visibility,
    isMember: isSpaceMember(sql, space.id, recipient.id),
  });
  if (!canSee) {
    throw new Error(
      `${recipient.name} (${recipient.id}) can't see space ${space.id} ("${space.name}"), ` +
        `so they couldn't open this handoff. File it in a list they can see, ` +
        `or ask an owner/admin to add them to the space.`
    );
  }
}

function requireHandoffContext(
  sql: SqlStorage,
  actor: Actor,
  recipientId: string,
  taskIds: readonly string[]
): string[] {
  const recipient = userById(sql, recipientId);
  const out: string[] = [];
  for (const taskId of taskIds) {
    if (out.includes(taskId)) continue;
    if (taskRow(sql, taskId) === null) {
      throw new Error(`Context task ${taskId} not found; contextTaskIds must name existing tasks.`);
    }
    const spaceId = spaceIdForTask(sql, taskId);
    const refusal = spaceWriteRefusal(sql, actor, spaceId);
    if (refusal !== null) {
      throw new Error(`Context task ${taskId} isn't visible to you. ${refusal}`);
    }
    if (recipient !== null && spaceId !== null) {
      const space = requireSpace(sql, spaceId);
      const recipientSees = canSeeSpace(recipient.role, {
        visibility: space.visibility,
        isMember: isSpaceMember(sql, space.id, recipient.id),
      });
      if (!recipientSees) {
        throw new Error(
          `Context task ${taskId} is in space ${space.id} ("${space.name}"), which ${recipient.name} ` +
            `can't see, so their agent couldn't read it. Leave it out, or ask an owner/admin to add them to that space.`
        );
      }
    }
    out.push(taskId);
  }
  return out;
}

function handoffStatusName(sql: SqlStorage, task: Task, next: HandoffState): string | undefined {
  const closed = getStatus(sql, task.statusId)?.type === "closed";
  switch (handoffStatusMove(next, closed)) {
    case "close":
      return closedStatus(sql, task.listId).name;
    case "reopen":
      return openStatus(sql, task.listId).name;
    case null:
      return undefined;
  }
}

function handoffRefusal(
  sql: SqlStorage,
  reason: "outsider" | "requester_state",
  task: Task,
  handoff: Handoff
): string {
  const label = (userId: string | null): string => {
    if (userId === null) return "nobody; the task is unassigned";
    const user = userById(sql, userId);
    return user === null ? userId : `${user.name} (${user.id})`;
  };
  const recipient = label(task.assigneeId);
  if (reason === "outsider") {
    return (
      `Only handoff ${task.id}'s recipient (${recipient}) or requester (${label(handoff.requestedBy)}) ` +
      `can reply to it; owners and admins can too. Use createComment to add a note without replying.`
    );
  }
  return (
    `As the requester you can only withdraw handoff ${task.id} (state "declined"), and only while it's still open. ` +
    `The recipient (${recipient}) moves it through requested, working, needs_input and done, ` +
    `and owners and admins can set any state. To answer a needs_input handoff, send a message ` +
    `without a state; that hands it back as "working".`
  );
}
