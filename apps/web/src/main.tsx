import { render } from "preact";
import { useEffect } from "preact/hooks";
import { Board } from "./board/index.js";
import { readBootCache, readCachedMe, setBootUserId } from "./lib/boot-cache.js";
import { listPath, navigate, routeListId, routeTaskId } from "./lib/router.js";
import { registerShell, shell, shellExists, shellModule } from "./lib/shell-bridge.js";
import { dismissToast, toasts } from "./lib/toast.js";
import { settingsOpen } from "./settings/route.js";
import * as shellMod from "./shell/index.js";
import {
  connect, connected, firstList, hydrate, hydrated, listById, listsBySpace, me, spaces, tasks,
} from "./store/index.js";
import "./styles.css";

// The shell owns the chrome and navigation. It is registered before the first
// render, so the board never paints its fallback sidebar first.
registerShell(shellMod);

// --- cached boot -----------------------------------------------------------
// Painting the real board is a local operation: last load's snapshot is sitting
// in localStorage, and the socket the inline script opened is already asking
// for the deltas since. Both happen before render, so the first frame is the
// user's actual workspace rather than "Connecting…".
//
// The cache is written for whoever was signed in at the time. We cannot know
// synchronously whether that is still this person, so store/ws.ts reconciles it
// against /api/me a moment later and wipes-and-reloads on a mismatch.
{
  const cached = readBootCache();
  if (cached) {
    setBootUserId(cached.userId);
    hydrate(cached.snapshot);
    me.value = readCachedMe();
  }
}

// --- fallback chrome -------------------------------------------------------
// Used until src/shell/index.tsx lands (that module owns navigation and the
// task detail panel). Keeps the board usable on its own.

function FallbackSidebar({ activeListId }: { activeListId: string | null }) {
  const bySpace = listsBySpace.value;
  return (
    <nav class="flex h-full w-[212px] shrink-0 flex-col border-r border-line bg-surface">
      <div class="flex items-center gap-2 px-3 py-3">
        <span class="h-[7px] w-[7px] rounded-full bg-accent" />
        <span class="text-[13px] font-semibold tracking-[-0.01em]">Flow</span>
        {!connected.value ? (
          <span class="ml-auto text-[10px] uppercase tracking-wider text-faint">offline</span>
        ) : null}
      </div>
      <div class="scroll-y flex-1 px-1.5 pb-3">
        {spaces.value.map((space) => (
          <div key={space.id} class="mb-3">
            <p class="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">
              {space.name}
            </p>
            {(bySpace.get(space.id) ?? []).map((list) => {
              const active = list.id === activeListId;
              return (
                <a
                  key={list.id}
                  href={listPath(space.id, list.id)}
                  onClick={(ev) => {
                    ev.preventDefault();
                    navigate(listPath(space.id, list.id));
                  }}
                  class={`block truncate rounded px-1.5 py-1 text-[12.5px] ${
                    active ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-raised"
                  }`}
                >
                  {list.name}
                </a>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}

function Toasts() {
  const items = toasts.value;
  if (items.length === 0) return null;
  return (
    <div class="pointer-events-none fixed bottom-4 left-1/2 z-[70] flex -translate-x-1/2 flex-col gap-1.5">
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismissToast(t.id)}
          class={`pointer-events-auto rounded-md border px-3 py-1.5 text-[12px] ${
            t.kind === "error"
              ? "border-danger bg-danger-soft text-danger"
              : "border-line bg-surface text-muted"
          }`}
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}

// --- app -------------------------------------------------------------------

function App() {
  useEffect(() => {
    void connect();
  }, []);

  const fallbackList = firstList.value;
  const routed = routeListId.value;
  const mod = shellModule.value;
  // The shell's view signal wins when it is mounted: it returns null while its
  // My Work overlay is up, and the URL's list id otherwise.
  const shellList = mod?.activeListId ? mod.activeListId.value : undefined;

  // Default route: the first list, once we know what that is. /settings carries
  // no list id and is a legitimate destination, so it opts out of the redirect —
  // otherwise a settings deep link would be bounced on hydration.
  //
  // A bare /t/:taskId is also list-less, and it is a real deep link (the one the
  // panel's header hands out). The redirect has to carry the task segment along
  // or the panel is closed before it ever opens; when the task is already in the
  // snapshot we land on its own board rather than an arbitrary first list.
  const inSettings = settingsOpen.value;
  const deepTaskId = routeTaskId.value;
  const deepTaskListId = deepTaskId ? (tasks.value.get(deepTaskId)?.listId ?? null) : null;
  const deepTaskSpaceId = deepTaskListId
    ? (listById.value.get(deepTaskListId)?.spaceId ?? null)
    : null;
  useEffect(() => {
    if (routed || !fallbackList || inSettings) return;
    const spaceId = deepTaskSpaceId ?? fallbackList.spaceId;
    const listId = deepTaskListId ?? fallbackList.id;
    navigate(listPath(spaceId, listId, deepTaskId), { replace: true });
  }, [routed, fallbackList?.id, inSettings, deepTaskId, deepTaskListId, deepTaskSpaceId]);

  const listId = shellList ?? routed ?? fallbackList?.id ?? null;

  const content = listId ? (
    <Board listId={listId} />
  ) : (
    <div class="grid h-full place-items-center text-[13px] text-faint">
      {hydrated.value ? "No lists yet." : "Connecting…"}
    </div>
  );

  const Shell = shell.value;
  if (Shell || shellExists) {
    return (
      <>
        {Shell ? <Shell>{content}</Shell> : <div class="h-screen w-screen" />}
        <Toasts />
      </>
    );
  }

  return (
    <>
      <div class="flex h-screen w-screen overflow-hidden">
        <FallbackSidebar activeListId={listId} />
        <main class="min-w-0 flex-1">{content}</main>
      </div>
      <Toasts />
    </>
  );
}

// DEV: a handle on the store so delta application can be poked from the
// console before the Worker is running. Stripped from production builds.
if (import.meta.env.DEV) {
  void import("./store/index.js").then((store) => {
    (globalThis as unknown as Record<string, unknown>).__flow = store;
  });
}

render(<App />, document.getElementById("app")!);
