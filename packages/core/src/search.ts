import type { SearchTasksInput, SearchTasksResult } from "@flow/shared";
import { type TaskRowSql, toTaskRow } from "./rows.js";
import { resolveStatusNamesAcrossLists } from "./statuses.js";

// ---------------------------------------------------------------------------
// searchTasks: FTS5 over title+description, combined with structured filters
// and keyset pagination.
//
// The sort is always (updated_at DESC, id DESC) rather than FTS rank, because
// that ordering is stable under concurrent writes — which is what makes the
// cursor safe. Relevance ranking would let a row move between pages.
// ---------------------------------------------------------------------------

const SELECT_COLUMNS = `t.id, t.list_id, t.title, t.description, t.status_id,
  t.assignee_id, t.priority, t.due_date, t.start_date, t.tags, t.position,
  t.created_by, t.created_at, t.updated_at, t.closed_at, t.clickup_id`;

/**
 * Turn free text into a safe FTS5 MATCH expression: word tokens only, each
 * quoted (so operators in user input are inert) and prefix-matched, ANDed.
 * Returns null when the text has no usable tokens.
 */
export function ftsExpression(text: string): string | null {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens
    .slice(0, 16)
    .map((t) => `"${t}"*`)
    .join(" AND ");
}

interface Cursor {
  updatedAt: number;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return btoa(`${c.updatedAt}:${c.id}`);
}

function decodeCursor(raw: string): Cursor {
  let decoded: string;
  try {
    decoded = atob(raw);
  } catch {
    throw new Error(`Invalid cursor "${raw}" — pass back the cursor from the previous page verbatim.`);
  }
  const at = decoded.indexOf(":");
  const updatedAt = Number(decoded.slice(0, at));
  const id = decoded.slice(at + 1);
  if (at < 0 || !Number.isFinite(updatedAt) || id === "") {
    throw new Error(`Invalid cursor "${raw}" — pass back the cursor from the previous page verbatim.`);
  }
  return { updatedAt, id };
}

/**
 * `visibleSpaceIds` is the caller's per-space permission filter: null means "no
 * filtering" (an owner/admin, or an internal call), a set means results are
 * restricted to lists in those spaces. It is applied before COUNT, so `total`
 * reflects what the caller may actually see rather than teasing them with rows
 * they cannot open.
 */
export function searchTasks(
  sql: SqlStorage,
  input: SearchTasksInput,
  visibleSpaceIds: ReadonlySet<string> | null = null
): SearchTasksResult {
  const where: string[] = [];
  const params: SqlStorageValue[] = [];

  if (visibleSpaceIds !== null) {
    const ids = [...visibleSpaceIds];
    // A member with access to nothing matches nothing; skip the scan entirely.
    if (ids.length === 0) return { tasks: [], cursor: null, total: 0 };
    where.push(
      `t.list_id IN (SELECT id FROM lists WHERE space_id IN (${ids.map(() => "?").join(", ")}))`
    );
    params.push(...ids);
  }

  if (input.query !== undefined && input.query.trim() !== "") {
    const expr = ftsExpression(input.query);
    if (expr === null) {
      // Query was punctuation only: nothing can match, so don't run the scan.
      return { tasks: [], cursor: null, total: 0 };
    }
    where.push("t.id IN (SELECT task_id FROM tasks_fts WHERE tasks_fts MATCH ?)");
    params.push(expr);
  }

  if (input.listId !== undefined) {
    where.push("t.list_id = ?");
    params.push(input.listId);
  }

  if (input.spaceId !== undefined) {
    where.push("t.list_id IN (SELECT id FROM lists WHERE space_id = ?)");
    params.push(input.spaceId);
  }

  if (input.status !== undefined && input.status.length > 0) {
    const statusIds = resolveStatusNamesAcrossLists(sql, input.status);
    where.push(`t.status_id IN (${statusIds.map(() => "?").join(", ")})`);
    params.push(...statusIds);
  }

  if (input.assigneeId !== undefined) {
    where.push("t.assignee_id = ?");
    params.push(input.assigneeId);
  }

  if (input.tags !== undefined) {
    for (const tag of input.tags) {
      where.push("t.tags_text LIKE ?");
      params.push(`%|${tag.trim().toLowerCase()}|%`);
    }
  }

  if (!input.includeClosed) where.push("t.closed_at IS NULL");

  if (input.dueBefore !== undefined) {
    where.push("t.due_date IS NOT NULL AND t.due_date <= ?");
    params.push(input.dueBefore);
  }
  if (input.dueAfter !== undefined) {
    where.push("t.due_date IS NOT NULL AND t.due_date >= ?");
    params.push(input.dueAfter);
  }
  if (input.updatedAfter !== undefined) {
    where.push("t.updated_at >= ?");
    params.push(input.updatedAfter);
  }

  const filterSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;

  const { total } = sql
    .exec<{ total: number }>(
      `SELECT COUNT(*) AS total FROM tasks t ${filterSql}`,
      ...params
    )
    .one();

  // Keyset predicate is appended after COUNT so `total` is the full result size.
  const pageWhere = [...where];
  const pageParams = [...params];
  if (input.cursor !== undefined) {
    const c = decodeCursor(input.cursor);
    pageWhere.push("(t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))");
    pageParams.push(c.updatedAt, c.updatedAt, c.id);
  }
  const pageSql = pageWhere.length === 0 ? "" : `WHERE ${pageWhere.join(" AND ")}`;

  const rows = sql
    .exec<TaskRowSql>(
      `SELECT ${SELECT_COLUMNS} FROM tasks t ${pageSql}
       ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`,
      ...pageParams,
      input.limit + 1
    )
    .toArray();

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page[page.length - 1];

  return {
    tasks: page.map(toTaskRow),
    cursor: hasMore && last ? encodeCursor({ updatedAt: last.updated_at, id: last.id }) : null,
    total,
  };
}
