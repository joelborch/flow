// Snapshot hydration and delta application. Deltas are authoritative: applying
// one for an entity drops any optimistic overlay still held for it.
import type {
  AutomationRule, BoardSnapshot, Comment, Delta, List, Space, Subtask, Task, User,
} from "@flow/shared";
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

function upsertRow<T extends { id: string }>(
  list: T[],
  id: string,
  op: Delta["op"],
  data: Record<string, unknown> | null
): T[] {
  if (op === "delete") return list.filter((r) => r.id !== id);
  const i = list.findIndex((r) => r.id === id);
  if (i === -1) {
    if (!data) return list;
    return [...list, { ...(data as unknown as T), id }];
  }
  const next = [...list];
  next[i] = { ...(list[i] as T), ...(data as Partial<T>) };
  return next;
}

function applyOne(d: Delta): void {
  switch (d.entity) {
    case "task": {
      if (d.op === "delete") {
        removeTask(d.id);
      } else if (d.op === "create") {
        if (d.data) putTask({ ...(d.data as unknown as Task), id: d.id });
      } else {
        const prev = taskIndex.get(d.id);
        if (prev && d.data) putTask({ ...prev, ...(d.data as Partial<Task>) });
        else if (d.data) putTask({ ...(d.data as unknown as Task), id: d.id });
      }
      clearPending(d.id);
      return;
    }
    case "subtask": {
      if (d.op === "delete") {
        removeSubtask(d.id);
      } else {
        const prev = getSubtask(d.id);
        if (prev && d.op === "update" && d.data) putSubtask({ ...prev, ...(d.data as Partial<Subtask>) });
        else if (d.data) putSubtask({ ...(d.data as unknown as Subtask), id: d.id });
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
