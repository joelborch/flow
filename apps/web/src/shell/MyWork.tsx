// Everything assigned to me across every list, grouped
// by when it's due — the view that answers "what am I doing today".
import { useEffect, useState } from "preact/hooks";
import { isSnoozed, snoozeUntilLabel } from "../lib/fmt.js";
import { titleLink } from "../lib/title-link.js";
import type { StoreTask } from "../store/index.js";
import { me, toggleSubtask } from "../store/index.js";
import {
  assignedOutBy,
  listById,
  myOpenSubtasks,
  myOpenTasks,
  spaceOfList,
  statusOfTask,
  userById,
  waitingOnOthersTasks,
  type AssignedOutItem,
  type MyOpenSubtask,
} from "./data.js";
import { cn, formatDue, startOfDay, today } from "./format.js";
import { openTask } from "./nav.js";
import { canUseQuickAdd, openQuickAdd } from "./quick-add.js";
import {
  Avatar, ChevronDown, ChevronRight, NoteLines, PriorityFlag, StatusDot, TitleLinkIcon, PILL_SM, PILL_TONE,
} from "./ui.js";

const DAY = 86_400_000;

/** One row in the view: a task of mine, or a subtask of mine on someone's
 *  (possibly not mine) task. Both bucket by their own due date. */
type WorkItem =
  | { kind: "task"; task: StoreTask }
  | { kind: "subtask"; subtask: MyOpenSubtask["subtask"]; parent: StoreTask };

function dueOf(item: WorkItem): number | null {
  return item.kind === "task" ? item.task.dueDate : item.subtask.dueDate;
}

function titleOf(item: WorkItem): string {
  return item.kind === "task" ? item.task.title : item.subtask.title;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Due date, then priority (subtasks have none, so they sort after prioritized
 *  tasks on the same day), then title — same ordering myOpenTasks uses. */
function compareItems(a: WorkItem, b: WorkItem): number {
  const ad = dueOf(a) ?? Number.MAX_SAFE_INTEGER;
  const bd = dueOf(b) ?? Number.MAX_SAFE_INTEGER;
  if (ad !== bd) return ad - bd;
  const ap = a.kind === "task" && a.task.priority ? (PRIORITY_RANK[a.task.priority] ?? 9) : 9;
  const bp = b.kind === "task" && b.task.priority ? (PRIORITY_RANK[b.task.priority] ?? 9) : 9;
  if (ap !== bp) return ap - bp;
  return titleOf(a).localeCompare(titleOf(b));
}

type Bucket = { key: string; label: string; tone: "overdue" | "now" | "normal"; items: WorkItem[] };

function bucketize(items: WorkItem[]): Bucket[] {
  const t0 = today();
  const buckets: Bucket[] = [
    { key: "overdue", label: "Overdue", tone: "overdue", items: [] },
    { key: "today", label: "Today", tone: "now", items: [] },
    { key: "tomorrow", label: "Tomorrow", tone: "normal", items: [] },
    { key: "week", label: "This week", tone: "normal", items: [] },
    { key: "later", label: "Later", tone: "normal", items: [] },
    { key: "none", label: "No due date", tone: "normal", items: [] },
  ];
  const put = (key: string, item: WorkItem) => {
    const b = buckets.find((x) => x.key === key);
    if (b) b.items.push(item);
  };

  for (const item of items) {
    const due = dueOf(item);
    if (due === null) {
      put("none", item);
      continue;
    }
    const d = startOfDay(due);
    const days = Math.round((d - t0) / DAY);
    if (days < 0) put("overdue", item);
    else if (days === 0) put("today", item);
    else if (days === 1) put("tomorrow", item);
    else if (days <= 7) put("week", item);
    else put("later", item);
  }

  return buckets.filter((b) => b.items.length > 0);
}

function TaskRow({ task, meId }: { task: StoreTask; meId?: string }) {
  const status = statusOfTask(task);
  const list = listById(task.listId);
  const space = spaceOfList(task.listId);
  const snoozed = isSnoozed(task.snoozedUntil);
  const overdue = !snoozed && task.dueDate !== null && startOfDay(task.dueDate) < today();
  const link = titleLink(task.title);
  const fromOther = meId !== undefined && task.assigneeId !== meId;
  const owner = fromOther ? userById(task.assigneeId) : undefined;

  return (
    <li>
      <button
        type="button"
        onClick={() => openTask(task.id)}
        data-mw-row
        class="group flex w-full items-center gap-2.5 border-b border-line px-2 py-2.5 text-left transition-colors last:border-b-0 hover:bg-raised focus-visible:bg-raised sm:gap-3"
      >
        {status ? <StatusDot color={status.color} /> : <span class="h-2.5 w-2.5" />}

        {/* The title gets three shares of the free space to the breadcrumb's
            one, and the breadcrumb is the only one allowed to shrink below its
            content — so a narrow window eats "Space / List" long before it
            starts clipping the thing the row is actually about. */}
        <span class="min-w-0 flex-[3_1_0%] truncate text-[14px] text-text group-hover:text-text">
          {task.title}
        </span>
        {link ? <TitleLinkIcon url={link} /> : null}

        {task.priority && <PriorityFlag priority={task.priority} class="shrink-0" />}

        {fromOther ? (
          <span
            class={cn(PILL_SM, PILL_TONE.accent)}
            title={owner ? `${owner.name}'s task — your turn` : "Unassigned — your turn"}
          >
            {/* The words carry it on a phone; the avatar joins from sm up. */}
            {owner ? <span class="hidden sm:inline-flex"><Avatar user={owner} size="xs" /></span> : null}
            <span class="max-w-[88px] truncate">
              {owner ? `for ${owner.name.split(" ")[0] ?? owner.name}` : "Your turn"}
            </span>
          </span>
        ) : null}

        <span
          class="hidden min-w-0 max-w-[280px] flex-[0_1_auto] truncate text-right text-[12px] text-faint md:block"
          title={`${space ? `${space.name} / ` : ""}${list?.name ?? "—"}`}
        >
          {list?.name ?? "—"}
        </span>

        {/* A parked task reports its wake date instead of its due date: the due
            date is not the next thing that happens to it. */}
        <span
          class={cn(
            "w-[62px] shrink-0 text-right text-[12px] tabular-nums sm:w-[74px]",
            snoozed || task.dueDate === null
              ? "text-faint"
              : overdue
                ? "font-medium text-danger"
                : "text-muted"
          )}
          title={
            snoozed && task.snoozedUntil !== null
              ? `${snoozeUntilLabel(task.snoozedUntil)}${task.blockedNote ? ` — blocked on ${task.blockedNote}` : ""}`
              : undefined
          }
        >
          {snoozed && task.snoozedUntil !== null
            ? `zZ ${formatDue(task.snoozedUntil)}`
            : task.dueDate === null
              ? "—"
              : formatDue(task.dueDate)}
        </span>
      </button>
    </li>
  );
}

/** A subtask of mine: a real checkbox that completes it in place, then the
 *  rest of the row opens the parent task where the full checklist lives. */
function SubtaskRow({ subtask, parent }: { subtask: MyOpenSubtask["subtask"]; parent: StoreTask }) {
  const list = listById(parent.listId);
  const space = spaceOfList(parent.listId);
  const overdue = subtask.dueDate !== null && startOfDay(subtask.dueDate) < today();

  return (
    <li class="group flex items-center gap-2.5 border-b border-line px-2 transition-colors last:border-b-0 hover:bg-raised sm:gap-3">
      <button
        type="button"
        role="checkbox"
        aria-checked={false}
        aria-label={`Mark "${subtask.title}" done`}
        onClick={() => void toggleSubtask(subtask.id, true)}
        class="relative flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded border border-line transition-colors hover:border-accent after:absolute after:-inset-[15px] after:content-[''] sm:after:hidden"
      />

      <button
        type="button"
        onClick={() => openTask(parent.id)}
        data-mw-row
        class="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 text-left sm:gap-3"
      >
        <span class="min-w-0 flex-[3_1_0%]" title={subtask.note ?? undefined}>
          <span class="block truncate text-[14px] text-text">
            {subtask.title}
            {subtask.note && (
              <NoteLines class="ml-1.5 inline-block h-3 w-3 align-[-1px] text-faint" />
            )}
          </span>
          {/* Below md the parent column is gone, and a bare "Step 2" says
              nothing, so the parent rides on a second line instead. */}
          <span class="block truncate text-[12px] text-faint md:hidden">{parent.title}</span>
        </span>

        {/* The parent task is the context that matters for a step; the full
            Space / List path still lives in the tooltip. */}
        <span
          class="hidden min-w-0 max-w-[280px] flex-[0_1_auto] truncate text-right text-[12px] text-faint md:block"
          title={`${space ? `${space.name} / ` : ""}${list?.name ?? "—"} / ${parent.title}`}
        >
          {parent.title}
        </span>

        <span
          class={cn(
            "w-[62px] shrink-0 text-right text-[12px] tabular-nums sm:w-[74px]",
            subtask.dueDate === null ? "text-faint" : overdue ? "font-medium text-danger" : "text-muted"
          )}
        >
          {subtask.dueDate === null ? "—" : formatDue(subtask.dueDate)}
        </span>
      </button>
    </li>
  );
}

const ASSIGNED_OUT_PREVIEW = 5;

function assignedTask(item: AssignedOutItem): StoreTask {
  return item.kind === "task" ? item.task : item.parent;
}

function assignedDue(item: AssignedOutItem): number | null {
  return item.kind === "task" ? item.task.dueDate : item.subtask.dueDate;
}

function assignedAssigneeId(item: AssignedOutItem): string | null {
  return item.kind === "task" ? item.task.assigneeId : item.subtask.assigneeId;
}

function assignedTitle(item: AssignedOutItem): string {
  return item.kind === "task" ? item.task.title : item.subtask.title;
}

function assignedIsSnoozed(item: AssignedOutItem): boolean {
  return isSnoozed(assignedTask(item).snoozedUntil);
}

function AssignedOutRow({
  item,
  mode,
}: {
  item: AssignedOutItem;
  mode: "delegated" | "waiting";
}) {
  const task = assignedTask(item);
  const list = listById(task.listId);
  const assignee = userById(assignedAssigneeId(item));
  const ballHolder =
    item.kind === "task" && task.waitingOn ? userById(task.waitingOn) : assignee;
  const due = assignedDue(item);
  const snoozed = assignedIsSnoozed(item);
  const overdue = !snoozed && due !== null && startOfDay(due) < today();

  const meta =
    mode === "waiting"
      ? `${ballHolder?.name ?? "Someone"}${list ? ` · ${list.name}` : ""}`
      : `${assignee?.name ?? "Unassigned"}${
          item.kind === "task" &&
          task.waitingOn &&
          task.waitingOn !== task.assigneeId &&
          ballHolder
            ? ` → ${ballHolder.name.split(" ")[0] ?? ballHolder.name}`
            : ""
        }${list ? ` · ${list.name}` : ""}${item.kind === "subtask" ? ` · ${task.title}` : ""}`;

  return (
    <li>
      <button
        type="button"
        onClick={() => openTask(task.id)}
        title={mode === "waiting" && ballHolder ? `Your task — ${ballHolder.name}'s turn` : undefined}
        class="group flex w-full items-start gap-2.5 border-b border-line px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-raised"
      >
        <Avatar user={ballHolder} size="sm" />
        <span class="min-w-0 flex-1">
          <span class="line-clamp-2 text-[13px] leading-[1.35] text-text">
            {assignedTitle(item)}
          </span>
          <span class="mt-1 block truncate text-[11px] text-faint">{meta}</span>
        </span>
        <span
          class={cn(
            "mt-0.5 max-w-[64px] shrink-0 text-right text-[11px] tabular-nums",
            snoozed || due === null ? "text-faint" : overdue ? "font-medium text-danger" : "text-muted"
          )}
        >
          {snoozed && task.snoozedUntil !== null
            ? `zZ ${formatDue(task.snoozedUntil)}`
            : due === null
              ? "—"
              : formatDue(due)}
        </span>
      </button>
    </li>
  );
}

function AssignedOutCard({
  delegated,
  waitingOn,
}: {
  delegated: AssignedOutItem[];
  waitingOn: StoreTask[];
}) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const sortSnoozedLast = (a: AssignedOutItem, b: AssignedOutItem) =>
    Number(assignedIsSnoozed(a)) - Number(assignedIsSnoozed(b));
  const orderedDelegated = [...delegated].sort(sortSnoozedLast);
  const orderedWaiting: AssignedOutItem[] = [...waitingOn]
    .map((task): AssignedOutItem => ({ kind: "task", task }))
    .sort(sortSnoozedLast);
  const allItems = [...orderedDelegated, ...orderedWaiting];
  const total = allItems.length;
  const visibleDelegated = showAll
    ? orderedDelegated
    : orderedDelegated.slice(0, ASSIGNED_OUT_PREVIEW);
  const remainingPreview = Math.max(0, ASSIGNED_OUT_PREVIEW - visibleDelegated.length);
  const visibleWaiting = showAll
    ? orderedWaiting
    : orderedWaiting.slice(0, remainingPreview);

  const t0 = today();
  const overdue = allItems.filter((item) => {
    const due = assignedDue(item);
    return !assignedIsSnoozed(item) && due !== null && startOfDay(due) < t0;
  }).length;
  const dueToday = allItems.filter((item) => {
    const due = assignedDue(item);
    return !assignedIsSnoozed(item) && due !== null && startOfDay(due) === t0;
  }).length;
  const summary = total === 0
    ? "Nothing waiting on anyone else"
    : [overdue > 0 ? `${overdue} overdue` : null, dueToday > 0 ? `${dueToday} today` : null]
        .filter(Boolean)
        .join(" · ") || "No immediate deadlines";

  return (
    <section aria-label="With others" class="overflow-hidden rounded-xl border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        class={cn(
          "flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-raised",
          open && "border-b border-line"
        )}
      >
        <span class="min-w-0 flex-1">
          <span class="block text-[13px] font-semibold text-text">With others</span>
          <span class="mt-0.5 block text-[12px] text-muted">{summary}</span>
        </span>
        <span class="rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold tabular-nums text-accent">
          {total}
        </span>
        {open ? <ChevronDown class="h-3.5 w-3.5 text-faint" /> : <ChevronRight class="h-3.5 w-3.5 text-faint" />}
      </button>

      {open ? (
        total === 0 ? (
          <p class="px-4 py-5 text-center text-[12px] text-faint">
            Nothing is waiting on anyone else.
          </p>
        ) : (
          <>
            {visibleDelegated.length > 0 ? (
              <div>
                <div class="flex items-baseline gap-1.5 px-3 pt-3 pb-1">
                  <h4 class="text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">
                    Delegated
                  </h4>
                  <span class="text-[11px] tabular-nums text-faint">{delegated.length}</span>
                </div>
                <ul>{visibleDelegated.map((item) => (
                  <AssignedOutRow
                    key={item.kind === "task" ? item.task.id : item.subtask.id}
                    item={item}
                    mode="delegated"
                  />
                ))}</ul>
              </div>
            ) : null}
            {visibleWaiting.length > 0 ? (
              <div class={visibleDelegated.length > 0 ? "border-t border-line" : undefined}>
                <div class="flex items-baseline gap-1.5 px-3 pt-3 pb-1">
                  <h4 class="text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">
                    Their turn
                  </h4>
                  <span class="text-[11px] tabular-nums text-faint">{waitingOn.length}</span>
                </div>
                <ul>{visibleWaiting.map((item) => (
                  <AssignedOutRow
                    key={item.kind === "task" ? item.task.id : item.subtask.id}
                    item={item}
                    mode="waiting"
                  />
                ))}</ul>
              </div>
            ) : null}
            {total > ASSIGNED_OUT_PREVIEW ? (
              <button
                type="button"
                onClick={() => setShowAll((value) => !value)}
                class="w-full border-t border-line px-4 py-2.5 text-center text-[12px] font-medium text-accent transition-colors hover:bg-raised"
              >
                {showAll ? "Show less" : `View all ${total}`}
              </button>
            ) : null}
          </>
        )
      ) : null}
    </section>
  );
}

/** The snoozed pile at the bottom: present, countable, collapsed by default. */
function SnoozedBucket({ tasks, meId }: { tasks: StoreTask[]; meId?: string }) {
  const [open, setOpen] = useState(false);
  if (tasks.length === 0) return null;

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        class="mb-1 flex w-full items-center gap-1.5 px-2 text-left"
      >
        {open ? (
          <ChevronDown class="h-3 w-3 text-faint" />
        ) : (
          <ChevronRight class="h-3 w-3 text-faint" />
        )}
        <h3 class="text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">Snoozed</h3>
        <span class="text-[11px] tabular-nums text-faint">{tasks.length}</span>
      </button>
      {open ? (
        <ul class="rounded-xl border border-line bg-surface px-1 opacity-70">
          {tasks.map((t) => <TaskRow key={t.id} task={t} meId={meId} />)}
        </ul>
      ) : null}
    </section>
  );
}

/** Rows of the main list in reading order: J/K and the arrows walk these. */
function myWorkRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-mw-row]"));
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable === true;
}

/**
 * My Work's keyboard: J/K (or the arrows) move through the rows, Enter opens
 * the focused one (rows are buttons, so that part is native), and N starts a
 * new task through quick add where this account has it.
 */
export function myWorkKey(ev: KeyboardEvent, rows: HTMLElement[], active: Element | null): "next" | "prev" | "new" | null {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return null;
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  if (key === "n") return "new";
  if (rows.length === 0) return null;
  if (key === "j" || key === "ArrowDown") return "next";
  if (key === "k" || key === "ArrowUp") return active && rows.includes(active as HTMLElement) ? "prev" : "next";
  return null;
}

export function MyWork() {
  const user = me.value;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (isTyping(ev.target) || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const rows = myWorkRows();
      const action = myWorkKey(ev, rows, document.activeElement);
      if (action === null) return;
      if (action === "new") {
        // Quick add files into a personal inbox only some accounts have.
        if (!canUseQuickAdd(me.value)) return;
        ev.preventDefault();
        openQuickAdd();
        return;
      }
      ev.preventDefault();
      const at = rows.indexOf(document.activeElement as HTMLElement);
      const next = action === "next" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0);
      rows[next]?.focus();
      rows[next]?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const all = myOpenTasks(user?.id);
  const allSubtasks = myOpenSubtasks(user?.id);
  // A snoozed task is not what you are doing today, so it leaves its due-date
  // bucket entirely rather than sitting in Overdue accusing you of something
  // you already decided to defer. A subtask follows its parent's snooze: the
  // parent was deferred as a whole, steps included.
  const snoozedTasks = all.filter((t) => isSnoozed(t.snoozedUntil));
  const tasks = all.filter((t) => !isSnoozed(t.snoozedUntil));
  const activeSubtasks = allSubtasks.filter((s) => !isSnoozed(s.parent.snoozedUntil));
  const items: WorkItem[] = [
    ...tasks.map((task): WorkItem => ({ kind: "task", task })),
    ...activeSubtasks.map((s): WorkItem => ({ kind: "subtask", subtask: s.subtask, parent: s.parent })),
  ].sort(compareItems);
  const buckets = bucketize(items);
  const delegated = assignedOutBy(user?.id);
  const waitingOn = waitingOnOthersTasks(user?.id);

  return (
    <div class="mx-auto max-w-[1240px] px-3 py-6 sm:px-6 sm:py-8">
      <div class="grid items-start gap-y-6 xl:grid-cols-[minmax(0,860px)_320px] xl:gap-x-7">
        <header class="min-w-0 xl:col-start-1 xl:row-start-1">
          <h2 class="text-[20px] font-semibold tracking-[-0.02em] text-text">
            {user ? `Hi ${user.name.split(" ")[0] ?? user.name}` : "My Work"}
          </h2>
          {/* Counts everything assigned, snoozed included, so this never
              contradicts the sidebar's badge; the snoozed share is called out
              separately because it is not work for today. */}
          <p class="mt-1 text-[13px] text-muted">
            {all.length === 0 && allSubtasks.length === 0
              ? "Nothing is assigned to you right now."
              : (() => {
                  const listCount = new Set([
                    ...all.map((t) => t.listId),
                    ...allSubtasks.map((s) => s.parent.listId),
                  ]).size;
                  const parts = [];
                  if (all.length > 0) parts.push(`${all.length} open ${all.length === 1 ? "task" : "tasks"}`);
                  if (allSubtasks.length > 0)
                    parts.push(`${allSubtasks.length} ${allSubtasks.length === 1 ? "subtask" : "subtasks"}`);
                  return `${parts.join(" and ")} across ${listCount} ${listCount === 1 ? "list" : "lists"}${snoozedTasks.length > 0 ? `, ${snoozedTasks.length} snoozed` : ""}.`;
                })()}
          </p>
        </header>

        <main class="min-w-0 xl:col-start-1 xl:row-start-2">
          {buckets.length === 0 && snoozedTasks.length === 0 ? (
            <div class="rounded-xl border border-dashed border-line px-6 py-10 text-center">
              <p class="text-[14px] text-muted">Pick a list in the sidebar to see the board and assign yourself work.</p>
            </div>
          ) : (
            <div class="space-y-7">
              {buckets.map((b) => (
                <section key={b.key}>
                  <div class="mb-1 flex items-baseline gap-2 px-2">
                    <h3
                      class={cn(
                        "text-[11px] font-semibold uppercase tracking-[0.07em]",
                        b.tone === "overdue" ? "text-danger" : b.tone === "now" ? "text-accent" : "text-faint"
                      )}
                    >
                      {b.label}
                    </h3>
                    <span class="text-[11px] tabular-nums text-faint">{b.items.length}</span>
                  </div>
                  <ul class="rounded-xl border border-line bg-surface px-1">
                    {b.items.map((item) =>
                      item.kind === "task" ? (
                        <TaskRow key={item.task.id} task={item.task} meId={user?.id} />
                      ) : (
                        <SubtaskRow key={item.subtask.id} subtask={item.subtask} parent={item.parent} />
                      )
                    )}
                  </ul>
                </section>
              ))}

              <SnoozedBucket tasks={snoozedTasks} meId={user?.id} />
            </div>
          )}
        </main>

        {/* Below xl the card stacks under your own work: what is yours comes first. */}
        <div class="xl:hidden">
          <AssignedOutCard delegated={delegated} waitingOn={waitingOn} />
        </div>

        <aside class="sticky top-[72px] hidden max-h-[calc(100vh-88px)] overflow-y-auto xl:col-start-2 xl:row-start-1 xl:row-span-2 xl:block">
          <AssignedOutCard delegated={delegated} waitingOn={waitingOn} />
        </aside>
      </div>
    </div>
  );
}
