import { z } from "zod";

// IDs are short prefixed nanoids: sp_xxx, ls_xxx, tk_xxx, st_xxx, sb_xxx,
// cm_xxx, at_xxx, us_xxx, ar_xxx, ak_xxx. Human-readable in URLs and logs.
export const Id = z.string().min(4);

// Epoch milliseconds everywhere. No Date objects across boundaries.
export const Ts = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Input size caps. One place, so REST, MCP and the DO all reject the same
// oversized input with the same message. `importBatch` is deliberately exempt
// (see packages/core/src/import.ts): historical ClickUp rows are truncated
// rather than rejected, because a migration must not lose a task.
// ---------------------------------------------------------------------------
export const LIMITS = {
  titleMax: 500,
  descriptionMax: 100_000,
  commentBodyMax: 20_000,
  subtaskTitleMax: 500,
  tagMax: 100,
  tagsMax: 50,
  /** "waiting on…" note that rides along with a snooze. One line, not an essay. */
  blockedNoteMax: 200,
  /** importBatch only: titles longer than this are truncated, never rejected. */
  importTitleMax: 2_000,
} as const;

/** Task/subtask title: non-empty, capped. Fresh instance per call so callers
 *  can chain `.optional()` without sharing schema state. */
export const taskTitle = (): z.ZodString =>
  z.string().min(1).max(LIMITS.titleMax, `Title must be ${LIMITS.titleMax} characters or fewer.`);

export const taskDescription = (): z.ZodString =>
  z
    .string()
    .max(LIMITS.descriptionMax, `Description must be ${LIMITS.descriptionMax} characters or fewer.`);

export const taskTags = (): z.ZodArray<z.ZodString> =>
  z
    .array(z.string().max(LIMITS.tagMax, `Each tag must be ${LIMITS.tagMax} characters or fewer.`))
    .max(LIMITS.tagsMax, `A task can carry at most ${LIMITS.tagsMax} tags.`);

/** The free-text half of a snooze: who or what the task is waiting on. */
export const blockedNote = (): z.ZodString =>
  z
    .string()
    .max(LIMITS.blockedNoteMax, `Note must be ${LIMITS.blockedNoteMax} characters or fewer.`);

export const Role = z.enum(["owner", "admin", "member"]);
export type Role = z.infer<typeof Role>;

export const User = z.object({
  id: Id,
  email: z.email(),
  name: z.string(),
  role: Role,
  // Deactivated users stay referenceable as assignees/authors (ClickUp
  // import has assignees who are no longer members).
  deactivated: z.boolean().default(false),
  createdAt: Ts,
});
export type User = z.infer<typeof User>;

/**
 * Who can see a space at all.
 *
 * "workspace" (the default, and what every pre-existing space is) means every
 * member sees it. "private" means only owners, admins and the space's own
 * members do — everyone else gets no spaces/lists/tasks from it in a snapshot,
 * no deltas from it over the socket, and a descriptive error on write.
 */
export const SpaceVisibility = z.enum(["workspace", "private"]);
export type SpaceVisibility = z.infer<typeof SpaceVisibility>;

export const Space = z.object({
  id: Id,
  name: z.string().min(1),
  color: z.string().nullable().default(null),
  position: z.number(),
  archived: z.boolean().default(false),
  visibility: SpaceVisibility.default("workspace"),
  createdAt: Ts,
});
export type Space = z.infer<typeof Space>;

// Status type drives board semantics: exactly one "open" first and one
// "closed" last per list; "custom" in between, ordered by position.
export const StatusType = z.enum(["open", "custom", "closed"]);
export type StatusType = z.infer<typeof StatusType>;

export const Status = z.object({
  id: Id,
  name: z.string().min(1),
  color: z.string(),
  type: StatusType,
  position: z.number(),
});
export type Status = z.infer<typeof Status>;

export const List = z.object({
  id: Id,
  spaceId: Id,
  name: z.string().min(1),
  position: z.number(),
  archived: z.boolean().default(false),
  statuses: z.array(Status).min(2),
  // Bearer token for the inbound webhook endpoint (Gleap etc.). Null when
  // inbound intake is disabled for the list.
  inboundToken: z.string().nullable().default(null),
  createdAt: Ts,
});
export type List = z.infer<typeof List>;

export const Priority = z.enum(["urgent", "high", "normal", "low"]);
export type Priority = z.infer<typeof Priority>;

export const Task = z.object({
  id: Id,
  listId: Id,
  title: taskTitle(),
  // Markdown. Rendered nicely in the UI; plain string over the wire.
  description: taskDescription().default(""),
  statusId: Id,
  // Single assignee by design (2 of 4,709 imported tasks had more than one).
  assigneeId: Id.nullable().default(null),
  priority: Priority.nullable().default(null),
  dueDate: Ts.nullable().default(null),
  startDate: Ts.nullable().default(null),
  tags: taskTags().default([]),
  // --- snooze / waiting-on ---------------------------------------------------
  // A snoozed task is still open and still in its status column; it is just
  // hidden from the board and parked at the bottom of My Work until the clock
  // runs out (the hourly sweep) or somebody comments on it. Waking NEVER
  // changes the status — snooze is an attention filter, not a workflow state.
  snoozedUntil: Ts.nullable().default(null),
  /** Optional "waiting on Dr. Patel for the x-rays" note shown with the snooze. */
  blockedNote: blockedNote().nullable().default(null),
  // Fractional ordering key within a status column.
  position: z.number(),
  createdBy: Id,
  createdAt: Ts,
  updatedAt: Ts,
  closedAt: Ts.nullable().default(null),
  // Provenance for imported tasks; keeps the import idempotent and old
  // ClickUp links resolvable.
  clickupId: z.string().nullable().default(null),
});
export type Task = z.infer<typeof Task>;

// Asana-style: subtasks are lightweight steps inside a card. Done/not-done
// only — they do NOT carry the list's status pipeline.
export const Subtask = z.object({
  id: Id,
  taskId: Id,
  title: z
    .string()
    .min(1)
    .max(LIMITS.subtaskTitleMax, `Subtask title must be ${LIMITS.subtaskTitleMax} characters or fewer.`),
  done: z.boolean().default(false),
  assigneeId: Id.nullable().default(null),
  dueDate: Ts.nullable().default(null),
  position: z.number(),
  createdAt: Ts,
});
export type Subtask = z.infer<typeof Subtask>;

export const Comment = z.object({
  id: Id,
  taskId: Id,
  authorId: Id,
  body: z
    .string()
    .min(1)
    .max(LIMITS.commentBodyMax, `Comment body must be ${LIMITS.commentBodyMax} characters or fewer.`), // markdown
  createdAt: Ts,
});
export type Comment = z.infer<typeof Comment>;

export const Attachment = z.object({
  id: Id,
  taskId: Id,
  filename: z.string(),
  r2Key: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string(),
  uploadedBy: Id.nullable(),
  createdAt: Ts,
});
export type Attachment = z.infer<typeof Attachment>;

// API keys impersonate a user: actions show as that user,
// with the key id recorded in the audit trail.
export const ApiKey = z.object({
  id: Id,
  userId: Id,
  name: z.string().min(1), // e.g. "claude-mcp", "gleap-inbound"
  tokenHash: z.string(), // sha256 hex of the bearer token; token shown once
  createdAt: Ts,
  lastUsedAt: Ts.nullable().default(null),
  revokedAt: Ts.nullable().default(null),
});
export type ApiKey = z.infer<typeof ApiKey>;

export const Actor = z.object({
  userId: Id,
  // How the mutation arrived; "automation" carries the rule id in apiKeyId's
  // place semantics-wise, see AuditEntry.
  via: z.enum(["ui", "api", "mcp", "webhook", "automation", "import"]),
  apiKeyId: Id.nullable().default(null),
  automationRuleId: Id.nullable().default(null),
});
export type Actor = z.infer<typeof Actor>;

export const AuditEntry = z.object({
  id: z.number().int(), // monotonic rowid
  actor: Actor,
  action: z.string(), // mutation name, e.g. "task.update"
  entity: z.string(), // e.g. "tk_abc123"
  diff: z.record(z.string(), z.unknown()).nullable(),
  at: Ts,
});
export type AuditEntry = z.infer<typeof AuditEntry>;
