// The agent-handoff strip under the panel title: who asked, who it's for, when
// it's needed and where it stands. The ask itself is the task's title and
// description, and replies are ordinary comments, so this only adds what a
// task alone can't say.
import type { HandoffState, User } from "@flow/shared";
import { me, setHandoffState, type StoreTask } from "../store/index.js";
import { isClosed, taskById, userById } from "../shell/data.js";
import { cn, formatDateTime, formatDue, isOverdue } from "../shell/format.js";
import { openTask } from "../shell/nav.js";
import { ChevronDown, Menu, MenuItem } from "../shell/ui.js";

export const HANDOFF_STATES: HandoffState[] = ["requested", "working", "needs_input", "done", "declined"];

export const HANDOFF_STATE_LABEL: Record<HandoffState, string> = {
  requested: "Requested",
  working: "Working",
  needs_input: "Needs input",
  done: "Done",
  declined: "Declined",
};

const PILL: Record<HandoffState, string> = {
  requested: "bg-surface text-muted ring-1 ring-inset ring-line",
  working: "bg-accent/10 text-accent",
  needs_input: "bg-warn/15 text-warn",
  done: "bg-ok/12 text-ok",
  declined: "bg-danger-soft text-danger",
};

const DOT: Record<HandoffState, string> = {
  requested: "text-faint",
  working: "text-accent",
  needs_input: "text-warn",
  done: "text-ok",
  declined: "text-danger",
};

/**
 * The states this viewer may move the handoff to, mirroring the server's rule:
 * the recipient (current assignee) and owners/admins may set any state, the
 * requester may only decline, and only while it's still open, and everyone
 * else gets a read-only pill. The server still decides; this only keeps the
 * menu from offering a refusal.
 */
export function handoffStatesFor(task: StoreTask, viewer: User | null | undefined): HandoffState[] {
  const handoff = task.handoff;
  if (!handoff || !viewer) return [];
  if (viewer.role === "owner" || viewer.role === "admin" || viewer.id === task.assigneeId) {
    return HANDOFF_STATES;
  }
  const open = handoff.state !== "done" && handoff.state !== "declined";
  if (viewer.id === handoff.requestedBy && open) return ["declined"];
  return [];
}

/** "needs by tomorrow" rather than "needs by Tomorrow"; dates stay as they are. */
function needsByLabel(ts: number): string {
  const label = formatDue(ts);
  return label === "Today" || label === "Tomorrow" || label === "Yesterday" ? label.toLowerCase() : label;
}

export function HandoffStrip({ task }: { task: StoreTask }) {
  // A boot cache written before handoffs existed carries no `handoff` at all,
  // so undefined reads the same as null: not a handoff.
  const handoff = task.handoff;
  if (!handoff) return null;

  const requester = userById(handoff.requestedBy);
  const assignee = userById(task.assigneeId);
  const overdue = task.dueDate !== null && isOverdue(task.dueDate) && !isClosed(task);

  return (
    <div class="mt-3 rounded-lg border border-line bg-raised px-3 py-2 text-[12.5px]">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class="min-w-0 text-muted">
          From <span class="font-medium text-text">{requester?.name ?? "Unknown"}</span>{" "}
          <span class="text-faint">(via agent)</span>
        </span>
        <span class="text-faint" aria-hidden="true">→</span>
        <span class="sr-only">to</span>
        <span class={cn("min-w-0 truncate font-medium", assignee ? "text-text" : "text-faint")}>
          {assignee ? assignee.name : "Unassigned"}
        </span>
        {task.dueDate !== null && (
          <span class="text-faint">
            · needs by{" "}
            <span class={overdue ? "font-medium text-danger" : "text-muted"}>{needsByLabel(task.dueDate)}</span>
          </span>
        )}
        <div class="ml-auto shrink-0">
          <StatePill task={task} state={handoff.state} since={handoff.stateChangedAt} />
        </div>
      </div>

      {handoff.returnFormat && (
        <p class="mt-1.5 text-muted">
          <span class="text-faint">Return:</span> {handoff.returnFormat}
        </p>
      )}

      {handoff.contextTaskIds.length > 0 && (
        <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="text-faint">Context:</span>
          {handoff.contextTaskIds.map((id) => (
            <ContextLink key={id} taskId={id} />
          ))}
        </div>
      )}
    </div>
  );
}

function StatePill({ task, state, since }: { task: StoreTask; state: HandoffState; since: number }) {
  const options = handoffStatesFor(task, me.value);
  const label = HANDOFF_STATE_LABEL[state];
  const pill = "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium";
  const title = `Since ${formatDateTime(since)}`;

  if (options.length === 0) {
    return (
      <span class={cn(pill, PILL[state])} title={title}>
        <span class="sr-only">Handoff state: </span>
        {label}
      </span>
    );
  }

  // The requester's only move is to withdraw the ask, so it reads as an action.
  const declineOnly = options.length === 1 && options[0] === "declined";

  return (
    <Menu
      label={`Handoff state: ${label}`}
      width="w-44"
      align="right"
      trigger={() => (
        <span class={cn(pill, PILL[state], "cursor-pointer")} title={title}>
          {label}
          <ChevronDown class="h-3 w-3 opacity-70" />
        </span>
      )}
    >
      {(close) =>
        declineOnly ? (
          <MenuItem
            danger
            onClick={() => {
              close();
              void setHandoffState(task.id, "declined");
            }}
          >
            Decline
          </MenuItem>
        ) : (
          options.map((s) => (
            <MenuItem
              key={s}
              selected={s === state}
              onClick={() => {
                close();
                if (s !== state) void setHandoffState(task.id, s);
              }}
            >
              <span class="inline-flex items-center gap-2">
                <span class={cn("inline-block h-2 w-2 shrink-0 rounded-full bg-current", DOT[s])} />
                {HANDOFF_STATE_LABEL[s]}
              </span>
            </MenuItem>
          ))
        )
      }
    </Menu>
  );
}

/** A task the recipient's agent should read first. One we don't hold (another
 *  space, or closed long ago) still opens; the panel fetches it by id. */
function ContextLink({ taskId }: { taskId: string }) {
  const target = taskById(taskId);
  return (
    <button
      type="button"
      onClick={() => openTask(taskId)}
      title={target ? target.title : taskId}
      class={cn(
        "max-w-[18rem] truncate rounded text-left text-accent underline-offset-2 hover:underline",
        !target && "font-mono text-[11.5px]"
      )}
    >
      {target ? target.title : taskId}
    </button>
  );
}
