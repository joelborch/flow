// ---------------------------------------------------------------------------
// Assignee resolution.
//
// An unknown assigneeId used to sail straight into the row: `assignee_id` has
// no foreign key, so the task simply pointed at nobody and the board rendered a
// blank avatar with no error anywhere. Every mutation that accepts an
// assigneeId now checks it, and the failure message lists the valid ids and
// names — the same shape as the status-name error in ./statuses.ts, so an agent
// can correct itself without another round trip.
//
// Deactivated users stay assignable on purpose: the ClickUp import carries
// history assigned to people who have since left, and refusing those ids would
// make that history un-editable. Only ids that do not exist at all are refused.
// ---------------------------------------------------------------------------

/** How many users the error message enumerates before it gives up. */
export const ASSIGNEE_HINT_LIMIT = 25;

export interface UserHint {
  id: string;
  name: string;
  deactivated?: boolean;
}

/**
 * The message body for an assigneeId that matches no user. Pure; tested.
 *
 * `total` is the real user count, which may exceed the sample in `known` — the
 * caller only reads the first `ASSIGNEE_HINT_LIMIT` rows so a large workspace
 * does not produce a multi-kilobyte error string.
 */
export function unknownAssigneeMessage(
  userId: string,
  known: readonly UserHint[],
  total: number = known.length
): string {
  if (total === 0) {
    return `Unknown assigneeId "${userId}" — this workspace has no users yet.`;
  }
  const listed = known
    .slice(0, ASSIGNEE_HINT_LIMIT)
    .map((u) => `${u.id} ("${u.name}"${u.deactivated === true ? ", deactivated" : ""})`)
    .join(", ");
  const shown = Math.min(known.length, ASSIGNEE_HINT_LIMIT);
  const overflow = total > shown ? `, and ${total - shown} more` : "";
  return (
    `Unknown assigneeId "${userId}". Valid user ids: ${listed}${overflow}. ` +
    `Deactivated users are still assignable; pass null to leave the item unassigned.`
  );
}

/**
 * Throw unless `userId` names an existing user. `null`/`undefined` mean
 * "unassigned" and are always fine.
 */
export function requireAssignee(sql: SqlStorage, userId: string | null | undefined): void {
  if (userId === null || userId === undefined) return;
  const hit = sql
    .exec<{ id: string }>("SELECT id FROM users WHERE id = ?", userId)
    .toArray()[0];
  if (hit) return;
  // Active users first: they are what a caller almost always meant.
  const known = sql
    .exec<{ id: string; name: string; deactivated: number }>(
      `SELECT id, name, deactivated FROM users ORDER BY deactivated, name LIMIT ?`,
      ASSIGNEE_HINT_LIMIT
    )
    .toArray()
    .map((r) => ({ id: r.id, name: r.name, deactivated: r.deactivated !== 0 }));
  const { n } = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM users").one();
  throw new Error(unknownAssigneeMessage(userId, known, n));
}
