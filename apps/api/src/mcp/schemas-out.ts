/**
 * Tool *output* schemas.
 *
 * Every tool declares one of these as its `outputSchema`, so `tools/list`
 * advertises the shape of what comes back and the SDK validates the
 * `structuredContent` we return against it on every call. A view function that
 * drifts from its declared shape is therefore a test failure, not a silently
 * malformed payload an agent has to reverse-engineer.
 *
 * These are the single source of truth for the result shapes: `views.ts` infers
 * its TypeScript types from here rather than declaring them a second time.
 *
 * Two conventions the shapes encode:
 *
 *  - **Concise vs detailed.** `format: "concise"` (the default) trims rows to the
 *    fields an agent needs to decide what to do next; `"detailed"` adds the rest.
 *    Rather than two unions per tool — which converts to an unhelpful `anyOf` in
 *    JSON Schema — the detailed-only keys are simply optional, so one schema
 *    describes both and a client can read the concise keys unconditionally.
 *  - **Cursors.** Anything pageable returns `cursor`, null when exhausted. The
 *    value is opaque: hand it straight back as the next call's `cursor`.
 */
import { z } from "zod";
import { AutomationRule } from "@flow/shared";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** The concise task row: enough to triage, sort and pick the next call. */
export const ConciseTaskView = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  list: z.string(),
  assignee: z.string().nullable(),
  dueDate: z.number().nullable(),
  priority: z.string().nullable(),
});
export type ConciseTaskView = z.infer<typeof ConciseTaskView>;

/** Everything a search row can carry — what `format: "detailed"` returns. */
export const TaskView = ConciseTaskView.extend({
  listId: z.string(),
  space: z.string(),
  assigneeId: z.string().nullable(),
  tags: z.array(z.string()),
  updatedAt: z.number(),
});
export type TaskView = z.infer<typeof TaskView>;

/**
 * What actually goes over the wire for a row: concise keys always present, the
 * detailed-only keys present only when the caller asked for them.
 */
export const TaskRowOut = TaskView.partial({
  listId: true,
  space: true,
  assigneeId: true,
  tags: true,
  updatedAt: true,
});
export type TaskRowOut = z.infer<typeof TaskRowOut>;

/** The full card. `flow_get_task` never trims these — only its comment list. */
export const TaskDetailView = TaskView.extend({
  description: z.string(),
  startDate: z.number().nullable(),
  closedAt: z.number().nullable(),
  snoozedUntil: z.number().nullable(),
  blockedNote: z.string().nullable(),
});
export type TaskDetailView = z.infer<typeof TaskDetailView>;

export const SubtaskView = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  assignee: z.string().nullable(),
  dueDate: z.number().nullable(),
});
export type SubtaskView = z.infer<typeof SubtaskView>;

export const CommentView = z.object({
  id: z.string(),
  author: z.string().nullable(),
  body: z.string(),
  createdAt: z.number(),
});
export type CommentView = z.infer<typeof CommentView>;

export const AttachmentView = z.object({
  id: z.string(),
  filename: z.string(),
  size: z.number(),
  mimeType: z.string(),
});
export type AttachmentView = z.infer<typeof AttachmentView>;

/** `email`/`role` are detailed-only; id and name are what the other tools need. */
export const UserView = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().optional(),
  role: z.string().optional(),
  deactivated: z.boolean().optional(),
});
export type UserView = z.infer<typeof UserView>;

// ---------------------------------------------------------------------------
// flow_get_workspace_map
// ---------------------------------------------------------------------------

export const WorkspaceMapView = z.object({
  seq: z.number(),
  spaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      archived: z.boolean().optional(),
      lists: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          archived: z.boolean().optional(),
          /** Detailed only — a count, not a value any other tool consumes. */
          openTasks: z.number().optional(),
          statuses: z.array(z.object({ name: z.string(), type: z.string() })),
        })
      ),
    })
  ),
  users: z.array(UserView),
  /** Absent unless `includeTags` was set; the tag scan is the expensive part. */
  tags: z.array(z.string()).optional(),
  legend: z.object({
    status: z.string(),
    ids: z.string(),
    timestamps: z.string(),
  }),
});
export type WorkspaceMapView = z.infer<typeof WorkspaceMapView>;

export const GetWorkspaceMapOut = WorkspaceMapView;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const SearchTasksOut = z.object({
  total: z.number(),
  cursor: z.string().nullable(),
  tasks: z.array(TaskRowOut),
});

export const GetTaskOut = z.object({
  task: TaskDetailView,
  subtasks: z.array(SubtaskView),
  comments: z.array(CommentView),
  attachments: z.array(AttachmentView),
  /** How many older comments the concise budget dropped; 0 in detailed. */
  commentsOmitted: z.number(),
  /** Present only when `commentsOmitted > 0`, telling the agent how to get them. */
  note: z.string().optional(),
});

/** The five due buckets, always all present — see `work.ts`. */
const byBucket = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    overdue: value,
    today: value,
    thisWeek: value,
    later: value,
    noDate: value,
  });

export const ListMyWorkOut = z.object({
  assignee: z.object({ id: z.string(), name: z.string().nullable() }),
  total: z.number(),
  returned: z.number(),
  cursor: z.string().nullable(),
  counts: byBucket(z.number()),
  buckets: byBucket(z.array(TaskRowOut)),
  legend: byBucket(z.string()),
});

export const ListAutomationsOut = z.object({
  automations: z.array(AutomationRule),
  total: z.number(),
});

export const AuditEntryView = z.object({
  id: z.number(),
  at: z.number(),
  action: z.string(),
  entity: z.string(),
  user: z.string().nullable(),
  via: z.string(),
  apiKeyId: z.string().nullable(),
  automationRuleId: z.string().nullable(),
  diff: z.record(z.unknown()).nullable(),
});

export const GetAuditLogOut = z.object({
  /** Opaque; hand it back as `cursor`. Numeric here because the log keys on rowid. */
  cursor: z.number().nullable(),
  entries: z.array(AuditEntryView),
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export const CreateTaskOut = z.object({ created: TaskView });
export const UpdateTaskOut = z.object({ updated: TaskView });
export const MoveTaskOut = z.object({ moved: TaskView });

const bulkTaskResult = z.object({
  taskId: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().nullable(),
});

export const BulkCreateTasksOut = z.object({
  created: z.number(),
  failed: z.number(),
  results: z.array(bulkTaskResult),
});

export const BulkUpdateTasksOut = z.object({
  updated: z.number(),
  failed: z.number(),
  results: z.array(bulkTaskResult),
});

export const CreateSubtasksOut = z.object({
  taskId: z.string(),
  created: z.number(),
  failed: z.number(),
  results: z.array(
    z.object({
      subtaskId: z.string().nullable(),
      title: z.string(),
      ok: z.boolean(),
      error: z.string().nullable(),
    })
  ),
});

export const ToggleSubtaskOut = z.object({ subtask: SubtaskView });

export const CommentOnTaskOut = z.object({ comment: CommentView });

export const UpsertAutomationOut = z.object({ automation: AutomationRule });
