import type { List } from "@flow/shared";
import { connected, spaceById, users } from "../store/index.js";
import { initials } from "../lib/fmt.js";
import { shellModule } from "../lib/shell-bridge.js";
import { ChevronDown, Menu, MenuItem } from "../shell/ui.js";
import {
  assigneeFilter, clearFilters, filtersActive, mineOnly, search, showSnoozed, statusFilter,
  toggleStatus,
} from "./filters.js";

// The filter controls share one shape and two states.
const PILL_SHAPE = "rounded-full border text-[12px] transition-colors";
const PILL_BUTTON = `flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 py-1 sm:py-[3px] ${PILL_SHAPE}`;
const PILL_ON = "border-accent bg-accent-soft font-medium text-accent";
const PILL_OFF = "border-line bg-surface text-muted hover:border-line-strong";
/** The assignee menu's value for "my tasks", which is its own filter flag. */
const MINE = "__mine";

function OfflineBadge() {
  if (connected.value) return null;
  return (
    <span
      class="flex items-center gap-1.5 rounded-full border border-line bg-raised px-2 py-[3px] text-[11px] text-muted"
      title="Reconnecting — changes are queued locally"
    >
      <span class="h-[6px] w-[6px] rounded-full bg-warn" />
      Offline
    </span>
  );
}

export function BoardHeader({ list, total }: { list: List; total: number }) {
  const space = spaceById.value.get(list.spaceId);
  const active = statusFilter.value;
  // The board draws its columns in position order; the chips have to agree, or
  // the filter row reads as a different pipeline than the one below it.
  const statuses = [...list.statuses].sort((a, b) => a.position - b.position);
  const roster = users.value.filter((u) => !u.deactivated);
  // The shell's top bar already names the list and reports the connection, so
  // the board only draws that row when it is running on its own.
  const standalone = shellModule.value === null;

  return (
    <header class="border-b border-line bg-bg/80 px-3 pb-2.5 pt-2.5 backdrop-blur sm:px-4 sm:pt-3">
      {standalone ? (
        <div class="flex items-baseline gap-2">
          {space ? (
            <span class="text-[11px] font-medium uppercase tracking-[0.07em] text-faint">
              {space.name}
            </span>
          ) : null}
          <h1 class="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-text">
            {list.name}
          </h1>
          <span class="tabular-nums text-[11px] text-faint">{total}</span>
          <div class="ml-auto flex items-center gap-2">
            <OfflineBadge />
          </div>
        </div>
      ) : null}

      <div
        class={`flex flex-wrap items-center gap-1.5 gap-y-2 sm:gap-y-1.5 ${standalone ? "mt-2.5" : ""}`}
      >
        {/* The columns below already name every status, so the filter for
            them is one button, not a second row of the same names. */}
        <Menu
          label="Filter by status"
          width="w-52"
          trigger={() => (
            <span class={`${PILL_BUTTON} ${active.size > 0 ? PILL_ON : PILL_OFF}`}>
              Status
              {active.size > 0 ? <span class="tabular-nums">· {active.size}</span> : null}
              <ChevronDown class="h-3 w-3" />
            </span>
          )}
        >
          {() => (
            <div>
              {statuses.map((status) => (
                <MenuItem key={status.id} selected={active.has(status.id)} onClick={() => toggleStatus(status.id)}>
                  <span class="flex items-center gap-2">
                    <span class="h-[7px] w-[7px] shrink-0 rounded-full" style={{ backgroundColor: status.color }} />
                    {status.name}
                  </span>
                </MenuItem>
              ))}
            </div>
          )}
        </Menu>

        {/* One control for whose tasks: "Mine" used to be a separate button
            that disabled this menu. */}
        <label class="relative shrink-0">
          <span class="sr-only">Filter by assignee</span>
          <select
            value={mineOnly.value ? MINE : (assigneeFilter.value ?? "")}
            onChange={(ev) => {
              const v = (ev.currentTarget as HTMLSelectElement).value;
              mineOnly.value = v === MINE;
              assigneeFilter.value = v === "" || v === MINE ? null : v;
            }}
            class={`appearance-none py-1 pl-2.5 pr-6 sm:py-[3px] ${PILL_SHAPE} ${
              mineOnly.value || assigneeFilter.value !== null ? PILL_ON : PILL_OFF
            }`}
          >
            <option value="">Anyone</option>
            <option value={MINE}>Mine</option>
            {roster.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({initials(u.name)})
              </option>
            ))}
          </select>
          <ChevronDown class="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-faint" />
        </label>

        <button
          type="button"
          onClick={() => {
            showSnoozed.value = !showSnoozed.value;
          }}
          aria-pressed={showSnoozed.value}
          title="Snoozed cards are hidden until their wake date, or until someone comments"
          class={`${PILL_BUTTON} ${showSnoozed.value ? PILL_ON : PILL_OFF}`}
        >
          Show snoozed
        </button>

        <div class="flex w-full min-w-0 items-center gap-1.5 sm:ml-auto sm:w-auto">
          {filtersActive.value ? (
            <button
              type="button"
              onClick={clearFilters}
              class="order-last shrink-0 rounded px-1.5 py-1 text-[12px] font-medium text-accent hover:bg-accent-soft sm:order-none sm:py-[3px]"
            >
              Reset
            </button>
          ) : null}
          <input
            type="search"
            value={search.value}
            placeholder="Search this list"
            aria-label="Search tasks in this list"
            onInput={(ev) => {
              search.value = (ev.currentTarget as HTMLInputElement).value;
            }}
            class="w-full min-w-0 rounded-full border border-line bg-surface px-3 py-1.5 text-[16px] text-text placeholder:text-faint hover:border-line-strong focus:border-accent focus:outline-none sm:w-48 sm:px-2.5 sm:py-[3px] sm:text-[12px]"
          />
        </div>
      </div>
    </header>
  );
}
