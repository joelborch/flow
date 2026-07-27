import type { List } from "@flow/shared";
import { connected, spaceById, users } from "../store/index.js";
import { initials } from "../lib/fmt.js";
import { shellModule } from "../lib/shell-bridge.js";
import {
  assigneeFilter, clearFilters, filtersActive, mineOnly, search, showSnoozed, statusFilter,
  toggleStatus,
} from "./filters.js";

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
            <span class="text-[11px] font-medium uppercase tracking-wider text-faint">
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
        {/* Statuses can outnumber a phone's width, so they scroll sideways
            rather than wrapping into a three-line header. */}
        <div class="flex w-full items-center gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:w-auto sm:overflow-visible sm:pb-0">
          {statuses.map((status) => {
            const on = active.has(status.id);
            return (
              <button
                key={status.id}
                type="button"
                onClick={() => toggleStatus(status.id)}
                aria-pressed={on}
                class={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-1 text-[11px] transition-colors sm:py-[3px] ${
                  on
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-line bg-surface text-muted hover:border-line-strong"
                }`}
              >
                <span
                  class="h-[6px] w-[6px] rounded-full"
                  style={{ backgroundColor: status.color }}
                />
                {status.name}
              </button>
            );
          })}
        </div>

        <span class="mx-1 hidden h-4 w-px bg-line sm:block" aria-hidden="true" />

        <button
          type="button"
          onClick={() => {
            mineOnly.value = !mineOnly.value;
            if (mineOnly.value) assigneeFilter.value = null;
          }}
          aria-pressed={mineOnly.value}
          class={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] transition-colors sm:py-[3px] ${
            mineOnly.value
              ? "border-accent bg-accent-soft font-medium text-accent"
              : "border-line bg-surface text-muted hover:border-line-strong"
          }`}
        >
          Mine
        </button>

        <button
          type="button"
          onClick={() => {
            showSnoozed.value = !showSnoozed.value;
          }}
          aria-pressed={showSnoozed.value}
          title="Snoozed cards are hidden until their wake date, or until someone comments"
          class={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] transition-colors sm:py-[3px] ${
            showSnoozed.value
              ? "border-accent bg-accent-soft font-medium text-accent"
              : "border-line bg-surface text-muted hover:border-line-strong"
          }`}
        >
          Show snoozed
        </button>

        <label class="relative shrink-0">
          <span class="sr-only">Filter by assignee</span>
          <select
            value={assigneeFilter.value ?? ""}
            disabled={mineOnly.value}
            onChange={(ev) => {
              const v = (ev.currentTarget as HTMLSelectElement).value;
              assigneeFilter.value = v === "" ? null : v;
            }}
            class="appearance-none rounded-full border border-line bg-surface py-1 pl-2.5 pr-6 text-[11px] text-muted hover:border-line-strong disabled:opacity-50 sm:py-[3px]"
          >
            <option value="">Anyone</option>
            {roster.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({initials(u.name)})
              </option>
            ))}
          </select>
          <svg
            class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-faint"
            width="8"
            height="8"
            viewBox="0 0 8 8"
            aria-hidden="true"
          >
            <path d="M1 2.5 4 5.5l3-3" fill="none" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </label>

        <div class="ml-auto flex min-w-0 flex-1 items-center gap-1.5 sm:flex-none">
          {filtersActive.value ? (
            <button
              type="button"
              onClick={clearFilters}
              class="shrink-0 rounded px-1.5 py-1 text-[11px] text-muted hover:text-text sm:py-[3px]"
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
            class="w-full min-w-0 rounded-full border border-line bg-surface px-2.5 py-1 text-[16px] text-text placeholder:text-faint hover:border-line-strong focus:border-accent focus:outline-none sm:w-44 sm:py-[3px] sm:text-[11px]"
          />
        </div>
      </div>
    </header>
  );
}
