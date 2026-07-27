// Navigation + sidebar chrome state.
//
// The URL is owned by lib/router (the board agent's module): /s/:spaceId/l/:listId
// with an optional /t/:taskId suffix. Everything here delegates to it, so a deep
// link, Back, Forward and a card click all end up in the same place. Separate
// from index.tsx so the sidebar and top bar can import it without a cycle.
import { computed, signal, type ReadonlySignal, type Signal } from "@preact/signals";
import { listPath, navigate, route, routeTaskId, withTask } from "../lib/router.js";

/** The task whose panel is open, straight from the URL. */
export const openTaskId: ReadonlySignal<string | null> = routeTaskId;

export type View = { kind: "my-work" } | { kind: "list"; listId: string | null };

/**
 * My Work is a pinned overlay rather than a route: main.tsx redirects any
 * list-less URL to the first list, so a /my-work path would be bounced.
 */
const myWorkOpen: Signal<boolean> = signal(false);

export const activeView: ReadonlySignal<View> = computed(() =>
  myWorkOpen.value ? { kind: "my-work" } : { kind: "list", listId: route.value.listId }
);

/** The list the board should render, or null while My Work is showing. */
export const activeListId: ReadonlySignal<string | null> = computed(() =>
  myWorkOpen.value ? null : route.value.listId
);

export function openList(spaceId: string, listId: string): void {
  myWorkOpen.value = false;
  closeDrawer();
  navigate(listPath(spaceId, listId, route.value.taskId));
}

export function showMyWork(): void {
  myWorkOpen.value = true;
  closeDrawer();
}

/**
 * What the panel should put the caret in when it mounts. A nonce rather than a
 * boolean: pressing C twice on the same task has to focus the composer twice,
 * and the panel is already open the second time.
 */
export type PanelFocus = { taskId: string; target: "comment"; nonce: number };

export const panelFocus: Signal<PanelFocus | null> = signal(null);

let focusNonce = 0;

export function openTask(taskId: string, opts?: { focus?: "comment" }): void {
  if (opts?.focus === "comment") {
    panelFocus.value = { taskId, target: "comment", nonce: ++focusNonce };
  }
  navigate(withTask(taskId));
}

export function closeTask(): void {
  if (route.value.taskId === null) return;
  navigate(withTask(null));
}

// --- mobile drawer ---------------------------------------------------------
// Below `sm` the 240px nav would leave the board about 135px of room, so it
// becomes a slide-over. The signal exists at every width — it is simply
// irrelevant once the sidebar is back in the layout flow — which keeps the
// "close on navigate" rule above a single unconditional call.

export const drawerOpen: Signal<boolean> = signal(false);

export function openDrawer(): void {
  drawerOpen.value = true;
}

export function closeDrawer(): void {
  if (drawerOpen.value) drawerOpen.value = false;
}

export function toggleDrawer(): void {
  drawerOpen.value = !drawerOpen.value;
}

// --- sidebar chrome --------------------------------------------------------
// Space expansion, pins and the dormant-list buckets live in shell/prefs.ts:
// they persist, and resolving the active list's space means reading the store,
// which this module deliberately does not do.

export const showArchived: Signal<boolean> = signal(false);
