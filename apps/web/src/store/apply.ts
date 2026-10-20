// Snapshot hydration and delta application. Deltas are authoritative: applying
// one for an entity drops any optimistic overlay still held for it.
import type {
  AutomationRule, BoardSnapshot, Comment, Delta, List, Space, Subtask, Task, User,
} from "@flow/shared";
import { api } from "../lib/api.js";
import { clearBootCache, writeBootCache } from "../lib/boot-cache.js";
import {
  automationRules, clearPending, comments, flush, getSubtask, hydrated, lastSeq, lists, me,
  putSubtask, putTask, removeSubtask, removeTask, resetIndexes, setSeq, spaces,
  subtasks, taskIndex, users,
} from "./state.js";

// --- boot cache ------------------------------------------------------------
// The board as it stands, written to localStorage so the next load paints it
// before the socket has even answered. Deltas arrive in bursts, so the write is
// debounced: a busy minute costs one serialisation every two seconds, not one
// per mutation.

const FLUSH_DEBOUNCE_MS = 2000;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** The current store, back in BoardSnapshot shape. */
function currentSnapshot(seq: number): BoardSnapshot {
  const allSubtasks: Subtask[] = [];
  for (const arr of subtasks.value.values()) allSubtasks.push(...arr);
  return {
    seq,
    spaces: spaces.value,
    lists: lists.value,
    // StoreTask is a superset of SnapshotTask; the detail fields it may carry
    // ride along harmlessly and are re-fetched on the next panel open anyway.
    tasks: [...taskIndex.values()].map((t) => ({ ...t, hasDescription: hasDescriptionOf(t) })),
    subtasks: allSubtasks,
    users: users.value,
    automationRules: automationRules.value,
  };
}

function hasDescriptionOf(task: { description?: string; hasDescription?: boolean }): boolean {
  return task.description !== undefined ? task.description !== "" : task.hasDescription === true;
}

function persistNow(): void {
  const seq = lastSeq.value;
  const userId = me.value?.id;
  // Without an identity we cannot label the record, and an unlabelled board
  // could be restored for the wrong user on the next load.
  if (seq === null || !userId || !hydrated.value) return;
  writeBootCache(userId, seq, currentSnapshot(seq));
}

/** Queue a boot-cache write. Cheap to call on every delta batch. */
export function scheduleBootCacheFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    persistNow();
  }, FLUSH_DEBOUNCE_MS);
}

/** Drop the cache and any queued write — used when the server asks to resync. */
export function invalidateBootCache(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  clearBootCache();
}

export function hydrate(snapshot: BoardSnapshot): void {
  resetAdoptions();
  resetIndexes();
  spaces.value = [...snapshot.spaces].sort((a, b) => a.position - b.position);
  lists.value = [...snapshot.lists].sort((a, b) => a.position - b.position);
  users.value = snapshot.users;
  automationRules.value = snapshot.automationRules;
  for (const t of snapshot.tasks) putTask(t);
  for (const s of snapshot.subtasks) putSubtask(s);
  comments.value = new Map();
  setSeq(snapshot.seq);
  flush();
  hydrated.value = true;
  scheduleBootCacheFlush();
}

/**
 * Apply one delta to a small row array. An `update` carries only the fields
 * that changed, so it can never stand in for a whole row: one for an id we do
 * not hold is dropped rather than inserted half-built.
 */
function upsertRow<T extends { id: string }>(
  list: T[],
  id: string,
  op: Delta["op"],
  data: Record<string, unknown> | null
): T[] {
  if (op === "delete") return list.filter((r) => r.id !== id);
  const i = list.findIndex((r) => r.id === id);
  if (i === -1) {
    if (!data || op !== "create") return list;
    return [...list, { ...(data as unknown as T), id }];
  }
  const next = [...list];
  next[i] = { ...(list[i] as T), ...(data as Partial<T>) };
  return next;
}

// --- tasks we never held -----------------------------------------------------
// The snapshot leaves out tasks closed more than 60 days ago, and a task can
// move into a space this user has only just been let into. The first delta for
// either is an `update` carrying nothing but the changed fields, so the task is
// fetched whole instead. One fetch per id: updates that land while it is out
// queue on the entry and replay on top of the answer, so a response the server
// built before them cannot roll them back.
//
// A bulk edit of old closed tasks reaches every connected client at once, so
// at most ADOPT_CONCURRENCY fetches run at a time and the rest wait. A task
// that is still closed beyond the snapshot's window is dropped on arrival: the
// next snapshot would leave it out, so holding it only bloats the boot cache.
// `hydrate` bumps the generation, so an answer to a fetch started before a
// snapshot (which may have just revoked this user's access) is discarded.

const ADOPT_CONCURRENCY = 4;
/** Mirrors SNAPSHOT_CLOSED_WINDOW_MS in packages/core/src/index.ts. */
const SNAPSHOT_CLOSED_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

type Adoption = { patches: Partial<Task>[]; generation: number };
const adopting = new Map<string, Adoption>();
const adoptQueue: string[] = [];
let adoptsInFlight = 0;
let adoptGeneration = 0;

function isWholeTask(task: Partial<Task> | null | undefined): task is Task {
  return !!task && typeof task.title === "string" && typeof task.listId === "string";
}

function outsideSnapshotWindow(task: Task): boolean {
  return task.closedAt != null && task.closedAt < Date.now() - SNAPSHOT_CLOSED_WINDOW_MS;
}

/** Forget every pending adoption: a fresh snapshot supersedes them all. */
function resetAdoptions(): void {
  adoptGeneration++;
  adopting.clear();
  adoptQueue.length = 0;
}

function adoptUnknownTask(id: string, patch: Partial<Task>): void {
  const pending = adopting.get(id);
  if (pending) {
    pending.patches.push(patch);
    return;
  }
  adopting.set(id, { patches: [patch], generation: adoptGeneration });
  adoptQueue.push(id);
  pumpAdoptions();
}

function pumpAdoptions(): void {
  while (adoptsInFlight < ADOPT_CONCURRENCY && adoptQueue.length > 0) {
    const id = adoptQueue.shift()!;
    const entry = adopting.get(id);
    if (!entry) continue; // deleted while it waited
    adoptsInFlight++;
    // Background work nobody asked for, so a 401 must not bounce the page to
    // login, and a 403/404/422 (a private task, or one already gone) is simply
    // not ours to show. Every failure is dropped; the next update retries.
    void api
      .taskDetail(id, { authRedirect: false })
      .then((detail) => {
        // Deleted while in flight, or superseded by a snapshot.
        if (adopting.get(id) !== entry || entry.generation !== adoptGeneration) return;
        adopting.delete(id);
        // A create landed it meanwhile, and that copy has seen every delta
        // since, so it wins.
        if (taskIndex.has(id) || !isWholeTask(detail?.task)) return;
        let task: Task = detail.task;
        for (const p of entry.patches) task = { ...task, ...p };
        if (outsideSnapshotWindow(task)) return;
        mergeTaskDetail({ ...detail, task });
        scheduleBootCacheFlush();
      })
      .catch(() => {
        if (adopting.get(id) === entry) adopting.delete(id);
      })
      .finally(() => {
        adoptsInFlight--;
        pumpAdoptions();
      });
  }
}

function applyOne(d: Delta): void {
  switch (d.entity) {
    case "task": {
      if (d.op === "delete") {
        removeTask(d.id);
        adopting.delete(d.id);
      } else if (d.op === "create") {
        if (d.data) putTask({ ...(d.data as unknown as Task), id: d.id });
      } else if (d.data) {
        const prev = taskIndex.get(d.id);
        if (prev) putTask({ ...prev, ...(d.data as Partial<Task>) });
        else adoptUnknownTask(d.id, d.data as Partial<Task>);
      }
      clearPending(d.id);
      return;
    }
    case "subtask": {
      if (d.op === "delete") {
        removeSubtask(d.id);
      } else if (d.op === "create") {
        if (d.data) putSubtask({ ...(d.data as unknown as Subtask), id: d.id });
      } else if (d.data) {
        // Same rule as upsertRow: an update for an id we do not hold is dropped.
        // Subtasks of a task adopted above arrive with its detail.
        const prev = getSubtask(d.id);
        if (prev) putSubtask({ ...prev, ...(d.data as Partial<Subtask>) });
      }
      return;
    }
    case "comment": {
      const data = d.data as (Partial<Comment> & { taskId?: string }) | null;
      const taskId = data?.taskId;
      const next = new Map(comments.value);
      if (d.op === "delete") {
        for (const [tid, arr] of next) {
          if (arr.some((c) => c.id === d.id)) next.set(tid, arr.filter((c) => c.id !== d.id));
        }
      } else if (taskId) {
        const arr = next.get(taskId);
        // Comments load lazily per task; ignore deltas for tasks never opened.
        if (arr) {
          next.set(taskId, upsertRow(arr, d.id, d.op, d.data));
        } else if (d.op === "create" && d.data) {
          next.set(taskId, [{ ...(d.data as unknown as Comment), id: d.id }]);
        }
      }
      comments.value = next;
      return;
    }
    case "space":
      spaces.value = upsertRow<Space>(spaces.value, d.id, d.op, d.data).sort(
        (a, b) => a.position - b.position
      );
      return;
    case "list":
      lists.value = upsertRow<List>(lists.value, d.id, d.op, d.data).sort(
        (a, b) => a.position - b.position
      );
      return;
    case "user": {
      users.value = upsertRow<User>(users.value, d.id, d.op, d.data);
      const current = me.value;
      if (current && current.id === d.id) {
        me.value = users.value.find((u) => u.id === d.id) ?? current;
      }
      return;
    }
    case "automation_rule":
      automationRules.value = upsertRow<AutomationRule>(automationRules.value, d.id, d.op, d.data);
      return;
    case "attachment":
      // Attachments render from TaskDetail, which the panel refetches on open.
      return;
  }
}

export function applyDeltas(deltas: readonly Delta[]): void {
  if (deltas.length === 0) return;
  let maxSeq: number | null = null;
  for (const d of deltas) {
    applyOne(d);
    if (maxSeq === null || d.seq > maxSeq) maxSeq = d.seq;
  }
  if (maxSeq !== null) setSeq(maxSeq);
  flush();
  scheduleBootCacheFlush();
}

/** Merge a TaskDetail response (task + subtasks + comments) into the store. */
export function mergeTaskDetail(detail: {
  task: Task;
  subtasks: Subtask[];
  comments: Comment[];
}): void {
  putTask(detail.task);
  for (const [id, arr] of subtasks.value) {
    if (id !== detail.task.id) continue;
    for (const s of arr) if (!detail.subtasks.some((n) => n.id === s.id)) removeSubtask(s.id);
  }
  for (const s of detail.subtasks) putSubtask(s);
  const next = new Map(comments.value);
  next.set(
    detail.task.id,
    [...detail.comments].sort((a, b) => a.createdAt - b.createdAt)
  );
  comments.value = next;
  flush();
}
