// Read-only SQL for agents (POST /api/query, MCP flow_query).
//
// One SELECT replaces the chain of map → search → get-task calls an agent
// otherwise makes, which is where its time goes. Two things keep it safe:
//
//   - Callers never see a base table. Every query runs under a WITH clause of
//     friendly views (QUERY_VIEWS) that leave out secrets — api_keys,
//     lists.inbound_token, attachments.r2_key, email bodies, the audit diff —
//     and any word in the caller's text that names a real table, an
//     sqlite_* object or a pragma_* function is refused. A table can only be
//     referenced by name, so that check is the boundary.
//   - Nothing can write. Statements other than SELECT/WITH and every write or
//     schema keyword are refused before execution, and the query runs inside
//     transactionSync with a deliberate throw at the end, so even a write that
//     slipped through would roll back.
//
// The DO is single-threaded and a running query can't be interrupted, so a
// careless cross join stalls everyone until it finishes. The route is
// owner/admin only for that reason as much as for visibility: views ignore
// private-space membership, exactly like the audit log.

/** Views the caller's SQL can use. Names must never collide with a real table. */
export const QUERY_VIEWS: Record<string, string> = {
  spaces_v: `SELECT id, name, visibility, archived, created_by, created_at FROM spaces`,
  space_members_v: `SELECT space_id, user_id, created_at FROM space_members`,
  lists_v: `SELECT l.id, l.name, l.space_id, s.name AS space_name, l.archived, l.position, l.created_at
    FROM lists l JOIN spaces s ON s.id = l.space_id`,
  statuses_v: `SELECT id, list_id, name, type, position FROM statuses`,
  users_v: `SELECT id, name, email, role, deactivated, created_at FROM users`,
  tasks_v: `SELECT t.id, t.title, t.description, t.list_id, l.name AS list_name, l.space_id,
      sp.name AS space_name, t.status_id, st.name AS status, st.type AS status_type,
      t.assignee_id, u.name AS assignee_name, u.email AS assignee_email, t.priority,
      t.due_date, date(t.due_date / 1000, 'unixepoch') AS due_on, t.start_date,
      t.tags, t.tags_text, t.snoozed_until, t.blocked_note,
      t.closed_at, t.closed_at IS NOT NULL AS is_closed,
      t.assigned_by, t.assigned_at, t.handoff_state, t.handoff_requested_by,
      t.created_by, t.created_at, t.updated_at, t.position,
      (SELECT count(*) FROM subtasks x WHERE x.task_id = t.id) AS subtask_count,
      (SELECT count(*) FROM subtasks x WHERE x.task_id = t.id AND x.done = 1) AS subtasks_done
    FROM tasks t
    JOIN lists l ON l.id = t.list_id
    JOIN spaces sp ON sp.id = l.space_id
    LEFT JOIN statuses st ON st.id = t.status_id
    LEFT JOIN users u ON u.id = t.assignee_id`,
  subtasks_v: `SELECT s.id, s.task_id, t.title AS task_title, s.title, s.done, s.note,
      s.assignee_id, u.name AS assignee_name, s.due_date,
      date(s.due_date / 1000, 'unixepoch') AS due_on, s.assigned_by, s.position, s.created_at
    FROM subtasks s JOIN tasks t ON t.id = s.task_id LEFT JOIN users u ON u.id = s.assignee_id`,
  comments_v: `SELECT c.id, c.task_id, c.author_id, u.name AS author_name, c.body, c.via,
      c.email_to, c.email_status, c.created_at
    FROM comments c LEFT JOIN users u ON u.id = c.author_id`,
  attachments_v: `SELECT id, task_id, filename, size, mime_type, uploaded_by, storage_provider,
      drive_web_view_link, created_at FROM attachments`,
};

export const QUERY_MAX_ROWS = 1000;
export const QUERY_DEFAULT_ROWS = 200;
export const QUERY_MAX_LENGTH = 10_000;

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** True when more rows matched than were returned. */
  truncated: boolean;
}

/** Thrown for SQL the gate refuses or SQLite rejects; the route maps it to a 400. */
export class QueryRejected extends Error {}

const WRITE_WORDS = new Set([
  "insert", "update", "delete", "replace", "upsert", "drop", "create", "alter", "attach",
  "detach", "pragma", "vacuum", "reindex", "analyze", "begin", "commit", "rollback", "end",
  "savepoint", "release", "returning", "load_extension",
]);

interface Token {
  word: string;
  start: number;
  end: number;
}

/**
 * Words and identifiers in `text`, lowercased, with string literals and
 * comments skipped and quoted identifiers ("x", `x`, [x]) unquoted. Also
 * reports where the first statement ends, so a second one can be refused.
 */
function tokenize(text: string): { tokens: Token[]; semicolons: number[]; contentEnd: number } {
  const tokens: Token[] = [];
  const semicolons: number[] = [];
  /** End of the last character that isn't whitespace, a comment or a semicolon. */
  let contentEnd = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'") {
      i = closeQuote(text, i, "'");
      contentEnd = i;
    } else if (ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      const end = closeQuote(text, i, close);
      tokens.push({ word: text.slice(i + 1, end - 1).toLowerCase(), start: i, end });
      i = end;
      contentEnd = i;
    } else if (ch === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl + 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) throw new QueryRejected("unterminated /* comment");
      i = close + 2;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_$]/.test(text[j]!)) j++;
      tokens.push({ word: text.slice(i, j).toLowerCase(), start: i, end: j });
      i = j;
      contentEnd = i;
    } else {
      if (ch === ";") semicolons.push(i);
      else if (!/\s/.test(ch)) contentEnd = i + 1;
      i++;
    }
  }
  return { tokens, semicolons, contentEnd };
}

/** Index just past the quote that closes the one at `open` (doubled quotes escape). */
function closeQuote(text: string, open: number, close: string): number {
  let j = open + 1;
  while (j < text.length) {
    if (text[j] === close) {
      if (close !== "]" && text[j + 1] === close) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  throw new QueryRejected("unterminated quote");
}

/**
 * Checks `text` against the gate and returns the full statement to run: the
 * caller's query with QUERY_VIEWS prepended as CTEs. `forbidden` is every real
 * table and view name in the database (sqlite_master), lowercased.
 */
export function prepareQuery(text: string, forbidden: ReadonlySet<string>): string {
  if (text.length > QUERY_MAX_LENGTH) {
    throw new QueryRejected(`query is longer than ${QUERY_MAX_LENGTH} characters`);
  }
  const { tokens, semicolons, contentEnd } = tokenize(text);
  const first = tokens[0];
  if (!first || (first.word !== "select" && first.word !== "with")) {
    throw new QueryRejected("only a single SELECT (or WITH … SELECT) is allowed");
  }
  if (semicolons.some((at) => at < contentEnd)) {
    throw new QueryRejected("only one statement is allowed");
  }
  for (const [index, { word }] of tokens.entries()) {
    if (WRITE_WORDS.has(word)) {
      throw new QueryRejected(`"${word}" isn't allowed; this endpoint is read-only`);
    }
    // Not echoed: the Worker turns any DO error mentioning "SQLITE_" into an
    // opaque 500, and "sqlite_master" would match.
    if (word.startsWith("sqlite_") || word.startsWith("pragma_")) {
      throw new QueryRejected(
        `SQLite internals and pragma functions aren't queryable; use the views: ${Object.keys(QUERY_VIEWS).join(", ")}`
      );
    }
    // Right after AS a name can only be an alias (count(*) AS comments), which
    // never reads the table it happens to share a name with. Its later uses
    // (ORDER BY comments) stay refused: allowing a name once it's been aliased
    // would also let `FROM api_keys` through after `1 AS api_keys`.
    if (forbidden.has(word) && tokens[index - 1]?.word !== "as") {
      throw new QueryRejected(
        `"${word}" is a base table and isn't queryable; use the views (${Object.keys(QUERY_VIEWS).join(", ")}), and if it's a column alias, rename it (e.g. n_${word})`
      );
    }
  }

  const views = Object.entries(QUERY_VIEWS)
    .map(([name, body]) => `${name} AS (${body})`)
    .join(",\n");
  // Drop a trailing semicolon; WITH RECURSIVE allows ordinary CTEs too, so the
  // caller's own WITH (recursive or not) merges into one clause.
  const body = text.slice(0, contentEnd);
  if (first.word === "with") {
    const second = tokens[1];
    const rest = second?.word === "recursive" ? body.slice(second.end) : body.slice(first.end);
    return `WITH RECURSIVE ${views},\n${rest}`;
  }
  return `WITH RECURSIVE ${views}\n${body}`;
}

/**
 * SQLite's message without its result code. The Worker turns DO errors that
 * mention SQLITE_ into opaque 500s, but a bad query is the caller's mistake and
 * "no such column: x" is exactly what an agent needs to fix it.
 */
function sqliteMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Offsets count the prepended views, so they'd point at the wrong place.
  const message = raw.replace(/:?\s*SQLITE_[A-Z_]+/g, "").replace(/ at offset \d+/g, "").trim();
  return `query failed: ${message}`;
}

/** Sentinel that makes transactionSync roll back after a successful read. */
class ReadDone extends Error {
  constructor(readonly result: QueryResult) {
    super("read done");
  }
}

/**
 * Runs a caller's read-only query. `transaction` is the DO's transactionSync;
 * the callback always throws, so the transaction always rolls back.
 */
export function runReadOnlyQuery(
  sql: SqlStorage,
  transaction: (fn: () => void) => void,
  text: string,
  maxRows: number = QUERY_DEFAULT_ROWS
): QueryResult {
  const limit = Math.min(Math.max(Math.trunc(maxRows), 1), QUERY_MAX_ROWS);
  const forbidden = new Set(
    sql
      .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view')`)
      .toArray()
      .map((row) => row.name.toLowerCase())
  );
  const statement = prepareQuery(text, forbidden);
  try {
    transaction(() => {
      let cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
      try {
        cursor = sql.exec(statement);
      } catch (err) {
        throw new QueryRejected(sqliteMessage(err));
      }
      const rows: unknown[][] = [];
      let truncated = false;
      for (const row of cursor.raw()) {
        if (rows.length === limit) {
          truncated = true;
          break;
        }
        rows.push(row.map((value) => (value instanceof ArrayBuffer ? `<blob ${value.byteLength} bytes>` : value)));
      }
      throw new ReadDone({ columns: cursor.columnNames, rows, truncated });
    });
  } catch (err) {
    if (err instanceof ReadDone) return err.result;
    if (err instanceof QueryRejected) throw err;
    throw new QueryRejected(sqliteMessage(err));
  }
  throw new Error("unreachable: query transaction returned without a result");
}
