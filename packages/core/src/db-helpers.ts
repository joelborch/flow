/// <reference types="@cloudflare/workers-types" />
import type {
  Actor,
  Attachment,
  AutomationRule,
  BoardSnapshot,
  Comment,
  CreateCommentInput,
  CreateListInput,
  CreateSpaceInput,
  CreateSubtaskInput,
  Delta,
  EmailIntake,
  Handoff,
  List,
  Role,
  ServerMsg,
  Space,
  Subtask,
  Task,
  ToggleSubtaskInput,
  User,
} from "@flow/shared";
import { EMAIL_REPLY_REFERENCE_LIMIT, SYNTHETIC_ID_PREFIX, type EmailReplyTarget } from "./email-intake.js";
import { QueryRateLimiter } from "./query.js";
import {
  type AttachmentRow,
  type CommentRow,
  type EmailIntakeRow,
  type ListRow,
  type RuleRow,
  type SpaceRow,
  type SubtaskRow,
  type TaskRowSql,
  type UserRow,
  tagsText,
  toAttachment,
  toComment,
  toEmailIntake,
  toRule,
  toSpace,
  toSubtask,
  toUser,
} from "./rows.js";
import { SandboxWriteBudget } from "./sandbox-seed.js";
import { PLACEHOLDER_EMAIL_DOMAIN } from "./schema.js";
import { type Turn } from "./turn.js";
import {
  canSeeSpace,
  isSpaceMember,
  isPrivilegedRole,
  isSystemActor,
  privateSpaceError,
  roleOf,
} from "./visibility.js";
import type { Workspace } from "./index.js";

export interface Env {
  WORKSPACE: DurableObjectNamespace<Workspace>;
  ATTACHMENTS: R2Bucket;
  SIDE_EFFECTS: Queue;
  ASSETS: Fetcher;
  APP_HOSTNAME?: string;
  EMAIL_DRY_RUN?: string;
  EMAIL_INTAKE_REPLY?: string;
  SANDBOX?: string;
}

export interface BackupStatus {
  lastSuccessAt: number | null;
  lastSuccess: { key: string; rows: number; bytes: number } | null;
  lastFailureAt: number | null;
  lastFailureError: string | null;
  stale: boolean;
}

export interface UpsertUserInput {
  id?: string;
  email: string;
  name?: string;
  role?: Role;
  deactivated?: boolean;
  clickupId?: string | null;
}

export interface CreateApiKeyInput {
  userId: string;
  name: string;
  tokenHash: string;
}

export interface CreateAttachmentInput {
  id?: string;
  taskId: string;
  filename: string;
  r2Key: string;
  size: number;
  mimeType: string;
}

export interface SetAttachmentDriveStorageInput {
  attachmentId: string;
  driveFileId: string;
  driveWebViewLink: string;
  driveDestination: "shared" | "private";
}

export type ParsedListInput = ReturnType<typeof CreateListInput.parse>;
export type ParsedSpaceInput = ReturnType<typeof CreateSpaceInput.parse>;
export type ParsedSubtaskInput = ReturnType<typeof CreateSubtaskInput.parse>;
export type ParsedToggleInput = ReturnType<typeof ToggleSubtaskInput.parse>;
export type ParsedCommentInput = ReturnType<typeof CreateCommentInput.parse>;

export const DAY_MS = 86_400_000;
export const SNAPSHOT_CLOSED_WINDOW_MS = 60 * DAY_MS;
export const CHANGES_RETENTION = 50_000;
export const AUTOMATION_RUNS_RETENTION = 20_000;
export const BACKUP_RETENTION = 30;
export const AUDIT_RETENTION_DAYS = 365;
export const AUDIT_PRUNE_BATCH = 5_000;
export const AUDIT_PRUNE_MAX_BATCHES = 20;
export const BACKUP_STALE_MS = 36 * 3_600_000;
export const WS_USER_HEADER = "X-Flow-User-Id";
export const EMAIL_RATE_WINDOW_MS = 3_600_000;
export const EMAIL_THREAD_REFERENCE_LIMIT = 20;

export const HANDOFF_COLUMNS = `handoff_requested_by, handoff_state, handoff_return, handoff_context,
  handoff_state_changed_at`;
export const TASK_COLUMNS = `id, list_id, title, description, status_id, assignee_id, assigned_by, assigned_at,
  waiting_on, priority, due_date, start_date, snoozed_until, blocked_note, tags, position,
  created_by, created_at, updated_at, closed_at, clickup_id,
  ${HANDOFF_COLUMNS}`;
export const SNAPSHOT_TASK_COLUMNS = `id, list_id, title, status_id, assignee_id, assigned_by, assigned_at, waiting_on, priority,
  due_date, tags, position, created_at, updated_at, snoozed_until, blocked_note,
  ${HANDOFF_COLUMNS}, (description != '') AS has_description`;
export const SPACE_COLUMNS = `id, name, color, position, archived, visibility, created_at, clickup_id`;
export const LIST_COLUMNS = `id, space_id, name, position, archived, inbound_token, created_at, clickup_id`;
export const EMAIL_INTAKE_COLUMNS = `list_id, alias, allowed_senders, created_at, updated_at`;
export const API_KEY_COLUMNS = `id, user_id, name, token_hash, created_at, last_used_at, revoked_at, can_email_requesters`;
export const COMMENT_COLUMNS = `id, task_id, author_id, body, created_at, via, email_to, email_status`;
export const USER_COLUMNS = `id, email, name, role, deactivated, created_at, needs_email_update, clickup_id`;
export const SUBTASK_COLUMNS = `id, task_id, title, done, assignee_id, assigned_by, assigned_at,
  due_date, note, position, created_at`;
export const ATTACHMENT_COLUMNS = `id, task_id, filename, r2_key, storage_provider, drive_file_id,
  drive_web_view_link, drive_destination, migration_state, size, mime_type, uploaded_by, created_at`;

export const TASK_DIFF_KEYS = [
  "listId",
  "title",
  "description",
  "statusId",
  "assigneeId",
  "assignedBy",
  "assignedAt",
  "waitingOn",
  "priority",
  "dueDate",
  "startDate",
  "snoozedUntil",
  "blockedNote",
  "tags",
  "position",
  "closedAt",
  "handoff",
] as const;

export interface WorkspaceHost {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  readonly sql: SqlStorage;
  readonly queryLimiter: QueryRateLimiter;
  readonly sandboxWrites: SandboxWriteBudget;
  armedAlarm: number | null;
  maxSeq(): number;
  runTurn<T>(actor: Actor, fn: (t: Turn) => T, silent?: boolean): T;
  runTaskTurn(actor: Actor, fn: (t: Turn) => Task): Task;
  armAlarm(): Promise<void>;
  getSnapshot(forUserId?: string): BoardSnapshot;
}

export function sqlPatch() {
  const sets: string[] = [];
  const params: SqlStorageValue[] = [];
  const set = (col: string, val: SqlStorageValue): void => {
    sets.push(`${col} = ?`);
    params.push(val);
  };
  const setIf = <T extends SqlStorageValue>(next: T | undefined, current: T, col: string): void => {
    if (next !== undefined && next !== current) set(col, next);
  };
  const setNullable = <T extends SqlStorageValue>(
    next: T | null | undefined,
    current: T | null,
    col: string
  ): void => {
    if (next !== undefined && (next ?? null) !== current) set(col, next ?? null);
  };
  return { sets, params, set, setIf, setNullable };
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function prevOf(
  before: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) out[key] = before[key];
  return out;
}

export function hasRealEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  return e.length > 0 && !e.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
}

export function handoffValues(
  handoff: Handoff | null
): [string | null, string | null, string | null, string | null, number | null] {
  if (handoff === null) return [null, null, null, null, null];
  return [
    handoff.requestedBy,
    handoff.state,
    handoff.returnFormat,
    JSON.stringify(handoff.contextTaskIds),
    handoff.stateChangedAt,
  ];
}

export function contractInput<T>(
  result:
    | { success: true; data: T }
    | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } },
  what: string
): T {
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue === undefined || issue.path.length === 0 ? "" : `${issue.path.map(String).join(".")}: `;
  throw new Error(`Invalid ${what}: ${field}${issue?.message ?? "rejected by the schema"}`);
}

export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag === "") continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export function systemUserId(sql: SqlStorage): string {
  const row = sql
    .exec<{ id: string }>("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1")
    .toArray()[0];
  return row?.id ?? "us_system";
}

export function humanAssigner(t: Turn, assigneeId: string | null): string | null {
  if (assigneeId === null || t.automationRuleId !== null) return null;
  if (t.actor.via === "automation" || t.actor.via === "import" || t.actor.via === "webhook") {
    return null;
  }
  return t.actor.userId;
}

export function spaceIdForList(sql: SqlStorage, listId: string): string | null {
  return (
    sql
      .exec<{ space_id: string }>("SELECT space_id FROM lists WHERE id = ?", listId)
      .toArray()[0]?.space_id ?? null
  );
}

export function spaceIdForTask(sql: SqlStorage, taskId: string): string | null {
  return (
    sql
      .exec<{ space_id: string }>(
        `SELECT l.space_id AS space_id FROM tasks t JOIN lists l ON l.id = t.list_id
         WHERE t.id = ?`,
        taskId
      )
      .toArray()[0]?.space_id ?? null
  );
}

export function spaceIdForChild(
  sql: SqlStorage,
  table: "subtasks" | "comments" | "attachments",
  childId: string
): string | null {
  return (
    sql
      .exec<{ space_id: string }>(
        `SELECT l.space_id AS space_id FROM ${table} c
           JOIN tasks t ON t.id = c.task_id JOIN lists l ON l.id = t.list_id
         WHERE c.id = ?`,
        childId
      )
      .toArray()[0]?.space_id ?? null
  );
}

export function spaceIdForDelta(
  sql: SqlStorage,
  entity: Delta["entity"],
  entityId: string,
  taskId: string | undefined
): string | null {
  switch (entity) {
    case "space":
      return entityId;
    case "list":
      return spaceIdForList(sql, entityId);
    case "task":
      return spaceIdForTask(sql, entityId);
    case "subtask":
    case "comment":
    case "attachment":
      if (taskId !== undefined) return spaceIdForTask(sql, taskId);
      return spaceIdForChild(
        sql,
        entity === "subtask" ? "subtasks" : entity === "comment" ? "comments" : "attachments",
        entityId
      );
    default:
      return null;
  }
}

export function spaceWriteRefusal(sql: SqlStorage, actor: Actor, spaceId: string | null): string | null {
  if (spaceId === null || isSystemActor(actor)) return null;
  const row = sql
    .exec<SpaceRow>(`SELECT ${SPACE_COLUMNS} FROM spaces WHERE id = ?`, spaceId)
    .toArray()[0];
  if (!row) return null;
  const space = toSpace(row);
  if (space.visibility !== "private") return null;
  const allowed = canSeeSpace(roleOf(sql, actor.userId), {
    visibility: space.visibility,
    isMember: isSpaceMember(sql, spaceId, actor.userId),
  });
  return allowed ? null : privateSpaceError(spaceId);
}

export function assertSpaceWritable(sql: SqlStorage, actor: Actor, spaceId: string | null): void {
  const refusal = spaceWriteRefusal(sql, actor, spaceId);
  if (refusal !== null) throw new Error(refusal);
}

export function assertTaskWritable(sql: SqlStorage, actor: Actor, taskId: string): void {
  assertSpaceWritable(sql, actor, spaceIdForTask(sql, taskId));
}

export function assertListWritable(sql: SqlStorage, actor: Actor, listId: string): void {
  assertSpaceWritable(sql, actor, spaceIdForList(sql, listId));
}

export function requirePrivileged(sql: SqlStorage, actor: Actor, action: string): void {
  if (isSystemActor(actor)) return;
  const role = roleOf(sql, actor.userId);
  if (!isPrivilegedRole(role)) {
    throw new Error(
      `${action} requires the owner or admin role; ${actor.userId} is a ${role ?? "non-member"}.`
    );
  }
}

export function addSpaceMember(sql: SqlStorage, spaceId: string, userId: string, now: number): void {
  sql.exec(
    "INSERT OR IGNORE INTO space_members (space_id, user_id, created_at) VALUES (?, ?, ?)",
    spaceId,
    userId,
    now
  );
}

export function userById(sql: SqlStorage, userId: string): User | null {
  const row = sql.exec<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, userId).toArray()[0];
  return row ? toUser(row) : null;
}

export function listUsers(sql: SqlStorage): User[] {
  return sql.exec<UserRow>(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at`).toArray().map(toUser);
}

export function listAutomations(sql: SqlStorage): AutomationRule[] {
  return sql
    .exec<RuleRow>(
      `SELECT id, name, enabled, scope, trigger, conditions, actions, created_at, updated_at
       FROM automation_rules ORDER BY created_at`
    )
    .toArray()
    .map(toRule);
}

export function insertTaskRow(sql: SqlStorage, task: Task): void {
  sql.exec(
    `INSERT INTO tasks (id, list_id, title, description, status_id, assignee_id, assigned_by, assigned_at, waiting_on, priority,
       due_date, start_date, snoozed_until, blocked_note, tags, tags_text, position,
       created_by, created_at, updated_at, closed_at, clickup_id, ${HANDOFF_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    task.id,
    task.listId,
    task.title,
    task.description,
    task.statusId,
    task.assigneeId,
    task.assignedBy,
    task.assignedAt,
    task.waitingOn,
    task.priority,
    task.dueDate,
    task.startDate,
    task.snoozedUntil,
    task.blockedNote,
    JSON.stringify(task.tags),
    tagsText(task.tags),
    task.position,
    task.createdBy,
    task.createdAt,
    task.updatedAt,
    task.closedAt,
    task.clickupId,
    ...handoffValues(task.handoff)
  );
}

export function taskRow(sql: SqlStorage, taskId: string): TaskRowSql | null {
  const rows = sql.exec<TaskRowSql>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`, taskId).toArray();
  return rows[0] ?? null;
}

export function requireTaskRow(sql: SqlStorage, taskId: string): TaskRowSql {
  const row = taskRow(sql, taskId);
  if (!row) throw new Error(`Task ${taskId} not found.`);
  return row;
}

export function requireSubtask(sql: SqlStorage, subtaskId: string): Subtask {
  const row = sql
    .exec<SubtaskRow>(`SELECT ${SUBTASK_COLUMNS} FROM subtasks WHERE id = ?`, subtaskId)
    .toArray()[0];
  if (!row) throw new Error(`Subtask ${subtaskId} not found.`);
  return toSubtask(row);
}

export function requireListRow(sql: SqlStorage, listId: string): ListRow {
  const row = sql.exec<ListRow>(`SELECT ${LIST_COLUMNS} FROM lists WHERE id = ?`, listId).toArray()[0];
  if (!row) {
    throw new Error(
      `List ${listId} not found. Use flow_get_workspace_map (or GET /api/lists) for the lists you can use.`
    );
  }
  return row;
}

export function requireSpace(sql: SqlStorage, spaceId: string): Space {
  const row = sql.exec<SpaceRow>(`SELECT ${SPACE_COLUMNS} FROM spaces WHERE id = ?`, spaceId).toArray()[0];
  if (!row) {
    const known = sql
      .exec<{ id: string; name: string }>("SELECT id, name FROM spaces ORDER BY name LIMIT 25")
      .toArray();
    throw new Error(
      `Space ${spaceId} not found. Known spaces: ${
        known.map((s) => `${s.id} ("${s.name}")`).join(", ") || "none yet"
      }.`
    );
  }
  return toSpace(row);
}

export function emailIntakeForList(sql: SqlStorage, listId: string): EmailIntake | null {
  const row = sql
    .exec<EmailIntakeRow>(`SELECT ${EMAIL_INTAKE_COLUMNS} FROM email_intakes WHERE list_id = ?`, listId)
    .toArray()[0];
  return row ? toEmailIntake(row) : null;
}

export function emailReplyTarget(host: WorkspaceHost, task: Task): EmailReplyTarget | null {
  if (host.env.EMAIL_INTAKE_REPLY !== "true") return null;
  const rows = host.sql
    .exec<{ message_id: string; alias: string; sender: string; comment_id: string | null }>(
      `SELECT message_id, alias, sender, comment_id FROM email_messages
        WHERE task_id = ? ORDER BY received_at, rowid`,
      task.id
    )
    .toArray();
  const opener = rows.find((r) => r.comment_id === null);
  if (!opener) return null;
  const live =
    host.sql.exec("SELECT 1 AS ok FROM email_intakes WHERE alias = ?", opener.alias).toArray().length > 0;
  if (!live) return null;
  const real = rows.map((r) => r.message_id).filter((m) => !m.startsWith(SYNTHETIC_ID_PREFIX));
  const references =
    real.length > EMAIL_REPLY_REFERENCE_LIMIT
      ? [real[0]!, ...real.slice(real.length - (EMAIL_REPLY_REFERENCE_LIMIT - 1))]
      : real;
  return {
    to: opener.sender,
    alias: opener.alias,
    inReplyTo: real[real.length - 1] ?? null,
    references,
  };
}

export function recordDeliveryFailure(
  sql: SqlStorage,
  input: { ruleId: string; taskId: string; kind: "webhook" | "email"; detail: string }
): { ok: true } {
  try {
    sql.exec(
      `INSERT INTO automation_runs (rule_id, task_id, trigger, results, depth, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.ruleId,
      input.taskId,
      "delivery_failure",
      JSON.stringify([
        {
          action: input.kind === "webhook" ? "call_webhook" : "send_email",
          ok: false,
          dryRun: false,
          detail: input.detail,
        },
      ]),
      0,
      Date.now()
    );
  } catch (err) {
    console.error("automation: cannot record delivery failure", err);
  }
  return { ok: true };
}

export function markEmailReply(
  host: WorkspaceHost,
  commentId: string,
  status: "sent" | "failed"
): { ok: boolean } {
  const actor: Actor = {
    userId: systemUserId(host.sql),
    via: "webhook",
    apiKeyId: null,
    automationRuleId: null,
  };
  return host.runTurn(actor, (t) => {
    const row = host.sql
      .exec<CommentRow>(`SELECT ${COMMENT_COLUMNS} FROM comments WHERE id = ?`, commentId)
      .toArray()[0];
    if (!row || row.email_status !== "sending") return { ok: false };
    host.sql.exec("UPDATE comments SET email_status = ? WHERE id = ?", status, commentId);
    const comment = toComment({ ...row, email_status: status });
    t.emit("update", "comment", comment.id, comment as unknown as Record<string, unknown>, {
      taskId: comment.taskId,
    });
    t.audit("comment.email_status", comment.id, { taskId: comment.taskId, status });
    return { ok: true };
  });
}

export function listAttachments(sql: SqlStorage, taskId: string): Attachment[] {
  return sql
    .exec<AttachmentRow>(
      `SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE task_id = ? ORDER BY created_at`,
      taskId
    )
    .toArray()
    .map(toAttachment);
}

export function getAttachment(sql: SqlStorage, attachmentId: string): Attachment | null {
  const row = sql
    .exec<AttachmentRow>(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE id = ?`, attachmentId)
    .toArray()[0];
  return row ? toAttachment(row) : null;
}

export function listSubtasks(sql: SqlStorage, taskId: string): Subtask[] {
  return sql
    .exec<SubtaskRow>(`SELECT ${SUBTASK_COLUMNS} FROM subtasks WHERE task_id = ? ORDER BY position`, taskId)
    .toArray()
    .map(toSubtask);
}

export function listComments(sql: SqlStorage, taskId: string): Comment[] {
  return sql
    .exec<CommentRow>(`SELECT ${COMMENT_COLUMNS} FROM comments WHERE task_id = ? ORDER BY created_at`, taskId)
    .toArray()
    .map(toComment);
}
