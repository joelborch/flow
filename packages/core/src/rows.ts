import type {
  ApiKey,
  Attachment,
  AuditEntry,
  Actor,
  AutomationRule,
  Comment,
  List,
  SnapshotTask,
  Space,
  SpaceVisibility,
  Status,
  Subtask,
  Task,
  TaskRow,
  User,
} from "@flow/shared";

// ---------------------------------------------------------------------------
// SQLite row shapes and their mappings to the shared entity types. Every row
// field is a SqlStorageValue (string | number | ArrayBuffer | null); booleans
// are 0/1 and JSON columns are text.
// ---------------------------------------------------------------------------

export interface UserRow {
  [key: string]: SqlStorageValue;
  id: string;
  email: string;
  name: string;
  role: string;
  deactivated: number;
  created_at: number;
  needs_email_update: number;
  clickup_id: string | null;
}

export interface SpaceRow {
  [key: string]: SqlStorageValue;
  id: string;
  name: string;
  color: string | null;
  position: number;
  archived: number;
  /** 'workspace' | 'private'; anything else is read as 'workspace'. */
  visibility: string;
  created_at: number;
  clickup_id: string | null;
}

export interface ListRow {
  [key: string]: SqlStorageValue;
  id: string;
  space_id: string;
  name: string;
  position: number;
  archived: number;
  inbound_token: string | null;
  created_at: number;
  clickup_id: string | null;
}

export interface StatusRow {
  [key: string]: SqlStorageValue;
  id: string;
  list_id: string;
  name: string;
  color: string;
  type: string;
  position: number;
}

export interface TaskRowSql {
  [key: string]: SqlStorageValue;
  id: string;
  list_id: string;
  title: string;
  description: string;
  status_id: string;
  assignee_id: string | null;
  priority: string | null;
  due_date: number | null;
  start_date: number | null;
  /** Epoch ms the snooze expires, or NULL when the task is not snoozed. */
  snoozed_until: number | null;
  blocked_note: string | null;
  tags: string;
  position: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  clickup_id: string | null;
}

/**
 * The reduced projection getSnapshot reads. `has_description` is computed in
 * SQL (`description != ''`) so the description text never leaves SQLite for a
 * snapshot — that column is ~90% of the table's bytes and no card renders it.
 */
export interface SnapshotTaskRowSql {
  [key: string]: SqlStorageValue;
  id: string;
  list_id: string;
  title: string;
  status_id: string;
  assignee_id: string | null;
  priority: string | null;
  due_date: number | null;
  tags: string;
  position: number;
  created_at: number;
  updated_at: number;
  snoozed_until: number | null;
  blocked_note: string | null;
  has_description: number;
}

export interface SubtaskRow {
  [key: string]: SqlStorageValue;
  id: string;
  task_id: string;
  title: string;
  done: number;
  assignee_id: string | null;
  due_date: number | null;
  position: number;
  created_at: number;
}

export interface CommentRow {
  [key: string]: SqlStorageValue;
  id: string;
  task_id: string;
  author_id: string;
  body: string;
  created_at: number;
}

export interface AttachmentRow {
  [key: string]: SqlStorageValue;
  id: string;
  task_id: string;
  filename: string;
  r2_key: string;
  size: number;
  mime_type: string;
  uploaded_by: string | null;
  created_at: number;
}

export interface ApiKeyRow {
  [key: string]: SqlStorageValue;
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/**
 * The columnar `automation_rules` layout the automation engine reads
 * (scope/trigger/conditions/actions are JSON TEXT). Keep it in sync with
 * readRuleObjects() in ./automation/engine.ts.
 */
export interface RuleRow {
  [key: string]: SqlStorageValue;
  id: string;
  name: string;
  enabled: number;
  scope: string;
  trigger: string;
  conditions: string;
  actions: string;
  created_at: number;
  updated_at: number;
}

export interface AuditRow {
  [key: string]: SqlStorageValue;
  id: number;
  actor: string;
  action: string;
  entity: string;
  diff: string | null;
  at: number;
}

export interface ChangeRow {
  [key: string]: SqlStorageValue;
  seq: number;
  op: string;
  entity: string;
  entity_id: string;
  data: string | null;
  actor_user_id: string;
  at: number;
}

export interface JobRow {
  [key: string]: SqlStorageValue;
  id: number;
  run_at: number;
  kind: string;
  payload: string | null;
  every_ms: number | null;
}

// --- mappers ---------------------------------------------------------------

const parseJson = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role as User["role"],
  deactivated: r.deactivated !== 0,
  createdAt: r.created_at,
});

/**
 * Storage -> contract for the visibility column. Anything unrecognised (an old
 * row, a hand-edited value) reads as "workspace": the failure mode of a bad
 * value should be "everyone sees it", matching what the workspace looked like
 * before private spaces existed, and never "a space silently disappears".
 */
export const toSpaceVisibility = (raw: unknown): SpaceVisibility =>
  raw === "private" ? "private" : "workspace";

export const toSpace = (r: SpaceRow): Space => ({
  id: r.id,
  name: r.name,
  color: r.color,
  position: r.position,
  archived: r.archived !== 0,
  visibility: toSpaceVisibility(r.visibility),
  createdAt: r.created_at,
});

export const toStatus = (r: StatusRow): Status => ({
  id: r.id,
  name: r.name,
  color: r.color,
  type: r.type as Status["type"],
  position: r.position,
});

/**
 * A list as it leaves the workspace: `inboundToken` is ALWAYS null.
 *
 * The token is a bearer credential for the list's intake webhook, and every
 * authenticated member can read snapshots, deltas and `GET /api/spaces/:id`.
 * Nulling it at the row→entity boundary means no read path can leak it by
 * omission — a new caller has to go out of its way, via `toListWithSecrets`,
 * to see it at all.
 */
export const toList = (r: ListRow, statuses: Status[]): List => ({
  ...toListWithSecrets(r, statuses),
  inboundToken: null,
});

/**
 * The same mapping WITH the inbound token. Only two callers may use it: inbound
 * webhook auth (token -> list) and the admin-only `getListWithSecrets` read.
 * Never hand the result to a delta, a snapshot, or a REST response body.
 */
export const toListWithSecrets = (r: ListRow, statuses: Status[]): List => ({
  id: r.id,
  spaceId: r.space_id,
  name: r.name,
  position: r.position,
  archived: r.archived !== 0,
  statuses,
  inboundToken: r.inbound_token,
  createdAt: r.created_at,
});

export const toTask = (r: TaskRowSql): Task => ({
  id: r.id,
  listId: r.list_id,
  title: r.title,
  description: r.description,
  statusId: r.status_id,
  assigneeId: r.assignee_id,
  priority: r.priority as Task["priority"],
  dueDate: r.due_date,
  startDate: r.start_date,
  // Columns added by core-0004-snooze. A row written before that migration
  // reads `undefined` for them under a stale prepared statement, so both
  // coalesce to null rather than leaking undefined into the contract.
  snoozedUntil: r.snoozed_until ?? null,
  blockedNote: r.blocked_note ?? null,
  tags: parseJson<string[]>(r.tags, []),
  position: r.position,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  closedAt: r.closed_at,
  clickupId: r.clickup_id,
});

export const toSnapshotTask = (r: SnapshotTaskRowSql): SnapshotTask => ({
  id: r.id,
  listId: r.list_id,
  title: r.title,
  statusId: r.status_id,
  assigneeId: r.assignee_id,
  priority: r.priority as SnapshotTask["priority"],
  dueDate: r.due_date,
  tags: parseJson<string[]>(r.tags, []),
  position: r.position,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  snoozedUntil: r.snoozed_until,
  blockedNote: r.blocked_note,
  hasDescription: r.has_description !== 0,
});

export const toTaskRow = (r: TaskRowSql): TaskRow => ({
  id: r.id,
  listId: r.list_id,
  title: r.title,
  statusId: r.status_id,
  assigneeId: r.assignee_id,
  priority: r.priority as TaskRow["priority"],
  dueDate: r.due_date,
  tags: parseJson<string[]>(r.tags, []),
  position: r.position,
  updatedAt: r.updated_at,
});

export const toSubtask = (r: SubtaskRow): Subtask => ({
  id: r.id,
  taskId: r.task_id,
  title: r.title,
  done: r.done !== 0,
  assigneeId: r.assignee_id,
  dueDate: r.due_date,
  position: r.position,
  createdAt: r.created_at,
});

export const toComment = (r: CommentRow): Comment => ({
  id: r.id,
  taskId: r.task_id,
  authorId: r.author_id,
  body: r.body,
  createdAt: r.created_at,
});

export const toAttachment = (r: AttachmentRow): Attachment => ({
  id: r.id,
  taskId: r.task_id,
  filename: r.filename,
  r2Key: r.r2_key,
  size: r.size,
  mimeType: r.mime_type,
  uploadedBy: r.uploaded_by,
  createdAt: r.created_at,
});

export const toApiKey = (r: ApiKeyRow): ApiKey => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  tokenHash: r.token_hash,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

export const toRule = (r: RuleRow): AutomationRule => ({
  id: r.id,
  name: r.name,
  enabled: r.enabled !== 0,
  scope: parseJson<AutomationRule["scope"]>(r.scope, { kind: "space", spaceId: "" }),
  trigger: parseJson<AutomationRule["trigger"]>(r.trigger, { kind: "task_created" }),
  conditions: parseJson<AutomationRule["conditions"]>(r.conditions, []),
  actions: parseJson<AutomationRule["actions"]>(r.actions, []),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const toAuditEntry = (r: AuditRow): AuditEntry => ({
  id: r.id,
  actor: parseJson<Actor>(r.actor, {
    userId: "",
    via: "api",
    apiKeyId: null,
    automationRuleId: null,
  }),
  action: r.action,
  entity: r.entity,
  diff: r.diff === null ? null : parseJson<Record<string, unknown>>(r.diff, {}),
  at: r.at,
});

/** Lowercased `|a|b|` form used by the tag filter (no JSON1 dependency). */
export const tagsText = (tags: readonly string[]): string =>
  tags.length === 0 ? "|" : `|${tags.map((t) => t.trim().toLowerCase()).join("|")}|`;
