// Read-only derivations for the sidebar, top bar and
// task panel. These lean on the store's own computed lookup maps rather than
// re-scanning arrays, and must be called during render so the signal reads
// register as dependencies.
import { computed, type ReadonlySignal } from "@preact/signals";
import type { List, Space, Status, User } from "@flow/shared";
import {
  listById as listMap, lists, listsBySpace, spaceById as spaceMap, spaces,
  statusById as statusMap, tasks, userById as userMap, type StoreTask,
} from "../store/index.js";

export function listById(listId: string | null | undefined): List | undefined {
  return listId ? listMap.value.get(listId) : undefined;
}

export function spaceById(spaceId: string | null | undefined): Space | undefined {
  return spaceId ? spaceMap.value.get(spaceId) : undefined;
}

export function spaceOfList(listId: string | null | undefined): Space | undefined {
  return spaceById(listById(listId)?.spaceId);
}

export function userById(userId: string | null | undefined): User | undefined {
  return userId ? userMap.value.get(userId) : undefined;
}

export function taskById(taskId: string | null | undefined): StoreTask | undefined {
  return taskId ? tasks.value.get(taskId) : undefined;
}

/** Statuses of a list in board order: open first, closed last. */
export function statusesOf(listId: string | null | undefined): Status[] {
  const l = listById(listId);
  if (!l) return [];
  return [...l.statuses].sort((a, b) => a.position - b.position);
}

export function statusOfTask(task: StoreTask | null | undefined): Status | undefined {
  return task ? statusMap.value.get(task.statusId) : undefined;
}

export function isClosed(task: StoreTask): boolean {
  return statusOfTask(task)?.type === "closed";
}

/** Assigned to me and still open, ordered by due date then priority. */
export function myOpenTasks(meId: string | null | undefined): StoreTask[] {
  if (!meId) return [];
  const rank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  const out: StoreTask[] = [];
  for (const t of tasks.value.values()) {
    if (t.assigneeId === meId && !isClosed(t)) out.push(t);
  }
  return out.sort((a, b) => {
    const ad = a.dueDate ?? Number.MAX_SAFE_INTEGER;
    const bd = b.dueDate ?? Number.MAX_SAFE_INTEGER;
    if (ad !== bd) return ad - bd;
    const ap = a.priority ? (rank[a.priority] ?? 9) : 9;
    const bp = b.priority ? (rank[b.priority] ?? 9) : 9;
    if (ap !== bp) return ap - bp;
    return a.title.localeCompare(b.title);
  });
}

export function listsOfSpace(spaceId: string, includeArchived: boolean): List[] {
  // listsBySpace already drops archived lists, so the toggle has to go back to
  // the raw array when someone asks to see them.
  if (!includeArchived) return listsBySpace.value.get(spaceId) ?? [];
  return lists.value
    .filter((l) => l.spaceId === spaceId)
    .sort((a, b) => a.position - b.position);
}

export function orderedSpaces(includeArchived: boolean): Space[] {
  const all = [...spaces.value].sort((a, b) => a.position - b.position);
  return includeArchived ? all : all.filter((s) => !s.archived);
}

/**
 * Open task count per list. One pass over every task, cached until the tasks or
 * statuses change — the sidebar asks for this once per list per render, and at
 * sixty lists a per-list scan would be sixty full sweeps of the workspace.
 */
export const openCountByList: ReadonlySignal<Map<string, number>> = computed(() => {
  const statuses = statusMap.value;
  const out = new Map<string, number>();
  for (const t of tasks.value.values()) {
    if (statuses.get(t.statusId)?.type === "closed") continue;
    out.set(t.listId, (out.get(t.listId) ?? 0) + 1);
  }
  return out;
});

/** Open task count for a list — the only number worth putting in the sidebar. */
export function openCountOfList(listId: string): number {
  return openCountByList.value.get(listId) ?? 0;
}

/**
 * Everything open in a space, so a collapsed space still reads as busy or
 * quiet. Archived lists are excluded whatever the archived toggle says: their
 * leftovers are not work anyone is being asked to do.
 */
export function openCountOfSpace(spaceId: string): number {
  let n = 0;
  for (const l of listsOfSpace(spaceId, false)) n += openCountOfList(l.id);
  return n;
}
