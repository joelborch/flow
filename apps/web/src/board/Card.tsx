import { isClosed } from "../shell/data.js";
import { cn } from "../shell/format.js";
import { useEffect, useRef } from "preact/hooks";
import type { User } from "@flow/shared";
import {
  avatarHue, dueLabel, initials, isOverdue, isSnoozed, PRIORITY_LABEL, snoozeLabel,
  visibleTags,
} from "../lib/fmt.js";
import { openTask } from "../lib/shell-bridge.js";
import { titleLink } from "../lib/title-link.js";
import { PILL_SM, PILL_TONE, PriorityFlag, TitleLinkIcon } from "../shell/ui.js";
import { me, prefetchTaskDetail, subtaskProgress, userById, type StoreTask } from "../store/index.js";
import { consumedByDrag, onCardPointerDown } from "./dnd.js";
import { focusCard, rangeSelect } from "./keyboard.js";

/** Pointer dwell before a card's detail is warmed. Long enough that a sweep
 *  across a column costs nothing, short enough to cover most of the fetch. */
const HOVER_PREFETCH_MS = 80;

function Avatar({ user }: { user: User }) {
  const hue = avatarHue(user);
  return (
    <span
      class="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-[9px] font-semibold tracking-wide text-white"
      style={{ backgroundColor: `hsl(${hue} 45% 36%)` }}
      title={user.name}
    >
      {initials(user.name)}
    </span>
  );
}

function SubtaskProgress({ done, total }: { done: number; total: number }) {
  return (
    <span
      class="inline-flex shrink-0 items-center gap-1 tabular-nums"
      title={`${done} of ${total} subtasks done`}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
        <rect
          x="1.25"
          y="1.25"
          width="9.5"
          height="9.5"
          rx="2.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.1"
        />
        {done === total ? (
          <path d="M3.6 6.2 5.3 8l3.1-3.6" fill="none" stroke="currentColor" stroke-width="1.4" />
        ) : null}
      </svg>
      {done}/{total}
    </span>
  );
}

export function Card({ task }: { task: StoreTask }) {
  const assignee = task.assigneeId ? userById.value.get(task.assigneeId) : undefined;
  const closed = isClosed(task);
  const ballHolder = !closed && task.waitingOn != null ? userById.value.get(task.waitingOn) : undefined;
  const myTurn = !closed && task.waitingOn != null && task.waitingOn === me.value?.id;
  const progress = subtaskProgress(task.id);
  const overdue = task.dueDate !== null && isOverdue(task.dueDate) && !closed;
  // A snoozed card is normally filtered out entirely; it only reaches here when
  // "Show snoozed" is on, so it renders dimmed and says why.
  const snoozed = isSnoozed(task.snoozedUntil);
  const link = titleLink(task.title);
  const tags = visibleTags(task.tags);
  const hasMeta =
    snoozed ||
    ballHolder !== undefined ||
    task.priority !== null ||
    task.dueDate !== null ||
    progress.total > 0 ||
    tags.length > 0 ||
    assignee !== undefined;

  // Shift-click extends the selection instead of opening: on a board, holding
  // Shift has meant "and this one too" long before it meant anything else.
  const open = (ev: MouseEvent) => {
    if (consumedByDrag()) return;
    if (ev.shiftKey) {
      ev.preventDefault();
      focusCard(task.id);
      rangeSelect(task.id);
      return;
    }
    openTask(task.id);
  };

  // Resting on a card for a moment is a good predictor of opening it, and the
  // detail fetch is the only thing standing between the click and a full panel.
  // The dwell keeps a pointer sweeping across a column from firing a request
  // per card; prefetchTaskDetail dedupes and remembers the rest.
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHover = () => {
    if (hover.current !== null) clearTimeout(hover.current);
    hover.current = null;
  };
  useEffect(() => cancelHover, []);

  return (
    <div
      data-task-id={task.id}
      onPointerDown={(ev) => onCardPointerDown(ev, task.id, task.listId)}
      onPointerEnter={(ev) => {
        // Touch "enter" fires on tap, which is already opening the card —
        // both the focus affordance and the prefetch are pointer-only.
        if (ev.pointerType === "touch") return;
        focusCard(task.id);
        cancelHover();
        hover.current = setTimeout(() => prefetchTaskDetail(task.id), HOVER_PREFETCH_MS);
      }}
      onPointerLeave={cancelHover}
      onClick={open}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          openTask(task.id);
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={task.title}
      class={`cursor-default select-none touch-manipulation rounded-lg border border-line bg-surface px-3 py-2.5 transition-colors [-webkit-touch-callout:none] hover:border-line-strong sm:px-2.5 sm:py-2${
        snoozed ? " opacity-55 hover:opacity-100" : ""
      }`}
    >
      <div class="flex items-start gap-1">
        <p class="line-clamp-3 min-w-0 flex-1 text-[13px] leading-[1.35] text-text">{task.title}</p>
        {link ? <TitleLinkIcon url={link} class="-mr-1 -mt-px" /> : null}
      </div>

      {hasMeta ? (
        <div class="mt-2 flex min-w-0 items-center gap-2 overflow-hidden text-[11px] text-muted">
          {task.priority ? (
            // The same flag My Work and the panel use, so priority reads one way.
            <span class="shrink-0" title={`${PRIORITY_LABEL[task.priority]} priority`}>
              <PriorityFlag priority={task.priority} class="[&>svg]:h-3 [&>svg]:w-3" />
            </span>
          ) : null}

          {snoozed && task.snoozedUntil !== null ? (
            <span
              class={cn(PILL_SM, PILL_TONE.neutral, "tabular-nums")}
              title={
                task.blockedNote
                  ? `Snoozed — blocked on ${task.blockedNote}`
                  : "Snoozed — hidden until this date"
              }
            >
              {snoozeLabel(task.snoozedUntil)}
            </span>
          ) : null}

          {task.dueDate !== null ? (
            <span
              class={
                overdue ? cn(PILL_SM, PILL_TONE.danger, "tabular-nums") : "shrink-0 tabular-nums"
              }
            >
              {dueLabel(task.dueDate)}
            </span>
          ) : null}

          {progress.total > 0 ? <SubtaskProgress {...progress} /> : null}

          {tags.length > 0 ? (
            <span class="flex min-w-0 items-center gap-1">
              {tags.slice(0, 2).map((tag) => (
                <span
                  key={tag}
                  class={cn(PILL_SM, PILL_TONE.neutral, "min-w-0 shrink truncate")}
                >
                  {tag}
                </span>
              ))}
              {tags.length > 2 ? (
                <span class="text-faint">+{tags.length - 2}</span>
              ) : null}
            </span>
          ) : null}

          {/* Whose turn sits with the owner's avatar, always in the same place. */}
          <span class="ml-auto flex shrink-0 items-center gap-1.5">
            {ballHolder ? (
              <span
                class={cn(PILL_SM, myTurn ? PILL_TONE.accent : PILL_TONE.outline)}
                title={`${ballHolder.name}'s turn`}
              >
                {myTurn ? "Your turn" : `${ballHolder.name.split(" ")[0] ?? ballHolder.name}'s turn`}
              </span>
            ) : null}
            {assignee ? <Avatar user={assignee} /> : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
