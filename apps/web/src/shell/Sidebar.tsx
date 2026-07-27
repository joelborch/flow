// Spaces as collapsible groups, lists beneath, My Work
// and pinned lists on top, archived tucked away at the bottom.
//
// The organising idea is that a real workspace (ten spaces, sixty lists, most
// of them dormant) must not arrive as sixty rows. So: spaces are collapsed
// until you open one, the space you are working in opens itself, lists with
// nothing open fold into a single "N inactive lists" row, and anything you
// actually care about gets pinned to the top. See shell/prefs.ts for what
// survives a reload.
import type { List, Space } from "@flow/shared";
import { listById, me, statusById, updateList, updateSpace, type StoreTask } from "../store/index.js";
import {
  listsOfSpace, myOpenTasks, openCountOfList, openCountOfSpace, orderedSpaces, spaceById,
} from "./data.js";
import { cn, relativeTime } from "./format.js";
import { activeView, closeDrawer, openList, openTask, showArchived, showMyWork } from "./nav.js";
import {
  AddListButton, NewSpaceComposer, RenameRow, RowMenu, renamingId, startRename,
} from "./organize.js";
import {
  DORMANT_MIN, expandedSpaces, dormantOpen, isPinned, pinnedLists, setSidebarMode, sidebarMode,
  toggleDormant, togglePin, toggleSpace, type SidebarMode,
} from "./prefs.js";
import { recentListRows, recentTaskRows } from "./recents.js";
import { Archive, ChevronDown, ChevronRight, Inbox, StatusDot, X } from "./ui.js";

function Wordmark() {
  return (
    <div class="flex h-[52px] shrink-0 items-center gap-2 px-4">
      {/* Two offset bars: work moving from one column to the next. */}
      <span class="flex h-[22px] w-[22px] items-center justify-center rounded-[6px] bg-accent">
        <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" stroke="white" stroke-width="1.9" stroke-linecap="round">
          <path d="M4 5.5h8M4 10.5h4.5" />
        </svg>
      </span>
      <span class="min-w-0 flex-1 truncate text-[14.5px] font-semibold tracking-[-0.02em] text-text">
        Flow
      </span>
      {/* Only reachable while the drawer is up; at sm+ the nav is never over
          anything, so there is nothing to dismiss. */}
      <button
        type="button"
        onClick={closeDrawer}
        aria-label="Close navigation"
        class="-mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-bg hover:text-text sm:hidden"
      >
        <X class="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ActiveRail() {
  return (
    <span class="absolute left-0 top-1/2 h-3.5 w-[2px] -translate-y-1/2 rounded-r-full bg-accent" />
  );
}

/**
 * A space's header row. The chevron, the name, the + and the ⋯ are separate
 * controls, so the row is a flex container rather than one big button — a
 * button inside a button is invalid and swallows the inner click.
 */
function SpaceHeader({ space, collapsed, focused }: { space: Space; collapsed: boolean; focused: boolean }) {
  const renaming = renamingId.value === space.id;
  const openCount = openCountOfSpace(space.id);
  const stopRename = (): void => {
    renamingId.value = null;
  };

  return (
    <div class="group flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">
      <button
        type="button"
        onClick={() => toggleSpace(space.id)}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${space.name}`}
        class="flex shrink-0 items-center transition-colors hover:text-muted"
      >
        {collapsed ? <ChevronRight class="h-3 w-3" /> : <ChevronDown class="h-3 w-3" />}
      </button>

      {space.color && (
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: space.color }} />
      )}

      {renaming ? (
        <RenameRow
          value={space.name}
          class="text-[11px] font-semibold uppercase tracking-[0.06em]"
          onCancel={stopRename}
          onCommit={(name) => {
            stopRename();
            void updateSpace(space.id, { name });
          }}
        />
      ) : (
        <>
          <button
            type="button"
            onClick={() => toggleSpace(space.id)}
            class="min-w-0 flex-1 truncate text-left transition-colors hover:text-muted"
          >
            {space.name}
          </button>
          {space.archived && <span class="shrink-0 normal-case tracking-normal">archived</span>}
          {/* A collapsed space still has to say whether anything is happening
              inside it; expanded, the per-list counts already say it. Fades on
              hover so it never competes with the + and the ⋯. */}
          {collapsed && openCount > 0 && (
            <span class="shrink-0 tabular-nums normal-case tracking-normal text-faint transition-opacity group-hover:opacity-0">
              {openCount}
            </span>
          )}
          <AddListButton spaceId={space.id} show={focused} />
          <RowMenu
            label={`${space.name} actions`}
            show={focused}
            actions={[
              { label: "Rename", onSelect: () => startRename(space.id) },
              {
                label: space.archived ? "Unarchive" : "Archive",
                onSelect: () => void updateSpace(space.id, { archived: !space.archived }),
              },
            ]}
          />
        </>
      )}
    </div>
  );
}

/**
 * One list. `breadcrumb` is the owning space's name, shown only in the Pinned
 * section — up there the row has no group header above it to say where it
 * lives, so it carries its own.
 */
function ListRow({
  list,
  active,
  breadcrumb,
}: {
  list: List;
  active: boolean;
  breadcrumb?: string;
}) {
  const count = openCountOfList(list.id);
  const pinned = isPinned(list.id);
  const renaming = renamingId.value === list.id;
  const stopRename = (): void => {
    renamingId.value = null;
  };

  return (
    <div
      class={cn(
        "group relative flex w-full items-center gap-2 rounded-lg py-[5px] pr-1.5 text-[13px] transition-colors",
        breadcrumb === undefined ? "pl-[26px]" : "pl-2",
        active ? "bg-accent-soft font-medium text-text" : "text-muted hover:bg-raised hover:text-text",
        list.archived && !active && "text-faint"
      )}
    >
      {active && <ActiveRail />}

      {renaming ? (
        <RenameRow
          value={list.name}
          onCancel={stopRename}
          onCommit={(name) => {
            stopRename();
            void updateList(list.id, { name });
          }}
        />
      ) : (
        <>
          <button
            type="button"
            onClick={() => openList(list.spaceId, list.id)}
            title={breadcrumb === undefined ? list.name : `${breadcrumb} / ${list.name}`}
            class="min-w-0 flex-1 text-left"
          >
            <span
              class={cn(
                "block truncate",
                list.archived && "line-through decoration-[1px] opacity-70"
              )}
            >
              {list.name}
            </span>
            {breadcrumb !== undefined && (
              <span class="block truncate text-[11px] font-normal leading-[1.35] text-faint">
                {breadcrumb}
              </span>
            )}
          </button>
          {list.archived && (
            <span class="shrink-0 rounded border border-line px-1 text-[10px] uppercase tracking-wide text-faint">
              archived
            </span>
          )}
          {count > 0 && (
            <span
              class={cn(
                "shrink-0 text-[11.5px] tabular-nums transition-opacity group-hover:opacity-0",
                active ? "text-muted" : "text-faint"
              )}
            >
              {count}
            </span>
          )}
          {/* Overlaid rather than in the flex flow, so revealing it on hover
              never shifts the name or the count. */}
          <RowMenu
            class="absolute right-1.5 top-1/2 -translate-y-1/2 bg-inherit"
            label={`${list.name} actions`}
            actions={[
              { label: "Rename", onSelect: () => startRename(list.id) },
              { label: pinned ? "Unpin" : "Pin", onSelect: () => togglePin(list.id) },
              {
                label: list.archived ? "Unarchive" : "Archive",
                onSelect: () => void updateList(list.id, { archived: !list.archived }),
              },
            ]}
          />
        </>
      )}
    </div>
  );
}

/**
 * Pins, resolved against the store and rendered in pin order. Ids that no
 * longer name a list (deleted elsewhere, or a stale key from another
 * workspace) are skipped rather than cleaned up — a read should not mutate
 * storage, and a resurrected id is a pin the user still wanted.
 */
function PinnedSection({ activeListId }: { activeListId: string | null }) {
  const byId = listById.value;
  const rows = pinnedLists.value
    .map((id) => byId.get(id))
    .filter((l): l is List => l !== undefined);

  if (rows.length === 0) return null;

  return (
    <>
      <p class="px-1.5 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">
        Pinned
      </p>
      <ul class="mb-2">
        {rows.map((list) => (
          <li key={list.id}>
            <ListRow
              list={list}
              active={activeListId === list.id}
              breadcrumb={spaceById(list.spaceId)?.name ?? "—"}
            />
          </li>
        ))}
      </ul>
      <div class="mx-2 mb-2 h-px bg-line" />
    </>
  );
}

/** The "N inactive lists" row that holds a space's dormant lists. */
function DormantToggle({ spaceId, count, open }: { spaceId: string; count: number; open: boolean }) {
  return (
    <button
      type="button"
      onClick={() => toggleDormant(spaceId)}
      aria-expanded={open}
      class="flex w-full items-center gap-1.5 rounded-lg py-[5px] pl-2 pr-1.5 text-left text-[12.5px] text-faint transition-colors hover:bg-raised hover:text-muted"
    >
      {open ? <ChevronDown class="h-3 w-3" /> : <ChevronRight class="h-3 w-3" />}
      <span class="min-w-0 flex-1 truncate">
        {count} inactive {count === 1 ? "list" : "lists"}
      </span>
    </button>
  );
}

/**
 * One space and its lists. Lists with open work always show; the rest sink
 * into the dormant bucket, except the list you are looking at — a list does
 * not get to hide itself out from under the board. Archived lists stay in
 * place too: asking to see them is already an explicit choice, and burying
 * them a second time would make the toggle look broken.
 */
function SpaceGroup({ space, activeListId }: { space: Space; activeListId: string | null }) {
  const includeArchived = showArchived.value;
  const collapsed = !expandedSpaces.value.has(space.id);
  const spaceLists = listsOfSpace(space.id, includeArchived);
  // The space holding the open list keeps its + and ⋯ on show; every other
  // space reveals them on hover only.
  const focused = activeListId !== null && spaceLists.some((l) => l.id === activeListId);

  const live: List[] = [];
  const dormant: List[] = [];
  for (const l of spaceLists) {
    const quiet =
      !l.archived && l.id !== activeListId && openCountOfList(l.id) === 0;
    (quiet ? dormant : live).push(l);
  }
  const bucketed = dormant.length >= DORMANT_MIN;
  const visible = bucketed ? live : spaceLists;
  const dormantShown = bucketed && dormantOpen.value.has(space.id);

  return (
    <div class="mb-1">
      <SpaceHeader space={space} collapsed={collapsed} focused={focused} />

      {!collapsed && (
        <ul class="mt-0.5">
          {spaceLists.length === 0 && (
            <li class="px-2 py-1 pl-[26px] text-[12.5px] text-faint">No lists</li>
          )}
          {visible.map((list) => (
            <li key={list.id}>
              <ListRow list={list} active={activeListId === list.id} />
            </li>
          ))}
          {bucketed && (
            <li>
              <DormantToggle spaceId={space.id} count={dormant.length} open={dormantShown} />
            </li>
          )}
          {dormantShown &&
            dormant.map((list) => (
              <li key={list.id}>
                <ListRow list={list} active={false} />
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

/** Group heading, same type as the Pinned label above. */
function GroupLabel({ children }: { children: string }) {
  return (
    <p class="px-1.5 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">
      {children}
    </p>
  );
}

/**
 * Projects / Recent. A two-way switch rather than a third nav item: both halves
 * answer "where do I go next", so they belong in the same slot, and the choice
 * is remembered because it reflects how someone works rather than what they are
 * doing this minute.
 */
function ModeSwitch() {
  const mode = sidebarMode.value;
  const options: Array<{ value: SidebarMode; label: string }> = [
    { value: "projects", label: "Projects" },
    { value: "recent", label: "Recent" },
  ];

  return (
    <div role="tablist" aria-label="Sidebar contents" class="mt-1.5 flex gap-0.5 rounded-lg bg-bg p-[3px]">
      {options.map((o) => {
        const on = mode === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => setSidebarMode(o.value)}
            class={cn(
              "min-w-0 flex-1 truncate rounded-[6px] px-2 py-[3px] text-[12px] transition-colors",
              on ? "bg-surface font-medium text-text shadow-[0_1px_2px_rgb(0_0_0/0.06)]" : "text-muted hover:text-text"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One recently-opened task. Denser than a My Work row because it is competing
 * with sixty list rows for the same 240px: the breadcrumb drops under the
 * title, and "when" is a two-character column on the right.
 */
function RecentTaskRow({ task, at }: { task: StoreTask; at: number }) {
  const status = statusById.value.get(task.statusId);
  const list = listById.value.get(task.listId);
  const space = spaceById(list?.spaceId);
  const crumb = [space?.name, list?.name].filter(Boolean).join(" / ");

  return (
    <button
      type="button"
      onClick={() => {
        closeDrawer();
        openTask(task.id);
      }}
      title={crumb ? `${crumb} / ${task.title}` : task.title}
      class="group flex w-full items-center gap-2 rounded-lg py-[5px] pl-2 pr-1.5 text-left transition-colors hover:bg-raised"
    >
      {status ? <StatusDot color={status.color} /> : <span class="h-2.5 w-2.5 shrink-0" />}
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[13px] text-muted group-hover:text-text">{task.title}</span>
        {crumb && <span class="block truncate text-[11px] leading-[1.35] text-faint">{crumb}</span>}
      </span>
      <span class="shrink-0 text-[11px] tabular-nums text-faint">{relativeTime(at)}</span>
    </button>
  );
}

/**
 * The Recent scroll region. It replaces the space tree and nothing else — the
 * wordmark, My Work, the switch and the footer all stay exactly where they
 * were, so flipping modes never moves anything you were aiming at.
 */
function RecentPanel({ activeListId }: { activeListId: string | null }) {
  const lists = recentListRows.value;
  const taskRows = recentTaskRows.value;

  if (lists.length === 0 && taskRows.length === 0) {
    return (
      <p class="px-2 py-3 text-[12.5px] text-faint">
        Nothing here yet. Lists and tasks you spend a moment on show up in this tab.
      </p>
    );
  }

  return (
    <>
      {lists.length > 0 && (
        <>
          <GroupLabel>Lists</GroupLabel>
          <ul class="mb-2">
            {lists.map((list) => (
              <li key={list.id}>
                <ListRow
                  list={list}
                  active={activeListId === list.id}
                  breadcrumb={spaceById(list.spaceId)?.name ?? "—"}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      {taskRows.length > 0 && (
        <>
          <GroupLabel>Tasks</GroupLabel>
          <ul>
            {taskRows.map(({ task, at }) => (
              <li key={task.id}>
                <RecentTaskRow task={task} at={at} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

export function Sidebar() {
  const view = activeView.value;
  const includeArchived = showArchived.value;
  const spaceList = orderedSpaces(includeArchived);
  const myCount = myOpenTasks(me.value?.id).length;
  const activeId = view.kind === "list" ? view.listId : null;
  const mode = sidebarMode.value;

  return (
    <nav
      aria-label="Workspace"
      class="flex h-full w-[240px] shrink-0 flex-col border-r border-line bg-surface"
    >
      <Wordmark />

      <div class="px-2 pb-2">
        <button
          type="button"
          onClick={showMyWork}
          class={cn(
            "relative flex w-full items-center gap-2 rounded-lg px-2 py-[6px] text-[13px] transition-colors",
            view.kind === "my-work"
              ? "bg-accent-soft font-medium text-text"
              : "text-muted hover:bg-raised hover:text-text"
          )}
        >
          {view.kind === "my-work" && <ActiveRail />}
          <Inbox class={cn("h-4 w-4", view.kind === "my-work" ? "text-accent" : "text-faint")} />
          <span class="min-w-0 flex-1 truncate text-left">My Work</span>
          {myCount > 0 && (
            <span class="shrink-0 text-[11.5px] tabular-nums text-faint">{myCount}</span>
          )}
        </button>

        <ModeSwitch />
      </div>

      <div class="mx-4 h-px bg-line" />

      <div class="scroll-y min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {mode === "recent" ? (
          <RecentPanel activeListId={activeId} />
        ) : (
          <>
            <PinnedSection activeListId={activeId} />

            {spaceList.length === 0 && (
              <p class="px-2 py-3 text-[12.5px] text-faint">No spaces yet.</p>
            )}

            {spaceList.map((space) => (
              <SpaceGroup key={space.id} space={space} activeListId={activeId} />
            ))}
          </>
        )}
      </div>

      <div class="shrink-0 border-t border-line px-2 py-2">
        <NewSpaceComposer />
        <button
          type="button"
          onClick={() => {
            showArchived.value = !showArchived.value;
          }}
          aria-pressed={includeArchived}
          class={cn(
            "flex w-full items-center gap-2 rounded-lg px-2 py-[6px] text-[12.5px] transition-colors",
            includeArchived
              ? "bg-accent-soft text-text"
              : "text-muted hover:bg-raised hover:text-text"
          )}
        >
          <Archive class="h-3.5 w-3.5 text-faint" />
          <span class="min-w-0 flex-1 truncate text-left">{includeArchived ? "Hide archived" : "Show archived"}</span>
        </button>
      </div>
    </nav>
  );
}
