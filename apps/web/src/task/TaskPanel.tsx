// The slide-over task detail. Fields read live from the
// store (so a delta from anyone else lands here); comments and attachments are
// panel-local because the store doesn't carry them.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { Attachment, TaskDetail } from "@flow/shared";
import { addComment, comments as commentStore, fetchTaskDetail, updateTask } from "../store/index.js";
import { listById, spaceOfList, taskById } from "../shell/data.js";
import { formatDateTime } from "../shell/format.js";
import { panelFocus } from "../shell/nav.js";
import { CalendarIcon, FlagIcon, Moon, TagIcon, X } from "../shell/ui.js";
import {
  AssigneePicker, BlockedNoteField, DuePicker, PriorityPicker, PropertyRow, SnoozeBanner,
  SnoozePicker, StatusPicker, TagEditor,
} from "./fields.js";
import { Description } from "./Description.js";
import { Subtasks } from "./Subtasks.js";
import { Comments, CommentComposer } from "./Comments.js";
import { Attachments } from "./Attachments.js";
import { uploadAttachment } from "./api.js";
import { useAutogrow } from "./autogrow.js";

export function TaskPanel({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState<string[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  // --- load ---------------------------------------------------------------
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // fetchTaskDetail merges subtasks and comments into the store, so those
      // two stay live from here on; attachments are ours to hold.
      const d = await fetchTaskDetail(taskId);
      setDetail(d);
      setAttachments(d?.attachments ?? []);
      if (!d && !taskById(taskId)) setLoadError("That task could not be loaded.");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "That task could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setDetail(null);
    setAttachments([]);
    setUploadError(null);
    void load();
  }, [load]);

  // Escape closes. Menus and inline editors stop the key in the capture phase
  // first, so this only fires when nothing smaller is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Freeze the page behind the panel.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // --- task source --------------------------------------------------------
  // Prefer the store's copy: it reflects optimistic edits and live deltas.
  const task = taskById(taskId) ?? detail?.task ?? null;
  const list = listById(task?.listId);
  const space = spaceOfList(task?.listId);

  // --- title --------------------------------------------------------------
  const [titleDraft, setTitleDraft] = useState("");
  const [titleFocused, setTitleFocused] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useAutogrow(titleRef, titleDraft, { min: 32 });

  useEffect(() => {
    if (!titleFocused && task) setTitleDraft(task.title);
  }, [task?.title, titleFocused, task]);

  const saveTitle = () => {
    setTitleFocused(false);
    const next = titleDraft.trim();
    if (!task) return;
    if (next === "" || next === task.title) {
      setTitleDraft(task.title);
      return;
    }
    void updateTask({ taskId: task.id, title: next });
  };

  // --- comments -----------------------------------------------------------
  // The store appends optimistically and rolls back on failure, so the thread
  // below re-renders on its own.
  const thread = commentStore.value.get(taskId) ?? detail?.comments ?? [];
  const send = (body: string) => addComment(taskId, body);
  // "C" on the board opens the panel with the caret already in the composer.
  const focusRequest = panelFocus.value;
  const composerFocusNonce =
    focusRequest && focusRequest.taskId === taskId && focusRequest.target === "comment"
      ? focusRequest.nonce
      : undefined;

  // --- attachments --------------------------------------------------------
  const upload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setUploadError(null);
      setUploading((prev) => [...prev, ...files.map((f) => f.name)]);
      for (const file of files) {
        try {
          const created = await uploadAttachment(taskId, file);
          setAttachments((prev) => (prev.some((a) => a.id === created.id) ? prev : [...prev, created]));
        } catch (e) {
          setUploadError(e instanceof Error ? `${file.name}: ${e.message}` : `${file.name} did not upload.`);
        } finally {
          setUploading((prev) => {
            const i = prev.indexOf(file.name);
            return i === -1 ? prev : [...prev.slice(0, i), ...prev.slice(i + 1)];
          });
        }
      }
    },
    [taskId]
  );

  return (
    <div class="fixed inset-0 z-50 h-[100dvh]">
      <div
        class="absolute inset-0 bg-black/25 animate-[flow-fade-in_140ms_ease-out]"
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={task ? task.title : "Task"}
        class="absolute right-0 top-0 flex h-full w-full max-w-[640px] flex-col border-l border-line bg-surface shadow-[-8px_0_40px_rgba(15,15,20,0.10)] animate-[flow-slide-in_170ms_cubic-bezier(0.32,0.72,0,1)]"
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current++;
          if (e.dataTransfer?.types.includes("Files")) setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          void upload(Array.from(e.dataTransfer?.files ?? []));
        }}
      >
        {/* header */}
        <header class="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-3 sm:px-5">
          <div class="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] text-muted">
            {space && <span class="truncate">{space.name}</span>}
            {space && list && <span class="text-faint">/</span>}
            {list && <span class="truncate text-text">{list.name}</span>}
          </div>
          <span class="hidden shrink-0 font-mono text-[11px] text-faint sm:inline" title="Task id">
            {taskId}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close task"
            class="-mr-1 rounded-lg p-2.5 text-faint transition-colors hover:bg-bg hover:text-text sm:-mr-1.5 sm:p-1.5"
          >
            <X />
          </button>
        </header>

        {/* body */}
        <div class="scroll-y min-h-0 flex-1 overflow-y-auto">
          {!task ? (
            <div class="px-4 py-8 sm:px-6">
              {loading ? (
                <div class="space-y-3">
                  <div class="h-6 w-2/3 animate-pulse rounded bg-bg" />
                  <div class="h-3 w-1/3 animate-pulse rounded bg-bg" />
                  <div class="h-24 w-full animate-pulse rounded bg-bg" />
                </div>
              ) : (
                <div>
                  <p class="text-[14px] text-text">{loadError ?? "That task could not be loaded."}</p>
                  <button
                    type="button"
                    onClick={() => void load()}
                    class="mt-3 rounded-lg border border-line px-2.5 py-1 text-[12.5px] font-medium text-text hover:bg-raised"
                  >
                    Try again
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              <div class="px-4 pb-5 pt-4 sm:px-6 sm:pt-5">
                <textarea
                  ref={titleRef}
                  rows={1}
                  value={titleDraft}
                  aria-label="Task title"
                  onFocus={() => setTitleFocused(true)}
                  onInput={(e) => setTitleDraft((e.currentTarget as HTMLTextAreaElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      (e.currentTarget as HTMLTextAreaElement).blur();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setTitleDraft(task.title);
                      setTitleFocused(false);
                      (e.currentTarget as HTMLTextAreaElement).blur();
                    }
                  }}
                  onBlur={saveTitle}
                  class="-mx-2 block w-[calc(100%+1rem)] resize-none overflow-hidden rounded-lg bg-transparent px-2 py-0.5 text-[19px] font-semibold leading-[1.3] tracking-[-0.018em] text-text transition-colors hover:bg-raised focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/25 sm:text-[22px] sm:leading-[1.28] sm:tracking-[-0.021em]"
                />

                <SnoozeBanner task={task} />

                <div class="mt-4 space-y-0.5">
                  <PropertyRow label="Status">
                    <StatusPicker task={task} />
                  </PropertyRow>
                  <PropertyRow label="Assignee">
                    <AssigneePicker task={task} />
                  </PropertyRow>
                  <PropertyRow label="Due" icon={<CalendarIcon class="h-3.5 w-3.5 text-faint" />}>
                    <DuePicker task={task} />
                  </PropertyRow>
                  <PropertyRow label="Snooze" icon={<Moon class="h-3.5 w-3.5 text-faint" />}>
                    <SnoozePicker task={task} />
                  </PropertyRow>
                  <PropertyRow label="Waiting on">
                    <BlockedNoteField task={task} />
                  </PropertyRow>
                  <PropertyRow label="Priority" icon={<FlagIcon class="h-3.5 w-3.5 text-faint" />}>
                    <PriorityPicker task={task} />
                  </PropertyRow>
                  <PropertyRow label="Tags" icon={<TagIcon class="h-3.5 w-3.5 text-faint" />}>
                    <TagEditor task={task} />
                  </PropertyRow>
                </div>
              </div>

              <div class="space-y-6 border-t border-line px-4 py-5 sm:space-y-7 sm:px-6 sm:py-6">
                <Description task={task} />
                <Subtasks taskId={taskId} fallback={detail?.subtasks ?? []} />
                <Attachments
                  attachments={attachments}
                  uploading={uploading}
                  error={uploadError}
                  onPick={(files) => void upload(files)}
                />
              </div>

              <div class="border-t border-line px-4 py-5 sm:px-6 sm:py-6">
                <Comments comments={thread} />
                <p class="mt-6 text-[11.5px] text-faint">
                  Created {formatDateTime(task.createdAt)} · updated {formatDateTime(task.updatedAt)}
                </p>
              </div>
            </>
          )}
        </div>

        {task && <CommentComposer onSend={send} focusNonce={composerFocusNonce} />}

        {dragging && (
          <div class="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent/60 bg-accent/[0.06]">
            <span class="rounded-lg bg-surface px-3 py-1.5 text-[13px] font-medium text-accent shadow-sm">
              Drop to attach
            </span>
          </div>
        )}
      </aside>
    </div>
  );
}

export default TaskPanel;
