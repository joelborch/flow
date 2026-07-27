/**
 * Tool input schemas.
 *
 * Every one of these is either a shared contract schema used verbatim or built
 * out of shared pieces. Nothing here redeclares an entity shape: `packages/shared`
 * stays the single source of truth, so a contract change is a typecheck failure
 * here rather than a silently divergent tool signature.
 *
 * `McpServer.registerTool` takes a raw Zod *shape*, not a ZodObject, so each
 * schema is exported as an object (handy to test and to reuse) and `.shape` is
 * what gets registered.
 */
import { z } from "zod";
import {
  BulkUpdateInput,
  CreateCommentInput,
  CreateTaskInput,
  Id,
  LIMITS,
  MoveTaskInput,
  SearchTasksInput,
  ToggleSubtaskInput,
  Ts,
  UpdateTaskInput,
  UpsertAutomationInput,
} from "@flow/shared";

/**
 * The response budget dial, shared by every read that has one.
 *
 * "concise" is the default everywhere: it is what an agent should be spending
 * context on unless it already knows it needs the long form. Trimming is per
 * tool and documented on the tool itself.
 */
export const Format = z.enum(["concise", "detailed"]).default("concise");
export type Format = z.infer<typeof Format>;

/** Reused verbatim from the contract — same vocabulary as REST. */
export const SearchTasksArgs = SearchTasksInput.extend({ format: Format });
export const CreateTaskArgs = CreateTaskInput;
export const UpdateTaskArgs = UpdateTaskInput;
export const MoveTaskArgs = MoveTaskInput;
export const BulkUpdateTasksArgs = BulkUpdateInput;
export const ToggleSubtaskArgs = ToggleSubtaskInput;
export const CommentOnTaskArgs = CreateCommentInput;
export const UpsertAutomationArgs = UpsertAutomationInput;

export const GetWorkspaceMapArgs = z.object({
  /**
   * Distinct tags in use are derived by scanning every task row, which is by
   * far the most expensive part of the map — so it is off by default and opted
   * into only when the caller actually needs to match an existing tag.
   */
  includeTags: z.boolean().default(false),
  includeArchived: z.boolean().default(false),
  /** "detailed" adds per-list open-task counts and member emails/roles. */
  format: Format,
});

export const GetTaskArgs = z.object({
  taskId: Id,
  /** "concise" keeps only the 15 newest comments; "detailed" returns them all. */
  format: Format,
});

/** How many comments a concise `flow_get_task` returns. */
export const CONCISE_COMMENT_LIMIT = 15;

export const ListMyWorkArgs = z.object({
  /** Defaults to the user this api key acts as. */
  assigneeId: Id.optional(),
  includeClosed: z.boolean().default(false),
  /**
   * 50 is a plate, not an archive. An agent that genuinely needs more should
   * page with `cursor` rather than pull 200 rows it will not read.
   */
  limit: z.number().int().min(1).max(200).default(50),
  /** Opaque; pass back the `cursor` from the previous page. */
  cursor: z.string().optional(),
  format: Format,
});

/** Mirrors `POST /api/tasks/bulk`: per-item results, up to 200 items. */
export const BulkCreateTasksArgs = z.object({
  tasks: z.array(CreateTaskInput).min(1).max(200),
});

/** Batch create under one parent. Subtasks are done/not-done — no status. */
export const CreateSubtasksArgs = z.object({
  taskId: Id,
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
        dueDate: Ts.nullable().optional(),
      })
    )
    .min(1)
    .max(100),
});

export const ListAutomationsArgs = z.object({
  enabledOnly: z.boolean().default(false),
  /** Filter to rules scoped to one list or space. */
  listId: Id.optional(),
  spaceId: Id.optional(),
});

/**
 * Same filters as `GET /api/audit`, minus the query-string coercion.
 *
 * `cursor` is this tool's half of the server-wide paging convention. `before`
 * is the older name for the same keyset value and is still accepted silently so
 * nothing that already pages by it breaks; `cursor` wins when both are sent.
 */
export const GetAuditLogArgs = z.object({
  entity: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  userId: Id.optional(),
  apiKeyId: Id.optional(),
  /** Opaque; pass back the `cursor` from the previous page. */
  cursor: Ts.optional(),
  before: Ts.optional(),
  after: Ts.optional(),
  limit: z.number().int().min(1).max(500).default(50),
});
