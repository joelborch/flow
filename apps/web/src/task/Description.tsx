// The centerpiece of the panel: read mode is properly
// typeset markdown, edit mode is the raw source in a growing textarea.
import { useEffect, useRef, useState } from "preact/hooks";
import { updateTask, type StoreTask } from "../store/index.js";
import { SectionLabel } from "../shell/ui.js";
import { Markdown } from "./markdown.js";
import { isSubmitChord, useAutogrow } from "./autogrow.js";

export function Description({ task }: { task: StoreTask }) {
  // The snapshot no longer carries description text, only a `hasDescription`
  // bit, and the panel's detail fetch fills the real thing in a moment later.
  // So there are three states, not two: we have the text (edit it), we know
  // there is none (offer the placeholder immediately — no false "Add a
  // description" flash for a task that does have one), or we are still waiting.
  const body = task.description;
  const known = body !== undefined;
  const text = body ?? "";
  const empty = known ? text.trim() === "" : task.hasDescription === false;
  const waiting = !known && !empty;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutogrow(ref, draft, { min: 120 });

  // Adopt remote edits while we're not the one typing.
  useEffect(() => {
    if (!editing) setDraft(text);
  }, [text, editing]);

  useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const save = () => {
    setEditing(false);
    if (draft !== text) void updateTask({ taskId: task.id, description: draft });
  };

  const cancel = () => {
    setDraft(text);
    setEditing(false);
  };

  return (
    <section>
      <SectionLabel
        right={
          editing ? (
            <span class="text-[11px] normal-case tracking-normal text-faint">
              <span class="hidden sm:inline">⌘↵ to save · esc to cancel</span>
              <span class="sm:hidden">tap outside to save</span>
            </span>
          ) : (
            known && text.trim() !== "" && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                class="rounded-md px-1.5 py-0.5 text-[11.5px] font-medium normal-case tracking-normal text-muted hover:bg-bg hover:text-text"
              >
                Edit
              </button>
            )
          )
        }
      >
        Description
      </SectionLabel>

      {editing ? (
        <textarea
          ref={ref}
          value={draft}
          placeholder="Write it in markdown — headings, lists, code, links."
          onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (isSubmitChord(e)) {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              cancel();
            }
          }}
          onBlur={save}
          class="block w-full resize-none rounded-xl border border-accent/40 bg-surface px-3 py-3 font-mono text-[16px] leading-[1.55] text-text ring-2 ring-accent/10 placeholder:text-faint focus:outline-none sm:px-3.5 sm:text-[13px] sm:leading-[1.6]"
        />
      ) : waiting ? (
        <div class="-mx-2 space-y-2 px-2 py-2.5" aria-busy="true">
          <div class="h-3 w-3/4 animate-pulse rounded bg-bg" />
          <div class="h-3 w-1/2 animate-pulse rounded bg-bg" />
        </div>
      ) : empty ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          class="-mx-2 block w-full rounded-xl px-2 py-2.5 text-left text-[14px] text-faint hover:bg-raised"
        >
          Add a description
        </button>
      ) : (
        <div
          role="button"
          tabIndex={0}
          title="Click to edit"
          onClick={(e) => {
            // Links, images and checkboxes inside the prose keep their own
            // behaviour; clicking the text itself opens the editor.
            const el = e.target as HTMLElement | null;
            if (el && el.closest("a, button, input, pre")) return;
            setEditing(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setEditing(true);
            }
          }}
          class="-mx-2 min-w-0 cursor-text rounded-xl px-2 py-1.5 transition-colors hover:bg-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
        >
          <Markdown source={text} />
        </div>
      )}
    </section>
  );
}
