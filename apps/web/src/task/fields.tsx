// The task panel's property editors. Every change goes
// straight through the store's optimistic updateTask; there is no local mirror
// of task fields, so a WS delta from anyone else lands here too.
import type { ComponentChildren } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import type { Priority } from "@flow/shared";
import { updateTask, users, type StoreTask } from "../store/index.js";
import { isClosed, statusesOf, statusOfTask, userById } from "../shell/data.js";
import { cn, formatDue, fromDateInput, isOverdue, toDateInput } from "../shell/format.js";
import { isSnoozed, snoozePreset, snoozeUntilLabel } from "../lib/fmt.js";
import {
  Avatar, Chip, Menu, MenuItem, PRIORITIES, PRIORITY_COLOR,
  PRIORITY_LABEL, PriorityFlag, Search, StatusDot, TagIcon, X,
} from "../shell/ui.js";

const FIELD =
  "flex min-h-[36px] w-full items-center gap-2 rounded-lg px-2 py-1 text-[13px] text-text transition-colors hover:bg-bg sm:min-h-[30px]";
const EMPTY = "text-faint";

// The label gutter narrows on a phone rather than stacking: five stacked rows
// would push the description off the first screen.
export function PropertyRow({ label, icon, children }: { label: string; icon?: ComponentChildren; children: ComponentChildren }) {
  return (
    <div class="flex items-start gap-2 py-0.5 sm:gap-3">
      <div class="flex w-[80px] shrink-0 items-center gap-1.5 pt-[9px] text-[12.5px] text-muted sm:w-[104px] sm:pt-[7px]">
        {icon}
        <span class="truncate">{label}</span>
      </div>
      <div class="-ml-2 min-w-0 flex-1">{children}</div>
    </div>
  );
}

// --- status ----------------------------------------------------------------

export function StatusPicker({ task }: { task: StoreTask }) {
  const statuses = statusesOf(task.listId);
  const current = statusOfTask(task);

  return (
    <Menu
      label="Change status"
      width="w-56"
      trigger={() => (
        <span class={FIELD}>
          {current ? (
            <>
              <StatusDot color={current.color} />
              <span class="truncate font-medium" style={{ color: current.color }}>{current.name}</span>
            </>
          ) : (
            <span class={EMPTY}>No status</span>
          )}
        </span>
      )}
    >
      {(close) =>
        statuses.map((s) => (
          <button
            key={s.id}
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              if (s.id !== task.statusId) void updateTask({ taskId: task.id, status: s.name });
            }}
            class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] text-text hover:bg-bg sm:py-1.5"
          >
            <StatusDot color={s.color} />
            <span class="min-w-0 flex-1 truncate">{s.name}</span>
            {s.id === task.statusId && <span class="text-[11px] font-medium text-faint">current</span>}
          </button>
        ))
      }
    </Menu>
  );
}

// --- assignee --------------------------------------------------------------

export function AssigneePicker({ task }: { task: StoreTask }) {
  const [q, setQ] = useState("");
  const assignee = userById(task.assigneeId);
  const all = users.value;

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const active = all.filter((u) => !u.deactivated || u.id === task.assigneeId);
    if (!needle) return active.slice(0, 50);
    return active
      .filter((u) => u.name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle))
      .slice(0, 50);
  }, [q, all, task.assigneeId]);

  return (
    <Menu
      label="Change assignee"
      width="w-64"
      trigger={() => (
        <span class={FIELD}>
          <Avatar user={assignee} size="sm" />
          <span class={cn("truncate", !assignee && EMPTY)}>{assignee ? assignee.name : "Unassigned"}</span>
        </span>
      )}
    >
      {(close) => (
        <div>
          <div class="flex items-center gap-1.5 border-b border-line px-2 pb-1.5 text-faint">
            <Search class="h-3.5 w-3.5" />
            <input
              autofocus
              value={q}
              placeholder="Assign to…"
              onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)}
              class="w-full bg-transparent py-1 text-[16px] text-text placeholder:text-faint focus:outline-none sm:text-[13px]"
            />
          </div>
          <div class="scroll-y max-h-64 overflow-y-auto pt-1">
            <MenuItem
              selected={task.assigneeId === null}
              onClick={() => {
                close();
                void updateTask({ taskId: task.id, assigneeId: null });
              }}
            >
              <span class="text-muted">Unassigned</span>
            </MenuItem>
            {matches.map((u) => (
              <button
                key={u.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  void updateTask({ taskId: task.id, assigneeId: u.id });
                }}
                class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] text-text hover:bg-bg sm:py-1.5"
              >
                <Avatar user={u} size="sm" />
                <span class="min-w-0 flex-1 truncate">{u.name}</span>
                {u.id === task.assigneeId && <span class="text-[11px] text-faint">assigned</span>}
              </button>
            ))}
            {matches.length === 0 && <p class="px-2 py-2 text-[12.5px] text-faint">No one matches “{q}”.</p>}
          </div>
        </div>
      )}
    </Menu>
  );
}

// --- due date --------------------------------------------------------------

export function DuePicker({ task }: { task: StoreTask }) {
  const ref = useRef<HTMLInputElement>(null);
  // A date in the past is only "overdue" while the task is still open; a done
  // task with last week's due date is just done.
  const overdue = isOverdue(task.dueDate) && !isClosed(task);

  return (
    <div class="group relative flex items-center">
      <span
        class={cn(FIELD, "cursor-pointer")}
        onClick={() => {
          const el = ref.current;
          if (!el) return;
          // showPicker is Chromium/Safari; the click fallback covers the rest.
          if (typeof el.showPicker === "function") el.showPicker();
          else el.focus();
        }}
      >
        <span class={cn(task.dueDate === null ? EMPTY : overdue ? "text-danger" : "text-text")}>
          {task.dueDate === null ? "No due date" : formatDue(task.dueDate)}
        </span>
        {overdue && <span class="text-[11px] font-medium text-danger">overdue</span>}
      </span>

      {task.dueDate !== null && (
        <button
          type="button"
          aria-label="Clear due date"
          onClick={() => void updateTask({ taskId: task.id, dueDate: null })}
          class="ml-1 rounded p-2 text-faint opacity-100 transition-opacity hover:bg-bg hover:text-muted sm:p-1 sm:opacity-0 sm:group-hover:opacity-100"
        >
          <X class="h-3 w-3" />
        </button>
      )}

      {/* Native picker, kept in flow but visually collapsed so the styled
          trigger above is what people see. */}
      <input
        ref={ref}
        type="date"
        aria-label="Due date"
        value={toDateInput(task.dueDate)}
        onChange={(e) => {
          const v = (e.currentTarget as HTMLInputElement).value;
          void updateTask({ taskId: task.id, dueDate: v ? fromDateInput(v) : null });
        }}
        class="absolute left-2 top-0 h-full w-px opacity-0"
      />
    </div>
  );
}

// --- snooze / waiting-on ---------------------------------------------------
// Snoozing hides the card from the board and drops the task to the bottom of My
// Work until its date passes or somebody comments on it. It never changes the
// status, so nothing about the pipeline is a lie while the task is parked.

export function SnoozePicker({ task }: { task: StoreTask }) {
  const ref = useRef<HTMLInputElement>(null);
  const snoozed = isSnoozed(task.snoozedUntil);

  const snoozeUntil = (ts: number) => void updateTask({ taskId: task.id, snoozedUntil: ts });

  return (
    <div class="group relative flex items-center">
      <Menu
        label="Snooze this task"
        width="w-56"
        trigger={() => (
          <span class={cn(FIELD, "cursor-pointer")}>
            <span class={cn(snoozed ? "text-text" : EMPTY)}>
              {snoozed && task.snoozedUntil !== null
                ? snoozeUntilLabel(task.snoozedUntil)
                : "Not snoozed"}
            </span>
          </span>
        )}
      >
        {(close) => (
          <div>
            <MenuItem
              onClick={() => {
                close();
                snoozeUntil(snoozePreset("tomorrow"));
              }}
            >
              Tomorrow
            </MenuItem>
            <MenuItem
              onClick={() => {
                close();
                snoozeUntil(snoozePreset("week"));
              }}
            >
              Next week
            </MenuItem>
            <MenuItem
              onClick={() => {
                close();
                // The native picker lives outside the menu, so it survives the
                // close; opening it on the next frame avoids racing the unmount.
                requestAnimationFrame(() => {
                  const el = ref.current;
                  if (!el) return;
                  if (typeof el.showPicker === "function") el.showPicker();
                  else el.focus();
                });
              }}
            >
              Pick a date…
            </MenuItem>
            {snoozed && (
              <>
                <div class="my-1 h-px bg-bg" />
                <MenuItem
                  onClick={() => {
                    close();
                    void updateTask({ taskId: task.id, snoozedUntil: null });
                  }}
                >
                  <span class="text-muted">Wake now</span>
                </MenuItem>
              </>
            )}
          </div>
        )}
      </Menu>

      {snoozed && (
        <button
          type="button"
          aria-label="Wake now"
          onClick={() => void updateTask({ taskId: task.id, snoozedUntil: null })}
          class="ml-1 rounded p-2 text-faint opacity-100 transition-opacity hover:bg-bg hover:text-muted sm:p-1 sm:opacity-0 sm:group-hover:opacity-100"
        >
          <X class="h-3 w-3" />
        </button>
      )}

      <input
        ref={ref}
        type="date"
        aria-label="Snooze until"
        value={toDateInput(task.snoozedUntil)}
        onChange={(e) => {
          const v = (e.currentTarget as HTMLInputElement).value;
          void updateTask({ taskId: task.id, snoozedUntil: v ? fromDateInput(v) : null });
        }}
        class="absolute left-2 top-0 h-full w-px opacity-0"
      />
    </div>
  );
}

/**
 * The "waiting on…" note. Free text, saved on blur or Enter — it is a reminder
 * for a person, not a reference to one, so there is nothing to resolve.
 */
export function BlockedNoteField({ task }: { task: StoreTask }) {
  const [draft, setDraft] = useState(task.blockedNote ?? "");
  const [focused, setFocused] = useState(false);
  // Someone else's edit should land here, but not while it is being typed into.
  if (!focused && (task.blockedNote ?? "") !== draft) setDraft(task.blockedNote ?? "");

  const commit = () => {
    setFocused(false);
    const next = draft.trim();
    if (next === (task.blockedNote ?? "")) return;
    void updateTask({ taskId: task.id, blockedNote: next === "" ? null : next });
  };

  return (
    <input
      value={draft}
      maxLength={200}
      placeholder="Waiting on…"
      aria-label="Waiting on"
      onFocus={() => setFocused(true)}
      onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setDraft(task.blockedNote ?? "");
          setFocused(false);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      onBlur={commit}
      class={cn(FIELD, "bg-transparent text-[16px] placeholder:text-faint focus:outline-none sm:text-[13px]")}
    />
  );
}

/**
 * The prominent state banner, shown above the properties while a task is
 * parked. The property row alone is too quiet for something that is actively
 * hiding this card from everyone's board.
 */
export function SnoozeBanner({ task }: { task: StoreTask }) {
  if (!isSnoozed(task.snoozedUntil) || task.snoozedUntil === null) return null;
  return (
    <div class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line bg-raised px-3 py-2 text-[12.5px]">
      <span class="font-medium text-text">{snoozeUntilLabel(task.snoozedUntil)}</span>
      {task.blockedNote ? <span class="min-w-0 truncate text-muted">waiting on {task.blockedNote}</span> : null}
      <span class="text-faint">· hidden from the board</span>
      <button
        type="button"
        onClick={() => void updateTask({ taskId: task.id, snoozedUntil: null })}
        class="ml-auto shrink-0 rounded-md border border-line bg-surface px-2 py-1 text-[12px] font-medium text-text hover:bg-bg"
      >
        Wake now
      </button>
    </div>
  );
}

// --- priority --------------------------------------------------------------

export function PriorityPicker({ task }: { task: StoreTask }) {
  return (
    <Menu
      label="Change priority"
      width="w-44"
      trigger={() => (
        <span class={FIELD}>
          {task.priority ? (
            <>
              <PriorityFlag priority={task.priority} />
              <span style={{ color: PRIORITY_COLOR[task.priority] }} class="font-medium">
                {PRIORITY_LABEL[task.priority]}
              </span>
            </>
          ) : (
            <span class={EMPTY}>No priority</span>
          )}
        </span>
      )}
    >
      {(close) => (
        <div>
          {PRIORITIES.map((p: Priority) => (
            <button
              key={p}
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                void updateTask({ taskId: task.id, priority: p });
              }}
              class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] text-text hover:bg-bg sm:py-1.5"
            >
              <PriorityFlag priority={p} />
              <span class="min-w-0 flex-1 truncate">{PRIORITY_LABEL[p]}</span>
            </button>
          ))}
          <div class="my-1 h-px bg-bg" />
          <MenuItem
            selected={task.priority === null}
            onClick={() => {
              close();
              void updateTask({ taskId: task.id, priority: null });
            }}
          >
            <span class="text-muted">Clear priority</span>
          </MenuItem>
        </div>
      )}
    </Menu>
  );
}

// --- tags ------------------------------------------------------------------

export function TagEditor({ task }: { task: StoreTask }) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (raw: string) => {
    const next = new Set(task.tags);
    let changed = false;
    for (const part of raw.split(",")) {
      const tag = part.trim().replace(/^#/, "");
      if (tag && !next.has(tag)) {
        next.add(tag);
        changed = true;
      }
    }
    setDraft("");
    if (changed) void updateTask({ taskId: task.id, tags: [...next] });
  };

  const remove = (tag: string) => {
    void updateTask({ taskId: task.id, tags: task.tags.filter((t) => t !== tag) });
  };

  return (
    <div class="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
      {task.tags.map((tag) => (
        <Chip key={tag} tone="accent" onRemove={() => remove(tag)}>{tag}</Chip>
      ))}

      {adding || task.tags.length === 0 ? (
        <input
          ref={inputRef}
          autofocus={adding}
          value={draft}
          placeholder={task.tags.length === 0 ? "Add a tag" : "Tag"}
          onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit(draft);
            } else if (e.key === "Backspace" && draft === "" && task.tags.length > 0) {
              e.preventDefault();
              const last = task.tags[task.tags.length - 1];
              if (last) remove(last);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setDraft("");
              setAdding(false);
            }
          }}
          onBlur={() => {
            commit(draft);
            setAdding(false);
          }}
          class="min-w-[86px] flex-1 bg-transparent text-[16px] text-text placeholder:text-faint focus:outline-none sm:text-[13px]"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-faint hover:bg-bg hover:text-muted"
        >
          <TagIcon class="h-3 w-3" />
          Add
        </button>
      )}
    </div>
  );
}
