import { z } from "zod";
import {
  Attachment, blockedNote, Comment, HandoffState, Id, LIMITS, List, Priority, Space,
  SpaceVisibility, Status, Subtask, subtaskNote, Task, Ts, taskDescription, taskTags, taskTitle,
} from "./entities.js";
import { AutomationRule } from "./automations.js";

// ---------------------------------------------------------------------------
// Mutation inputs. One vocabulary shared by REST routes, MCP tools, and the
// DO's RPC methods — REST and MCP are thin wrappers over the same mutations,
// so automations fire identically regardless of caller.
// All mutations are executed inside the workspace DO.
// ---------------------------------------------------------------------------

export const CreateTaskInput = z.object({
  listId: Id,
  title: taskTitle(),
  description: taskDescription().default(""),
  // Status NAME (case-insensitive) or omitted for the list's open status.
  status: z.string().optional(),
  assigneeId: Id.nullable().optional(),
  priority: Priority.nullable().optional(),
  dueDate: Ts.nullable().optional(),
  startDate: Ts.nullable().optional(),
  tags: taskTags().optional(),
  subtasks: z
    .array(
      z.object({
        title: z
          .string()
          .min(1)
          .max(
            LIMITS.subtaskTitleMax,
            `Subtask title must be ${LIMITS.subtaskTitleMax} characters or fewer.`
          ),
        assigneeId: Id.nullable().optional(),
      })
    )
    .optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

export const UpdateTaskInput = z.object({
  taskId: Id,
  title: taskTitle().optional(),
  description: taskDescription().optional(),
  status: z.string().optional(), // status name
  assigneeId: Id.nullable().optional(),
  priority: Priority.nullable().optional(),
  dueDate: Ts.nullable().optional(),
  startDate: Ts.nullable().optional(),
  tags: taskTags().optional(),
  // Snooze the task until this instant; null wakes it now. Waking, by clock or
  // by hand, never touches the status.
  snoozedUntil: Ts.nullable().optional(),
  blockedNote: blockedNote().nullable().optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInput>;

export const MoveTaskInput = z.object({
  taskId: Id,
  listId: Id.optional(), // omit to stay in place
  status: z.string().optional(),
  // Fractional position between neighbors; server assigns when omitted.
  position: z.number().optional(),
});
export type MoveTaskInput = z.infer<typeof MoveTaskInput>;

export const SearchTasksInput = z.object({
  query: z.string().optional(), // FTS over title + description
  listId: Id.optional(),
  spaceId: Id.optional(),
  status: z.array(z.string()).optional(),
  assigneeId: Id.optional(),
  tags: z.array(z.string()).optional(),
  includeClosed: z.boolean().default(false),
  dueBefore: Ts.optional(),
  dueAfter: Ts.optional(),
  updatedAfter: Ts.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type SearchTasksInput = z.infer<typeof SearchTasksInput>;

// Concise rows for search results / board hydration side-channel uses.
export const TaskRow = Task.pick({
  id: true, listId: true, title: true, statusId: true, assigneeId: true,
  priority: true, dueDate: true, tags: true, position: true, updatedAt: true,
});
export type TaskRow = z.infer<typeof TaskRow>;

export const SearchTasksResult = z.object({
  tasks: z.array(TaskRow),
  cursor: z.string().nullable(),
  total: z.number().int(),
});
export type SearchTasksResult = z.infer<typeof SearchTasksResult>;

export const BulkUpdateInput = z.object({
  updates: z.array(UpdateTaskInput).min(1).max(200),
});
export type BulkUpdateInput = z.infer<typeof BulkUpdateInput>;

// Per-item outcomes so a partial failure never forces a blind full retry.
export const BulkResult = z.object({
  results: z.array(
    z.object({
      taskId: Id.nullable(),
      ok: z.boolean(),
      error: z.string().nullable(),
    })
  ),
});
export type BulkResult = z.infer<typeof BulkResult>;

export const CreateSubtaskInput = z.object({
  taskId: Id,
  title: z
    .string()
    .min(1)
    .max(
      LIMITS.subtaskTitleMax,
      `Subtask title must be ${LIMITS.subtaskTitleMax} characters or fewer.`
    ),
  assigneeId: Id.nullable().optional(),
  dueDate: Ts.nullable().optional(),
  note: subtaskNote().nullable().optional(),
});
export type CreateSubtaskInput = z.infer<typeof CreateSubtaskInput>;
export const ToggleSubtaskInput = z.object({ subtaskId: Id, done: z.boolean() });
export const UpdateSubtaskInput = z.object({
  subtaskId: Id,
  done: z.boolean().optional(),
  title: taskTitle().optional(),
  assigneeId: Id.nullable().optional(),
  dueDate: Ts.nullable().optional(),
  note: subtaskNote().nullable().optional(),
});
export type UpdateSubtaskInput = z.infer<typeof UpdateSubtaskInput>;
export type ToggleSubtaskInput = z.infer<typeof ToggleSubtaskInput>;
export const CreateCommentInput = z.object({
  taskId: Id,
  body: z
    .string()
    .min(1)
    .max(
      LIMITS.commentBodyMax,
      `Comment body must be ${LIMITS.commentBodyMax} characters or fewer.`
    ),
  /**
   * Also email this comment to the person whose email opened the ticket, in
   * their thread (TaskDetail.emailReplyTo says who that is). Sent by a person
   * in the web app, or with an api key an owner or admin allowed to
   * (ApiKey.canEmailRequesters). Never through MCP.
   */
  emailToRequester: z.boolean().optional(),
});
export type CreateCommentInput = z.infer<typeof CreateCommentInput>;

// ---------------------------------------------------------------------------
// Agent handoffs (see Handoff in entities.ts). REST: POST /api/handoffs,
// GET /api/handoffs, POST /api/tasks/:taskId/handoff. MCP: flow_request_handoff,
// flow_list_handoffs, flow_reply_handoff.
// ---------------------------------------------------------------------------

/** File a request for a teammate's agent: it becomes a task assigned to them. */
export const RequestHandoffInput = z.object({
  listId: Id,
  /** The teammate whose agent should handle it; becomes the task's assignee. */
  toUserId: Id,
  title: taskTitle(),
  /** The ask, in markdown. Becomes the task's description. */
  ask: taskDescription().min(1, "Describe what you need."),
  /** What to send back, e.g. "a table of page, sessions and change date". */
  returnFormat: z
    .string()
    .max(LIMITS.handoffReturnMax, `Return format must be ${LIMITS.handoffReturnMax} characters or fewer.`)
    .optional(),
  /** Tasks the recipient's agent should read for context. */
  contextTaskIds: z.array(Id).max(LIMITS.handoffContextMax).optional(),
  /** When the answer is needed, epoch ms. Becomes the task's due date. */
  dueDate: Ts.nullable().optional(),
});
export type RequestHandoffInput = z.infer<typeof RequestHandoffInput>;

/**
 * Answer, ask back, or move a handoff along. A message is posted as a comment;
 * `state` moves the handoff (done and declined also close the task). The
 * recipient may set any state; the requester's message on a needs_input
 * handoff hands it back as "working"; owners/admins may set any state.
 */
export const ReplyHandoffInput = z
  .object({
    taskId: Id,
    message: z
      .string()
      .min(1)
      .max(LIMITS.commentBodyMax, `Message must be ${LIMITS.commentBodyMax} characters or fewer.`)
      .optional(),
    state: HandoffState.optional(),
  })
  .refine((input) => input.message !== undefined || input.state !== undefined, {
    message: "Send a message, a new state, or both.",
  });
export type ReplyHandoffInput = z.infer<typeof ReplyHandoffInput>;

/** Handoffs addressed to me (incoming) or filed by me (outgoing). */
export const ListHandoffsInput = z.object({
  direction: z.enum(["incoming", "outgoing"]).default("incoming"),
  /** Defaults to the open states: requested, working, needs_input. */
  states: z.array(HandoffState).min(1).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type ListHandoffsInput = z.infer<typeof ListHandoffsInput>;

export const CreateListInput = z.object({
  spaceId: Id,
  name: z.string().min(1),
  // Named status-set template or explicit statuses; default is
  // open("To Do") -> custom("In Progress") -> closed("Done").
  statuses: z
    .array(Status.pick({ name: true, color: true, type: true }))
    .min(2)
    .optional(),
});
export type CreateListInput = z.infer<typeof CreateListInput>;
export const CreateSpaceInput = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
  // Spaces are born private unless the caller opts into workspace-wide
  // visibility — private is the norm across the workspace.
  visibility: SpaceVisibility.default("private"),
});
export type CreateSpaceInput = z.infer<typeof CreateSpaceInput>;

/**
 * Flip a space between workspace-wide and private. Owner/admin only, enforced
 * both on the route and inside the DO.
 */
export const UpdateSpaceVisibilityInput = z.object({
  spaceId: Id,
  visibility: SpaceVisibility,
});
export type UpdateSpaceVisibilityInput = z.infer<typeof UpdateSpaceVisibilityInput>;

/**
 * Replace a private space's member list wholesale — `userIds` is the complete
 * set afterwards, not a delta. Only meaningful for `visibility: "private"`
 * spaces; membership on a workspace-visible space is stored but changes nothing.
 */
export const UpdateSpaceMembersInput = z.object({
  spaceId: Id,
  userIds: z.array(Id),
});
export type UpdateSpaceMembersInput = z.infer<typeof UpdateSpaceMembersInput>;

export const UpsertAutomationInput = AutomationRule.omit({
  id: true, createdAt: true, updatedAt: true,
}).extend({ id: Id.optional() });
export type UpsertAutomationInput = z.infer<typeof UpsertAutomationInput>;

// ---------------------------------------------------------------------------
// Inbound webhook (Gleap etc.): POST /api/inbound/:listId with the list's
// inboundToken as Bearer. Body is mapped to CreateTaskInput; unrecognized
// fields land in the description.
// ---------------------------------------------------------------------------
export const InboundTaskInput = z.object({
  title: taskTitle(),
  description: taskDescription().optional(),
  status: z.string().optional(),
  tags: taskTags().optional(),
  externalId: z.string().optional(), // idempotency key from the source system
  externalUrl: z.string().url().optional(),
});
export type InboundTaskInput = z.infer<typeof InboundTaskInput>;

// ---------------------------------------------------------------------------
// Email intake: a per-list ticket inbox. Mail to <alias>@<EMAIL_INTAKE_DOMAIN>
// from an allowed sender opens a task in that list; a reply to one of those
// messages lands as a comment on the same task. Owner/admin configure it.
// ---------------------------------------------------------------------------

/** The address's local part: 1–40 lowercase letters, digits, dots or hyphens. */
export const EmailIntakeAlias = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9](?:[a-z0-9.-]{0,38}[a-z0-9])?$/,
    "Alias must be 1–40 lowercase letters, digits, dots or hyphens, starting and ending with a letter or digit."
  );

/** "@example.com" admits a whole domain (not its subdomains); "name@example.com" one address. */
export const EmailIntakeSender = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?:[^\s@]+)?@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/,
    "Each allowed sender must be an address (name@example.com) or a whole domain (@example.com)."
  );

export const SetEmailIntakeInput = z.object({
  alias: EmailIntakeAlias,
  // At least one: an intake that accepts mail from anyone is a spam inlet.
  allowedSenders: z
    .array(EmailIntakeSender)
    .min(1, "Add at least one allowed sender or domain.")
    .max(50),
});
export type SetEmailIntakeInput = z.infer<typeof SetEmailIntakeInput>;

export const EmailIntake = z.object({
  listId: Id,
  alias: z.string(),
  allowedSenders: z.array(z.string()),
  createdAt: Ts,
  updatedAt: Ts,
});
export type EmailIntake = z.infer<typeof EmailIntake>;

// --- MCP tool names (single source of truth) -------------------------------
export const MCP_TOOLS = [
  "flow_get_workspace_map",
  "flow_search_tasks",
  "flow_get_task",
  "flow_list_my_work",
  "flow_create_task",
  "flow_update_task",
  "flow_move_task",
  "flow_bulk_create_tasks",
  "flow_bulk_update_tasks",
  "flow_create_subtasks",
  "flow_toggle_subtask",
  "flow_comment_on_task",
  "flow_list_automations",
  "flow_upsert_automation",
  "flow_get_audit_log",
  "flow_request_handoff",
  "flow_list_handoffs",
  "flow_reply_handoff",
] as const;
export type McpToolName = (typeof MCP_TOOLS)[number];

// --- DO RPC surface --------------------------------------------------------
// The workspace Durable Object implements exactly these methods; REST/MCP
// handlers call them and never touch SQL directly.
//
// The three reads take an OPTIONAL `forUserId`. Passing it filters the result to
// the spaces that user may see (see `SpaceVisibility`); omitting it returns the
// unfiltered workspace and is for internal callers only — every request-serving
// path must pass the authenticated user's id.
export interface WorkspaceRpc {
  getSnapshot(forUserId?: string): unknown; // BoardSnapshot
  getTaskDetail(taskId: string, forUserId?: string): unknown; // TaskDetail
  searchTasks(input: SearchTasksInput, actorUserId: string): unknown;
  createTask(input: CreateTaskInput, actorUserId: string): unknown; // Task
  updateTask(input: UpdateTaskInput, actorUserId: string): unknown; // Task
  moveTask(input: MoveTaskInput, actorUserId: string): unknown; // Task
  bulkUpdate(input: BulkUpdateInput, actorUserId: string): unknown; // BulkResult
  deleteTask(taskId: string, actorUserId: string): unknown;
}
