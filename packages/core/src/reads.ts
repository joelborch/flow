import type {
  Actor,
  ApiKey,
  AuditEntry,
  BoardSnapshot,
  List,
  SearchTasksInput,
  SearchTasksResult,
  Space,
  Status,
  TaskDetail,
  User,
} from "@flow/shared";
import {
  API_KEY_COLUMNS,
  LIST_COLUMNS,
  SNAPSHOT_CLOSED_WINDOW_MS,
  SNAPSHOT_TASK_COLUMNS,
  SPACE_COLUMNS,
  USER_COLUMNS,
  type WorkspaceHost,
  assertSpaceWritable,
  emailReplyTarget,
  listAttachments,
  listAutomations,
  listComments,
  listSubtasks,
  listUsers,
  requireTaskRow,
  spaceIdForTask,
} from "./db-helpers.js";
import { replySubject } from "./email-intake.js";
import { type QueryResult, runReadOnlyQuery } from "./query.js";
import {
  type ApiKeyRow,
  type AuditRow,
  type ListRow,
  type SnapshotTaskRowSql,
  type SpaceRow,
  type SubtaskRow,
  type UserRow,
  toApiKey,
  toAuditEntry,
  toList,
  toListWithSecrets,
  toSnapshotTask,
  toSpace,
  toSubtask,
  toTask,
  toUser,
} from "./rows.js";
import { searchTasks as runSearch } from "./search.js";
import { listStatuses } from "./statuses.js";
import { toActor } from "./turn.js";
import { automationRulesForSnapshot, visibleSpaceIds } from "./visibility.js";

export function getSnapshot(host: WorkspaceHost, forUserId?: string): BoardSnapshot {
  const { sql } = host;
  const cutoff = Date.now() - SNAPSHOT_CLOSED_WINDOW_MS;
  const seq = host.maxSeq();
  const visible = forUserId === undefined ? null : visibleSpaceIds(sql, forUserId);

  const spaces = sql
    .exec<SpaceRow>(`SELECT ${SPACE_COLUMNS} FROM spaces ORDER BY position`)
    .toArray()
    .map(toSpace)
    .filter((sp) => visible === null || visible.has(sp.id));

  const visibleListIds =
    visible === null
      ? null
      : new Set(
          sql
            .exec<{ id: string; space_id: string }>("SELECT id, space_id FROM lists")
            .toArray()
            .filter((r) => visible.has(r.space_id))
            .map((r) => r.id)
        );

  const statusesByList = new Map<string, Status[]>();
  for (const s of sql
    .exec<{
      id: string;
      list_id: string;
      name: string;
      color: string;
      type: string;
      position: number;
    }>("SELECT id, list_id, name, color, type, position FROM statuses ORDER BY list_id, position")
    .toArray()) {
    const bucket = statusesByList.get(s.list_id);
    const status: Status = {
      id: s.id,
      name: s.name,
      color: s.color,
      type: s.type as Status["type"],
      position: s.position,
    };
    if (bucket) bucket.push(status);
    else statusesByList.set(s.list_id, [status]);
  }

  const lists = sql
    .exec<ListRow>(`SELECT ${LIST_COLUMNS} FROM lists ORDER BY space_id, position`)
    .toArray()
    .filter((r) => visibleListIds === null || visibleListIds.has(r.id))
    .map((r) => toList(r, statusesByList.get(r.id) ?? []));

  const tasks = sql
    .exec<SnapshotTaskRowSql>(
      `SELECT ${SNAPSHOT_TASK_COLUMNS} FROM tasks
       WHERE closed_at IS NULL OR closed_at >= ?
       ORDER BY list_id, status_id, position`,
      cutoff
    )
    .toArray()
    .filter((r) => visibleListIds === null || visibleListIds.has(r.list_id))
    .map(toSnapshotTask);

  const visibleTaskIds = visibleListIds === null ? null : new Set(tasks.map((t) => t.id));
  const subtasks = sql
    .exec<SubtaskRow>(
      `SELECT s.id, s.task_id, s.title, s.done, s.assignee_id, s.assigned_by, s.assigned_at,
              s.due_date, s.note, s.position, s.created_at
       FROM subtasks s JOIN tasks t ON t.id = s.task_id
       WHERE t.closed_at IS NULL OR t.closed_at >= ?
       ORDER BY s.task_id, s.position`,
      cutoff
    )
    .toArray()
    .filter((r) => visibleTaskIds === null || visibleTaskIds.has(r.task_id))
    .map(toSubtask);

  return {
    seq,
    spaces,
    lists,
    tasks,
    subtasks,
    users: listUsers(sql),
    automationRules: automationRulesForSnapshot(visible, () => listAutomations(sql)),
  };
}

export function getWorkspaceMap(
  host: WorkspaceHost,
  forUserId?: string
): {
  seq: number;
  spaces: Array<
    Space & { lists: Array<{ id: string; name: string; archived: boolean; statuses: Status[]; openTasks: number }> }
  >;
  users: User[];
} {
  const { sql } = host;
  const visible = forUserId === undefined ? null : visibleSpaceIds(sql, forUserId);
  const counts = new Map<string, number>();
  for (const r of sql
    .exec<{ list_id: string; n: number }>(
      "SELECT list_id, COUNT(*) AS n FROM tasks WHERE closed_at IS NULL GROUP BY list_id"
    )
    .toArray()) {
    counts.set(r.list_id, r.n);
  }
  const snapshotLists = sql.exec<ListRow>(`SELECT ${LIST_COLUMNS} FROM lists ORDER BY space_id, position`).toArray();
  const spaces = sql
    .exec<SpaceRow>(`SELECT ${SPACE_COLUMNS} FROM spaces ORDER BY position`)
    .toArray()
    .map(toSpace)
    .filter((sp) => visible === null || visible.has(sp.id));

  return {
    seq: host.maxSeq(),
    spaces: spaces.map((sp) => ({
      ...sp,
      lists: snapshotLists
        .filter((l) => l.space_id === sp.id)
        .map((l) => ({
          id: l.id,
          name: l.name,
          archived: l.archived !== 0,
          statuses: listStatuses(sql, l.id),
          openTasks: counts.get(l.id) ?? 0,
        })),
    })),
    users: listUsers(sql),
  };
}

export function getTaskDetail(host: WorkspaceHost, taskId: string, forUserId?: string): TaskDetail {
  const { sql } = host;
  const row = requireTaskRow(sql, taskId);
  if (forUserId !== undefined) {
    assertSpaceWritable(sql, toActor(forUserId), spaceIdForTask(sql, taskId));
  }
  const task = toTask(row);
  const replyTo = emailReplyTarget(host, task)?.to ?? null;
  return {
    task,
    subtasks: listSubtasks(sql, taskId),
    comments: listComments(sql, taskId),
    attachments: listAttachments(sql, taskId),
    emailReplyTo: replyTo,
    emailReplySubject: replyTo === null ? null : replySubject(task.title),
  };
}

export function getTaskDetails(
  host: WorkspaceHost,
  taskIds: string[],
  forUserId?: string
): { details: TaskDetail[]; errors: Array<{ taskId: string; error: string }> } {
  const details: TaskDetail[] = [];
  const errors: Array<{ taskId: string; error: string }> = [];
  for (const taskId of taskIds) {
    try {
      details.push(getTaskDetail(host, taskId, forUserId));
    } catch (err) {
      errors.push({ taskId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { details, errors };
}

export function searchTasks(
  sql: SqlStorage,
  input: SearchTasksInput,
  actor?: string | Actor
): SearchTasksResult {
  const visible = actor === undefined ? null : visibleSpaceIds(sql, toActor(actor).userId);
  return runSearch(sql, input, visible);
}

export function getUserByEmail(sql: SqlStorage, email: string): User | null {
  const row = sql
    .exec<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower(?)`, email.trim())
    .toArray()[0];
  return row ? toUser(row) : null;
}

export function getAuditLog(
  sql: SqlStorage,
  filter: {
    entity?: string;
    action?: string;
    userId?: string;
    apiKeyId?: string;
    before?: number;
    after?: number;
    limit?: number;
  } = {}
): { entries: AuditEntry[]; nextBefore: number | null } {
  const where: string[] = [];
  const params: SqlStorageValue[] = [];
  if (filter.entity !== undefined) {
    where.push("entity = ?");
    params.push(filter.entity);
  }
  if (filter.action !== undefined) {
    where.push("action = ?");
    params.push(filter.action);
  }
  if (filter.userId !== undefined) {
    where.push("actor_user_id = ?");
    params.push(filter.userId);
  }
  if (filter.apiKeyId !== undefined) {
    where.push("api_key_id = ?");
    params.push(filter.apiKeyId);
  }
  if (filter.before !== undefined) {
    where.push("id < ?");
    params.push(filter.before);
  }
  if (filter.after !== undefined) {
    where.push("at >= ?");
    params.push(filter.after);
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const rows = sql
    .exec<AuditRow>(
      `SELECT id, actor, action, entity, diff, at FROM audit
       ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
       ORDER BY id DESC LIMIT ?`,
      ...params,
      limit
    )
    .toArray();
  const last = rows[rows.length - 1];
  return {
    entries: rows.map(toAuditEntry),
    nextBefore: rows.length === limit && last ? last.id : null,
  };
}

export function runQuery(
  host: WorkspaceHost,
  text: string,
  maxRows: number | undefined,
  forUserId: string
): QueryResult {
  const visible = visibleSpaceIds(host.sql, forUserId);
  if (visible !== null) host.queryLimiter.take(forUserId);
  return runReadOnlyQuery(host.sql, (fn) => host.ctx.storage.transactionSync(fn), text, maxRows, visible);
}

export function resolveApiKey(sql: SqlStorage, tokenHash: string): { key: ApiKey; user: User } | null {
  const row = sql
    .exec<ApiKeyRow>(`SELECT ${API_KEY_COLUMNS} FROM api_keys WHERE token_hash = ?`, tokenHash)
    .toArray()[0];
  if (!row || row.revoked_at !== null) return null;
  const user = sql
    .exec<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, row.user_id)
    .toArray()[0];
  if (!user) return null;
  sql.exec("UPDATE api_keys SET last_used_at = ? WHERE id = ?", Date.now(), row.id);
  return { key: toApiKey(row), user: toUser(user) };
}

export function listApiKeys(sql: SqlStorage): ApiKey[] {
  return sql
    .exec<ApiKeyRow>(`SELECT ${API_KEY_COLUMNS} FROM api_keys ORDER BY created_at`)
    .toArray()
    .map(toApiKey);
}

export function getListByInboundToken(sql: SqlStorage, inboundToken: string): List | null {
  const row = sql
    .exec<ListRow>(`SELECT ${LIST_COLUMNS} FROM lists WHERE inbound_token = ?`, inboundToken)
    .toArray()[0];
  return row ? toListWithSecrets(row, listStatuses(sql, row.id)) : null;
}

export function getListWithSecrets(sql: SqlStorage, listId: string): List | null {
  const row = sql
    .exec<ListRow>(`SELECT ${LIST_COLUMNS} FROM lists WHERE id = ?`, listId)
    .toArray()[0];
  return row ? toListWithSecrets(row, listStatuses(sql, row.id)) : null;
}
