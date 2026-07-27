// Optimistic mutations. Each one patches local state, fires the REST call, and
// then lets the authoritative answer overwrite the guess. A failed call rolls
// the entity back to its pre-mutation value and posts a toast.
import type {
  Comment, CreateListInput, CreateSpaceInput, List, MoveTaskInput, Space, Status, Subtask,
  Task, TaskDetail, CreateTaskInput, UpdateTaskInput,
} from "@flow/shared";
import { api, ApiError } from "../lib/api.js";
import { append } from "../lib/frac.js";
import { toast } from "../lib/toast.js";
import { mergeTaskDetail } from "./apply.js";
import {
  beginPending, comments, endPending, findStatus, flush, getSubtask, listById, listBucket,
  lists, me, openStatus, putSubtask, putTask, removeSubtask, removeTask, spaces, subtasks,
  taskIndex, type StoreTask,
} from "./state.js";

function rid(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_tmp${Date.now().toString(36)}${rand}`;
}

function reason(err: unknown): string {
  if (err instanceof ApiError) return err.status === 0 ? "no connection" : err.message;
  return err instanceof Error ? err.message : "unknown error";
}

/** Resolve an optimistic task mutation: server value wins, failure rolls back. */
function settleTask(taskId: string, result: Task | null, err?: unknown): void {
  if (result) putTask(result);
  const target = endPending(taskId, err !== undefined);
  if (target !== undefined) {
    if (target === null) removeTask(taskId);
    else putTask(target);
  }
  flush();
  if (err !== undefined) toast(`Couldn't save — ${reason(err)}`, "error");
}

function positionAtEnd(listId: string, statusId: string): number {
  const positions: number[] = [];
  for (const t of listBucket(listId).peek()) if (t.statusId === statusId) positions.push(t.position);
  return append(positions);
}

export async function createTask(input: CreateTaskInput): Promise<void> {
  const list = listById.value.get(input.listId);
  if (!list) {
    toast("That list is gone — reload to catch up", "error");
    return;
  }
  const status = (input.status ? findStatus(list, input.status) : undefined) ?? openStatus(list);
  const now = Date.now();
  const tempId = rid("tk");
  const optimistic: Task = {
    id: tempId,
    listId: input.listId,
    title: input.title,
    description: input.description ?? "",
    statusId: status.id,
    assigneeId: input.assigneeId ?? null,
    priority: input.priority ?? null,
    dueDate: input.dueDate ?? null,
    startDate: input.startDate ?? null,
    snoozedUntil: null,
    blockedNote: null,
    tags: input.tags ?? [],
    position: positionAtEnd(input.listId, status.id),
    createdBy: me.value?.id ?? "us_unknown",
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    clickupId: null,
  };

  beginPending(tempId);
  putTask(optimistic);
  flush();

  if (input.subtasks && input.subtasks.length > 0) {
    let pos = 0;
    for (const s of input.subtasks) {
      putSubtask({
        id: rid("sb"),
        taskId: tempId,
        title: s.title,
        done: false,
        assigneeId: s.assigneeId ?? null,
        dueDate: null,
        position: pos++,
        createdAt: now,
      });
    }
    flush();
  }

  try {
    const created = await api.createTask(input);
    // The server assigns the real id; drop the placeholder and its subtasks.
    for (const s of subtasks.value.get(tempId) ?? []) removeSubtask(s.id);
    removeTask(tempId);
    putTask(created);
    endPending(tempId, false);
    flush();
  } catch (err) {
    for (const s of subtasks.value.get(tempId) ?? []) removeSubtask(s.id);
    settleTask(tempId, null, err);
  }
}

export async function updateTask(input: UpdateTaskInput): Promise<void> {
  const prev = taskIndex.get(input.taskId);
  if (!prev) return;
  const list = listById.value.get(prev.listId);
  const statusId =
    input.status && list ? (findStatus(list, input.status)?.id ?? prev.statusId) : prev.statusId;

  const next: StoreTask = { ...prev, statusId, updatedAt: Date.now() };
  if (input.title !== undefined) next.title = input.title;
  if (input.description !== undefined) next.description = input.description;
  if (input.assigneeId !== undefined) next.assigneeId = input.assigneeId;
  if (input.priority !== undefined) next.priority = input.priority;
  if (input.dueDate !== undefined) next.dueDate = input.dueDate;
  if (input.startDate !== undefined) next.startDate = input.startDate;
  if (input.snoozedUntil !== undefined) next.snoozedUntil = input.snoozedUntil;
  if (input.blockedNote !== undefined) next.blockedNote = input.blockedNote;
  if (input.tags !== undefined) next.tags = input.tags;

  beginPending(input.taskId);
  putTask(next);
  flush();

  try {
    settleTask(input.taskId, await api.updateTask(input));
  } catch (err) {
    settleTask(input.taskId, null, err);
  }
}

export async function moveTask(input: MoveTaskInput): Promise<void> {
  const prev = taskIndex.get(input.taskId);
  if (!prev) return;
  const listId = input.listId ?? prev.listId;
  const list = listById.value.get(listId);
  const statusId =
    input.status && list ? (findStatus(list, input.status)?.id ?? prev.statusId) : prev.statusId;
  const position = input.position ?? positionAtEnd(listId, statusId);

  beginPending(input.taskId);
  putTask({ ...prev, listId, statusId, position, updatedAt: Date.now() });
  flush();

  try {
    settleTask(input.taskId, await api.moveTask({ ...input, position }));
  } catch (err) {
    settleTask(input.taskId, null, err);
  }
}

export async function toggleSubtask(subtaskId: string, done: boolean): Promise<void> {
  const prev = getSubtask(subtaskId);
  if (!prev) return;
  putSubtask({ ...prev, done });
  flush();
  try {
    putSubtask(await api.toggleSubtask(subtaskId, done));
    flush();
  } catch (err) {
    putSubtask(prev);
    flush();
    toast(`Couldn't update the subtask — ${reason(err)}`, "error");
  }
}

export async function setSubtaskAssignee(
  subtaskId: string,
  assigneeId: string | null
): Promise<void> {
  const prev = getSubtask(subtaskId);
  if (!prev || prev.assigneeId === assigneeId) return;
  putSubtask({ ...prev, assigneeId });
  flush();
  try {
    putSubtask(await api.setSubtaskAssignee(subtaskId, assigneeId));
    flush();
  } catch (err) {
    putSubtask(prev);
    flush();
    toast(`Couldn't assign the subtask — ${reason(err)}`, "error");
  }
}

export async function createSubtask(taskId: string, title: string): Promise<void> {
  const existing = subtasks.value.get(taskId) ?? [];
  const tempId = rid("sb");
  const optimistic: Subtask = {
    id: tempId,
    taskId,
    title,
    done: false,
    assigneeId: null,
    dueDate: null,
    position: append(existing.map((s) => s.position)),
    createdAt: Date.now(),
  };
  putSubtask(optimistic);
  flush();
  try {
    const created = await api.createSubtask(taskId, title);
    removeSubtask(tempId);
    putSubtask(created);
    flush();
  } catch (err) {
    removeSubtask(tempId);
    flush();
    toast(`Couldn't add the subtask — ${reason(err)}`, "error");
  }
}

export async function addComment(taskId: string, body: string): Promise<void> {
  const tempId = rid("cm");
  const optimistic: Comment = {
    id: tempId,
    taskId,
    authorId: me.value?.id ?? "us_unknown",
    body,
    createdAt: Date.now(),
  };
  const put = (list: Comment[]): void => {
    const next = new Map(comments.value);
    next.set(taskId, list);
    comments.value = next;
  };
  const before = comments.value.get(taskId) ?? [];
  put([...before, optimistic]);
  try {
    const created = await api.addComment(taskId, body);
    // Filter the server id too: the WS delta may have landed this comment
    // before the REST response resolved, and appending without that check
    // duplicates it in the open panel.
    put([
      ...(comments.value.get(taskId) ?? []).filter((c) => c.id !== tempId && c.id !== created.id),
      created,
    ]);
  } catch (err) {
    put((comments.value.get(taskId) ?? []).filter((c) => c.id !== tempId));
    toast(`Couldn't post the comment — ${reason(err)}`, "error");
  }
}

export async function deleteTask(taskId: string): Promise<void> {
  const prev = taskIndex.get(taskId);
  if (!prev) return;
  beginPending(taskId);
  removeTask(taskId);
  flush();
  try {
    await api.deleteTask(taskId);
    endPending(taskId, false);
  } catch (err) {
    settleTask(taskId, null, err);
  }
}

// --- spaces & lists --------------------------------------------------------
// Same shape as the task mutations: patch the signal, fire the call, let the
// server's answer overwrite the guess, roll back and toast on failure. Spaces
// and lists are small arrays kept in position order, so the "index" here is
// just the sorted array itself.

const byPosition = (a: { position: number }, b: { position: number }): number =>
  a.position - b.position;

/** Replace-or-insert one row in a position-ordered signal array. */
function putRow<T extends { id: string; position: number }>(
  sig: { value: T[] },
  row: T
): void {
  sig.value = [...sig.value.filter((r) => r.id !== row.id), row].sort(byPosition);
}

function dropRow<T extends { id: string }>(sig: { value: T[] }, id: string): void {
  sig.value = sig.value.filter((r) => r.id !== id);
}

/** Optimistic statuses need ids too, so the new list's board can render at once. */
function draftStatuses(specs: Array<Pick<Status, "name" | "color" | "type">> | undefined): Status[] {
  const source =
    specs && specs.length >= 2
      ? specs
      : [
          { name: "To Do", color: "#8b8f9a", type: "open" as const },
          { name: "In Progress", color: "#3b82f6", type: "custom" as const },
          { name: "Done", color: "#22c55e", type: "closed" as const },
        ];
  return source.map((s, i) => ({ ...s, id: rid("st"), position: i }));
}

/**
 * Create a space. Resolves to the server's space, or null when the call failed
 * and the optimistic row was rolled back — callers navigate only on a real id.
 */
export async function createSpace(input: CreateSpaceInput): Promise<Space | null> {
  const tempId = rid("sp");
  const optimistic: Space = {
    id: tempId,
    name: input.name,
    color: input.color ?? null,
    position: append(spaces.value.map((s) => s.position)),
    archived: false,
    // CreateSpaceInput carries no visibility, so a new space is workspace-wide;
    // making it private is a separate, owner/admin-only flip.
    visibility: "workspace",
    createdAt: Date.now(),
  };
  putRow(spaces, optimistic);

  try {
    const created = await api.createSpace(input);
    dropRow(spaces, tempId);
    putRow(spaces, created);
    return created;
  } catch (err) {
    dropRow(spaces, tempId);
    toast(`Couldn't create the space — ${reason(err)}`, "error");
    return null;
  }
}

/** Create a list. Omit `statuses` to take the server's To Do / In Progress / Done. */
export async function createList(input: CreateListInput): Promise<List | null> {
  const tempId = rid("ls");
  const siblings = lists.value.filter((l) => l.spaceId === input.spaceId);
  const optimistic: List = {
    id: tempId,
    spaceId: input.spaceId,
    name: input.name,
    position: append(siblings.map((l) => l.position)),
    archived: false,
    statuses: draftStatuses(input.statuses),
    inboundToken: null,
    createdAt: Date.now(),
  };
  putRow(lists, optimistic);

  try {
    const created = await api.createList(input);
    dropRow(lists, tempId);
    putRow(lists, created);
    return created;
  } catch (err) {
    dropRow(lists, tempId);
    toast(`Couldn't create the list — ${reason(err)}`, "error");
    return null;
  }
}

export async function updateList(
  listId: string,
  patch: { name?: string; archived?: boolean; position?: number; spaceId?: string }
): Promise<boolean> {
  const prev = lists.value.find((l) => l.id === listId);
  if (!prev) return false;
  putRow(lists, { ...prev, ...patch });

  try {
    // The PATCH response omits inboundToken by design; keep the one we hold.
    const after = await api.updateList(listId, patch);
    const current = lists.value.find((l) => l.id === listId);
    putRow(lists, { ...after, inboundToken: current?.inboundToken ?? prev.inboundToken });
    return true;
  } catch (err) {
    putRow(lists, prev);
    toast(`Couldn't update the list — ${reason(err)}`, "error");
    return false;
  }
}

export async function updateSpace(
  spaceId: string,
  patch: { name?: string; color?: string | null; archived?: boolean; position?: number }
): Promise<boolean> {
  const prev = spaces.value.find((s) => s.id === spaceId);
  if (!prev) return false;
  putRow(spaces, { ...prev, ...patch });

  try {
    putRow(spaces, await api.updateSpace(spaceId, patch));
    return true;
  } catch (err) {
    putRow(spaces, prev);
    toast(`Couldn't update the space — ${reason(err)}`, "error");
    return false;
  }
}

/**
 * Load comments/attachments for one task. Falls back to whatever the board
 * already holds when the API is unreachable, so the panel still opens.
 */
export async function fetchTaskDetail(taskId: string): Promise<TaskDetail | null> {
  const inflight = detailInFlight.get(taskId);
  if (inflight) return inflight;
  const p = loadTaskDetail(taskId).finally(() => {
    detailInFlight.delete(taskId);
  });
  detailInFlight.set(taskId, p);
  return p;
}

async function loadTaskDetail(taskId: string): Promise<TaskDetail | null> {
  try {
    const detail = await api.taskDetail(taskId);
    mergeTaskDetail(detail);
    rememberPrefetch(taskId);
    return detail;
  } catch {
    const task = taskIndex.get(taskId);
    if (!task) return null;
    // The board copy is a SnapshotTask; a TaskDetail is a full Task, so the
    // detail-only fields fall back to their empty values rather than lying
    // about content we have never fetched.
    return {
      task: {
        ...task,
        description: task.description ?? "",
        startDate: task.startDate ?? null,
        createdBy: task.createdBy ?? "",
        closedAt: task.closedAt ?? null,
        clickupId: task.clickupId ?? null,
      },
      subtasks: subtasks.value.get(taskId) ?? [],
      comments: comments.value.get(taskId) ?? [],
      attachments: [],
    };
  }
}

// --- hover prefetch --------------------------------------------------------
// Opening a card costs one round trip for its detail. The board knows which
// card the pointer is resting on ~80ms before the click lands, which is most of
// that trip, so we spend it early. Two guards keep it from becoming traffic:
// an in-flight map (shared with fetchTaskDetail, so a real open never doubles
// up on a prefetch already running) and a small LRU of ids already fetched.

const detailInFlight = new Map<string, Promise<TaskDetail | null>>();
const PREFETCH_LRU_MAX = 30;
/** Insertion-ordered, so the first entry is the least recently touched. */
const prefetched = new Set<string>();

function rememberPrefetch(taskId: string): void {
  prefetched.delete(taskId);
  prefetched.add(taskId);
  while (prefetched.size > PREFETCH_LRU_MAX) {
    const oldest = prefetched.values().next().value;
    if (oldest === undefined) break;
    prefetched.delete(oldest);
  }
}

/**
 * Warm one task's detail. Fire-and-forget: it merges into the store exactly as
 * `fetchTaskDetail` does, so the panel finds description, subtasks and comments
 * already present and renders without a spinner. Never throws.
 */
export function prefetchTaskDetail(taskId: string): void {
  if (prefetched.has(taskId) || detailInFlight.has(taskId)) return;
  void fetchTaskDetail(taskId).catch(() => undefined);
}
