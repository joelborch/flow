// History-based router. The whole app needs exactly three slots, so the route
// is parsed into them rather than matched against a pattern table:
//   /s/:spaceId/l/:listId        board
//   /t/:taskId                   task deep link (the shell renders the panel)
//   /s/:spaceId/l/:listId/t/:taskId  both
import { computed, signal, type ReadonlySignal } from "@preact/signals";

export type Route = {
  spaceId: string | null;
  listId: string | null;
  taskId: string | null;
  path: string;
};

function parse(path: string): Route {
  const seg = path.split("/").filter(Boolean);
  const at = (key: string): string | null => {
    const i = seg.indexOf(key);
    if (i === -1) return null;
    return seg[i + 1] ?? null;
  };
  return { spaceId: at("s"), listId: at("l"), taskId: at("t"), path };
}

export const route = signal<Route>(parse(location.pathname));

export const routeListId: ReadonlySignal<string | null> = computed(() => route.value.listId);
export const routeTaskId: ReadonlySignal<string | null> = computed(() => route.value.taskId);

if (typeof window !== "undefined") {
  addEventListener("popstate", () => {
    route.value = parse(location.pathname);
  });
}

export function navigate(path: string, opts?: { replace?: boolean }): void {
  if (path === route.value.path) return;
  // The route lives in the path; a query string (dev knobs, campaign tags) is
  // carried along rather than dropped on the first redirect.
  const url = path.includes("?") ? path : path + location.search;
  if (opts?.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  route.value = parse(path);
}

export function listPath(spaceId: string, listId: string, taskId?: string | null): string {
  const base = `/s/${spaceId}/l/${listId}`;
  return taskId ? `${base}/t/${taskId}` : base;
}

/** Keeps the current board location, swapping the task deep-link segment. */
export function withTask(taskId: string | null): string {
  const { spaceId, listId } = route.value;
  if (spaceId && listId) return listPath(spaceId, listId, taskId);
  return taskId ? `/t/${taskId}` : "/";
}
