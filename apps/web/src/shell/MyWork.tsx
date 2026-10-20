// Everything assigned to me across every list, grouped
// by when it's due — the view that answers "what am I doing today".
import { useState } from "preact/hooks";
import { isSnoozed, snoozeUntilLabel } from "../lib/fmt.js";
import type { StoreTask } from "../store/index.js";
import { me, toggleSubtask } from "../store/index.js";
import { listById, myOpenSubtasks, myOpenTasks, spaceOfList, statusOfTask, type MyOpenSubtask } from "./data.js";
import { cn, formatDue, startOfDay, today } from "./format.js";
import { openTask } from "./nav.js";
import { ChevronDown, ChevronRight, NoteLines, PriorityFlag, StatusDot } from "./ui.js";

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

  return (
    <div class="mx-auto max-w-[860px] px-3 py-6 sm:px-6 sm:py-8">
      <div class="mb-6">
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
      </div>

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
    </div>
  );
}
