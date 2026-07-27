// The ⌘K command palette.
//
// Three ranked sections, always in this order: tasks, then places (lists and
// spaces), then actions. Tasks come first because that is what the shortcut is
// reached for; actions come last because they are the only section that is
// still useful when nothing matched.
//
// Task results have two origins that are deliberately not the same thing:
//
//   local   — the loaded snapshot, filtered on every keystroke. Instant, and
//             the only source that can rank by how well the title matched.
//   server  — POST /api/tasks/search after a 250ms pause. FTS covers the
//             description and everything the tab never loaded, so a hit whose
//             task is absent from the snapshot is badged "archive". Opening it
//             still works: the panel fetches its own detail from /t/:id.
//
// Server hits are merged beneath the local ones rather than re-ranked with
// them — an FTS score and a title-match score are not comparable, and shuffling
// results under the cursor 250ms after the user stopped typing is worse than
// any ordering gain.
import type { JSX } from "preact";
import { signal, type Signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { TaskRow } from "@flow/shared";
import { api } from "../lib/api.js";
import { isDark, toggleDark } from "../lib/theme.js";
import { requestNewTask } from "../board/compose.js";
import { openSettings } from "../settings/route.js";
import { listById as listMap, spaceById as spaceMap, statusById, tasks } from "../store/index.js";
import { listsOfSpace, orderedSpaces, spaceOfList } from "./data.js";
import { cn } from "./format.js";
import { activeView, openDrawer, openList, openTask, showMyWork } from "./nav.js";
import { newListFor, newSpaceOpen } from "./organize.js";
import { recentListRows, recentTaskRows } from "./recents.js";
import {
  Bars, Inbox, ListIcon, Moon, Plus, Search, GearSmall, SpaceIcon, StatusDot, Sun,
} from "./ui.js";

// --- open/close ------------------------------------------------------------

export const paletteOpen: Signal<boolean> = signal(false);

export function openPalette(): void {
  paletteOpen.value = true;
}

export function closePalette(): void {
  paletteOpen.value = false;
}

export function togglePalette(): void {
  paletteOpen.value = !paletteOpen.value;
}

// --- matching --------------------------------------------------------------

/**
 * Lower is better; null means no match. The bands are wide enough that a
 * within-band tweak can never outrank a better kind of match: a prefix always
 * beats a word-start, which always beats a mid-word substring, which always
 * beats a scattered subsequence.
 */
function score(text: string, q: string): number | null {
  if (q === "") return 0;
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at === 0) return at;
  if (at > 0) {
    const prev = t.charCodeAt(at - 1);
    const alnum =
      (prev >= 97 && prev <= 122) || (prev >= 48 && prev <= 57); // a-z 0-9
    return (alnum ? 30 : 10) + Math.min(at, 60) * 0.05;
  }
  // Subsequence: every query character in order, penalised by how far apart
  // the characters ended up and how late the first one landed.
  let from = 0;
  let gaps = 0;
  let first = -1;
  for (let i = 0; i < q.length; i++) {
    const k = t.indexOf(q[i]!, from);
    if (k === -1) return null;
    if (first === -1) first = k;
    else gaps += k - from;
    from = k + 1;
  }
  return 100 + Math.min(gaps, 200) * 0.1 + Math.min(first, 60) * 0.05;
}

// --- items -----------------------------------------------------------------

type Section = "tasks" | "places" | "actions";

const SECTION_LABEL: Record<Section, string> = {
  tasks: "Tasks",
  places: "Lists & spaces",
  actions: "Actions",
};

type Item = {
  id: string;
  section: Section;
  label: string;
  /** Right-hand context: a breadcrumb, or what an action will do. */
  hint?: string;
  badge?: string;
  /** Status colour, for task rows. */
  dot?: string;
  icon?: JSX.Element;
  run: () => void;
  score: number;
};

const MAX_TASKS = 8;
const MAX_PLACES = 6;

function taskItem(
  row: { id: string; title: string; listId: string; statusId: string },
  s: number,
  badge?: string
): Item {
  const list = listMap.value.get(row.listId);
  const space = spaceOfList(row.listId);
  const crumb = [space?.name, list?.name].filter(Boolean).join(" / ");
  return {
    id: `task:${row.id}`,
    section: "tasks",
    label: row.title,
    hint: crumb || undefined,
    badge,
    dot: statusById.value.get(row.statusId)?.color,
    run: () => openTask(row.id),
    score: s,
  };
}

/** Snapshot tasks whose title matches. Read during render, so it is reactive. */
function localTasks(q: string): Item[] {
  const out: Item[] = [];
  for (const t of tasks.value.values()) {
    const s = score(t.title, q);
    if (s === null) continue;
    out.push(taskItem(t, s));
  }
  out.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
  return out.slice(0, MAX_TASKS);
}

function places(q: string): Item[] {
  const out: Item[] = [];

  const myWorkScore = score("My Work", q);
  if (myWorkScore !== null) {
    out.push({
      id: "place:my-work",
      section: "places",
      label: "My Work",
      hint: "Everything assigned to you",
      icon: <Inbox class="h-3.5 w-3.5 text-faint" />,
      run: showMyWork,
      score: myWorkScore - 1, // pinned just above an equally-good list
    });
  }

  for (const space of orderedSpaces(false)) {
    const spaceScore = score(space.name, q);
    if (spaceScore !== null) {
      const first = listsOfSpace(space.id, false)[0];
      out.push({
        id: `space:${space.id}`,
        section: "places",
        label: space.name,
        hint: "Space",
        icon: <SpaceIcon class="h-3.5 w-3.5 text-faint" />,
        // A space is not a destination on its own, so it opens its first list.
        run: () => {
          if (first) openList(space.id, first.id);
          else openDrawer();
        },
        score: spaceScore + 2,
      });
    }
    for (const list of listsOfSpace(space.id, false)) {
      // Matching against the breadcrumb means "acme bugs" finds it too.
      const s = Math.min(
        score(list.name, q) ?? Number.POSITIVE_INFINITY,
        (score(`${space.name} / ${list.name}`, q) ?? Number.POSITIVE_INFINITY) + 1
      );
      if (!Number.isFinite(s)) continue;
      out.push({
        id: `list:${list.id}`,
        section: "places",
        label: list.name,
        hint: space.name,
        icon: <ListIcon class="h-3.5 w-3.5 text-faint" />,
        run: () => openList(space.id, list.id),
        score: s,
      });
    }
  }

  out.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
  return out.slice(0, MAX_PLACES);
}

function actions(q: string): Item[] {
  const view = activeView.value;
  const listId = view.kind === "list" ? view.listId : null;
  const list = listId ? listMap.value.get(listId) : undefined;
  const space = list ? spaceMap.value.get(list.spaceId) : undefined;
  const targetSpace = space ?? orderedSpaces(false)[0];

  const defs: { label: string; hint?: string; icon: JSX.Element; run: () => void }[] = [];

  if (list) {
    defs.push({
      label: `New task in ${list.name}`,
      hint: "Opens the quick-add",
      icon: <Plus class="h-3.5 w-3.5 text-faint" />,
      run: () => {
        openList(list.spaceId, list.id);
        requestNewTask(list.id);
      },
    });
  }

  if (targetSpace) {
    defs.push({
      label: "New list…",
      hint: targetSpace.name,
      icon: <ListIcon class="h-3.5 w-3.5 text-faint" />,
      run: () => {
        newListFor.value = targetSpace.id;
      },
    });
  }

  defs.push({
    label: "New space…",
    hint: "In the sidebar",
    icon: <SpaceIcon class="h-3.5 w-3.5 text-faint" />,
    run: () => {
      // The composer lives in the sidebar, which is a slide-over on phones —
      // opening it behind a closed drawer would type into nothing.
      openDrawer();
      newSpaceOpen.value = true;
    },
  });

  defs.push({
    label: "Open settings",
    hint: "Automations, API keys, inbound",
    icon: <GearSmall class="h-3.5 w-3.5 text-faint" />,
    run: openSettings,
  });

  const dark = isDark.value;
  defs.push({
    label: dark ? "Switch to light mode" : "Switch to dark mode",
    hint: "Appearance",
    icon: dark ? <Sun class="h-3.5 w-3.5 text-faint" /> : <Moon class="h-3.5 w-3.5 text-faint" />,
    run: toggleDark,
  });

  const out: Item[] = [];
  for (const d of defs) {
    const s = score(d.label, q);
    if (s === null) continue;
    out.push({ id: `action:${d.label}`, section: "actions", ...d, score: s });
  }
  // Definition order is the useful order for an empty query, so a tie keeps it.
  return out;
}

/**
 * The empty-query view: what you were just doing, then the fixed rows.
 *
 * Recents come off the same store as the sidebar's Recent tab (shell/recents),
 * already aged out, de-pinned and resolved — so an id the snapshot cannot
 * explain simply does not appear here either. My Work and the actions sit
 * beneath them because they are always in the same place, and a list you closed
 * a minute ago is the thing you are most likely reaching for.
 */
function defaults(): Item[] {
  const out: Item[] = recentTaskRows.value.map(({ task }) => taskItem(task, 0));

  for (const list of recentListRows.value) {
    out.push({
      id: `list:${list.id}`,
      section: "places",
      label: list.name,
      hint: spaceMap.value.get(list.spaceId)?.name ?? "Recent",
      icon: <ListIcon class="h-3.5 w-3.5 text-faint" />,
      run: () => openList(list.spaceId, list.id),
      score: 0,
    });
  }

  out.push({
    id: "place:my-work",
    section: "places",
    label: "My Work",
    hint: "Everything assigned to you",
    icon: <Inbox class="h-3.5 w-3.5 text-faint" />,
    run: showMyWork,
    score: 1,
  });

  return [...out, ...actions("")];
}

// --- server search ---------------------------------------------------------

const DEBOUNCE_MS = 250;

function useServerHits(query: string): TaskRow[] {
  const [rows, setRows] = useState<TaskRow[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setRows([]);
      return;
    }
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      api
        .searchTasks({ query: q, includeClosed: true, limit: 10 })
        .then((res) => {
          if (seq.current === mine) setRows(res.tasks);
        })
        .catch(() => {
          // The API being unreachable under `vite dev` is normal, and the local
          // results are already on screen. Fail quiet.
          if (seq.current === mine) setRows([]);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  return rows;
}

// --- the palette -----------------------------------------------------------

export function CommandPalette() {
  if (!paletteOpen.value) return null;
  return <Palette />;
}

function Palette() {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const serverRows = useServerHits(query);
  const q = query.trim().toLowerCase();

  // Signals are read inside this render, so a delta arriving mid-search
  // refreshes the results without a refetch.
  const local = q === "" ? [] : localTasks(q);
  const localIds = new Set(local.map((i) => i.id));
  const merged: Item[] = [...local];
  if (q !== "") {
    const snapshot = tasks.value;
    for (const row of serverRows) {
      if (localIds.has(`task:${row.id}`)) continue;
      merged.push(taskItem(row, 1000, snapshot.has(row.id) ? undefined : "archive"));
    }
  }

  const items: Item[] =
    q === "" ? defaults() : [...merged.slice(0, MAX_TASKS + 4), ...places(q), ...actions(q)];

  // The cursor is an index into a flat list, so Down never has to know where a
  // section ends. Clamped here rather than in the key handler because the list
  // also shrinks on its own when server hits arrive or a delta lands.
  const max = items.length - 1;
  const active = Math.min(Math.max(cursor, 0), Math.max(max, 0));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>("[data-active='true']");
    el?.scrollIntoView({ block: "nearest" });
  }, [active, items.length]);

  const run = (item: Item | undefined): void => {
    if (!item) return;
    closePalette();
    item.run();
  };

  // Capture phase: the task panel closes on a bubbled Escape, and the palette
  // is on top of it, so the key has to be consumed before it gets there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closePalette();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => (max < 0 ? 0 : (Math.min(Math.max(c, 0), max) + 1) % (max + 1)));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => (max < 0 ? 0 : (Math.min(Math.max(c, 0), max) + max) % (max + 1)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(items[active]);
    } else if (e.key === "Home") {
      setCursor(0);
    } else if (e.key === "End") {
      setCursor(Math.max(max, 0));
    }
  };

  let lastSection: Section | null = null;

  return (
    <div
      class="fixed inset-0 z-[65] flex items-start justify-center bg-black/30 px-4 pt-[12vh] animate-[flow-fade-in_120ms_ease-out]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closePalette();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        class="flex w-[560px] max-w-full flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl shadow-black/20 animate-[flow-pop_120ms_ease-out]"
      >
        <div class="flex items-center gap-2.5 border-b border-line px-3.5 py-3">
          <Search class="h-4 w-4 shrink-0 text-faint" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="flow-palette-results"
            aria-activedescendant={items[active] ? `flow-palette-${active}` : undefined}
            spellcheck={false}
            autocomplete="off"
            placeholder="Search tasks, jump to a list, run a command…"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={onKeyDown}
            class="min-w-0 flex-1 bg-transparent text-[14px] text-text outline-none placeholder:text-faint focus-visible:outline-hidden!"
          />
          <kbd class="hidden shrink-0 rounded border border-line bg-raised px-1.5 py-px font-sans text-[10px] font-medium text-faint sm:block">
            esc
          </kbd>
        </div>

        <div
          ref={listRef}
          id="flow-palette-results"
          role="listbox"
          class="scroll-y max-h-[52vh] min-h-0 overflow-y-auto p-1.5"
        >
          {items.length === 0 && (
            <p class="px-3 py-6 text-center text-[12.5px] text-faint">
              Nothing matches “{query.trim()}”.
            </p>
          )}
          {items.map((item, i) => {
            const header = item.section !== lastSection ? item.section : null;
            lastSection = item.section;
            const on = i === active;
            return (
              <div key={item.id}>
                {header && (
                  <p
                    class={cn(
                      "px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-faint",
                      i === 0 ? "pt-1" : "pt-2.5"
                    )}
                  >
                    {SECTION_LABEL[header]}
                  </p>
                )}
                <button
                  type="button"
                  id={`flow-palette-${i}`}
                  role="option"
                  aria-selected={on}
                  data-active={on ? "true" : "false"}
                  onMouseMove={() => {
                    if (!on) setCursor(i);
                  }}
                  onClick={() => run(item)}
                  class={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-left transition-colors",
                    on ? "bg-accent-soft" : "hover:bg-bg"
                  )}
                >
                  <span class="flex h-4 w-4 shrink-0 items-center justify-center">
                    {item.dot ? <StatusDot color={item.dot} /> : item.icon}
                  </span>
                  <span
                    class={cn(
                      "min-w-0 flex-1 truncate text-[13.5px]",
                      on ? "font-medium text-text" : "text-text"
                    )}
                  >
                    {item.label}
                  </span>
                  {item.badge && (
                    <span class="shrink-0 rounded border border-line px-1 text-[10px] uppercase tracking-wide text-faint">
                      {item.badge}
                    </span>
                  )}
                  {item.hint && (
                    <span class="hidden max-w-[42%] shrink truncate text-[11.5px] text-faint sm:block">
                      {item.hint}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        <div class="hidden items-center gap-3 border-t border-line bg-raised px-3.5 py-2 text-[11px] text-faint sm:flex">
          <Hint keys="↑↓">navigate</Hint>
          <Hint keys="↵">open</Hint>
          <Hint keys="esc">close</Hint>
          <span class="ml-auto">{items.length} result{items.length === 1 ? "" : "s"}</span>
        </div>
      </div>
    </div>
  );
}

function Hint({ keys, children }: { keys: string; children: string }) {
  return (
    <span class="flex items-center gap-1">
      <kbd class="rounded border border-line bg-surface px-1 py-px font-sans text-[10px] font-medium text-faint">
        {keys}
      </kbd>
      {children}
    </span>
  );
}

// --- the shell's trigger ---------------------------------------------------

/** The top bar's search affordance. It has never been a text field — it opens
 *  the palette, which is where searching actually happens. */
export function PaletteTrigger() {
  return (
    <button
      type="button"
      onClick={openPalette}
      aria-label="Search tasks"
      class="group relative hidden h-[30px] w-[170px] items-center rounded-lg border border-line bg-surface pl-8 pr-11 text-left transition-colors hover:border-line-strong sm:flex md:w-[220px]"
    >
      <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
      <span class="truncate text-[13px] text-faint">Search tasks</span>
      <kbd class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-line bg-raised px-1 py-px font-sans text-[10px] font-medium text-faint">
        ⌘K
      </kbd>
    </button>
  );
}

/** The phone-width counterpart: just the magnifier. */
export function PaletteIconButton() {
  return (
    <button
      type="button"
      onClick={openPalette}
      aria-label="Search tasks"
      class="inline-flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-bg hover:text-text sm:hidden"
    >
      <Search class="h-4 w-4" />
    </button>
  );
}

/** The hamburger. Only meaningful below `sm`, where the sidebar is a drawer. */
export function DrawerButton() {
  return (
    <button
      type="button"
      onClick={openDrawer}
      aria-label="Open navigation"
      class="-ml-1 inline-flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-bg hover:text-text sm:hidden"
    >
      <Bars class="h-4 w-4" />
    </button>
  );
}
