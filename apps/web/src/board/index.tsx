// Kanban board for one list. Columns are the list's statuses in position
// order; cards are dragged between them with pointer events (see dnd.ts).
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Status, Task } from "@flow/shared";
import { hydrated, listById, tasksByListAndStatus, type StoreTask } from "../store/index.js";
import { BoardHeader } from "./BoardHeader.js";
import { Column } from "./Column.js";
import { cardFilter, clearFilters, hiddenBySnooze, statusFilter } from "./filters.js";
import { composeRequest } from "./compose.js";
import { isDragging } from "./dnd.js";
import { handleBoardKey, resetBoardKeyboard, setBoardLayout } from "./keyboard.js";
import { BoardOverlays } from "./pickers.js";

function typingInField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true
  );
}

export function Board({ listId }: { listId: string }) {
  const [composing, setComposing] = useState<string | null>(null);
  const list = listById.value.get(listId);

  // Status ids are per list, so a list switch invalidates the filter set.
  useEffect(() => {
    clearFilters();
    setComposing(null);
    // A focused card and a selection belong to one board; carrying either into
    // the next list would light up ids that are no longer on screen.
    resetBoardKeyboard();
  }, [listId]);

  const statuses = list ? [...list.statuses].sort((a, b) => a.position - b.position) : [];
  const selected = statusFilter.value;
  const visibleStatuses = selected.size > 0 ? statuses.filter((s) => selected.has(s.id)) : statuses;
  const firstVisible = visibleStatuses[0]?.id ?? null;

  // "New task in <list>" from the command palette. Read during render so the
  // signal is a dependency; the effect keys off the nonce so the same request
  // never fires twice. A request aimed at another list is ignored — the palette
  // navigates first, and this board remounts already carrying the nonce.
  const request = composeRequest.value;
  useEffect(() => {
    if (request.nonce === 0) return;
    if (request.listId !== null && request.listId !== listId) return;
    setComposing(firstVisible);
    // Nonce only: a plain list switch must not re-open a composer.
  }, [request.nonce]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey || isDragging()) return;
      if (typingInField(ev.target)) return;
      // Focus, selection and the property pickers get first refusal; only the
      // keys they leave alone fall through to the composer.
      if (handleBoardKey(ev)) return;
      if (ev.key === "n" || ev.key === "N") {
        ev.preventDefault();
        setComposing(firstVisible);
      } else if (ev.key === "Escape") {
        setComposing(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [firstVisible]);

  if (!list) {
    return (
      <div class="grid h-full place-items-center text-[13px] text-faint">
        {hydrated.value ? "That list no longer exists." : "Loading…"}
      </div>
    );
  }

  const columns = tasksByListAndStatus(listId).value;
  const passes = cardFilter.value;

  // Two separate reasons a card can be missing, counted separately: "hidden by
  // filters" is something you did to the board, "snoozed" is something the task
  // did on its own, and a footer that merged them would send you hunting
  // through the filter row for cards no filter is holding back.
  let total = 0;
  const perColumn = visibleStatuses.map((status) => {
    const all = columns.get(status.id) ?? [];
    const matching = all.filter(passes);
    const tasks = matching.filter((t) => !hiddenBySnooze(t));
    total += tasks.length;
    return {
      status,
      tasks,
      hiddenCount: all.length - matching.length,
      snoozedCount: matching.length - tasks.length,
    };
  });

  return (
    <BoardFrame listId={listId} columns={perColumn}>
      <BoardHeader list={list} total={total} />
      {/* Narrow screens page through columns one at a time; wide ones scroll
          freely. scroll-px keeps a snapped column clear of the gutter. */}
      <div class="min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-px-2 px-2 py-2.5 sm:snap-none sm:py-3">
        <div class="flex h-full gap-1.5">
          {perColumn.map(({ status, tasks, hiddenCount, snoozedCount }) => (
            <Column
              key={status.id}
              status={status}
              listId={listId}
              tasks={tasks}
              hiddenCount={hiddenCount}
              snoozedCount={snoozedCount}
              composing={composing === status.id}
              onCompose={() => setComposing(status.id)}
              onCloseCompose={() => setComposing(null)}
            />
          ))}
        </div>
      </div>
    </BoardFrame>
  );
}

/**
 * The board's own chrome, split out only so the layout hand-off to the keyboard
 * layer can run in an effect — it has to happen after the cards are in the DOM,
 * because that is when focus and selection are repainted onto them.
 */
function BoardFrame({
  listId,
  columns,
  children,
}: {
  listId: string;
  columns: Array<{ status: Status; tasks: StoreTask[] }>;
  children: ComponentChildren;
}) {
  const signature = columns.map((c) => `${c.status.id}:${c.tasks.map((t) => t.id).join(",")}`).join("|");

  useEffect(() => {
    setBoardLayout(columns.map((c) => ({ statusId: c.status.id, taskIds: c.tasks.map((t) => t.id) })));
  }, [signature]);

  return (
    <div class="@container relative flex h-full min-w-0 flex-col">
      {children}
      <BoardOverlays listId={listId} />
    </div>
  );
}

export default Board;
