// The board's floating property pickers, the selection bar, and the shortcut
// sheet — everything the keyboard layer needs to draw.
//
// These are not the task panel's editors. Those are click targets wired to one
// task (task/fields.tsx); these are keyboard-first, open at the focused card,
// and write to the whole selection. What they do share is the visual
// vocabulary — StatusDot, Avatar, PriorityFlag, the menu row — which already
// lives in shell/ui.js, so nothing had to be lifted out of the panel to reuse
// it here.
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Priority } from "@flow/shared";
import { users } from "../store/index.js";
import { statusesOf } from "../shell/data.js";
import { cn, fromDateInput, toDateInput } from "../shell/format.js";
import {
  Avatar, PRIORITIES, PRIORITY_LABEL, PriorityFlag, Search, StatusDot,
} from "../shell/ui.js";
import {
  addTagsToTargets, applyToTargets, cheatSheetOpen, clearSelection, focusedTaskId, openPicker,
  selectedIds, targetIds, type PickerKind,
} from "./keyboard.js";

const PANEL_W = 248;
const PANEL_H = 300;

/** Open under the focused card, clamped into the viewport. */
function anchorPosition(): { top: number; left: number } {
  const id = focusedTaskId.peek();
  let top = innerHeight / 3;
  let left = (innerWidth - PANEL_W) / 2;
  if (id !== null && typeof document !== "undefined") {
    const el = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
    if (el) {
      const r = el.getBoundingClientRect();
      top = r.bottom + 6;
      left = r.left;
    }
  }
  return {
    top: Math.min(Math.max(top, 8), Math.max(8, innerHeight - PANEL_H - 8)),
    left: Math.min(Math.max(left, 8), Math.max(8, innerWidth - PANEL_W - 8)),
  };
}

function closePicker(): void {
  openPicker.value = null;
}

function Popover({ label, children }: { label: string; children: ComponentChildren }) {
  const [pos] = useState(anchorPosition);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closePicker();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, []);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      data-board-overlay="picker"
      style={{ top: `${pos.top}px`, left: `${pos.left}px`, width: `${PANEL_W}px` }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closePicker();
        }
      }}
      class="fixed z-[58] overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-xl shadow-black/[0.10] animate-[flow-pop_120ms_ease-out]"
    >
      {children}
    </div>
  );
}

/** How many cards the next keystroke is about to change. */
function TargetNote() {
  const n = targetIds().length;
  if (n < 2) return null;
  return (
    <p class="px-2 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-faint">
      {n} tasks
    </p>
  );
}

type Option = { key: string; label: string; icon?: ComponentChildren; note?: string; run: () => void };

/**
 * The one list body every picker uses: optional filter box, arrow keys, Enter.
 * The cursor is an index into the filtered array, so it never has to know which
 * options a query removed.
 */
function OptionList({
  options,
  filter,
  placeholder,
}: {
  options: Option[];
  filter?: boolean;
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) => o.label.toLowerCase().includes(needle));
  }, [q, options]);

  const max = shown.length - 1;
  const active = Math.min(Math.max(cursor, 0), Math.max(max, 0));

  useLayoutEffect(() => {
    if (filter) inputRef.current?.focus();
    else boxRef.current?.focus();
  }, [filter]);

  useEffect(() => {
    boxRef.current?.querySelector<HTMLElement>("[data-active='true']")?.scrollIntoView({ block: "nearest" });
  }, [active, shown.length]);

  // Every key this list understands is stopped, not just prevented: the board's
  // own handler is on the window, and by the time Enter bubbles up the picker
  // has already closed — it would read as "open the focused task".
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      setCursor((c) => (max < 0 ? 0 : (Math.min(Math.max(c, 0), max) + 1) % (max + 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setCursor((c) => (max < 0 ? 0 : (Math.min(Math.max(c, 0), max) + max) % (max + 1)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const item = shown[active];
      if (item) {
        closePicker();
        item.run();
      }
    }
  };

  return (
    <div>
      {filter && (
        <div class="flex items-center gap-1.5 border-b border-line px-2 pb-1.5 text-faint">
          <Search class="h-3.5 w-3.5" />
          <input
            ref={inputRef}
            value={q}
            placeholder={placeholder}
            spellcheck={false}
            onInput={(e) => {
              setQ((e.currentTarget as HTMLInputElement).value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            class="w-full bg-transparent py-1 text-[13px] text-text placeholder:text-faint focus:outline-none"
          />
        </div>
      )}
      <div
        ref={boxRef}
        tabIndex={filter ? -1 : 0}
        onKeyDown={filter ? undefined : onKeyDown}
        class="scroll-y max-h-64 overflow-y-auto pt-1 focus:outline-none"
      >
        {shown.map((o, i) => {
          const on = i === active;
          return (
            <button
              key={o.key}
              type="button"
              role="menuitem"
              data-active={on ? "true" : "false"}
              onMouseMove={() => {
                if (!on) setCursor(i);
              }}
              onClick={() => {
                closePicker();
                o.run();
              }}
              class={cn(
                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-text",
                on ? "bg-accent-soft" : "hover:bg-bg"
              )}
            >
              {o.icon && <span class="flex h-4 w-4 shrink-0 items-center justify-center">{o.icon}</span>}
              <span class="min-w-0 flex-1 truncate">{o.label}</span>
              {o.note && <span class="shrink-0 text-[11px] text-faint">{o.note}</span>}
            </button>
          );
        })}
        {shown.length === 0 && <p class="px-2 py-2 text-[12.5px] text-faint">Nothing matches.</p>}
      </div>
    </div>
  );
}

// --- the five pickers ------------------------------------------------------

function StatusBody({ listId }: { listId: string }) {
  const options: Option[] = statusesOf(listId).map((s) => ({
    key: s.id,
    label: s.name,
    icon: <StatusDot color={s.color} />,
    run: () => applyToTargets({ status: s.name }),
  }));
  return <OptionList options={options} />;
}

function AssigneeBody() {
  const all = users.value;
  const options: Option[] = [
    { key: "none", label: "Unassigned", run: () => applyToTargets({ assigneeId: null }) },
    ...all
      .filter((u) => !u.deactivated)
      .map((u) => ({
        key: u.id,
        label: u.name,
        icon: <Avatar user={u} size="xs" />,
        run: () => applyToTargets({ assigneeId: u.id }),
      })),
  ];
  return <OptionList options={options} filter placeholder="Assign to…" />;
}

function PriorityBody() {
  const options: Option[] = [
    ...PRIORITIES.map((p: Priority) => ({
      key: p,
      label: PRIORITY_LABEL[p],
      icon: <PriorityFlag priority={p} />,
      run: () => applyToTargets({ priority: p }),
    })),
    { key: "none", label: "Clear priority", run: () => applyToTargets({ priority: null }) },
  ];
  return <OptionList options={options} />;
}

const DAY = 86_400_000;

/** Relative offsets cover most of it; the date field is there for the rest. */
function DueBody() {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);

  const at = (days: number): number => {
    const d = new Date(Date.now() + days * DAY);
    d.setHours(12, 0, 0, 0);
    return d.getTime();
  };

  const quick: Array<{ label: string; value: number | null }> = [
    { label: "Today", value: at(0) },
    { label: "Tomorrow", value: at(1) },
    { label: "Next week", value: at(7) },
    { label: "No due date", value: null },
  ];

  return (
    <div>
      <div class="pt-1">
        {quick.map((o) => (
          <button
            key={o.label}
            type="button"
            role="menuitem"
            onClick={() => {
              closePicker();
              applyToTargets({ dueDate: o.value });
            }}
            class="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-[13px] text-text hover:bg-bg"
          >
            {o.label}
          </button>
        ))}
      </div>
      <div class="mt-1 border-t border-line px-2 pb-1 pt-2">
        <input
          ref={ref}
          type="date"
          aria-label="Due date"
          value={toDateInput(null)}
          onChange={(e) => {
            const v = (e.currentTarget as HTMLInputElement).value;
            closePicker();
            applyToTargets({ dueDate: v ? fromDateInput(v) : null });
          }}
          class="w-full rounded-lg border border-line bg-surface px-2 py-1 text-[13px] text-text focus:border-accent/50 focus:outline-none"
        />
      </div>
    </div>
  );
}

/** Tags add rather than replace, so the field is a comma list, not an editor. */
function TagsBody() {
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div class="px-2 py-1.5">
      <input
        ref={ref}
        value={draft}
        placeholder="Add tags, comma separated"
        spellcheck={false}
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            closePicker();
            addTagsToTargets(draft);
          }
        }}
        class="w-full bg-transparent py-1 text-[13px] text-text placeholder:text-faint focus:outline-none"
      />
      <p class="pt-1 text-[11px] text-faint">Enter to add</p>
    </div>
  );
}

const PICKER_LABEL: Record<PickerKind, string> = {
  status: "Set status",
  assignee: "Set assignee",
  priority: "Set priority",
  due: "Set due date",
  tags: "Add tags",
};

function Picker({ kind, listId }: { kind: PickerKind; listId: string }) {
  return (
    <Popover label={PICKER_LABEL[kind]}>
      <TargetNote />
      {kind === "status" && <StatusBody listId={listId} />}
      {kind === "assignee" && <AssigneeBody />}
      {kind === "priority" && <PriorityBody />}
      {kind === "due" && <DueBody />}
      {kind === "tags" && <TagsBody />}
    </Popover>
  );
}

// --- selection bar ---------------------------------------------------------

function SelectionBar() {
  const n = selectedIds.value.size;
  if (n === 0) return null;
  return (
    <div class="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center pb-3">
      <div class="pointer-events-auto flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] text-muted shadow-lg shadow-black/[0.08]">
        <span class="font-medium text-text tabular-nums">{n} selected</span>
        <span class="text-faint">·</span>
        <button type="button" onClick={clearSelection} class="text-muted transition-colors hover:text-text">
          Esc to clear
        </button>
      </div>
    </div>
  );
}

// --- cheat sheet -----------------------------------------------------------

const KEYMAP: Array<{ group: string; rows: Array<[string, string]> }> = [
  {
    group: "Move",
    rows: [
      ["J / ↓", "Next card"],
      ["K / ↑", "Previous card"],
      ["H / ←", "Column left"],
      ["L / →", "Column right"],
      ["↵", "Open the task"],
    ],
  },
  {
    group: "Select",
    rows: [
      ["X", "Toggle this card"],
      ["⇧X / ⇧click", "Extend down the column"],
      ["Esc", "Clear selection, then focus"],
      ["S A P D T", "Apply to all selected"],
    ],
  },
  {
    group: "Edit",
    rows: [
      ["S", "Status"],
      ["A", "Assignee"],
      ["P", "Priority"],
      ["D", "Due date"],
      ["T", "Add tags"],
      ["I", "Assign to me"],
      ["C", "Comment"],
    ],
  },
  {
    group: "Board",
    rows: [
      ["N", "New task"],
      ["?", "This sheet"],
    ],
  },
];

function CheatSheet() {
  if (!cheatSheetOpen.value) return null;
  return (
    <div
      class="fixed inset-0 z-[62] flex items-center justify-center bg-black/30 px-4 animate-[flow-fade-in_120ms_ease-out]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cheatSheetOpen.value = false;
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        data-board-overlay="cheatsheet"
        class="w-[440px] max-w-full overflow-hidden rounded-xl border border-line bg-surface p-4 shadow-2xl shadow-black/20 animate-[flow-pop_120ms_ease-out]"
      >
        <div class="mb-3 flex items-baseline justify-between">
          <h2 class="text-[14px] font-semibold text-text">Board shortcuts</h2>
          <span class="text-[11px] text-faint">esc to close</span>
        </div>
        <div class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {KEYMAP.map((g) => (
            <section key={g.group}>
              <h3 class="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-faint">
                {g.group}
              </h3>
              <ul class="space-y-1">
                {g.rows.map(([keys, what]) => (
                  <li key={keys} class="flex items-baseline gap-2 text-[12.5px]">
                    <kbd class="shrink-0 rounded border border-line bg-raised px-1.5 py-px font-sans text-[10.5px] font-medium text-muted">
                      {keys}
                    </kbd>
                    <span class="min-w-0 flex-1 leading-[1.4] text-muted">{what}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- what the board renders ------------------------------------------------

export function BoardOverlays({ listId }: { listId: string }) {
  const kind = openPicker.value;
  return (
    <>
      <SelectionBar />
      {kind && <Picker kind={kind} listId={listId} />}
      <CheatSheet />
    </>
  );
}
