// Chronological thread with markdown bodies, plus the
// composer. The store has no comments signal, so the panel owns the list and
// hands us an optimistic appender.
import { useEffect, useRef, useState } from "preact/hooks";
import type { Comment } from "@flow/shared";
import { me } from "../store/index.js";
import { userById } from "../shell/data.js";
import { formatDateTime, relativeTime } from "../shell/format.js";
import { Avatar, SectionLabel } from "../shell/ui.js";
import { Markdown } from "./markdown.js";
import { isSubmitChord, useAutogrow } from "./autogrow.js";

export function Comments({ comments }: { comments: Comment[] }) {
  const rows = [...comments].sort((a, b) => a.createdAt - b.createdAt);

  return (
    <section>
      <SectionLabel
        right={rows.length > 0 && <span class="text-[11.5px] font-medium tabular-nums text-faint">{rows.length}</span>}
      >
        Comments
      </SectionLabel>

      {rows.length === 0 ? (
        <p class="text-[13px] text-faint">No comments yet. Start the thread below.</p>
      ) : (
        <ul class="space-y-4">
          {rows.map((c) => {
            const author = userById(c.authorId);
            return (
              <li key={c.id} class="flex gap-2.5">
                {/* Imported threads reference authors who were never imported,
                    so the placeholder has to read as an unknown person rather
                    than as the "unassigned" slot it shares a glyph with. */}
                <Avatar
                  user={author}
                  size="md"
                  {...(author ? {} : { title: "Unknown author" })}
                />
                <div class="min-w-0 flex-1">
                  <div class="flex items-baseline gap-2">
                    <span class="text-[13px] font-medium text-text">{author?.name ?? "Unknown"}</span>
                    <span class="text-[11.5px] text-faint" title={formatDateTime(c.createdAt)}>
                      {relativeTime(c.createdAt)}
                    </span>
                  </div>
                  <Markdown source={c.body} class="mt-0.5 [&>p]:mt-2 [&>p]:text-[14px]" />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function CommentComposer({
  onSend,
  focusNonce,
}: {
  onSend: (body: string) => Promise<void>;
  /** Bumped by the board's "C" shortcut; each new value pulls the caret here. */
  focusNonce?: number;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutogrow(ref, body, { min: 38, max: 220 });

  useEffect(() => {
    if (focusNonce === undefined) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.scrollIntoView({ block: "nearest" });
  }, [focusNonce]);

  const send = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    setBody("");
    try {
      await onSend(text);
    } finally {
      setSending(false);
    }
  };

  return (
    <div class="border-t border-line bg-surface/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:px-6 sm:pb-3">
      <div class="flex items-start gap-2.5">
        <Avatar user={me.value} size="md" />
        <div class="min-w-0 flex-1 rounded-xl border border-line px-3 py-2 transition-colors focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/10">
          <textarea
            ref={ref}
            value={body}
            rows={1}
            placeholder="Write a comment… markdown works"
            onInput={(e) => setBody((e.currentTarget as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (isSubmitChord(e)) {
                e.preventDefault();
                void send();
              } else if (e.key === "Escape" && body !== "") {
                // Keep Escape from closing the panel on top of clearing a draft.
                e.stopPropagation();
              }
            }}
            class="scroll-y block w-full resize-none bg-transparent text-[16px] leading-[1.5] text-text placeholder:text-faint focus:outline-none sm:text-[14px] sm:leading-[1.55]"
          />
          {body.trim() !== "" && (
            <div class="mt-1.5 flex items-center justify-between">
              <span class="hidden text-[11px] text-faint sm:inline">⌘↵ to send</span>
              <button
                type="button"
                disabled={sending}
                onClick={() => void send()}
                class="ml-auto rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50 sm:px-2.5 sm:py-1"
              >
                Comment
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
