// Everything assigned to me across every list, grouped
// by when it's due — the view that answers "what am I doing today".
import { useState } from "preact/hooks";
import { isSnoozed, snoozeUntilLabel } from "../lib/fmt.js";
import type { StoreTask } from "../store/index.js";
import { me } from "../store/index.js";
import { listById, myOpenTasks, spaceOfList, statusOfTask } from "./data.js";
import { cn, formatDue, startOfDay, today } from "./format.js";
import { openTask } from "./nav.js";
import { ChevronDown, ChevronRight, PriorityFlag, StatusDot } from "./ui.js";

const DAY = 86_400_000;

type Bucket = { key: string; label: string; tone: "overdue" | "now" | "normal"; tasks: StoreTask[] };

function bucketize(tasks: StoreTask[]): Bucket[] {
  const t0 = today();
  const buckets: Bucket[] = [
    { key: "overdue", label: "Overdue", tone: "overdue", tasks: [] },
    { key: "today", label: "Today", tone: "now", tasks: [] },
    { key: "tomorrow", label: "Tomorrow", tone: "normal", tasks: [] },
    { key: "week", label: "This week", tone: "normal", tasks: [] },
    { key: "later", label: "Later", tone: "normal", tasks: [] },
    { key: "none", label: "No due date", tone: "normal", tasks: [] },
  ];
  const put = (key: string, task: StoreTask) => {
    const b = buckets.find((x) => x.key === key);
    if (b) b.tasks.push(task);
  };

  for (const task of tasks) {
    if (task.dueDate === null) {
      put("none", task);
      continue;
    }
    const d = startOfDay(task.dueDate);
    const days = Math.round((d - t0) / DAY);
    if (days < 0) put("overdue", task);
    else if (days === 0) put("today", task);
    else if (days === 1) put("tomorrow", task);
    else if (days <= 7) put("week", task);
    else put("later", task);
  }

  return buckets.filter((b) => b.tasks.length > 0);
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
  // A snoozed task is not what you are doing today, so it leaves its due-date
  // bucket entirely rather than sitting in Overdue accusing you of something
  // you already decided to defer.
  const snoozedTasks = all.filter((t) => isSnoozed(t.snoozedUntil));
  const tasks = all.filter((t) => !isSnoozed(t.snoozedUntil));
  const buckets = bucketize(tasks);

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
          {all.length === 0
            ? "Nothing is assigned to you right now."
            : `${all.length} open ${all.length === 1 ? "task" : "tasks"} across ${new Set(all.map((t) => t.listId)).size} ${new Set(all.map((t) => t.listId)).size === 1 ? "list" : "lists"}${snoozedTasks.length > 0 ? `, ${snoozedTasks.length} snoozed` : ""}.`}
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
                <span class="text-[11px] tabular-nums text-faint">{b.tasks.length}</span>
              </div>
              <ul class="rounded-xl border border-line bg-surface px-1">
                {b.tasks.map((t) => <TaskRow key={t.id} task={t} />)}
              </ul>
            </section>
          ))}

          <SnoozedBucket tasks={snoozedTasks} />
        </div>
      )}
    </div>
  );
}
