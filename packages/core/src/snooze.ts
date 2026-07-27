// Snooze semantics, kept as pure functions so the two wake paths — the hourly
// clock sweep and the comment-clears-it rule — can be reasoned about and tested
// without a Durable Object.
//
// Waking only ever clears `snoozedUntil`. It does not move the task, does not
// touch its status, and does not clear `blockedNote`: the note is the person's
// own record of what they were waiting on, and it is theirs to remove.

/** Rows the wake sweep reads: id plus the raw column. */
export interface SnoozedRow {
  [key: string]: SqlStorageValue;
  id: string;
  snoozed_until: number | null;
}

/**
 * How many parked tasks one sweep pass considers. The sweep runs hourly and a
 * workspace with more than this many snoozed tasks drains over the following
 * hours rather than doing an unbounded scan inside a single alarm.
 */
export const WAKE_SWEEP_LIMIT = 500;

/**
 * Is this task hidden right now? `snoozedUntil` exactly equal to `now` counts
 * as expired, which is the same boundary `wakeCandidates` uses — a task can
 * never be both awake by one rule and asleep by the other.
 */
export function isSnoozed(snoozedUntil: number | null, now: number): boolean {
  return snoozedUntil !== null && snoozedUntil > now;
}

/** Ids whose snooze has run out at `now`, in the order they were read. */
export function wakeCandidates(rows: readonly SnoozedRow[], now: number): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.snoozed_until !== null && row.snoozed_until <= now) out.push(row.id);
  }
  return out;
}

/**
 * Activity-based wake (Linear's rule): any comment on a snoozed task un-snoozes
 * it in the same turn, however far off the wake time still was. A comment is
 * somebody bringing the task back, which is exactly what the snooze was
 * deferring.
 */
export function wakesOnComment(snoozedUntil: number | null): boolean {
  return snoozedUntil !== null;
}
