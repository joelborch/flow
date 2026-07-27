/**
 * The 15 tools named in `MCP_TOOLS`.
 *
 * Every one is a thin wrapper over the same DO RPC method the REST route calls,
 * so a task created over MCP fires exactly the automations a task created in the
 * UI does. Nothing here touches SQL, and nothing here re-implements a mutation.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { MCP_TOOLS, type McpToolName } from "@flow/shared";
import { queryAudit } from "../do.js";
import { ApiError } from "../errors.js";
import { ToolContext } from "./context.js";
import {
  BulkCreateTasksArgs,
  BulkUpdateTasksArgs,
  CommentOnTaskArgs,
  CONCISE_COMMENT_LIMIT,
  CreateSubtasksArgs,
  CreateTaskArgs,
  GetAuditLogArgs,
  GetTaskArgs,
  GetWorkspaceMapArgs,
  ListAutomationsArgs,
  ListMyWorkArgs,
  MoveTaskArgs,
  SearchTasksArgs,
  ToggleSubtaskArgs,
  UpdateTaskArgs,
  UpsertAutomationArgs,
} from "./schemas.js";
import {
  BulkCreateTasksOut,
  BulkUpdateTasksOut,
  CommentOnTaskOut,
  CreateSubtasksOut,
  CreateTaskOut,
  GetAuditLogOut,
  GetTaskOut,
  GetWorkspaceMapOut,
  ListAutomationsOut,
  ListMyWorkOut,
  MoveTaskOut,
  SearchTasksOut,
  ToggleSubtaskOut,
  UpdateTaskOut,
  UpsertAutomationOut,
} from "./schemas-out.js";
import {
  attachmentView,
  commentView,
  distinctTags,
  subtaskView,
  taskDetailView,
  taskRowView,
  taskView,
  workspaceMapView,
} from "./views.js";
import { DUE_BUCKET_LABELS, groupByDueBucket } from "./work.js";

// ---------------------------------------------------------------------------
// Annotations
//
// Explicit on every tool, because a *missing* hint is not "false" — it is
// "unknown", and a client deciding whether to auto-approve a call has to assume
// the worst. `openWorldHint` is false everywhere: every tool talks to this one
// workspace DO and nothing else, so results are closed and repeatable.
// ---------------------------------------------------------------------------

/** All six reads. */
const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

/** A write that creates or appends: calling it twice creates two things. */
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

/** A write that sets a value: calling it twice with the same args is a no-op. */
const WRITE_IDEMPOTENT: ToolAnnotations = { ...WRITE, idempotentHint: true };

/**
 * `flow_upsert_automation` is the one destructive tool: passing an existing `id`
 * replaces that rule wholesale — trigger, conditions and actions — rather than
 * patching it, so a partial payload silently drops the parts it omits.
 */
const WRITE_REPLACE: ToolAnnotations = { ...WRITE_IDEMPOTENT, destructiveHint: true };

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/**
 * Every tool declares an `outputSchema`, and the SDK then *requires*
 * `structuredContent` on a non-error result and validates it against that
 * schema. The serialized text block stays alongside it for clients that predate
 * structured output (and for anything that just prints the result).
 */
const ok = (payload: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  structuredContent: payload,
});

const fail = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

/**
 * The DO's domain errors are written for callers ("unknown status 'Blocked' for
 * list ls_x; valid statuses are To Do, In Progress, Done") and `workspace()`
 * already turns them into `ApiError`s. Pass that sentence through verbatim as
 * the tool error — it is the whole reason an agent can self-correct — and never
 * leak a stack.
 */
function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

async function guard(
  run: () => Promise<Record<string, unknown>>
): Promise<CallToolResult> {
  try {
    return ok(await run());
  } catch (err) {
    return fail(errorMessage(err));
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFlowTools(server: McpServer, ctx: ToolContext): void {
  const registered = new Set<McpToolName>();
  const claim = (name: McpToolName): string => {
    registered.add(name);
    return name;
  };

  // --- reads ---------------------------------------------------------------

  server.registerTool(
    claim("flow_get_workspace_map"),
    {
      title: "Get workspace map",
      description:
        "Call this first: returns every space, list, valid status NAME per list and member, so you can pass correct status names and ids to the other tools. includeTags=true adds the tags in use (a full task scan — off by default); includeArchived adds archived spaces and lists; format=detailed adds per-list open-task counts and member emails and roles.",
      inputSchema: GetWorkspaceMapArgs.shape,
      outputSchema: GetWorkspaceMapOut.shape,
      annotations: READ,
    },
    ({ includeTags, includeArchived, format }) =>
      guard(async () => {
        const map = await ctx.workspaceMap();
        // Tags are free-form strings with no registry, so "tags in use" can only
        // come from the task rows — the one part of this that is not cheap.
        const tags = includeTags ? distinctTags((await ctx.ws.getSnapshot(ctx.userId)).tasks) : null;
        return workspaceMapView(map, {
          includeArchived,
          tags,
          detailed: format === "detailed",
        });
      })
  );

  server.registerTool(
    claim("flow_search_tasks"),
    {
      title: "Search tasks",
      description:
        "Full-text and filtered task search: query (title + description), listId, spaceId, status (an array of status NAMES), assigneeId, tags, dueBefore/dueAfter/updatedAfter in epoch ms, includeClosed, limit and cursor for paging. Rows are concise by default (id, title, status, list, assignee, dueDate, priority); format=detailed adds listId, space, assigneeId, tags and updatedAt.",
      inputSchema: SearchTasksArgs.shape,
      outputSchema: SearchTasksOut.shape,
      annotations: READ,
    },
    ({ format, ...search }) =>
      guard(async () => {
        const [result, names] = await Promise.all([
          ctx.ws.searchTasks(search, ctx.actor),
          ctx.names(),
        ]);
        const detailed = format === "detailed";
        return {
          total: result.total,
          cursor: result.cursor,
          tasks: result.tasks.map((task) => taskRowView(task, names, detailed)),
        };
      })
  );

  server.registerTool(
    claim("flow_get_task"),
    {
      title: "Get task",
      description:
        `Full detail for one taskId: description, status NAME, list, assignee, dates, tags, subtasks, comments and attachments. Concise (the default) returns only the ${CONCISE_COMMENT_LIMIT} newest comments and reports how many it dropped in commentsOmitted; format=detailed returns the whole thread.`,
      inputSchema: GetTaskArgs.shape,
      outputSchema: GetTaskOut.shape,
      annotations: READ,
    },
    ({ taskId, format }) =>
      guard(async () => {
        const [detail, names] = await Promise.all([
          ctx.ws.getTaskDetail(taskId, ctx.userId),
          ctx.names(),
        ]);
        if (!detail) throw new ApiError(404, `no task ${taskId}`);
        // A long-running task's comment thread is by far the biggest thing this
        // tool can return, and the oldest comments are the least useful, so the
        // budget cuts from the front and says so rather than truncating quietly.
        const all = detail.comments.map((comment) => commentView(comment, names));
        const kept = format === "detailed" ? all : all.slice(-CONCISE_COMMENT_LIMIT);
        const commentsOmitted = all.length - kept.length;
        return {
          task: taskDetailView(detail.task, names),
          subtasks: detail.subtasks.map((sub) => subtaskView(sub, names)),
          comments: kept,
          attachments: detail.attachments.map(attachmentView),
          commentsOmitted,
          ...(commentsOmitted > 0
            ? {
                note: `${commentsOmitted} older comments omitted — call again with format: "detailed" for the full thread`,
              }
            : {}),
        };
      })
  );

  server.registerTool(
    claim("flow_list_my_work"),
    {
      title: "List my work",
      description:
        "Open tasks assigned to you (or to assigneeId), grouped into overdue / today / thisWeek / later / noDate buckets; pass includeClosed to include finished work. Returns 50 rows by default — page with cursor for more — and concise rows unless format=detailed.",
      inputSchema: ListMyWorkArgs.shape,
      outputSchema: ListMyWorkOut.shape,
      annotations: READ,
    },
    ({ assigneeId, includeClosed, limit, cursor, format }) =>
      guard(async () => {
        const target = assigneeId ?? ctx.auth.user.id;
        const [result, names] = await Promise.all([
          ctx.ws.searchTasks(
            { assigneeId: target, includeClosed, limit, ...(cursor === undefined ? {} : { cursor }) },
            ctx.actor
          ),
          ctx.names(),
        ]);
        const detailed = format === "detailed";
        // Buckets group the page in hand, not the whole result set — `total` and
        // `cursor` are what say whether there is more behind it.
        const buckets = groupByDueBucket(
          result.tasks.map((task) => taskRowView(task, names, detailed)),
          Date.now()
        );
        return {
          assignee: { id: target, name: names.userName(target) },
          total: result.total,
          returned: result.tasks.length,
          cursor: result.cursor,
          counts: {
            overdue: buckets.overdue.length,
            today: buckets.today.length,
            thisWeek: buckets.thisWeek.length,
            later: buckets.later.length,
            noDate: buckets.noDate.length,
          },
          buckets,
          legend: DUE_BUCKET_LABELS,
        };
      })
  );

  server.registerTool(
    claim("flow_list_automations"),
    {
      title: "List automations",
      description:
        "Every automation rule with its trigger, conditions and actions; filter with enabledOnly, listId or spaceId. Rules reference statuses by NAME. These fire inline on every mutation — read them before doing by hand what a rule already does.",
      inputSchema: ListAutomationsArgs.shape,
      outputSchema: ListAutomationsOut.shape,
      annotations: READ,
    },
    ({ enabledOnly, listId, spaceId }) =>
      guard(async () => {
        const rules = await ctx.ws.listAutomations();
        const filtered = rules.filter((rule) => {
          if (enabledOnly && !rule.enabled) return false;
          if (listId !== undefined) {
            if (rule.scope.kind !== "list" || rule.scope.listId !== listId) return false;
          }
          if (spaceId !== undefined) {
            if (rule.scope.kind !== "space" || rule.scope.spaceId !== spaceId) return false;
          }
          return true;
        });
        return { automations: filtered, total: filtered.length };
      })
  );

  server.registerTool(
    claim("flow_get_audit_log"),
    {
      title: "Get audit log",
      description:
        "Who changed what, newest first: filter by entity id, action (e.g. task.update), userId, apiKeyId and after in epoch ms; page by passing the returned cursor back as cursor. (before is the older name for the same value and still works.)",
      inputSchema: GetAuditLogArgs.shape,
      outputSchema: GetAuditLogOut.shape,
      annotations: READ,
    },
    ({ cursor, before, ...filter }) =>
      guard(async () => {
        const [page, names] = await Promise.all([
          queryAudit(ctx.env, { ...filter, before: cursor ?? before }),
          ctx.names(),
        ]);
        return {
          cursor: page.cursor,
          entries: page.entries.map((entry) => ({
            id: entry.id,
            at: entry.at,
            action: entry.action,
            entity: entry.entity,
            user: names.userName(entry.actor.userId),
            via: entry.actor.via,
            apiKeyId: entry.actor.apiKeyId,
            automationRuleId: entry.actor.automationRuleId,
            diff: entry.diff,
          })),
        };
      })
  );

  // --- writes --------------------------------------------------------------

  server.registerTool(
    claim("flow_create_task"),
    {
      title: "Create task",
      description:
        "Create one task in listId: title plus optional description (markdown), status NAME (defaults to the list's open status), assigneeId, priority, dueDate/startDate in epoch ms, tags and inline subtasks.",
      inputSchema: CreateTaskArgs.shape,
      outputSchema: CreateTaskOut.shape,
      annotations: WRITE,
    },
    (args) =>
      guard(async () => {
        const [task, names] = await Promise.all([
          ctx.ws.createTask(args, ctx.actor),
          ctx.names(),
        ]);
        return { created: taskView(task, names) };
      })
  );

  server.registerTool(
    claim("flow_update_task"),
    {
      title: "Update task",
      description:
        "Change fields on one taskId — title, description, status NAME, assigneeId, priority, dueDate/startDate, tags, snoozedUntil (epoch ms; hides the task from the board until then, or null to wake it now — waking never changes the status) and blockedNote (what it is waiting on, 200 chars); omitted fields are left alone and null clears a nullable field.",
      inputSchema: UpdateTaskArgs.shape,
      outputSchema: UpdateTaskOut.shape,
      annotations: WRITE_IDEMPOTENT,
    },
    (args) =>
      guard(async () => {
        const [task, names] = await Promise.all([
          ctx.ws.updateTask(args, ctx.actor),
          ctx.names(),
        ]);
        return { updated: taskView(task, names) };
      })
  );

  server.registerTool(
    claim("flow_move_task"),
    {
      title: "Move task",
      description:
        "Move one taskId to another listId and/or status NAME, with an optional fractional position; the server picks a position when you omit it.",
      inputSchema: MoveTaskArgs.shape,
      outputSchema: MoveTaskOut.shape,
      annotations: WRITE_IDEMPOTENT,
    },
    (args) =>
      guard(async () => {
        const [task, names] = await Promise.all([
          ctx.ws.moveTask(args, ctx.actor),
          ctx.names(),
        ]);
        return { moved: taskView(task, names) };
      })
  );

  server.registerTool(
    claim("flow_bulk_create_tasks"),
    {
      title: "Bulk create tasks",
      description:
        "Create up to 200 tasks in one call (each entry is a full create: listId, title, status NAME, assigneeId, …); returns one ok/error result per item so a single bad entry does not lose the batch.",
      inputSchema: BulkCreateTasksArgs.shape,
      outputSchema: BulkCreateTasksOut.shape,
      annotations: WRITE,
    },
    ({ tasks }) =>
      guard(async () => {
        // Sequential like the REST route: the DO is single-threaded and each
        // create appends a delta, so pipelining buys nothing and muddles order.
        const results: Array<{ taskId: string | null; ok: boolean; error: string | null }> = [];
        for (const input of tasks) {
          try {
            const task = await ctx.ws.createTask(input, ctx.actor);
            results.push({ taskId: task.id, ok: true, error: null });
          } catch (err) {
            results.push({ taskId: null, ok: false, error: errorMessage(err) });
          }
        }
        return {
          created: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          results,
        };
      })
  );

  server.registerTool(
    claim("flow_bulk_update_tasks"),
    {
      title: "Bulk update tasks",
      description:
        "Apply up to 200 updates in one call — `updates` is an array of { taskId, …fields } with status as a NAME — and returns one ok/error result per taskId.",
      inputSchema: BulkUpdateTasksArgs.shape,
      outputSchema: BulkUpdateTasksOut.shape,
      annotations: WRITE,
    },
    (args) =>
      guard(async () => {
        const result = await ctx.ws.bulkUpdate(args, ctx.actor);
        return {
          updated: result.results.filter((r) => r.ok).length,
          failed: result.results.filter((r) => !r.ok).length,
          results: result.results,
        };
      })
  );

  server.registerTool(
    claim("flow_create_subtasks"),
    {
      title: "Create subtasks",
      description:
        "Add up to 100 subtasks under one parent taskId; subtasks are done/not-done checklist steps with an optional assigneeId and dueDate and carry no status.",
      inputSchema: CreateSubtasksArgs.shape,
      outputSchema: CreateSubtasksOut.shape,
      annotations: WRITE,
    },
    ({ taskId, subtasks }) =>
      guard(async () => {
        const results: Array<{
          subtaskId: string | null;
          title: string;
          ok: boolean;
          error: string | null;
        }> = [];
        for (const sub of subtasks) {
          try {
            const created = await ctx.ws.createSubtask({ taskId, ...sub }, ctx.actor);
            results.push({ subtaskId: created.id, title: created.title, ok: true, error: null });
          } catch (err) {
            results.push({
              subtaskId: null,
              title: sub.title,
              ok: false,
              error: errorMessage(err),
            });
          }
        }
        return {
          taskId,
          created: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          results,
        };
      })
  );

  server.registerTool(
    claim("flow_toggle_subtask"),
    {
      title: "Toggle subtask",
      description:
        "Mark one subtaskId done or not done; completing the last open subtask is what fires all_subtasks_done automations.",
      inputSchema: ToggleSubtaskArgs.shape,
      outputSchema: ToggleSubtaskOut.shape,
      annotations: WRITE_IDEMPOTENT,
    },
    (args) =>
      guard(async () => {
        const [subtask, names] = await Promise.all([
          ctx.ws.toggleSubtask(args, ctx.actor),
          ctx.names(),
        ]);
        return { subtask: subtaskView(subtask, names) };
      })
  );

  server.registerTool(
    claim("flow_comment_on_task"),
    {
      title: "Comment on task",
      description:
        "Post a markdown comment on taskId as the user this api key acts as.",
      inputSchema: CommentOnTaskArgs.shape,
      outputSchema: CommentOnTaskOut.shape,
      annotations: WRITE,
    },
    (args) =>
      guard(async () => {
        const [comment, names] = await Promise.all([
          ctx.ws.createComment(args, ctx.actor),
          ctx.names(),
        ]);
        return { comment: commentView(comment, names) };
      })
  );

  server.registerTool(
    claim("flow_upsert_automation"),
    {
      title: "Upsert automation",
      description:
        "Create or replace an automation rule (owner/admin only): name, enabled, scope, trigger, conditions and actions, with statuses given as NAMES; pass an existing id to replace that rule.",
      inputSchema: UpsertAutomationArgs.shape,
      outputSchema: UpsertAutomationOut.shape,
      annotations: WRITE_REPLACE,
    },
    (args) =>
      guard(async () => {
        // Same gate as POST/PATCH /api/automations — changing the workspace's
        // wiring is not member-level work.
        if (!ctx.isAdmin) {
          throw new ApiError(
            403,
            `this tool requires the owner or admin role; ${ctx.auth.user.email} is a ${ctx.auth.user.role}`
          );
        }
        return { automation: await ctx.ws.upsertAutomation(args, ctx.actor) };
      })
  );

  // Fails loudly at construction if the contract and this file disagree, rather
  // than leaving an agent to discover a missing tool at runtime.
  const missing = MCP_TOOLS.filter((name) => !registered.has(name));
  if (missing.length > 0) {
    throw new Error(`MCP_TOOLS not implemented: ${missing.join(", ")}`);
  }
}
