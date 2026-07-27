// Inline task composer at the bottom of a column. Enter creates and stays open
// so a batch of tasks can be typed without touching the mouse.
import { useEffect, useRef, useState } from "preact/hooks";
import { createTask } from "../store/index.js";

export function QuickAdd({
  listId,
  statusName,
  onClose,
}: {
  listId: string;
  statusName: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = () => {
    const title = value.trim();
    if (!title) {
      onClose();
      return;
    }
    void createTask({ listId, title, description: "", status: statusName });
    setValue("");
    ref.current?.focus();
  };

  return (
    <div class="rounded-card border border-accent bg-surface px-2.5 py-2" data-no-drag>
      <textarea
        ref={ref}
        rows={2}
        value={value}
        placeholder="Task title"
        class="w-full resize-none bg-transparent text-[16px] leading-[1.35] text-text placeholder:text-faint focus:outline-none sm:text-[13px]"
        onInput={(ev) => setValue((ev.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            submit();
          } else if (ev.key === "Escape") {
            ev.preventDefault();
            onClose();
          }
        }}
        onBlur={() => {
          if (!value.trim()) onClose();
        }}
      />
      <div class="mt-1 flex items-center justify-between text-[10px] text-faint">
        <span class="hidden sm:inline">Enter to add · Esc to close</span>
        <button
          type="button"
          class="ml-auto rounded px-2 py-1 font-medium text-accent hover:bg-accent-soft sm:px-1.5 sm:py-0.5"
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={submit}
        >
          Add
        </button>
      </div>
    </div>
  );
}
