// Everything assigned to me across every list, grouped
// by when it's due — the view that answers "what am I doing today".
import { useState } from "preact/hooks";
import { isSnoozed, snoozeUntilLabel } from "../lib/fmt.js";
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
  type AssignedOutItem,
  type MyOpenSubtask,
} from "./data.js";
import { cn, formatDue, startOfDay, today } from "./format.js";
import { openTask } from "./nav.js";
import { Avatar, ChevronDown, ChevronRight, NoteLines, PriorityFlag, StatusDot } from "./ui.js";

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

function TaskRow({ task }: { task: StoreTask }) {
  const status = statusOfTask(task);
  const list = listById(task.listId);
  const space = spaceOfList(task.listId);
  const snoozed = isSnoozed(task.snoozedUntil);
  const overdue = !snoozed && task.dueDate !== null && startOfDay(task.dueDate) < today();

  return (
    <li>
      <button
        type="button"
        onClick={() => openTask(task.id)}
        class="group flex w-full items-center gap-2.5 border-b border-line px-2 py-2.5 text-left transition-colors last:border-b-0 hover:bg-raised sm:gap-3"
      >
        {status ? <StatusDot color={status.color} /> : <span class="h-2.5 w-2.5" />}

        {/* The title gets three shares of the free space to the breadcrumb's
            one, and the breadcrumb is the only one allowed to shrink below its
            content — so a narrow window eats "Space / List" long before it
            starts clipping the thing the row is actually about. */}
        <span class="min-w-0 flex-[3_1_0%] truncate text-[13.5px] text-text group-hover:text-text">
          {task.title}
        </span>

        {task.priority && <PriorityFlag priority={task.priority} class="shrink-0" />}

        <span
          class="hidden min-w-0 max-w-[170px] flex-[1_1_0%] truncate text-right text-[12px] text-faint md:block"
          title={`${space ? `${space.name} / ` : ""}${list?.name ?? "—"}`}
        >
          {space ? `${space.name} / ` : ""}
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
              ? `${snoozeUntilLabel(task.snoozedUntil)}${task.blockedNote ? ` — waiting on ${task.blockedNote}` : ""}`
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
        class="relative flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border border-line transition-colors hover:border-accent after:absolute after:-inset-2.5 after:content-[''] sm:after:hidden"
      />

      <button
        type="button"
        onClick={() => openTask(parent.id)}
        class="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 text-left sm:gap-3"
      >
        <span
          class="min-w-0 flex-[3_1_0%] truncate text-[13.5px] text-text"
          title={subtask.note ?? undefined}
        >
          {subtask.title}
          {subtask.note && (
            <NoteLines class="ml-1.5 inline-block h-3 w-3 align-[-1px] text-faint" />
          )}
        </span>

        {/* The parent task is the context that matters for a step; the full
            Space / List path still lives in the tooltip. */}
        <span
          class="hidden min-w-0 max-w-[170px] flex-[1_1_0%] truncate text-right text-[12px] text-faint md:block"
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

function AssignedOutRow({ item }: { item: AssignedOutItem }) {
  const task = assignedTask(item);
  const list = listById(task.listId);
  const assignee = userById(assignedAssigneeId(item));
  const due = assignedDue(item);
  const snoozed = assignedIsSnoozed(item);
  const overdue = !snoozed && due !== null && startOfDay(due) < today();

  return (
    <li>
      <button
        type="button"
        onClick={() => openTask(task.id)}
        class="group flex w-full items-start gap-2.5 border-b border-line px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-raised"
      >
        <Avatar user={assignee} size="sm" />
        <span class="min-w-0 flex-1">
          <span class="line-clamp-2 text-[12.5px] leading-[1.35] text-text">
            {assignedTitle(item)}
          </span>
          <span class="mt-1 block truncate text-[11px] text-faint">
            {assignee?.name ?? "Unassigned"}
            {list ? ` · ${list.name}` : ""}
            {item.kind === "subtask" ? ` · ${task.title}` : ""}
          </span>
        </span>
        <span
          class={cn(
            "mt-0.5 max-w-[64px] shrink-0 text-right text-[10.5px] tabular-nums",
            snoozed || due === null ? "text-faint" : overdue ? "font-medium text-danger" : "text-muted"
          )}
        >
          {snoozed && task.snoozedUntil !== null
            ? `zZ ${formatDue(task.snoozedUntil)}`
            : due === null
              ? "No date"
              : formatDue(due)}
        </span>
      </button>
    </li>
  );
}

function AssignedOutCard({ items, compact = false }: { items: AssignedOutItem[]; compact?: boolean }) {
  const [open, setOpen] = useState(!compact);
  const [showAll, setShowAll] = useState(false);
  const ordered = [...items].sort((a, b) => {
    const snoozed = Number(assignedIsSnoozed(a)) - Number(assignedIsSnoozed(b));
    return snoozed;
  });
  const visible = showAll ? ordered : ordered.slice(0, ASSIGNED_OUT_PREVIEW);
  const t0 = today();
  const overdue = items.filter((item) => {
    const due = assignedDue(item);
    return !assignedIsSnoozed(item) && due !== null && startOfDay(due) < t0;
  }).length;
  const dueToday = items.filter((item) => {
    const due = assignedDue(item);
    return !assignedIsSnoozed(item) && due !== null && startOfDay(due) === t0;
  }).length;
  const summary = items.length === 0
    ? "Nothing delegated right now"
    : [overdue > 0 ? `${overdue} overdue` : null, dueToday > 0 ? `${dueToday} today` : null]
        .filter(Boolean)
        .join(" · ") || "No immediate deadlines";

  return (
    <section aria-label="Assigned out" class="overflow-hidden rounded-xl border border-line bg-surface">
      {compact ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          class="flex w-full items-center gap-3 px-4 py-3 text-left"
        >
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2 text-[13px] font-semibold text-text">
              Assigned out
              <span class="rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold tabular-nums text-accent">
                {items.length}
              </span>
            </span>
            <span class="mt-0.5 block text-[11.5px] text-muted">{summary}</span>
          </span>
          {open ? <ChevronDown class="h-3.5 w-3.5 text-faint" /> : <ChevronRight class="h-3.5 w-3.5 text-faint" />}
        </button>
      ) : (
        <div class="flex items-start gap-3 border-b border-line px-4 py-3.5">
          <span class="min-w-0 flex-1">
            <span class="block text-[13px] font-semibold text-text">Assigned out</span>
            <span class="mt-0.5 block text-[11.5px] text-muted">{summary}</span>
          </span>
          <span class="rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold tabular-nums text-accent">
            {items.length}
          </span>
        </div>
      )}

      {open ? (
        items.length === 0 ? (
          <p class="px-4 py-5 text-center text-[12px] text-faint">
            Tasks you assign to other people will appear here.
          </p>
        ) : (
          <>
            <ul>{visible.map((item) => (
              <AssignedOutRow
                key={item.kind === "task" ? item.task.id : item.subtask.id}
                item={item}
              />
            ))}</ul>
            {items.length > ASSIGNED_OUT_PREVIEW ? (
              <button
                type="button"
                onClick={() => setShowAll((value) => !value)}
                class="w-full px-4 py-2.5 text-center text-[11.5px] font-medium text-accent transition-colors hover:bg-raised"
              >
                {showAll ? "Show less" : `View all ${items.length}`}
              </button>
            ) : null}
          </>
        )
      ) : null}
    </section>
  );
}

/** The snoozed pile at the bottom: present, countable, collapsed by default. */
function SnoozedBucket({ tasks }: { tasks: StoreTask[] }) {
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
          {tasks.map((t) => <TaskRow key={t.id} task={t} />)}
        </ul>
      ) : null}
    </section>
  );
}

export function MyWork() {
  const user = me.value;
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

        <div class="xl:hidden">
          <AssignedOutCard items={delegated} compact />
        </div>

        <main class="min-w-0 xl:col-start-1 xl:row-start-2">
          {buckets.length === 0 && snoozedTasks.length === 0 ? (
            <div class="rounded-xl border border-dashed border-line px-6 py-10 text-center">
              <p class="text-[13.5px] text-muted">Pick a list in the sidebar to see the board and assign yourself work.</p>
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
                        <TaskRow key={item.task.id} task={item.task} />
                      ) : (
                        <SubtaskRow key={item.subtask.id} subtask={item.subtask} parent={item.parent} />
                      )
                    )}
                  </ul>
                </section>
              ))}

              <SnoozedBucket tasks={snoozedTasks} />
            </div>
          )}
        </main>

        <aside class="sticky top-[72px] hidden max-h-[calc(100vh-88px)] overflow-y-auto xl:col-start-2 xl:row-start-1 xl:row-span-2 xl:block">
          <AssignedOutCard items={delegated} />
        </aside>
      </div>
    </div>
  );
}
