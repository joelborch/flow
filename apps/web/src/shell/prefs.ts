// Sidebar preferences — the state that decides how
// much of a 10-space, 60-list workspace is on screen at once.
//
// Three separate lifetimes, deliberately:
//   expandedSpaces   localStorage. Spaces are collapsed until you open one, so
//                    a fresh browser shows ten headers rather than sixty rows.
//   pinnedLists      localStorage. Per-browser, not per-user: pins are not in
//                    the workspace contract, so a second machine starts empty.
//   dormantOpen      memory only. Peeking at a space's inactive lists is a
//                    momentary thing; it should not follow you into tomorrow.
//
// Kept out of nav.ts because nav owns routing and the mobile drawer, and this
// module has to read the store to resolve the active list's space.
import { effect, signal, type Signal } from "@preact/signals";
import { listById } from "../store/index.js";
import { activeListId } from "./nav.js";

export const EXPANDED_SPACES_KEY = "flow.sidebar.expandedSpaces";
export const PINNED_LISTS_KEY = "flow.sidebar.pinnedLists";
export const SIDEBAR_MODE_KEY = "flow.sidebar.mode";

/** Both keys hold a JSON array of ids; anything else on disk is ignored. */
function readIds(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // Bad JSON, or storage blocked (private mode, embedded webview).
    return [];
  }
}

function writeIds(key: string, ids: readonly string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Persisting is a nicety; losing it must never break the sidebar.
  }
}

// --- sidebar mode ----------------------------------------------------------
// Which of the two scroll regions the nav is showing. localStorage, same
// lifetime as the pins: it is a way of working, not a momentary peek.

export type SidebarMode = "projects" | "recent";

function readMode(): SidebarMode {
  try {
    return localStorage.getItem(SIDEBAR_MODE_KEY) === "recent" ? "recent" : "projects";
  } catch {
    return "projects";
  }
}

export const sidebarMode: Signal<SidebarMode> = signal(readMode());

export function setSidebarMode(mode: SidebarMode): void {
  sidebarMode.value = mode;
  try {
    localStorage.setItem(SIDEBAR_MODE_KEY, mode);
  } catch {
    /* same as above: persisting is a nicety. */
  }
}

// --- expanded spaces -------------------------------------------------------

export const expandedSpaces: Signal<Set<string>> = signal(new Set(readIds(EXPANDED_SPACES_KEY)));

function commitExpanded(next: Set<string>): void {
  expandedSpaces.value = next;
  writeIds(EXPANDED_SPACES_KEY, [...next]);
}

export function toggleSpace(spaceId: string): void {
  const next = new Set(expandedSpaces.value);
  if (next.has(spaceId)) next.delete(spaceId);
  else next.add(spaceId);
  commitExpanded(next);
}

/**
 * Reads through `peek` so callers inside an effect — the auto-expand below —
 * do not take a dependency on the very signal they are about to write.
 */
export function expandSpace(spaceId: string): void {
  const cur = expandedSpaces.peek();
  if (cur.has(spaceId)) return;
  commitExpanded(new Set([...cur, spaceId]));
}

/**
 * Navigating to a list opens its space, so a deep link or a ⌘K jump never
 * lands you on a board whose list is hidden in a collapsed group.
 */
effect(() => {
  const id = activeListId.value;
  if (id === null) return;
  const spaceId = listById.value.get(id)?.spaceId;
  if (spaceId) expandSpace(spaceId);
});

// --- dormant lists ---------------------------------------------------------

/** Spaces whose "N inactive lists" group is currently open. */
export const dormantOpen: Signal<Set<string>> = signal(new Set());

export function toggleDormant(spaceId: string): void {
  const next = new Set(dormantOpen.value);
  if (next.has(spaceId)) next.delete(spaceId);
  else next.add(spaceId);
  dormantOpen.value = next;
}

/**
 * Below this a bucket is pointless: one hidden list behind a one-line expander
 * saves no space and costs a click.
 */
export const DORMANT_MIN = 2;

// --- pinned lists ----------------------------------------------------------

/** Most recently pinned first — the whole ordering model, no drag handles. */
export const pinnedLists: Signal<string[]> = signal(readIds(PINNED_LISTS_KEY));

export function isPinned(listId: string): boolean {
  return pinnedLists.value.includes(listId);
}

export function togglePin(listId: string): void {
  const cur = pinnedLists.value;
  const next = cur.includes(listId) ? cur.filter((id) => id !== listId) : [listId, ...cur];
  pinnedLists.value = next;
  writeIds(PINNED_LISTS_KEY, next);
}
