import { LIMITS, type Priority, type Role, type SpaceVisibility, type StatusType } from "@flow/shared";

// ---------------------------------------------------------------------------
// Import batch shapes for `Workspace.importBatch`.
//
// NOTE FOR THE REST/IMPORTER AGENTS: these types are NOT in @flow/shared —
// `importBatch` is not part of the `WorkspaceRpc` interface, so rather than
// widen the shared contract from inside packages/core, the shapes live here
// and are re-exported from `@flow/core`:
//
//   import type { ImportBatch } from "@flow/core";
//
// IDENTITY: every row is upserted, and identity is resolved in this order:
//   1. `id` — a Flow id the caller already assigned (this is what the ClickUp
//      importer does: it mints ids during transform and POSTs fully-formed
//      @flow/shared entities). Inserted with that exact id if it's new.
//   2. `clickupId` — provenance from the source system.
// At least one of the two is required; supplying both is best, since it keeps
// a replay idempotent no matter which key the caller keys off.
//
// Parents may be referenced by Flow id or by ClickUp id, resolved in the DO.
// A batch is applied in dependency order (users, spaces, lists, tasks,
// subtasks, comments) regardless of key order in the object.
// ---------------------------------------------------------------------------

export interface ImportUser {
  id?: string;
  clickupId?: string | null;
  email: string;
  name?: string;
  role?: Role;
  deactivated?: boolean;
  createdAt?: number;
}

export interface ImportSpace {
  id?: string;
  clickupId?: string | null;
  name: string;
  color?: string | null;
  position?: number;
  archived?: boolean;
  createdAt?: number;
  /**
   * Omitted leaves an existing space alone and makes a new one "workspace" —
   * so a re-import can never accidentally publish a space someone made private
   * after the first load.
   */
  visibility?: SpaceVisibility;
  /**
   * Members for a private space, as Flow user ids. When present it REPLACES the
   * space's membership, matching `setSpaceMembers`; omitted leaves it alone.
   */
  memberUserIds?: string[];
}

export interface ImportList {
  id?: string;
  clickupId?: string | null;
  /** One of the three is required. */
  spaceId?: string;
  spaceClickupId?: string;
  name: string;
  position?: number;
  archived?: boolean;
  inboundToken?: string | null;
  createdAt?: number;
  /**
   * Omitted = the default To Do / In Progress / Done set. Pass `id` on a status
   * to keep ids the caller already assigned (so `task.statusId` resolves).
   */
  statuses?: Array<{ id?: string; name: string; color?: string; type: StatusType }>;
}

export interface ImportTask {
  id?: string;
  clickupId?: string | null;
  /** One of the two is required. */
  listId?: string;
  listClickupId?: string;
  title: string;
  description?: string;
  /** Either the resolved status id, or a status NAME within the target list. */
  statusId?: string;
  status?: string;
  assigneeId?: string | null;
  assigneeEmail?: string | null;
  priority?: Priority | null;
  dueDate?: number | null;
  startDate?: number | null;
  tags?: string[];
  position?: number;
  createdBy?: string;
  createdAt?: number;
  updatedAt?: number;
  closedAt?: number | null;
}

export interface ImportSubtask {
  id?: string;
  clickupId?: string | null;
  /** One of the two is required. */
  taskId?: string;
  taskClickupId?: string;
  title: string;
  done?: boolean;
  assigneeId?: string | null;
  dueDate?: number | null;
  position?: number;
  createdAt?: number;
}

export interface ImportComment {
  id?: string;
  clickupId?: string | null;
  /** One of the two is required. */
  taskId?: string;
  taskClickupId?: string;
  authorId?: string;
  authorEmail?: string;
  body: string;
  createdAt?: number;
}

export interface ImportBatch {
  users?: ImportUser[];
  spaces?: ImportSpace[];
  lists?: ImportList[];
  tasks?: ImportTask[];
  subtasks?: ImportSubtask[];
  comments?: ImportComment[];
}

export interface ImportCounts {
  users: number;
  spaces: number;
  lists: number;
  tasks: number;
  subtasks: number;
  comments: number;
}

export interface ImportResult {
  created: ImportCounts;
  updated: ImportCounts;
  /** Per-row failures; the rest of the batch still commits. */
  errors: Array<{ entity: keyof ImportBatch; ref: string; error: string }>;
  /**
   * Flow id per row, keyed by clickupId when present and by Flow id otherwise,
   * so the importer can build its own map without guessing.
   */
  ids: Record<string, string>;
}

/**
 * Import stays lenient where the interactive API is strict: a ClickUp task with
 * a 4 kB title is real history, and rejecting the row would lose it. Titles are
 * truncated to `LIMITS.importTitleMax` (with an ellipsis so the cut is visible)
 * rather than failing the row.
 */
export function truncateImportTitle(raw: string, max: number = LIMITS.importTitleMax): string {
  return raw.length <= max ? raw : `${raw.slice(0, max - 1)}…`;
}

export const emptyCounts = (): ImportCounts => ({
  users: 0,
  spaces: 0,
  lists: 0,
  tasks: 0,
  subtasks: 0,
  comments: 0,
});
