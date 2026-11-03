import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareQuery,
  QUERY_MEMBER_MAX_ROWS,
  QUERY_VIEWS,
  QueryRateLimited,
  QueryRateLimiter,
  QueryRejected,
  runReadOnlyQuery,
} from "./query.js";
import { runMigrations } from "./schema.js";

// The read-only query gate (POST /api/query, MCP flow_query). prepareQuery is
// the security boundary, so most of these are refusals; the runReadOnlyQuery
// cases run the real migrations on node:sqlite and query through the views.

const TABLES = new Set(["tasks", "lists", "spaces", "users", "api_keys", "audit", "email_messages"]);

function refused(text: string): string {
  try {
    prepareQuery(text, TABLES);
  } catch (err) {
    expect(err).toBeInstanceOf(QueryRejected);
    return (err as Error).message;
  }
  throw new Error(`expected a refusal for: ${text}`);
}

describe("prepareQuery: what it refuses", () => {
  it.each([
    "DELETE FROM tasks_v",
    "UPDATE tasks_v SET title = 'x'",
    "PRAGMA table_info(tasks)",
    "ATTACH DATABASE 'x' AS y",
    "VACUUM",
    "",
  ])("anything but SELECT or WITH: %s", (text) => {
    expect(refused(text)).toMatch(/only a single SELECT|isn't allowed|base table/);
  });

  it("a write hidden behind WITH", () => {
    expect(refused("WITH x AS (SELECT 1) DELETE FROM tasks_v")).toContain('"delete"');
    expect(refused("WITH x AS (SELECT 1) INSERT INTO tasks_v SELECT * FROM x")).toContain('"insert"');
  });

  it("a second statement, but not a trailing semicolon", () => {
    expect(refused("SELECT 1; SELECT 2")).toContain("only one statement");
    expect(refused("SELECT 1; DROP TABLE tasks")).toContain("only one statement");
    expect(() => prepareQuery("SELECT 1;  -- done\n", TABLES)).not.toThrow();
  });

  it("base tables, however they're quoted", () => {
    for (const text of [
      "SELECT * FROM tasks",
      'SELECT * FROM "tasks"',
      "SELECT * FROM `api_keys`",
      "SELECT * FROM [audit]",
      "SELECT * FROM Tasks_v JOIN users ON 1",
      "SELECT (SELECT token_hash FROM api_keys LIMIT 1)",
      "SELECT * FROM tasks_v WHERE id IN (SELECT entity FROM audit)",
    ]) {
      expect(refused(text)).toContain("base table");
    }
  });

  it("sqlite internals and pragma functions", () => {
    for (const text of [
      "SELECT sql FROM sqlite_master",
      "SELECT * FROM sqlite_schema",
      "SELECT * FROM pragma_table_info('tasks_v')",
    ]) {
      const message = refused(text);
      expect(message).toContain("aren't queryable");
      // The Worker hides any DO error matching /SQLITE_/i behind a 500.
      expect(message).not.toMatch(/SQLITE_/i);
    }
  });

  it("unterminated quotes and comments", () => {
    expect(refused("SELECT 'abc")).toContain("unterminated");
    expect(refused("SELECT 1 /* x")).toContain("unterminated");
  });
});

describe("prepareQuery: what it allows", () => {
  it("table and keyword names inside string literals and comments", () => {
    const text = "SELECT title FROM tasks_v WHERE title LIKE '%delete tasks%' -- update users\n";
    expect(prepareQuery(text, TABLES)).toContain("'%delete tasks%'");
  });

  it("doubled quotes inside a literal", () => {
    expect(() => prepareQuery("SELECT 'it''s; DROP TABLE tasks' AS x", TABLES)).not.toThrow();
  });

  it("a table name used as an alias after AS, but nowhere else", () => {
    expect(() => prepareQuery("SELECT count(*) AS tasks, list_name AS lists FROM tasks_v GROUP BY list_name", TABLES)).not.toThrow();
    expect(refused("SELECT count(*) tasks FROM tasks_v")).toContain("rename it (e.g. n_tasks)");
    expect(refused("SELECT count(*) AS tasks FROM tasks_v ORDER BY tasks")).toContain("rename it");
    expect(refused("SELECT 1 AS api_keys, (SELECT token_hash FROM api_keys)")).toContain("base table");
    expect(refused("SELECT 1 AS tasks FROM tasks")).toContain("base table");
  });

  it("column names that merely contain a keyword", () => {
    expect(() => prepareQuery("SELECT updated_at, created_by FROM tasks_v", TABLES)).not.toThrow();
  });

  it("prepends every view, and merges the caller's own WITH into one clause", () => {
    const plain = prepareQuery("SELECT 1", TABLES);
    for (const name of Object.keys(QUERY_VIEWS)) expect(plain).toContain(`${name} AS (`);
    expect(plain.match(/\bWITH\b/g)).toHaveLength(1);

    const merged = prepareQuery("with recursive n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3) SELECT * FROM n", TABLES);
    expect(merged.match(/\bWITH RECURSIVE\b/gi)).toHaveLength(1);
    expect(merged).toContain("n(i) AS (SELECT 1");
  });
});

/** SqlStorage over node:sqlite, with the raw()/columnNames cursor runReadOnlyQuery reads. */
function sqliteStorage(db: DatabaseSync): SqlStorage {
  const exec = (query: string, ...params: unknown[]): unknown => {
    if (!/^\s*(SELECT|WITH)/i.test(query)) {
      db.prepare(query).run(...(params as never[]));
      return { toArray: () => [], one: () => undefined, raw: () => [][Symbol.iterator](), columnNames: [] };
    }
    const objects = db.prepare(query).all(...(params as never[]));
    const arrays = db.prepare(query);
    arrays.setReturnArrays(true);
    return {
      toArray: () => objects,
      one: () => objects[0],
      raw: () => (arrays.all(...(params as never[])) as unknown as unknown[][])[Symbol.iterator](),
      columnNames: arrays.columns().map((c) => c.name),
    };
  };
  return { exec } as unknown as SqlStorage;
}

describe("runReadOnlyQuery against the real schema", () => {
  let db: DatabaseSync;
  let sql: SqlStorage;
  const transaction = (fn: () => void): void => {
    db.prepare("SAVEPOINT q").run();
    try {
      fn();
      db.prepare("RELEASE q").run();
    } catch (err) {
      db.prepare("ROLLBACK TO q").run();
      db.prepare("RELEASE q").run();
      throw err;
    }
  };

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    sql = sqliteStorage(db);
    runMigrations(sql, (fn) => transaction(fn));
    const now = Date.UTC(2026, 10, 2, 17);
    db.exec(`
      INSERT INTO users (id, email, name, role, created_at) VALUES ('us_a', 'avery@example.com', 'Avery', 'owner', ${now});
      INSERT INTO spaces (id, name, position, created_at) VALUES ('sp_1', 'Acme', 1, ${now});
      INSERT INTO lists (id, space_id, name, position, inbound_token, created_at) VALUES ('ls_1', 'sp_1', 'Ongoing', 1, 'secret-token', ${now});
      INSERT INTO statuses (id, list_id, name, color, type, position) VALUES ('st_1', 'ls_1', 'to do', '#888', 'open', 1);
      INSERT INTO tasks (id, list_id, title, status_id, assignee_id, due_date, tags, tags_text, position, created_by, created_at, updated_at)
        VALUES ('tk_1', 'ls_1', 'Fix the form', 'st_1', 'us_a', ${now}, '["web"]', '|web|', 1, 'us_a', ${now}, ${now}),
               ('tk_2', 'ls_1', 'Write the post', 'st_1', NULL, NULL, '[]', '|', 2, 'us_a', ${now}, ${now});
      INSERT INTO subtasks (id, task_id, title, done, position, created_at) VALUES ('sb_1', 'tk_1', 'step', 1, 1, ${now});
    `);
  });

  it("joins names onto tasks and counts subtasks", () => {
    const result = runReadOnlyQuery(
      sql,
      transaction,
      "SELECT id, list_name, space_name, status, assignee_name, due_on, subtask_count, subtasks_done FROM tasks_v WHERE tags_text LIKE '%|web|%'"
    );
    expect(result.columns).toEqual([
      "id", "list_name", "space_name", "status", "assignee_name", "due_on", "subtask_count", "subtasks_done",
    ]);
    expect(result.rows).toEqual([["tk_1", "Ongoing", "Acme", "to do", "Avery", "2026-11-02", 1, 1]]);
    expect(result.truncated).toBe(false);
  });

  it("keeps secrets out of the views", () => {
    const lists = runReadOnlyQuery(sql, transaction, "SELECT * FROM lists_v");
    expect(lists.columns).not.toContain("inbound_token");
    expect(JSON.stringify(lists.rows)).not.toContain("secret-token");
    const attachments = runReadOnlyQuery(sql, transaction, "SELECT * FROM attachments_v");
    expect(attachments.columns).not.toContain("r2_key");
  });

  it("caps rows and says so", () => {
    const result = runReadOnlyQuery(sql, transaction, "SELECT id FROM tasks_v ORDER BY id", 1);
    expect(result.rows).toEqual([["tk_1"]]);
    expect(result.truncated).toBe(true);
  });

  it("refuses every real table in the database, not just a fixed list", () => {
    expect(() => runReadOnlyQuery(sql, transaction, "SELECT * FROM scheduled_jobs")).toThrow(/base table/);
    expect(() => runReadOnlyQuery(sql, transaction, "SELECT * FROM tasks_fts")).toThrow(/base table/);
  });

  it("reports SQLite's own error without its result code", () => {
    expect(() => runReadOnlyQuery(sql, transaction, "SELECT nope FROM tasks_v")).toThrow(
      /^query failed: no such column: nope/
    );
  });

  it("always rolls back", () => {
    const spy = vi.fn(transaction);
    runReadOnlyQuery(sql, spy, "SELECT count(*) FROM tasks_v");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 2 });
  });
});

describe("runReadOnlyQuery for a member", () => {
  // Three spaces: sp_pub (workspace-visible), sp_mine (private, the member is
  // in it) and sp_hidden (private, they aren't). Every hidden row carries the
  // word "hidden" somewhere, so a leak through any column shows up in a plain
  // string search of the result.
  let db: DatabaseSync;
  let sql: SqlStorage;
  const VISIBLE: ReadonlySet<string> = new Set(["sp_pub", "sp_mine"]);
  const transaction = (fn: () => void): void => {
    db.prepare("SAVEPOINT q").run();
    try {
      fn();
      db.prepare("RELEASE q").run();
    } catch (err) {
      db.prepare("ROLLBACK TO q").run();
      db.prepare("RELEASE q").run();
      throw err;
    }
  };
  const run = (text: string, maxRows?: number, visible: ReadonlySet<string> | null = VISIBLE) =>
    runReadOnlyQuery(sql, transaction, text, maxRows, visible);

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    sql = sqliteStorage(db);
    runMigrations(sql, (fn) => transaction(fn));
    const now = Date.UTC(2026, 10, 3, 17);
    const seed = (key: string, visibility: string) => `
      INSERT INTO spaces (id, name, visibility, position, created_at) VALUES ('sp_${key}', '${key} space', '${visibility}', 1, ${now});
      INSERT INTO lists (id, space_id, name, position, inbound_token, created_at) VALUES ('ls_${key}', 'sp_${key}', '${key} list', 1, 'tok-${key}', ${now});
      INSERT INTO statuses (id, list_id, name, color, type, position) VALUES ('st_${key}', 'ls_${key}', '${key} status', '#888', 'open', 1);
      INSERT INTO tasks (id, list_id, title, status_id, tags, tags_text, position, created_by, created_at, updated_at)
        VALUES ('tk_${key}', 'ls_${key}', '${key} task', 'st_${key}', '[]', '|', 1, 'us_owner', ${now}, ${now});
      INSERT INTO subtasks (id, task_id, title, done, position, created_at) VALUES ('sb_${key}', 'tk_${key}', '${key} subtask', 0, 1, ${now});
      INSERT INTO comments (id, task_id, author_id, body, created_at) VALUES ('cm_${key}', 'tk_${key}', 'us_owner', '${key} comment', ${now});
      INSERT INTO attachments (id, task_id, filename, r2_key, size, mime_type, created_at)
        VALUES ('at_${key}', 'tk_${key}', '${key}.pdf', 'r2/${key}', 1, 'application/pdf', ${now});`;
    db.exec(`
      INSERT INTO users (id, email, name, role, created_at) VALUES ('us_owner', 'owner@example.com', 'Owner', 'owner', ${now});
      INSERT INTO users (id, email, name, role, created_at) VALUES ('us_member', 'member@example.com', 'Member', 'member', ${now});
      ${seed("pub", "workspace")}
      ${seed("mine", "private")}
      ${seed("hidden", "private")}
      INSERT INTO space_members (space_id, user_id, created_at) VALUES ('sp_mine', 'us_member', ${now});
      INSERT INTO space_members (space_id, user_id, created_at) VALUES ('sp_hidden', 'us_owner', ${now});
    `);
  });

  it.each(Object.keys(QUERY_VIEWS).filter((name) => name !== "users_v"))(
    "%s holds no row from a space the member can't see",
    (view) => {
      const result = run(`SELECT * FROM ${view}`);
      expect(result.rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(result.rows)).not.toContain("hidden");
    }
  );

  it("gives an owner/admin every space through the same views", () => {
    const result = run("SELECT id FROM tasks_v ORDER BY id", undefined, null);
    expect(result.rows).toEqual([["tk_hidden"], ["tk_mine"], ["tk_pub"]]);
  });

  it("can't reach a hidden space through a join, subquery or the caller's own CTE", () => {
    const attempts = [
      "SELECT t.id, s.title FROM tasks_v t LEFT JOIN subtasks_v s ON s.task_id = t.id",
      "SELECT (SELECT group_concat(title) FROM tasks_v) AS titles",
      "SELECT count(*) AS n FROM tasks_v WHERE title LIKE '%hidden%'",
      "WITH mine AS (SELECT * FROM comments_v) SELECT body FROM mine",
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3) SELECT title FROM tasks_v, n",
      "SELECT c.body, a.filename FROM comments_v c JOIN attachments_v a ON a.task_id = c.task_id",
      "SELECT s.name FROM spaces_v s JOIN space_members_v m ON m.space_id = s.id",
    ];
    for (const text of attempts) {
      expect(JSON.stringify(run(text).rows), text).not.toContain("hidden");
    }
    expect(run("SELECT count(*) AS n FROM tasks_v WHERE title LIKE '%hidden%'").rows).toEqual([[0]]);
  });

  it("still refuses the base tables, so the filter can't be stepped around", () => {
    expect(() => run("SELECT title FROM tasks WHERE id = 'tk_hidden'")).toThrow(/base table/);
    expect(() => run("SELECT * FROM space_members")).toThrow(/base table/);
  });

  it("returns nothing, rather than failing, for a member who sees no space", () => {
    expect(run("SELECT count(*) AS n FROM tasks_v", undefined, new Set()).rows).toEqual([[0]]);
  });

  it("quotes space ids safely", () => {
    const result = run("SELECT count(*) AS n FROM tasks_v", undefined, new Set(["sp_pub", "x') OR 1=1 --"]));
    expect(result.rows).toEqual([[1]]);
  });

  it("caps a member at QUERY_MEMBER_MAX_ROWS whatever maxRows asks for", () => {
    const result = run(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500) SELECT i FROM n",
      1000
    );
    expect(result.rows).toHaveLength(QUERY_MEMBER_MAX_ROWS);
    expect(result.truncated).toBe(true);
    expect(run("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500) SELECT i FROM n", 1000, null).rows).toHaveLength(500);
  });
});

describe("QueryRateLimiter", () => {
  it("allows the budget per rolling minute per user, then says how long to wait", () => {
    let now = 1_000_000;
    const limiter = new QueryRateLimiter(3, () => now);
    for (let i = 0; i < 3; i++) limiter.take("us_a");
    expect(() => limiter.take("us_a")).toThrow(QueryRateLimited);
    expect(() => limiter.take("us_a")).toThrow(/^too many queries: members may run 3 a minute; try again in 60s$/);
    // Someone else's budget is their own.
    limiter.take("us_b");
    now += 60_001;
    limiter.take("us_a");
  });
});
