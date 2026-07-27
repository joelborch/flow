// Fractional ordering. Tasks are ordered inside a (list, status) column and
// subtasks inside a task; a move only rewrites the one row that moved.
export const POSITION_STEP = 1024;

/**
 * A key strictly between two neighbours. `null` means "no neighbour on that
 * side". Doubles give ~50 consecutive midpoint inserts at the same spot before
 * precision runs out, which `needsRebalance` detects.
 */
export function between(prev: number | null, next: number | null): number {
  if (prev === null && next === null) return POSITION_STEP;
  if (prev === null) return next! - POSITION_STEP;
  if (next === null) return prev + POSITION_STEP;
  return (prev + next) / 2;
}

/** True when prev/next have collapsed and the column should be renumbered. */
export function needsRebalance(prev: number | null, next: number | null): boolean {
  if (prev === null || next === null) return false;
  return Math.abs(next - prev) < 1e-6;
}

/** Renumber a column to clean multiples of POSITION_STEP, order preserved. */
export function rebalanceTaskColumn(sql: SqlStorage, listId: string, statusId: string): void {
  const rows = sql
    .exec<{ id: string }>(
      "SELECT id FROM tasks WHERE list_id = ? AND status_id = ? ORDER BY position, created_at",
      listId,
      statusId
    )
    .toArray();
  rows.forEach((r, i) => {
    sql.exec("UPDATE tasks SET position = ? WHERE id = ?", (i + 1) * POSITION_STEP, r.id);
  });
}

/**
 * True when any adjacent pair in the column has collapsed. Clients omit
 * `position` on a move precisely when their local midpoint would underflow, so
 * the DO checks this and renumbers before assigning.
 */
export function columnHasCollapsed(sql: SqlStorage, listId: string, statusId: string): boolean {
  const positions = sql
    .exec<{ position: number }>(
      "SELECT position FROM tasks WHERE list_id = ? AND status_id = ? ORDER BY position",
      listId,
      statusId
    )
    .toArray()
    .map((r) => r.position);
  for (let i = 1; i < positions.length; i++) {
    if (needsRebalance(positions[i - 1]!, positions[i]!)) return true;
  }
  return false;
}

/** Position for appending to the end of a (list, status) column. */
export function nextTaskPosition(sql: SqlStorage, listId: string, statusId: string): number {
  const { max } = sql
    .exec<{ max: number | null }>(
      "SELECT MAX(position) AS max FROM tasks WHERE list_id = ? AND status_id = ?",
      listId,
      statusId
    )
    .one();
  return between(max, null);
}

/** Position for appending to the end of a task's subtask list. */
export function nextSubtaskPosition(sql: SqlStorage, taskId: string): number {
  const { max } = sql
    .exec<{ max: number | null }>(
      "SELECT MAX(position) AS max FROM subtasks WHERE task_id = ?",
      taskId
    )
    .one();
  return between(max, null);
}

/** Position for appending to the end of a sibling set (`spaces`, `lists`). */
export function nextPosition(sql: SqlStorage, table: "spaces" | "lists", spaceId?: string): number {
  const { max } =
    table === "lists" && spaceId !== undefined
      ? sql
          .exec<{ max: number | null }>(
            "SELECT MAX(position) AS max FROM lists WHERE space_id = ?",
            spaceId
          )
          .one()
      : sql.exec<{ max: number | null }>(`SELECT MAX(position) AS max FROM ${table}`).one();
  return between(max, null);
}
