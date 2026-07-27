// Textareas that grow with their content — nobody
// should have to drag a scrollbar inside a description field.
import { useLayoutEffect } from "preact/hooks";
import type { RefObject } from "preact";

export function useAutogrow(
  ref: RefObject<HTMLTextAreaElement>,
  value: string,
  opts: { min?: number; max?: number } = {}
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const min = opts.min ?? 0;
    const max = opts.max ?? Infinity;
    const next = Math.min(Math.max(el.scrollHeight, min), max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [ref, value, opts.min, opts.max]);
}

/** True for ⌘/Ctrl + Enter — the submit chord across the app. */
export function isSubmitChord(e: KeyboardEvent): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey);
}
