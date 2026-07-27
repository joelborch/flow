// Entity state. The authoritative copy is a plain Map (`taskIndex`); signals
// are views published from it. Writes go through put/remove/flush so a delta
// batch only republishes the lists it actually touched — a status change in one
// list never re-renders another list's columns.
import { computed, signal, type ReadonlySignal, type Signal } from "@preact/signals";
import type {
  AutomationRule, Comment, List, Space, Status, Subtask, Task, User,
} from "@flow/shared";

/** Fields the BoardSnapshot no longer carries — see `SnapshotTask` in shared. */
type DetailField = "description" | "clickupId" | "startDate" | "createdBy" | "closedAt";

/**
 * A task as the client holds it. The snapshot lands `SnapshotTask` entries, and
 * a detail fetch or a delta upgrades them in place to full `Task` shapes, so the
 * index is a union of the two: everything the board draws is always present,
 * and the five detail fields are `undefined` until something fills them in.
 * Both `SnapshotTask` and `Task` are assignable to it, which is what lets
 * `putTask` take either without a cast.
 */
export type StoreTask = Omit<Task, DetailField> &
  Partial<Pick<Task, DetailField>> & {
    /** Present on snapshot entries only; `description !== undefined` is the
     *  stronger signal once detail has landed. */
    hasDescription?: boolean;
  };

// --- connection ------------------------------------------------------------

export const connected: Signal<boolean> = signal(false);
/** True once a snapshot (real or DEV fallback) has been applied. */
export const hydrated: Signal<boolean> = signal(false);
/** Last delta seq applied. Sent back as `hello.sinceSeq` on reconnect. */
export const lastSeq: Signal<number | null> = signal(null);

const SEQ_KEY = "flow.seq";

export function storedSeq(): number | null {
  try {
    const raw = sessionStorage.getItem(SEQ_KEY);
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function setSeq(seq: number | null): void {
  lastSeq.value = seq;
  try {
    if (seq === null) sessionStorage.removeItem(SEQ_KEY);
    else sessionStorage.setItem(SEQ_KEY, String(seq));
  } catch {
    /* private mode — in-memory seq still works for this page */
  }
}

// --- entity signals --------------------------------------------------------

export const spaces: Signal<Space[]> = signal([]);
export const lists: Signal<List[]> = signal([]);
export const tasks: Signal<Map<string, StoreTask>> = signal(new Map());
export const subtasks: Signal<Map<string, Subtask[]>> = signal(new Map());
export const comments: Signal<Map<string, Comment[]>> = signal(new Map());
export const users: Signal<User[]> = signal([]);
export const me: Signal<User | null> = signal(null);
export const automationRules: Signal<AutomationRule[]> = signal([]);

// --- optimistic overlay ----------------------------------------------------
// Server deltas always win. An in-flight mutation records the pre-mutation
// task so a failed request can roll back; the entry is dropped as soon as the
// authoritative delta for that id arrives.

export type PendingTask = { prev: StoreTask | null; inFlight: number };
export const pendingTasks = new Map<string, PendingTask>();
/** Count of in-flight optimistic mutations, for a subtle saving indicator. */
export const pendingCount: Signal<number> = signal(0);

export function beginPending(taskId: string): void {
  const entry = pendingTasks.get(taskId);
  if (entry) entry.inFlight++;
  else pendingTasks.set(taskId, { prev: taskIndex.get(taskId) ?? null, inFlight: 1 });
  pendingCount.value++;
}

/** Resolve an in-flight mutation. Returns the rollback target when rolling back. */
export function endPending(taskId: string, rollback: boolean): StoreTask | null | undefined {
  pendingCount.value = Math.max(0, pendingCount.value - 1);
  const entry = pendingTasks.get(taskId);
  if (!entry) return undefined;
  entry.inFlight--;
  if (entry.inFlight > 0) return undefined;
  const target = entry.prev;
  pendingTasks.delete(taskId);
  return rollback ? target : undefined;
}

export function clearPending(taskId: string): void {
  pendingTasks.delete(taskId);
}

// --- lookups ---------------------------------------------------------------

export const listById: ReadonlySignal<Map<string, List>> = computed(
  () => new Map(lists.value.map((l) => [l.id, l]))
);

export const spaceById: ReadonlySignal<Map<string, Space>> = computed(
  () => new Map(spaces.value.map((s) => [s.id, s]))
);

export const userById: ReadonlySignal<Map<string, User>> = computed(
  () => new Map(users.value.map((u) => [u.id, u]))
);

/** Every status in the workspace, keyed by id — statuses live inside lists. */
export const statusById: ReadonlySignal<Map<string, Status>> = computed(() => {
  const m = new Map<string, Status>();
  for (const l of lists.value) for (const s of l.statuses) m.set(s.id, s);
  return m;
});

export const listsBySpace: ReadonlySignal<Map<string, List[]>> = computed(() => {
  const m = new Map<string, List[]>();
  for (const l of lists.value) {
    if (l.archived) continue;
    const arr = m.get(l.spaceId);
    if (arr) arr.push(l);
    else m.set(l.spaceId, [l]);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.position - b.position);
  return m;
});

/** First list in position order — the default route. */
export const firstList: ReadonlySignal<List | null> = computed(() => {
  let best: List | null = null;
  for (const s of [...spaces.value].sort((a, b) => a.position - b.position)) {
    const inSpace = listsBySpace.value.get(s.id);
    if (inSpace && inSpace.length > 0) {
      best = inSpace[0]!;
      break;
    }
  }
  if (best) return best;
  const any = [...lists.value].sort((a, b) => a.position - b.position);
  return any[0] ?? null;
});

// --- task index ------------------------------------------------------------

export const taskIndex = new Map<string, StoreTask>();
const subtaskIndex = new Map<string, Subtask>();
const membersByList = new Map<string, Set<string>>();
const bucketByList = new Map<string, Signal<StoreTask[]>>();

const dirtyLists = new Set<string>();
let taskMapDirty = false;
let subtaskMapDirty = false;

function membersOf(listId: string): Set<string> {
  let set = membersByList.get(listId);
  if (!set) {
    set = new Set();
    membersByList.set(listId, set);
  }
  return set;
}

/** Live, unsorted tasks of one list. Only republished when that list changes. */
export function listBucket(listId: string): Signal<StoreTask[]> {
  let sig = bucketByList.get(listId);
  if (!sig) {
    sig = signal(collect(listId));
    bucketByList.set(listId, sig);
  }
  return sig;
}

function collect(listId: string): StoreTask[] {
  const out: StoreTask[] = [];
  for (const id of membersOf(listId)) {
    const t = taskIndex.get(id);
    if (t) out.push(t);
  }
  return out;
}

export function putTask(task: StoreTask): void {
  const prev = taskIndex.get(task.id);
  if (prev && prev.listId !== task.listId) {
    membersOf(prev.listId).delete(task.id);
    dirtyLists.add(prev.listId);
  }
  taskIndex.set(task.id, task);
  membersOf(task.listId).add(task.id);
  dirtyLists.add(task.listId);
  taskMapDirty = true;
}

export function removeTask(taskId: string): void {
  const prev = taskIndex.get(taskId);
  if (!prev) return;
  taskIndex.delete(taskId);
  membersOf(prev.listId).delete(taskId);
  dirtyLists.add(prev.listId);
  taskMapDirty = true;
}

export function putSubtask(sub: Subtask): void {
  const prev = subtaskIndex.get(sub.id);
  if (prev && prev.taskId !== sub.taskId) removeSubtask(prev.id);
  subtaskIndex.set(sub.id, sub);
  subtaskMapDirty = true;
}

export function removeSubtask(subtaskId: string): void {
  if (!subtaskIndex.delete(subtaskId)) return;
  subtaskMapDirty = true;
}

export function getSubtask(subtaskId: string): Subtask | undefined {
  return subtaskIndex.get(subtaskId);
}

export function resetIndexes(): void {
  taskIndex.clear();
  subtaskIndex.clear();
  membersByList.clear();
  for (const [listId, sig] of bucketByList) {
    sig.value = [];
    dirtyLists.add(listId);
  }
  taskMapDirty = true;
  subtaskMapDirty = true;
}

/** Publish everything touched since the last flush. Call once per batch. */
export function flush(): void {
  for (const listId of dirtyLists) {
    const sig = bucketByList.get(listId);
    if (sig) sig.value = collect(listId);
  }
  dirtyLists.clear();
  if (taskMapDirty) {
    tasks.value = new Map(taskIndex);
    taskMapDirty = false;
  }
  if (subtaskMapDirty) {
    const grouped = new Map<string, Subtask[]>();
    for (const s of subtaskIndex.values()) {
      const arr = grouped.get(s.taskId);
      if (arr) arr.push(s);
      else grouped.set(s.taskId, [s]);
    }
    for (const arr of grouped.values()) arr.sort((a, b) => a.position - b.position);
    subtasks.value = grouped;
    subtaskMapDirty = false;
  }
}

// --- derived board shape ---------------------------------------------------

export type StatusColumns = Map<string, StoreTask[]>;

const columnsByList = new Map<string, ReadonlySignal<StatusColumns>>();

function order(a: StoreTask, b: StoreTask): number {
  return a.position - b.position || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);
}

/**
 * Tasks of one list grouped by statusId and sorted by fractional position.
 * Cached per list, so a delta in another list costs nothing here.
 */
export function tasksByListAndStatus(listId: string): ReadonlySignal<StatusColumns> {
  let sig = columnsByList.get(listId);
  if (!sig) {
    const bucket = listBucket(listId);
    sig = computed(() => {
      const grouped: StatusColumns = new Map();
      for (const t of bucket.value) {
        const arr = grouped.get(t.statusId);
        if (arr) arr.push(t);
        else grouped.set(t.statusId, [t]);
      }
      for (const arr of grouped.values()) arr.sort(order);
      return grouped;
    });
    columnsByList.set(listId, sig);
  }
  return sig;
}

export function subtaskProgress(taskId: string): { done: number; total: number } {
  const arr = subtasks.value.get(taskId);
  if (!arr || arr.length === 0) return { done: 0, total: 0 };
  let done = 0;
  for (const s of arr) if (s.done) done++;
  return { done, total: arr.length };
}

/** Status by name (case-insensitive) within a list. */
export function findStatus(list: List, name: string): Status | undefined {
  const lower = name.toLowerCase();
  return list.statuses.find((s) => s.name.toLowerCase() === lower);
}

export function openStatus(list: List): Status {
  const sorted = [...list.statuses].sort((a, b) => a.position - b.position);
  return sorted.find((s) => s.type === "open") ?? sorted[0]!;
}
