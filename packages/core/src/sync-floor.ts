// ---------------------------------------------------------------------------
// Resync floor.
//
// The constraint this exists for: three mutations change board state without
// writing anything to the `changes` log — `importBatch` (thousands of rows,
// one `resync` frame), `setSpaceMembers` and `setSpaceVisibility` (a member's
// gained/lost subtree cannot be expressed as a patch). A currently-connected
// client is told to resync, but a client that is OFFLINE at that moment keeps
// its old `sinceSeq`, reconnects later, sees no seq gap, replays deltas only —
// and never learns about the delta-less change. Worse, the stale board is then
// persisted to its localStorage boot cache, entrenching the hole across
// reloads.
//
// So every delta-less mutation records the max `seq` at the time it ran — the
// "floor" — and the hello handler answers any `sinceSeq <= floor` with a full
// snapshot instead of a replay. `<=` rather than `<` because these mutations
// do not advance `seq`: a client whose sinceSeq equals the floor may have
// disconnected just before the mutation and is indistinguishable from one that
// snapshotted just after it. The cost of that ambiguity is a spurious full
// snapshot (~50KB) for up-to-date clients reconnecting before the next real
// delta lands, which is cheap and self-heals.
//
// The floor is workspace-wide, not per-user. `setSpaceMembers` /
// `setSpaceVisibility` only actually invalidate replay for the users whose
// visibility changed, so a per-user floor would be more precise — but the
// spurious snapshot for everyone else is one cheap frame per reconnect, and a
// single value in SQLite cannot rot the way a per-user map could. It lives in
// `sync_meta` (not an in-memory field) so it survives DO hibernation and
// eviction, and is read per-hello like `maxSeq` is.
// ---------------------------------------------------------------------------

/** Replay gap above which a reconnecting client gets a fresh snapshot. */
export const REPLAY_GAP_LIMIT = 5_000;

const FLOOR_KEY = "resync_floor";

/** The highest seq known to be unsafe to replay from. 0 = never bumped. */
export function resyncFloor(sql: SqlStorage): number {
  const row = sql
    .exec<{ value: number }>("SELECT value FROM sync_meta WHERE key = ?", FLOOR_KEY)
    .toArray()[0];
  return row?.value ?? 0;
}

/**
 * Record that a delta-less mutation just ran at `maxSeq`. MAX() so concurrent
 * or out-of-order bumps can only raise the floor, never lower it.
 */
export function bumpResyncFloor(sql: SqlStorage, maxSeq: number): void {
  sql.exec(
    `INSERT INTO sync_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = MAX(value, excluded.value)`,
    FLOOR_KEY,
    maxSeq
  );
}

/**
 * The hello handler's snapshot-vs-replay decision, pure so it is testable
 * without a DO. Snapshot when the client is ahead of the log (its state is not
 * ours), too far behind to replay, behind the pruned tail, or at/below the
 * resync floor (a delta-less mutation happened at or after its seq).
 */
export function needsSnapshot(args: {
  sinceSeq: number;
  maxSeq: number;
  /** MIN(seq) of the changes log, or null when the log is empty. */
  minSeq: number | null;
  floor: number;
  gapLimit: number;
}): boolean {
  const { sinceSeq, maxSeq, minSeq, floor, gapLimit } = args;
  const pruned = minSeq !== null && sinceSeq < minSeq - 1;
  return sinceSeq > maxSeq || maxSeq - sinceSeq > gapLimit || pruned || sinceSeq <= floor;
}
