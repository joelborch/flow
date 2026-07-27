import type { Status } from "@flow/shared";
import { useEffect, useRef } from "preact/hooks";
import type { StoreTask } from "../store/index.js";
import { Card } from "./Card.js";
import { QuickAdd } from "./QuickAdd.js";
import { registerColumn } from "./dnd.js";

export function Column({
  status,
  listId,
  tasks,
  hiddenCount,
  snoozedCount,
  composing,
  onCompose,
  onCloseCompose,
}: {
  status: Status;
  listId: string;
  tasks: StoreTask[];
  hiddenCount: number;
  /** Cards this column is holding back because they are snoozed, not filtered. */
  snoozedCount: number;
  composing: boolean;
  onCompose: () => void;
  onCloseCompose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // One line per reason a card is missing, in the order they were applied.
  const notes: string[] = [];
  if (hiddenCount > 0) notes.push(`${hiddenCount} hidden by filters`);
  if (snoozedCount > 0) notes.push(`${snoozedCount} snoozed`);

  useEffect(() => {
    registerColumn(status.id, listId, scrollRef.current);
    return () => registerColumn(status.id, listId, null);
  }, [status.id, listId]);

  // Width comes off the board container, not the viewport, so a visible sidebar
  // doesn't push the snapped column past the right edge. Below ~330px of board
  // the column narrows and leaves a 44px peek of the next one.
  return (
    <section class="flex h-full w-[min(calc(100cqw-2.75rem),288px)] shrink-0 snap-start flex-col rounded-lg transition-colors">
      <header class="flex items-center gap-2 px-2 pb-2 pt-1">
        <span
          class="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: status.color }}
          aria-hidden="true"
        />
        <h2 class="truncate text-[12px] font-semibold tracking-wide text-text uppercase">
          {status.name}
        </h2>
        <span class="tabular-nums text-[11px] text-faint">{tasks.length}</span>
        <button
          type="button"
          onClick={onCompose}
          title="Add task (n)"
          aria-label={`Add task to ${status.name}`}
          class="-my-1 ml-auto grid h-7 w-7 place-items-center rounded text-muted hover:bg-line hover:text-text sm:my-0 sm:h-5 sm:w-5"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <div ref={scrollRef} class="scroll-y flex-1 space-y-1.5 px-2 pb-2">
        {tasks.map((task) => (
          <Card key={task.id} task={task} />
        ))}

        {composing ? (
          <QuickAdd listId={listId} statusName={status.name} onClose={onCloseCompose} />
        ) : null}

        {/* An empty column invites a task. A column emptied by the filters or by
            a snooze is a different statement — the cards are there, they just
            aren't being shown — so it reports that instead of offering a
            composer the click would otherwise open by surprise. */}
        {tasks.length === 0 && !composing ? (
          notes.length > 0 ? (
            <p class="w-full rounded-card border border-dashed border-line px-2.5 py-3 text-left text-[12px] text-faint">
              {notes.join(" · ")}
            </p>
          ) : (
            <button
              type="button"
              onClick={onCompose}
              class="w-full rounded-card border border-dashed border-line px-2.5 py-3 text-left text-[12px] text-faint hover:border-line-strong hover:text-muted"
            >
              Add a task
            </button>
          )
        ) : null}

        {notes.length > 0 && tasks.length > 0 ? (
          <p class="px-1 pt-1 text-[11px] text-faint">{notes.join(" · ")}</p>
        ) : null}
      </div>
    </section>
  );
}
