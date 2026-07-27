import { z } from "zod";
import {
  Attachment, blockedNote, Comment, Id, LIMITS, List, Priority, Space, SpaceVisibility, Status,
  Subtask, Task, Ts, taskDescription, taskTags, taskTitle,
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
});
export type CreateSubtaskInput = z.infer<typeof CreateSubtaskInput>;
export const ToggleSubtaskInput = z.object({ subtaskId: Id, done: z.boolean() });
export const UpdateSubtaskInput = z.object({
  subtaskId: Id,
  done: z.boolean().optional(),
  title: taskTitle().optional(),
  assigneeId: Id.nullable().optional(),
  dueDate: Ts.nullable().optional(),
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
});
export type CreateCommentInput = z.infer<typeof CreateCommentInput>;

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
export const CreateSpaceInput = z.object({ name: z.string().min(1), color: z.string().optional() });
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
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.string().optional(),
  tags: z.array(z.string()).optional(),
  externalId: z.string().optional(), // idempotency key from the source system
  externalUrl: z.string().url().optional(),
});
export type InboundTaskInput = z.infer<typeof InboundTaskInput>;

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
