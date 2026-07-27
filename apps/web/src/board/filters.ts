// Board filter state. Client-side only — it narrows the tasks already loaded.
// Full-text search across the workspace goes through /api/tasks/search later.
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { isSnoozed } from "../lib/fmt.js";
import { me, type StoreTask } from "../store/index.js";

/** Empty = every status shows. */
export const statusFilter = signal<ReadonlySet<string>>(new Set());
export const assigneeFilter = signal<string | null>(null);
export const mineOnly = signal(false);
export const search = signal("");
/**
 * Snoozed cards are hidden by default — that is the whole point of snoozing —
 * and this reveals them, dimmed and in place, rather than moving them anywhere.
 * It is deliberately not part of `filtersActive`: the other controls narrow the
 * board, this one widens it, so folding it into "Reset" would read backwards.
 */
export const showSnoozed = signal(false);

export const filtersActive: ReadonlySignal<boolean> = computed(
  () =>
    statusFilter.value.size > 0 ||
    assigneeFilter.value !== null ||
    mineOnly.value ||
    search.value.trim() !== ""
);

export function clearFilters(): void {
  statusFilter.value = new Set();
  assigneeFilter.value = null;
  mineOnly.value = false;
  search.value = "";
  showSnoozed.value = false;
}

/** A card the snooze gate hides: parked, and the reveal toggle is off. */
export function hiddenBySnooze(task: StoreTask, now = Date.now()): boolean {
  return !showSnoozed.value && isSnoozed(task.snoozedUntil, now);
}

export function toggleStatus(statusId: string): void {
  const next = new Set(statusFilter.value);
  if (next.has(statusId)) next.delete(statusId);
  else next.add(statusId);
  statusFilter.value = next;
}

/** Predicate over everything except status (columns handle that themselves). */
export const cardFilter: ReadonlySignal<(task: StoreTask) => boolean> = computed(() => {
  const q = search.value.trim().toLowerCase();
  const assignee = mineOnly.value ? (me.value?.id ?? null) : assigneeFilter.value;
  if (!q && !assignee) return () => true;
  return (task: StoreTask) => {
    if (assignee && task.assigneeId !== assignee) return false;
    if (q && !task.title.toLowerCase().includes(q)) return false;
    return true;
  };
});
