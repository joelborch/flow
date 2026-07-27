import type { Status, StatusType } from "@flow/shared";
import { id } from "./id.js";
import { type StatusRow, toStatus } from "./rows.js";

// ---------------------------------------------------------------------------
// Status semantics: statuses are per-list and ordered. Exactly one "open"
// status, always first; exactly one "closed" status, always last; any number
// of "custom" in between.
//
// Mutation inputs reference a status by NAME, case-insensitively, and every
// failure to resolve one lists the valid names — agents read these messages.
// ---------------------------------------------------------------------------

export interface StatusSpec {
  name: string;
  color: string;
  type: StatusType;
  /** Import only: reuse an id the caller already assigned. */
  id?: string;
}

export const DEFAULT_STATUSES: readonly StatusSpec[] = [
  { name: "To Do", color: "#8b8f9a", type: "open" },
  { name: "In Progress", color: "#3b82f6", type: "custom" },
  { name: "Done", color: "#22c55e", type: "closed" },
];

/** Order left-to-right and enforce the one-open-first / one-closed-last rule. */
export function normalizeStatusSpecs(
  input: ReadonlyArray<{ name: string; color?: string; type: StatusType; id?: string }> | undefined
): StatusSpec[] {
  if (!input || input.length === 0) return [...DEFAULT_STATUSES];

  const specs: StatusSpec[] = input.map((s) => ({
    name: s.name.trim(),
    color: s.color?.trim() || "#8b8f9a",
    type: s.type,
    id: s.id,
  }));

  const seen = new Set<string>();
  for (const s of specs) {
    if (s.name === "") throw new Error("Status names cannot be empty.");
    const key = s.name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate status name "${s.name}" — status names must be unique per list.`);
    }
    seen.add(key);
  }

  const open = specs.filter((s) => s.type === "open");
  const closed = specs.filter((s) => s.type === "closed");
  if (open.length !== 1) {
    throw new Error(
      `A list needs exactly one status of type "open", got ${open.length} (${
        open.map((s) => s.name).join(", ") || "none"
      }).`
    );
  }
  if (closed.length !== 1) {
    throw new Error(
      `A list needs exactly one status of type "closed", got ${closed.length} (${
        closed.map((s) => s.name).join(", ") || "none"
      }).`
    );
  }
  // Open first, closed last, customs keep their given order in between.
  return [open[0]!, ...specs.filter((s) => s.type === "custom"), closed[0]!];
}

export function insertStatuses(
  sql: SqlStorage,
  listId: string,
  specs: readonly StatusSpec[]
): Status[] {
  const out: Status[] = [];
  specs.forEach((spec, i) => {
    // A caller-supplied id that already exists (on ANY list — the id is the
    // table's primary key) gets replaced with a fresh one rather than letting
    // the insert throw and silently strip this list of its status set. The
    // ClickUp import hit exactly this: inherited space-default statuses share
    // one ClickUp id across many lists.
    let statusId = spec.id ?? id("st_");
    if (
      spec.id !== undefined &&
      sql.exec("SELECT 1 FROM statuses WHERE id = ?", spec.id).toArray().length > 0
    ) {
      statusId = id("st_");
    }
    sql.exec(
      "INSERT INTO statuses (id, list_id, name, color, type, position) VALUES (?, ?, ?, ?, ?, ?)",
      statusId,
      listId,
      spec.name,
      spec.color,
      spec.type,
      i
    );
    out.push({ id: statusId, name: spec.name, color: spec.color, type: spec.type, position: i });
  });
  return out;
}

export function listStatuses(sql: SqlStorage, listId: string): Status[] {
  return sql
    .exec<StatusRow>(
      "SELECT id, list_id, name, color, type, position FROM statuses WHERE list_id = ? ORDER BY position",
      listId
    )
    .toArray()
    .map(toStatus);
}

export function getStatus(sql: SqlStorage, statusId: string): Status | null {
  const rows = sql
    .exec<StatusRow>(
      "SELECT id, list_id, name, color, type, position FROM statuses WHERE id = ?",
      statusId
    )
    .toArray();
  return rows.length === 0 ? null : toStatus(rows[0]!);
}

/** The list's "open" status — the default for newly created tasks. */
export function openStatus(sql: SqlStorage, listId: string): Status {
  const statuses = listStatuses(sql, listId);
  if (statuses.length === 0) {
    throw new Error(`List ${listId} has no statuses — the list is malformed.`);
  }
  return statuses.find((s) => s.type === "open") ?? statuses[0]!;
}

/**
 * Resolve a status NAME (case-insensitive, whitespace-tolerant) within a list.
 * Throws with the full valid set so callers — including LLM agents — can
 * correct themselves without another round trip.
 */
export function resolveStatusName(sql: SqlStorage, listId: string, name: string): Status {
  const statuses = listStatuses(sql, listId);
  const wanted = name.trim().toLowerCase();
  const hit = statuses.find((s) => s.name.toLowerCase() === wanted);
  if (hit) return hit;
  throw new Error(
    `Unknown status "${name}" for list ${listId}. Valid statuses (in order): ${statuses
      .map((s) => `"${s.name}" (${s.type})`)
      .join(", ")}.`
  );
}

/** Resolve many names at once, e.g. the searchTasks status filter. */
export function resolveStatusNamesAcrossLists(sql: SqlStorage, names: readonly string[]): string[] {
  const wanted = new Set(names.map((n) => n.trim().toLowerCase()));
  if (wanted.size === 0) return [];
  const rows = sql
    .exec<{ id: string; name: string }>("SELECT id, name FROM statuses")
    .toArray();
  const ids = rows.filter((r) => wanted.has(r.name.toLowerCase())).map((r) => r.id);
  if (ids.length === 0) {
    const known = [...new Set(rows.map((r) => r.name))].sort();
    throw new Error(
      `No status matches ${[...wanted].map((n) => `"${n}"`).join(", ")}. ` +
        `Known status names in this workspace: ${known.map((n) => `"${n}"`).join(", ")}.`
    );
  }
  return ids;
}
