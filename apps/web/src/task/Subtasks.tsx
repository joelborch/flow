// Asana-style checklist: done/not-done plus optional
// assignee and due date. No statuses — that's the board's job, not a step's.
import { useMemo, useRef, useState } from "preact/hooks";
import type { Subtask, User } from "@flow/shared";
import {
  createSubtask,
  setSubtaskAssignee,
  subtasks as subtaskStore,
  toggleSubtask,
  users,
} from "../store/index.js";
import { userById } from "../shell/data.js";
import { cn, formatDue, isOverdue } from "../shell/format.js";
import { Avatar, Menu, MenuItem, PersonIcon, Plus, SectionLabel, Search } from "../shell/ui.js";

function SubtaskAssignee({ subtask, assignee }: { subtask: Subtask; assignee: User | undefined }) {
  const [q, setQ] = useState("");
  const all = users.value;

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const active = all.filter((u) => !u.deactivated || u.id === subtask.assigneeId);
    if (!needle) return active.slice(0, 50);
    return active
      .filter((u) => u.name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle))
      .slice(0, 50);
  }, [q, all, subtask.assigneeId]);

  return (
    <Menu
      label={assignee ? `Assigned to ${assignee.name}` : "Assign subtask"}
      width="w-64"
      align="right"
      trigger={({ open }) =>
        assignee ? (
          <span class="flex shrink-0 items-center">
            <Avatar user={assignee} size="xs" />
          </span>
        ) : (
          // Invisible until the row is hovered (always visible on touch, where
          // there is no hover), so unassigned rows stay quiet.
          <span
            class={cn(
              "flex shrink-0 items-center rounded-md p-0.5 text-faint hover:text-muted",
              !open && "sm:opacity-0 sm:group-hover:opacity-100"
            )}
          >
            <PersonIcon class="h-3.5 w-3.5" />
          </span>
        )
      }
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
              selected={subtask.assigneeId === null}
              onClick={() => {
                close();
                void setSubtaskAssignee(subtask.id, null);
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
                  void setSubtaskAssignee(subtask.id, u.id);
                }}
                class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] text-text hover:bg-bg sm:py-1.5"
              >
                <Avatar user={u} size="sm" />
                <span class="min-w-0 flex-1 truncate">{u.name}</span>
                {u.id === subtask.assigneeId && <span class="text-[11px] text-faint">assigned</span>}
              </button>
            ))}
            {matches.length === 0 && <p class="px-2 py-2 text-[12.5px] text-faint">No one matches “{q}”.</p>}
          </div>
        </div>
      )}
    </Menu>
  );
}

export function Subtasks({ taskId, fallback }: { taskId: string; fallback: Subtask[] }) {
  // The store carries subtasks from the snapshot and keeps them live through
  // deltas; the detail payload is the fallback for anything it hasn't seen.
  const fromStore = subtaskStore.value.get(taskId);
  const [local, setLocal] = useState<Subtask[]>(fallback);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Synchronous re-entry guard. State alone can't prevent the double-fire:
  // Enter -> add() -> setSaving(true) -> re-render disables the focused input
  // -> the browser fires blur -> onBlur's stale closure still sees saving=false.
  const savingRef = useRef(false);

  const rows = [...(fromStore ?? local)].sort((a, b) => a.position - b.position);
  const done = rows.filter((s) => s.done).length;
  const pct = rows.length === 0 ? 0 : Math.round((done / rows.length) * 100);

  const toggle = (s: Subtask) => {
    // Optimistic locally as well, so the row reacts even when this task's
    // subtasks came from the detail fetch rather than the snapshot.
    setLocal((prev) => prev.map((x) => (x.id === s.id ? { ...x, done: !s.done } : x)));
    void toggleSubtask(s.id, !s.done);
  };

  const add = async () => {
    const title = draft.trim();
    if (!title || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      setDraft("");
      await createSubtask(taskId, title);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add that subtask.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <section>
      <SectionLabel
        right={
          rows.length > 0 && (
            <span class="text-[11.5px] font-medium tabular-nums text-faint">
              {done}/{rows.length}
            </span>
          )
        }
      >
        Subtasks
      </SectionLabel>

      {rows.length > 0 && (
        <div class="mb-2 h-[3px] w-full overflow-hidden rounded-full bg-bg">
          <div
            class="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      <ul class="-mx-2">
        {rows.map((s) => {
          const assignee = userById(s.assigneeId);
          return (
            <li key={s.id} class="group flex items-center gap-2.5 rounded-lg px-2 py-2.5 hover:bg-raised sm:py-[7px]">
              <button
                type="button"
                role="checkbox"
                aria-checked={s.done}
                aria-label={s.done ? `Mark “${s.title}” not done` : `Mark “${s.title}” done`}
                onClick={() => toggle(s)}
                class={cn(
                  // The box stays 16px; the invisible ::after gives a finger a
                  // 40px target without moving anything around it.
                  "relative flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px] border transition-colors after:absolute after:-inset-3 after:content-[''] sm:after:hidden",
                  s.done
                    ? "border-accent bg-accent text-white"
                    : "border-line-strong hover:border-accent"
                )}
              >
                {s.done && (
                  <svg viewBox="0 0 16 16" class="h-2.5 w-2.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3.5 8.5 6.2 11.2 12.5 5" />
                  </svg>
                )}
              </button>

              <span
                class={cn(
                  "min-w-0 flex-1 truncate text-[13.5px]",
                  s.done ? "text-faint line-through decoration-line-strong" : "text-text"
                )}
                title={s.title}
              >
                {s.title}
              </span>

              {s.dueDate !== null && (
                <span
                  class={cn(
                    "shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium",
                    isOverdue(s.dueDate) && !s.done ? "bg-danger-soft text-danger" : "bg-bg text-muted"
                  )}
                >
                  {formatDue(s.dueDate)}
                </span>
              )}
              <SubtaskAssignee subtask={s} assignee={assignee} />
            </li>
          );
        })}
      </ul>

      <div class="mt-1 flex items-center gap-2 rounded-lg px-2 py-2 focus-within:bg-raised sm:py-1">
        <Plus class="h-3.5 w-3.5 text-faint" />
        <input
          value={draft}
          disabled={saving}
          placeholder="Add a subtask"
          onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            } else if (e.key === "Escape" && draft !== "") {
              e.preventDefault();
              e.stopPropagation();
              setDraft("");
            }
          }}
          onBlur={() => void add()}
          class="w-full bg-transparent text-[16px] text-text placeholder:text-faint focus:outline-none disabled:opacity-50 sm:text-[13.5px]"
        />
      </div>

      {error && <p class="mt-1 px-2 text-[12px] text-danger">{error}</p>}
    </section>
  );
}
