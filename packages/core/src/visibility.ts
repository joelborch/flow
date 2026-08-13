import type { Actor, Role, SpaceVisibility } from "@flow/shared";

// ---------------------------------------------------------------------------
// Per-space permissions.
//
// The model is deliberately small:
//
//   - Every space is "workspace" (the default) or "private".
//   - Owners and admins see every space, always.
//   - A member sees workspace-visible spaces, plus private spaces they are a
//     member of (`space_members`).
//   - Everything below a space — its lists, tasks, subtasks, comments,
//     attachments — inherits that decision. There is no per-list override.
//
// The decision itself is a pure function so it can be unit-tested and reused by
// the read filters, the write guard and the per-connection WebSocket filter
// without any of them re-deriving the rule.
// ---------------------------------------------------------------------------

/** What a caller needs to know about a space to decide whether to show it. */
export interface SpaceAccess {
  visibility: SpaceVisibility;
  /** Is the user in `space_members` for this space? */
  isMember: boolean;
}

/** Owners and admins are never filtered — they administer the workspace. */
export function isPrivilegedRole(role: Role | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Delta entities that only owner/admin connections may receive. Automation
 * rules are workspace wiring — webhook URLs, email targets, cross-space
 * actions — and the snapshot already withholds them from members, so the
 * live and replay delta paths must too or the socket would leak what the
 * snapshot hides.
 */
export function isPrivilegedDeltaEntity(entity: string): boolean {
  return entity === "automation_rule";
}

/**
 * Entities that always live under a space. A delta for one of these whose
 * space cannot be resolved (row deleted before the log stored `space_id`)
 * must be treated as potentially-private and withheld from members — fail
 * closed. Workspace-scoped entities (`user`) legitimately have no space and
 * stay visible to everyone.
 */
export function isSpaceScopedEntity(entity: string): boolean {
  return (
    entity === "space" ||
    entity === "list" ||
    entity === "task" ||
    entity === "subtask" ||
    entity === "comment" ||
    entity === "attachment"
  );
}

/**
 * Sentinel space id for a space-scoped delta whose space could not be
 * resolved. It is never a real space id, so it is never in any member's
 * visible set — `deltaVisibleTo` therefore fails closed for members while
 * privileged users (visibleSpaces === null) still see everything.
 */
export const UNRESOLVED_SPACE_ID = "__unresolved__";

/**
 * May one delta reach one connection? `visibleSpaces` is the connection user's
 * `visibleSpaceIds` result: null means owner/admin (or an internal caller) and
 * admits everything, a set means a member — who never receives privileged
 * entities, and receives space-scoped deltas only for spaces in the set.
 * Space-less deltas (`user`) go to everyone, as before.
 */
export function deltaVisibleTo(
  entity: string,
  spaceId: string | null,
  visibleSpaces: ReadonlySet<string> | null
): boolean {
  if (visibleSpaces === null) return true;
  if (isPrivilegedDeltaEntity(entity)) return false;
  return spaceId === null || visibleSpaces.has(spaceId);
}

/**
 * The snapshot's automation-rule section. Same `visibleSpaces` convention:
 * null (privileged or internal) gets the real rules, a member gets an empty
 * array — the shared SnapshotSchema requires the field, and an empty list is
 * exactly what a member's Settings view should render.
 */
export function automationRulesForSnapshot<T>(
  visibleSpaces: ReadonlySet<string> | null,
  listAll: () => T[]
): T[] {
  return visibleSpaces === null ? listAll() : [];
}

/**
 * The one rule, in one place. `role` is null for an unknown user id (a
 * deactivated-and-deleted actor, a stale WebSocket attachment): unknown users
 * get the member treatment, never the admin treatment.
 */
export function canSeeSpace(role: Role | null | undefined, access: SpaceAccess): boolean {
  if (isPrivilegedRole(role)) return true;
  return access.visibility !== "private" || access.isMember;
}

/**
 * The message every blocked write returns. It names the space and the way out,
 * because agents and humans both navigate by these sentences — and it says
 * "private" rather than "not found", since pretending the space does not exist
 * would send people hunting for a missing id.
 */
export function privateSpaceError(spaceId: string): string {
  return `Space ${spaceId} is private; ask an owner/admin for access.`;
}

/**
 * Mutations that the workspace itself decided on, rather than a person: inline
 * automation actions and `importBatch`. They run as system and are exempt from
 * the space guard — an automation scoped to a private space must still fire for
 * the member whose task tripped it, and an import loads spaces it is in the
 * middle of creating.
 */
export function isSystemActor(actor: Actor): boolean {
  return actor.via === "automation" || actor.via === "import";
}

// --- storage-backed lookups ------------------------------------------------
// These live here rather than in the DO class so the rule and the queries that
// feed it stay side by side. They take `SqlStorage` like ./statuses.ts does.

export interface SpaceAccessRow {
  [key: string]: SqlStorageValue;
  id: string;
  visibility: string;
}

/** Role for a user id, or null when there is no such user. */
export function roleOf(sql: SqlStorage, userId: string): Role | null {
  if (userId === "") return null;
  const row = sql
    .exec<{ role: string }>("SELECT role FROM users WHERE id = ?", userId)
    .toArray()[0];
  return (row?.role as Role | undefined) ?? null;
}

/** Space ids the user is an explicit member of. */
export function memberSpaceIds(sql: SqlStorage, userId: string): Set<string> {
  if (userId === "") return new Set();
  return new Set(
    sql
      .exec<{ space_id: string }>("SELECT space_id FROM space_members WHERE user_id = ?", userId)
      .toArray()
      .map((r) => r.space_id)
  );
}

/**
 * Every space id this user may see.
 *
 * Returns null — not a set — for owners and admins. That is the "no filtering
 * needed" signal, and it keeps the callers from having to hold the id of every
 * space in the workspace just to prove a privileged user can see all of them.
 */
export function visibleSpaceIds(sql: SqlStorage, userId: string): Set<string> | null {
  if (isPrivilegedRole(roleOf(sql, userId))) return null;
  const member = memberSpaceIds(sql, userId);
  const visible = new Set<string>();
  for (const row of sql
    .exec<SpaceAccessRow>("SELECT id, visibility FROM spaces")
    .toArray()) {
    if (
      canSeeSpace("member", {
        visibility: row.visibility === "private" ? "private" : "workspace",
        isMember: member.has(row.id),
      })
    ) {
      visible.add(row.id);
    }
  }
  return visible;
}

/** Ids of the private spaces only. Cheap enough to re-read per broadcast. */
export function privateSpaceIds(sql: SqlStorage): Set<string> {
  return new Set(
    sql
      .exec<{ id: string }>("SELECT id FROM spaces WHERE visibility = 'private'")
      .toArray()
      .map((r) => r.id)
  );
}

export function isSpaceMember(sql: SqlStorage, spaceId: string, userId: string): boolean {
  if (userId === "") return false;
  return (
    sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM space_members WHERE space_id = ? AND user_id = ?",
        spaceId,
        userId
      )
      .one().n > 0
  );
}

export function listSpaceMemberIds(sql: SqlStorage, spaceId: string): string[] {
  return sql
    .exec<{ user_id: string }>(
      "SELECT user_id FROM space_members WHERE space_id = ? ORDER BY created_at, user_id",
      spaceId
    )
    .toArray()
    .map((r) => r.user_id);
}
