import { useEffect, useRef, useState } from "preact/hooks";
import { toast } from "../lib/toast.js";
import { createTask, lists, me, spaces } from "../store/index.js";
import { formatDue } from "./format.js";
import {
  closeQuickAdd,
  openQuickAdd,
  quickAddOpen,
  recognizeDueDate,
  resolveQuickAddDestination,
  shouldOpenQuickAdd,
} from "./quick-add.js";
import { CalendarIcon, X } from "./ui.js";

function destination() {
  return resolveQuickAddDestination(me.value, spaces.value, lists.value);
}

function blockingModalOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"][aria-modal="true"]:not([data-quick-add-compatible])'
    ) !== null
  );
}

export function QuickAddDialog() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!shouldOpenQuickAdd(event, document.activeElement, blockingModalOpen())) return;
      event.preventDefault();
      if (!destination()) {
        toast("Quick add isn't available for this account", "error");
        return;
      }
      openQuickAdd();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!quickAddOpen.value) return null;
  return <QuickAddForm />;
}

function QuickAddForm() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [dismissedInput, setDismissedInput] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = destination();
  const parsed = recognizeDueDate(value, new Date(), dismissedInput);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Capture and stop Escape so a task panel underneath the quick-add remains
  // open when this dialog closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeQuickAdd();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  async function submit(): Promise<void> {
    if (busy || !target) return;
    const title = (parsed?.title ?? value).trim();
    if (!title) return;
    setBusy(true);
    const created = await createTask({
      listId: target.listId,
      title,
      description: "",
      status: target.status,
      assigneeId: target.assigneeId,
      dueDate: parsed?.dueDate,
    });
    setBusy(false);
    if (created) closeQuickAdd();
  }

  return (
    <div
      class="fixed inset-0 z-[70] flex items-start justify-center bg-black/35 px-4 pt-[14vh] animate-[flow-fade-in_120ms_ease-out]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) closeQuickAdd();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Quick add task"
        class="w-[560px] max-w-full overflow-hidden rounded-xl border border-line bg-surface shadow-2xl shadow-black/20 animate-[flow-pop_120ms_ease-out]"
      >
        <div class="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 class="min-w-0 flex-1 text-[14px] font-semibold text-text">Quick add</h2>
          <kbd class="rounded border border-line bg-raised px-1.5 py-px font-sans text-[10px] font-medium text-faint">
            Q
          </kbd>
          <button
            type="button"
            aria-label="Close quick add"
            disabled={busy}
            onClick={closeQuickAdd}
            class="inline-flex h-6 w-6 items-center justify-center rounded-lg text-faint hover:bg-bg hover:text-text disabled:opacity-50"
          >
            <X class="h-3 w-3" />
          </button>
        </div>

        <form
          class="px-4 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            ref={inputRef}
            value={value}
            disabled={busy || !target}
            autocomplete="off"
            spellcheck={false}
            placeholder="Task title — try “tom” or “in 3 days”"
            onInput={(event) => {
              setDismissedInput(null);
              setValue((event.currentTarget as HTMLInputElement).value);
            }}
            class="w-full bg-transparent py-1 text-[16px] text-text outline-none placeholder:text-faint disabled:opacity-60"
          />

          <div class="mt-3 flex min-h-7 flex-wrap items-center gap-2">
            {target ? (
              <span class="rounded-full border border-line bg-raised px-2.5 py-1 text-[11.5px] text-muted">
                {target.label}
              </span>
            ) : (
              <span class="text-[12px] text-danger">
                Your private quick-add destination isn't available. Nothing will be created.
              </span>
            )}
            {parsed && (
              <span class="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[11.5px] font-medium text-accent">
                <CalendarIcon class="h-3 w-3" />
                Due {formatDue(parsed.dueDate)}
                <button
                  type="button"
                  aria-label={`Keep “${parsed.text}” in the task title`}
                  title="Keep this text in the title"
                  onClick={() => setDismissedInput(value)}
                  class="-mr-1 inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-accent/10"
                >
                  <X class="h-2.5 w-2.5" />
                </button>
              </span>
            )}
          </div>

          <div class="mt-4 flex items-center justify-between border-t border-line pt-3 text-[11px] text-faint">
            <span>Enter to add · Esc to close</span>
            <button
              type="submit"
              disabled={busy || !target || !(parsed?.title ?? value).trim()}
              class="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity disabled:opacity-40"
            >
              {busy ? "Adding…" : "Add task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
