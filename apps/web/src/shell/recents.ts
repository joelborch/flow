// What you looked at lately, so the sidebar can offer
// it back without you hunting through ten spaces for it.
//
// The recording rule is a dwell gate rather than a navigation hook: passing
// through a list on the way somewhere else is not a visit, so an entry is only
// written once you have stayed put for DWELL_MS. The effect below re-runs on
// every route change and cancels the pending timer, which is what makes
// "still there when it fires" true by construction.
//
// Storage is deliberately raw and generous (30 entries, no resolution against
// the store): filtering is a read-time concern, and an id that resolves to
// nothing today may well resolve tomorrow — a list unarchived, a snapshot that
// finished hydrating. See `recentListRows` / `recentTaskRows` for the filters
// that actually decide what a reader sees.
import { computed, effect, signal, type ReadonlySignal, type Signal } from "@preact/signals";
import type { List } from "@flow/shared";
import type { StoreTask } from "../store/index.js";
import { listById, tasks } from "../store/index.js";
import { activeListId, openTaskId } from "./nav.js";
import { pinnedLists } from "./prefs.js";

export const RECENTS_KEY = "flow.sidebar.recents";

export type RecentKind = "list" | "task";
export type RecentEntry = { kind: RecentKind; id: string; at: number };

/** How long you have to stay on a route before it counts as a visit. */
export const DWELL_MS = 2_000;
/** Raw entries kept on disk, newest first. */
export const MAX_RAW = 30;
/** Older than this and it is history, not "recent". */
export const MAX_AGE_MS = 14 * 86_400_000;
export const MAX_RECENT_LISTS = 8;
export const MAX_RECENT_TASKS = 10;

/** Newest wins per id, newest first, capped. The only ordering rule there is. */
function dedupe(entries: RecentEntry[]): RecentEntry[] {
  const sorted = [...entries].sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  const out: RecentEntry[] = [];
  for (const e of sorted) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
    if (out.length >= MAX_RAW) break;
  }
  return out;
}

function read(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: RecentEntry[] = [];
    for (const v of parsed) {
      if (typeof v !== "object" || v === null) continue;
      const e = v as Partial<RecentEntry>;
      if ((e.kind !== "list" && e.kind !== "task") || typeof e.id !== "string") continue;
      if (typeof e.at !== "number" || !Number.isFinite(e.at)) continue;
      out.push({ kind: e.kind, id: e.id, at: e.at });
    }
    return dedupe(out);
  } catch {
    // Bad JSON, or storage blocked (private mode, embedded webview).
    return [];
  }
}

function write(entries: readonly RecentEntry[]): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(entries));
  } catch {
    // Persisting is a nicety; losing it must never break the sidebar.
  }
}

export const recents: Signal<RecentEntry[]> = signal(read());

/**
 * Reads through `peek` so the recording effect never takes a dependency on the
 * signal it is about to write.
 */
export function recordVisit(kind: RecentKind, id: string, at: number = Date.now()): void {
  const next = dedupe([{ kind, id, at }, ...recents.peek()]);
  recents.value = next;
  write(next);
}

export function clearRecents(): void {
  recents.value = [];
  write([]);
}

// A board and an open task are two separate things to remember, and a deep link
// to a task lands on both at once — so a settled route can record either, or
// both. My Work has no id and is always one click away, so it records nothing.
if (typeof window !== "undefined") {
  effect(() => {
    const listId = activeListId.value;
    const taskId = openTaskId.value;
    if (listId === null && taskId === null) return;
    const timer = setTimeout(() => {
      if (listId !== null) recordVisit("list", listId);
      if (taskId !== null) recordVisit("task", taskId);
    }, DWELL_MS);
    return () => clearTimeout(timer);
  });
}

// --- read-time views -------------------------------------------------------
// Three filters, all of them applied on read rather than on write: stale
// entries age out, pinned lists are already on screen a few pixels higher, and
// an id the store cannot resolve has nothing to render.

export const recentListRows: ReadonlySignal<List[]> = computed(() => {
  const cutoff = Date.now() - MAX_AGE_MS;
  const byId = listById.value;
  const pinned = new Set(pinnedLists.value);
  const out: List[] = [];
  for (const e of recents.value) {
    if (e.kind !== "list" || e.at < cutoff || pinned.has(e.id)) continue;
    const list = byId.get(e.id);
    if (!list) continue;
    out.push(list);
    if (out.length >= MAX_RECENT_LISTS) break;
  }
  return out;
});

export const recentTaskRows: ReadonlySignal<Array<{ task: StoreTask; at: number }>> = computed(() => {
  const cutoff = Date.now() - MAX_AGE_MS;
  const byId = tasks.value;
  const out: Array<{ task: StoreTask; at: number }> = [];
  for (const e of recents.value) {
    if (e.kind !== "task" || e.at < cutoff) continue;
    const task = byId.get(e.id);
    if (!task) continue;
    out.push({ task, at: e.at });
    if (out.length >= MAX_RECENT_TASKS) break;
  }
  return out;
});
