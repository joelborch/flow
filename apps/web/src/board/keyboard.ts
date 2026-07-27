// Keyboard control for the board: a focused card, a selection, and the single
// keydown handler that drives both.
//
// Focus and selection are painted onto the DOM directly rather than threaded
// through props, for the same reason dnd.ts drives the drag imperatively: J
// held down on a 500-card board must not re-render 500 components. The signals
// below exist so the small things that genuinely need to react — the picker,
// the selection bar — can subscribe, and the cards themselves never do.
//
// Preact only writes `class` when the vnode's own value changed, and Card's is
// a constant string, so the classes we add here survive an ordinary re-render.
// New nodes are covered because setBoardLayout repaints after every layout
// change, and that runs in an effect after the board has committed.
import { signal, type Signal } from "@preact/signals";
import type { Priority } from "@flow/shared";
import { me, tasks, updateTask } from "../store/index.js";
import { openTask } from "../lib/shell-bridge.js";

export type PickerKind = "status" | "assignee" | "priority" | "due" | "tags";

/** The board's shape, in reading order: columns left to right, cards top down. */
export type BoardColumn = { statusId: string; taskIds: string[] };

export const boardColumns: Signal<BoardColumn[]> = signal<BoardColumn[]>([]);
export const focusedTaskId: Signal<string | null> = signal<string | null>(null);
export const selectedIds: Signal<ReadonlySet<string>> = signal<ReadonlySet<string>>(new Set());
export const openPicker: Signal<PickerKind | null> = signal<PickerKind | null>(null);
export const cheatSheetOpen: Signal<boolean> = signal(false);

/** The card a Shift-range extends from: whatever you last picked on purpose. */
let anchorId: string | null = null;

// --- painting --------------------------------------------------------------

const FOCUS_CLASS = "card-focused";
const SELECT_CLASS = "card-selected";

function paint(scroll = false): void {
  if (typeof document === "undefined") return;
  const focused = focusedTaskId.peek();
  const sel = selectedIds.peek();
  for (const el of document.querySelectorAll<HTMLElement>("[data-task-id]")) {
    const id = el.dataset.taskId;
    if (id === undefined) continue;
    const on = id === focused;
    el.classList.toggle(FOCUS_CLASS, on);
    el.classList.toggle(SELECT_CLASS, sel.has(id));
    if (on && scroll) el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function setFocused(id: string | null, scroll: boolean): void {
  if (focusedTaskId.peek() !== id) focusedTaskId.value = id;
  paint(scroll);
}

function setSelection(next: ReadonlySet<string>): void {
  selectedIds.value = next;
  paint(false);
}

/**
 * Called from the board once it knows its columns. Also the moment stale focus
 * and stale selection get dropped: a card filtered away, moved by someone
 * else's delta, or deleted must not stay lit or stay selected.
 */
export function setBoardLayout(columns: BoardColumn[]): void {
  boardColumns.value = columns;

  const live = new Set<string>();
  for (const col of columns) for (const id of col.taskIds) live.add(id);

  const focused = focusedTaskId.peek();
  if (focused !== null && !live.has(focused)) focusedTaskId.value = null;
  if (anchorId !== null && !live.has(anchorId)) anchorId = null;

  const sel = selectedIds.peek();
  if (sel.size > 0) {
    const kept = new Set([...sel].filter((id) => live.has(id)));
    if (kept.size !== sel.size) selectedIds.value = kept;
  }

  paint(false);
}

export function resetBoardKeyboard(): void {
  anchorId = null;
  focusedTaskId.value = null;
  selectedIds.value = new Set();
  openPicker.value = null;
  cheatSheetOpen.value = false;
  paint(false);
}

// --- geometry --------------------------------------------------------------

function locate(id: string | null): { col: number; row: number } | null {
  if (id === null) return null;
  const cols = boardColumns.peek();
  for (let c = 0; c < cols.length; c++) {
    const r = cols[c]!.taskIds.indexOf(id);
    if (r !== -1) return { col: c, row: r };
  }
  return null;
}

function firstCard(): string | null {
  for (const col of boardColumns.peek()) {
    const id = col.taskIds[0];
    if (id !== undefined) return id;
  }
  return null;
}

export function moveFocus(dir: "up" | "down" | "left" | "right"): void {
  const cols = boardColumns.peek();
  if (cols.length === 0) return;

  const at = locate(focusedTaskId.peek());
  if (!at) {
    setFocused(firstCard(), true);
    return;
  }

  if (dir === "up" || dir === "down") {
    const ids = cols[at.col]!.taskIds;
    const row = Math.min(Math.max(at.row + (dir === "down" ? 1 : -1), 0), ids.length - 1);
    setFocused(ids[row] ?? null, true);
    return;
  }

  // Sideways keeps your place down the column and skips columns the filters
  // emptied — landing on nothing would silently drop focus mid-keystroke.
  const step = dir === "right" ? 1 : -1;
  for (let c = at.col + step; c >= 0 && c < cols.length; c += step) {
    const ids = cols[c]!.taskIds;
    if (ids.length === 0) continue;
    setFocused(ids[Math.min(at.row, ids.length - 1)] ?? null, true);
    return;
  }
}

/** Hover moves focus, so the pointer and the keyboard never disagree. */
export function focusCard(taskId: string): void {
  if (openPicker.peek() !== null || cheatSheetOpen.peek()) return;
  setFocused(taskId, false);
}

// --- selection -------------------------------------------------------------

export function toggleSelect(taskId: string): void {
  const next = new Set(selectedIds.peek());
  if (next.has(taskId)) next.delete(taskId);
  else next.add(taskId);
  anchorId = taskId;
  setSelection(next);
}

/**
 * Extend the selection from the anchor to `taskId`. Ranges are per column —
 * a rectangle across four columns is not a thing anyone means by Shift-click on
 * a kanban board — so an anchor elsewhere degrades to a plain toggle.
 */
export function rangeSelect(taskId: string): void {
  const to = locate(taskId);
  const from = locate(anchorId);
  if (!to || !from || from.col !== to.col) {
    toggleSelect(taskId);
    return;
  }
  const ids = boardColumns.peek()[to.col]!.taskIds;
  const lo = Math.min(from.row, to.row);
  const hi = Math.max(from.row, to.row);
  const next = new Set(selectedIds.peek());
  for (let i = lo; i <= hi; i++) {
    const id = ids[i];
    if (id !== undefined) next.add(id);
  }
  setSelection(next);
}

export function clearSelection(): void {
  anchorId = null;
  setSelection(new Set());
}

/** Selection if there is one, the focused card otherwise. */
export function targetIds(): string[] {
  const sel = selectedIds.peek();
  if (sel.size > 0) return [...sel];
  const focused = focusedTaskId.peek();
  return focused === null ? [] : [focused];
}

// --- mutations -------------------------------------------------------------
// Sequential rather than one /api/tasks/bulk call: every updateTask is already
// optimistic and rolls itself back on failure, so a partial failure leaves the
// board consistent card by card. A bulk PATCH would need its own settle path in
// the store to get the same guarantee.

type FieldPatch = {
  status?: string;
  assigneeId?: string | null;
  priority?: Priority | null;
  dueDate?: number | null;
};

export function applyToTargets(patch: FieldPatch): void {
  for (const taskId of targetIds()) void updateTask({ taskId, ...patch });
}

/** Tags merge rather than replace — a bulk tag is an addition, not a reset. */
export function addTagsToTargets(raw: string): void {
  const add = raw
    .split(",")
    .map((p) => p.trim().replace(/^#/, ""))
    .filter((p) => p !== "");
  if (add.length === 0) return;
  const byId = tasks.peek();
  for (const taskId of targetIds()) {
    const task = byId.get(taskId);
    if (!task) continue;
    const next = new Set(task.tags);
    const before = next.size;
    for (const tag of add) next.add(tag);
    if (next.size !== before) void updateTask({ taskId, tags: [...next] });
  }
}

export function assignToMe(): void {
  const meId = me.peek()?.id;
  if (!meId) return;
  applyToTargets({ assigneeId: meId });
}

// --- the key handler -------------------------------------------------------

function typing(el: EventTarget | Element | null): boolean {
  const node = el as HTMLElement | null;
  if (!node || typeof node.tagName !== "string") return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable === true;
}

/**
 * Anything modal that is not ours — the palette, the task panel, the mobile
 * drawer's overlay. Asking the DOM rather than importing the shell keeps the
 * board compiling on its own, which is the whole point of lib/shell-bridge.
 */
function modalUp(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('[role="dialog"][aria-modal="true"]:not([data-board-overlay])') !== null;
}

const PICKER_KEYS: Record<string, PickerKind> = {
  s: "status",
  a: "assignee",
  p: "priority",
  d: "due",
  t: "tags",
};

/**
 * Returns true when the key was consumed. The board calls this first and falls
 * back to its own handling (n, Escape closing a composer) when it returns false.
 */
export function handleBoardKey(ev: KeyboardEvent): boolean {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return false;
  if (typing(ev.target) || typing(document.activeElement)) return false;

  // The cheat sheet is ours, so it answers before the modal guard rather than
  // being locked out by it.
  if (cheatSheetOpen.peek()) {
    if (ev.key === "Escape" || ev.key === "?") {
      ev.preventDefault();
      cheatSheetOpen.value = false;
      return true;
    }
    return false;
  }

  if (modalUp()) return false;

  if (ev.key === "?") {
    ev.preventDefault();
    cheatSheetOpen.value = true;
    return true;
  }

  if (ev.key === "Escape") {
    // Unwind one layer at a time, outermost first.
    if (openPicker.peek() !== null) {
      openPicker.value = null;
      return true;
    }
    if (selectedIds.peek().size > 0) {
      clearSelection();
      return true;
    }
    if (focusedTaskId.peek() !== null) {
      setFocused(null, false);
      return true;
    }
    return false;
  }

  if (openPicker.peek() !== null) return false;

  const key = ev.key.toLowerCase();

  switch (key) {
    case "j":
    case "arrowdown":
      ev.preventDefault();
      moveFocus("down");
      return true;
    case "k":
    case "arrowup":
      ev.preventDefault();
      moveFocus("up");
      return true;
    case "h":
    case "arrowleft":
      ev.preventDefault();
      moveFocus("left");
      return true;
    case "l":
    case "arrowright":
      ev.preventDefault();
      moveFocus("right");
      return true;
  }

  const focused = focusedTaskId.peek();
  if (focused === null && targetIds().length === 0) return false;

  if (ev.key === "Enter") {
    if (focused === null) return false;
    ev.preventDefault();
    openTask(focused);
    return true;
  }

  if (key === "x") {
    if (focused === null) return false;
    ev.preventDefault();
    if (ev.shiftKey) rangeSelect(focused);
    else toggleSelect(focused);
    return true;
  }

  if (key === "c") {
    if (focused === null) return false;
    ev.preventDefault();
    openTask(focused, { focus: "comment" });
    return true;
  }

  if (key === "i") {
    ev.preventDefault();
    assignToMe();
    return true;
  }

  const picker = PICKER_KEYS[key];
  if (picker) {
    ev.preventDefault();
    openPicker.value = picker;
    return true;
  }

  return false;
}
