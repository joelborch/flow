/**
 * Due-date bucketing for `flow_list_my_work`.
 *
 * Pure and UTC-based on purpose. An agent asking "what is on my plate" wants
 * day granularity, not millisecond granularity: a task due at 09:00 today is
 * still *today's* work at 17:00, not overdue. Comparing whole UTC days gives
 * that, and it makes the function deterministic to test — the alternative,
 * per-user local time, would need a timezone the workspace does not store.
 */

/** Bucket order is the order an agent should read them in. */
export const DUE_BUCKETS = ["overdue", "today", "thisWeek", "later", "noDate"] as const;
export type DueBucket = (typeof DUE_BUCKETS)[number];

/** Human labels, used in tool descriptions and the tool result's own legend. */
export const DUE_BUCKET_LABELS: Record<DueBucket, string> = {
  overdue: "overdue",
  today: "due today",
  thisWeek: "due in the next 7 days",
  later: "due more than 7 days out",
  noDate: "no due date",
};

const DAY_MS = 86_400_000;

/** Whole UTC days since the epoch. */
function utcDay(ts: number): number {
  return Math.floor(ts / DAY_MS);
}

export function dueBucket(dueDate: number | null | undefined, now: number): DueBucket {
  if (dueDate === null || dueDate === undefined) return "noDate";
  const days = utcDay(dueDate) - utcDay(now);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= 7) return "thisWeek";
  return "later";
}

/**
 * Group rows into the five buckets, preserving input order inside each and
 * always returning all five keys — an agent should be able to read
 * `buckets.overdue.length` without a presence check.
 */
export function groupByDueBucket<T extends { dueDate?: number | null }>(
  rows: readonly T[],
  now: number
): Record<DueBucket, T[]> {
  const grouped = {
    overdue: [] as T[],
    today: [] as T[],
    thisWeek: [] as T[],
    later: [] as T[],
    noDate: [] as T[],
  };
  for (const row of rows) grouped[dueBucket(row.dueDate, now)].push(row);
  // Within a bucket, soonest first; undated rows keep their search order.
  for (const bucket of DUE_BUCKETS) {
    if (bucket === "noDate") continue;
    grouped[bucket].sort((a, b) => (a.dueDate ?? 0) - (b.dueDate ?? 0));
  }
  return grouped;
}
