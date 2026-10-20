import type { HandoffState } from "@flow/shared";

// ---------------------------------------------------------------------------
// Agent handoffs: the state rules as pure functions.
//
// A handoff is an ordinary task (title + description = the ask, assignee = the
// recipient, due date = when it's needed, tag "handoff") plus a `handoff`
// object. The DO owns the reads and writes; this file owns who may move a
// handoff where, and what that does to the task's status, so the rules can be
// tested without a workspace. handoffs-storage.test.ts covers the DO side.
// ---------------------------------------------------------------------------

/** Tag every handoff task carries, so boards and searches can find them. */
export const HANDOFF_TAG = "handoff";

/** What listHandoffs returns when the caller names no states. */
export const OPEN_HANDOFF_STATES: readonly HandoffState[] = ["requested", "working", "needs_input"];

/** Done and declined close the task; every other state is open work. */
export function isTerminalHandoffState(state: HandoffState): boolean {
  return state === "done" || state === "declined";
}

/**
 * Who the actor is relative to one handoff. The recipient is the task's
 * CURRENT assignee (a reassigned handoff follows its task), the requester is
 * `handoff.requestedBy`, and owners/admins may act as either.
 */
export interface HandoffRoles {
  recipient: boolean;
  requester: boolean;
  privileged: boolean;
}

export type HandoffDecision =
  | { ok: true; next: HandoffState }
  | { ok: false; reason: "outsider" | "requester_state" };

/**
 * The state a reply leaves the handoff in, or why the actor may not send it.
 *
 * - An explicit `requested` state: the recipient or an owner/admin may set any
 *   state; the requester may only set "declined" (withdrawing the request),
 *   and only while it's still open — a done handoff's outcome is the
 *   recipient's, not something the requester can overwrite.
 * - No explicit state: a message from the requester on a needs_input handoff
 *   moves it to "working", since they just answered the question and the ball
 *   is back with the recipient. Anything else leaves the state alone.
 * - Anyone who is none of the three may not reply at all (they can still
 *   comment on the task the ordinary way).
 */
export function decideHandoffState(
  current: HandoffState,
  requested: HandoffState | undefined,
  hasMessage: boolean,
  roles: HandoffRoles
): HandoffDecision {
  if (!roles.recipient && !roles.requester && !roles.privileged) {
    return { ok: false, reason: "outsider" };
  }
  if (requested !== undefined) {
    if (roles.recipient || roles.privileged) return { ok: true, next: requested };
    return requested === "declined" && !isTerminalHandoffState(current)
      ? { ok: true, next: "declined" }
      : { ok: false, reason: "requester_state" };
  }
  if (hasMessage && roles.requester && !roles.recipient && current === "needs_input") {
    return { ok: true, next: "working" };
  }
  return { ok: true, next: current };
}

/**
 * What a state change does to the task's status. A terminal state closes an
 * open task and an open state reopens a closed one; a task whose status already
 * agrees with the new state (done -> declined, working -> needs_input) is left
 * where it is.
 */
export function handoffStatusMove(
  next: HandoffState,
  taskClosed: boolean
): "close" | "reopen" | null {
  if (isTerminalHandoffState(next)) return taskClosed ? null : "close";
  return taskClosed ? "reopen" : null;
}

/**
 * The handoff state a task's own status move implies, or null to leave it.
 * Someone closing a handoff task by hand (or a rule doing it) has finished it,
 * so an open handoff becomes "done"; reopening a finished one puts it back to
 * "working". Without this the strip would say Working on a closed task, and
 * the task would fall out of every default handoff list with no outcome.
 */
export function handoffStateForStatusMove(
  current: HandoffState,
  wasClosed: boolean,
  nowClosed: boolean
): HandoffState | null {
  if (!wasClosed && nowClosed && !isTerminalHandoffState(current)) return "done";
  if (wasClosed && !nowClosed && isTerminalHandoffState(current)) return "working";
  return null;
}
