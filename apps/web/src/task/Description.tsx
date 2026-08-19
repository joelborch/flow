import { lazy, Suspense } from "preact/compat";
import { useRef, useState } from "preact/hooks";
import { updateTask, type StoreTask } from "../store/index.js";
import { SectionLabel } from "../shell/ui.js";
import { Markdown } from "./markdown.js";
import type { TipTapEditorHandle } from "./TipTapEditor.js";

const LazyTipTapEditor = lazy(() =>
  import("./TipTapEditor.js").then((m) => ({ default: m.TipTapEditor }))
);

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
  const editorHandleRef = useRef<TipTapEditorHandle>(null);

  const save = (newText: string) => {
    setEditing(false);
    if (newText !== text) void updateTask({ taskId: task.id, description: newText });
  };

  const cancel = () => {
    setEditing(false);
  };

  const onDoneClick = () => {
    if (editorHandleRef.current) {
      editorHandleRef.current.save();
    } else {
      setEditing(false);
    }
  };

  return (
    <section>
      <SectionLabel
        right={
          editing ? (
            <div class="flex items-center gap-2">
              <span class="text-[11px] normal-case tracking-normal text-faint">
                <span class="hidden sm:inline">⌘↵ to save · esc to cancel</span>
                <span class="sm:hidden">tap outside to save</span>
              </span>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onDoneClick}
                class="rounded-md px-1.5 py-0.5 text-[11.5px] font-medium normal-case tracking-normal text-muted hover:bg-bg hover:text-text"
              >
                Done
              </button>
            </div>
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
        <div class="-mx-2 mt-1">
          <Suspense
            fallback={
              <div class="min-h-[180px] w-full animate-pulse rounded-xl border border-accent/20 bg-surface p-4">
                <div class="h-4 w-1/3 rounded bg-bg" />
                <div class="mt-3 h-3 w-2/3 rounded bg-bg" />
              </div>
            }
          >
            <LazyTipTapEditor
              initialValue={text}
              editorHandleRef={editorHandleRef}
              onSave={save}
              onCancel={cancel}
            />
          </Suspense>
        </div>
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
