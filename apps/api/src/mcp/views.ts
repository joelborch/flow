/**
 * Result shaping. Tools return compact JSON with names where the DO returns
 * ids, because an agent that has to make a second call to learn what
 * `st_7f2a` means will make that call on every single result.
 *
 * Pure functions over a `NameIndex` so they are trivially testable.
 *
 * The result *types* are inferred from the Zod schemas in `schemas-out.ts` —
 * the same schemas the tools declare as their `outputSchema` — so a shape
 * declared to clients and the shape actually built here cannot drift.
 */
import type { Comment, Subtask, Task, TaskRow, User } from "@flow/shared";
import type { NameIndex, WorkspaceMap } from "./context.js";
import type {
  AttachmentView,
  CommentView,
  ConciseTaskView,
  SubtaskView,
  TaskDetailView,
  TaskRowOut,
  TaskView,
  UserView,
  WorkspaceMapView,
} from "./schemas-out.js";

export type { ConciseTaskView, TaskDetailView, TaskRowOut, TaskView };

export function taskView(row: TaskRow | Task, names: NameIndex): TaskView {
  return {
    id: row.id,
    title: row.title,
    status: names.statusName(row.statusId),
    list: names.listName(row.listId),
    listId: row.listId,
    space: names.spaceNameForList(row.listId),
    assignee: names.userName(row.assigneeId),
    assigneeId: row.assigneeId,
    priority: row.priority,
    dueDate: row.dueDate,
    tags: row.tags,
    updatedAt: row.updatedAt,
  };
}

/**
 * The response-budget row: id, title, status, list, assignee, dueDate,
 * priority and nothing else. A 200-row search in this shape is roughly a third
 * the tokens of the full one, and every field an agent needs to pick the task
 * it wants — then `flow_get_task` for the rest — is still here.
 */
export function conciseTaskView(row: TaskRow | Task, names: NameIndex): ConciseTaskView {
  return {
    id: row.id,
    title: row.title,
    status: names.statusName(row.statusId),
    list: names.listName(row.listId),
    assignee: names.userName(row.assigneeId),
    dueDate: row.dueDate,
    priority: row.priority,
  };
}

/** One row in whichever shape the caller asked for. */
export function taskRowView(
  row: TaskRow | Task,
  names: NameIndex,
  detailed: boolean
): TaskRowOut {
  return detailed ? taskView(row, names) : conciseTaskView(row, names);
}

/** The full card: everything in `TaskView` plus the long fields. */
export function taskDetailView(task: Task, names: NameIndex): TaskDetailView {
  return {
    ...taskView(task, names),
    description: task.description,
    startDate: task.startDate,
    closedAt: task.closedAt,
    // So an agent can tell "nobody is working on this" from "somebody
    // deliberately parked this until Monday".
    snoozedUntil: task.snoozedUntil ?? null,
    blockedNote: task.blockedNote ?? null,
  };
}

export function subtaskView(sub: Subtask, names: NameIndex): SubtaskView {
  return {
    id: sub.id,
    title: sub.title,
    done: sub.done,
    assignee: names.userName(sub.assigneeId),
    dueDate: sub.dueDate,
  };
}

export function commentView(comment: Comment, names: NameIndex): CommentView {
  return {
    id: comment.id,
    author: names.userName(comment.authorId),
    body: comment.body,
    createdAt: comment.createdAt,
  };
}

export function attachmentView(att: {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
}): AttachmentView {
  return { id: att.id, filename: att.filename, size: att.size, mimeType: att.mimeType };
}

/**
 * `detailed` adds email and role. Concise keeps id and name, which is all the
 * other tools consume — `assigneeId` wants an id, a report wants a name.
 */
export function userView(user: User, detailed = true): UserView {
  if (!detailed) return { id: user.id, name: user.name };
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    ...(user.deactivated ? { deactivated: true } : {}),
  };
}

/**
 * The orientation payload: every valid space, list, status name, member and tag
 * in one call. Archived spaces and lists are dropped unless asked for, since a
 * status name from an archived list is not somewhere an agent should be filing
 * work.
 *
 * `detailed` adds per-list open-task counts and full member records; the
 * concise default keeps only what the other tools take as arguments.
 */
export function workspaceMapView(
  map: WorkspaceMap,
  options: { includeArchived: boolean; tags: string[] | null; detailed: boolean }
): WorkspaceMapView {
  const spaces = map.spaces
    .filter((space) => options.includeArchived || !space.archived)
    .map((space) => ({
      id: space.id,
      name: space.name,
      ...(space.archived ? { archived: true } : {}),
      lists: space.lists
        .filter((list) => options.includeArchived || !list.archived)
        .map((list) => ({
          id: list.id,
          name: list.name,
          ...(list.archived ? { archived: true } : {}),
          ...(options.detailed ? { openTasks: list.openTasks } : {}),
          statuses: list.statuses.map((status) => ({
            name: status.name,
            type: status.type,
          })),
        })),
    }));

  return {
    seq: map.seq,
    spaces,
    users: map.users.map((user) => userView(user, options.detailed)),
    ...(options.tags === null ? {} : { tags: options.tags }),
    legend: {
      status:
        "pass status NAMES (e.g. \"In Progress\") to create/update/move, matched case-insensitively per list",
      ids: "listId for creating and moving, assigneeId for assigning, taskId for everything else",
      timestamps: "epoch milliseconds",
    },
  };
}

/** Distinct tags in use across the workspace, sorted. */
export function distinctTags(tasks: readonly { tags: string[] }[]): string[] {
  const seen = new Set<string>();
  for (const task of tasks) for (const tag of task.tags) seen.add(tag);
  return [...seen].sort((a, b) => a.localeCompare(b));
}
