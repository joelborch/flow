import { Hono } from "hono";
import { z } from "zod";
import {
  BulkUpdateInput,
  CreateCommentInput,
  CreateSubtaskInput,
  CreateTaskInput,
  Id,
  MoveTaskInput,
  SearchTasksInput,
  ToggleSubtaskInput,
  UpdateSubtaskInput,
  UpdateTaskInput,
} from "@flow/shared";
import { requireAuth } from "../auth.js";
import { workspace } from "../do.js";
import type { AppEnv } from "../env.js";
import { notFound, parseOrThrow, readJson } from "../errors.js";

export const taskRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Search. Accepted as query params (agent- and curl-friendly) or as a POST body
// for the long filters. Repeatable params collapse into arrays, and `tags=a,b`
// is accepted as a convenience.
// ---------------------------------------------------------------------------

const csv = (values: string[]): string[] =>
  values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => v !== "");

function searchInputFromQuery(url: URL): unknown {
  const q = url.searchParams;
  const num = (key: string): number | undefined => {
    const raw = q.get(key);
    if (raw === null || raw.trim() === "") return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : Number.NaN; // NaN -> Zod reports it
  };
  const str = (key: string): string | undefined => q.get(key) ?? undefined;
  const arr = (key: string): string[] | undefined => {
    const all = csv(q.getAll(key));
    return all.length > 0 ? all : undefined;
  };
  const bool = (key: string): boolean | undefined => {
    const raw = q.get(key);
    if (raw === null) return undefined;
    return raw !== "false" && raw !== "0";
  };

  // Only include keys that were actually supplied, so Zod defaults still apply.
  const out: Record<string, unknown> = {};
  const assign = (key: string, value: unknown) => {
    if (value !== undefined) out[key] = value;
  };
  assign("query", str("query") ?? str("q"));
  assign("listId", str("listId"));
  assign("spaceId", str("spaceId"));
  assign("status", arr("status"));
  assign("assigneeId", str("assigneeId"));
  assign("tags", arr("tags"));
  assign("includeClosed", bool("includeClosed"));
  assign("dueBefore", num("dueBefore"));
  assign("dueAfter", num("dueAfter"));
  assign("updatedAfter", num("updatedAfter"));
  assign("limit", num("limit"));
  assign("cursor", str("cursor"));
  return out;
}

taskRoutes.get("/tasks/search", async (c) => {
  const auth = requireAuth(c);
  const input = parseOrThrow(
    SearchTasksInput,
    searchInputFromQuery(new URL(c.req.url)),
    "search query params"
  );
  return c.json(await workspace(c.env).searchTasks(input, auth.actor));
});

taskRoutes.post("/tasks/search", async (c) => {
  const auth = requireAuth(c);
  const input = parseOrThrow(SearchTasksInput, await readJson(c));
  return c.json(await workspace(c.env).searchTasks(input, auth.actor));
});

// ---------------------------------------------------------------------------
// Bulk. Registered before /tasks/:taskId so "bulk" is never read as an id.
// ---------------------------------------------------------------------------

taskRoutes.patch("/tasks/bulk", async (c) => {
  const auth = requireAuth(c);
  const input = parseOrThrow(BulkUpdateInput, await readJson(c));
  return c.json(await workspace(c.env).bulkUpdate(input, auth.actor));
});

taskRoutes.post("/tasks/bulk", async (c) => {
  const auth = requireAuth(c);
  const body = parseOrThrow(
    z.object({ tasks: z.array(CreateTaskInput).min(1).max(200) }),
    await readJson(c)
  );
  const ws = workspace(c.env);
  const results: Array<{ taskId: string | null; ok: boolean; error: string | null }> = [];
  // Sequential on purpose: the DO is single-threaded and each create appends a
  // delta, so pipelining buys nothing and muddles the ordering.
  for (const input of body.tasks) {
    try {
      const task = await ws.createTask(input, auth.actor);
      results.push({ taskId: task.id, ok: true, error: null });
    } catch (err) {
      results.push({
        taskId: null,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return c.json({ results }, 201);
});

// ---------------------------------------------------------------------------
// Task CRUD
// ---------------------------------------------------------------------------

/** Filtered list read; a thin wrapper over search for the common cases. */
taskRoutes.get("/tasks", async (c) => {
  const auth = requireAuth(c);
  const input = parseOrThrow(
    SearchTasksInput,
    searchInputFromQuery(new URL(c.req.url)),
    "query params"
  );
  return c.json(await workspace(c.env).searchTasks(input, auth.actor));
});

taskRoutes.get("/tasks/:taskId", async (c) => {
  const auth = requireAuth(c);
  const taskId = parseOrThrow(Id, c.req.param("taskId"), "taskId");
  const detail = await workspace(c.env).getTaskDetail(taskId, auth.user.id);
  if (!detail) throw notFound(`no task ${taskId}`);
  return c.json(detail);
});

taskRoutes.post("/tasks", async (c) => {
  const auth = requireAuth(c);
  const input = parseOrThrow(CreateTaskInput, await readJson(c));
  return c.json(await workspace(c.env).createTask(input, auth.actor), 201);
});

taskRoutes.patch("/tasks/:taskId", async (c) => {
  const auth = requireAuth(c);
  const taskId = parseOrThrow(Id, c.req.param("taskId"), "taskId");
  const body = await readJson(c);
  // taskId comes from the path; a body copy is allowed but must agree.
  const input = parseOrThrow(UpdateTaskInput, {
    ...(typeof body === "object" && body !== null ? body : {}),
    taskId,
  });
  return c.json(await workspace(c.env).updateTask(input, auth.actor));
});

taskRoutes.post("/tasks/:taskId/move", async (c) => {
  const auth = requireAuth(c);
  const taskId = parseOrThrow(Id, c.req.param("taskId"), "taskId");
  const body = await readJson(c);
  const input = parseOrThrow(MoveTaskInput, {
    ...(typeof body === "object" && body !== null ? body : {}),
    taskId,
  });
  return c.json(await workspace(c.env).moveTask(input, auth.actor));
});

taskRoutes.delete("/tasks/:taskId", async (c) => {
  const auth = requireAuth(c);
  const taskId = parseOrThrow(Id, c.req.param("taskId"), "taskId");
  await workspace(c.env).deleteTask(taskId, auth.actor);
  return c.json({ ok: true, deleted: taskId });
});

// ---------------------------------------------------------------------------
// Subtasks — done/not-done only, no status pipeline (Asana-style).
// ---------------------------------------------------------------------------

taskRoutes.post("/tasks/:taskId/subtasks", async (c) => {
  const auth = requireAuth(c);
  const taskId = parseOrThrow(Id, c.req.param("taskId"), "taskId");
  const body = await readJson(c);
  const raw = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  // Accept one subtask or a batch — agents overwhelmingly want the batch form.
  if (Array.isArray(raw["subtasks"])) {
    const input = parseOrThrow(
      z.object({
        subtasks: z
          .array(
            z.object({
              title: z.string().min(1),
              assigneeId: Id.nullable().optional(),
              dueDate: z.number().int().nonnegative().nullable().optional(),
            })
          )
          .min(1)
          .max(100),
      }),
      raw
    );
    const ws = workspace(c.env);
    const created = [];
    for (const sub of input.subtasks) {
      created.push(await ws.createSubtask({ taskId, ...sub }, auth.actor));
    }
    return c.json({ subtasks: created }, 201);
  }

  const input = parseOrThrow(CreateSubtaskInput, { ...raw, taskId });
  return c.json(await workspace(c.env).createSubtask(input, auth.actor), 201);
});

taskRoutes.patch("/subtasks/:subtaskId", async (c) => {
  const auth = requireAuth(c);
  const subtaskId = parseOrThrow(Id, c.req.param("subtaskId"), "subtaskId");
  const body = await readJson(c);
  const input = parseOrThrow(UpdateSubtaskInput, {
    ...(typeof body === "object" && body !== null ? body : {}),
    subtaskId,
  });
  const ws = workspace(c.env);
  let result;
  const { done, ...fields } = input;
  const hasFieldEdit = ["title", "assigneeId", "dueDate"].some(
    (k) => (fields as Record<string, unknown>)[k] !== undefined
  );
  if (hasFieldEdit) result = await ws.updateSubtask(fields, auth.actor);
  if (done !== undefined) result = await ws.toggleSubtask({ subtaskId, done }, auth.actor);
  if (!result) result = await ws.toggleSubtask({ subtaskId, done: false }, auth.actor);
  return c.json(result);
});

taskRoutes.delete("/subtasks/:subtaskId", async (c) => {
  const auth = requireAuth(c);
  const subtaskId = parseOrThrow(Id, c.req.param("subtaskId"), "subtaskId");
  await workspace(c.env).deleteSubtask(subtaskId, auth.actor);
  return c.json({ ok: true, deleted: subtaskId });
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

taskRoutes.get("/tasks/:taskId/comments", async (c) => {
  const auth = requireAuth(c);
  const taskId = parseOrThrow(Id, c.req.param("taskId"), "taskId");
  const detail = await workspace(c.env).getTaskDetail(taskId, auth.user.id);
  if (!detail) throw notFound(`no task ${taskId}`);
  return c.json({ comments: detail.comments });
});

taskRoutes.post("/tasks/:taskId/comments", async (c) => {
  const auth = requireAuth(c);
  const taskId = parseOrThrow(Id, c.req.param("taskId"), "taskId");
  const body = await readJson(c);
  const input = parseOrThrow(CreateCommentInput, {
    ...(typeof body === "object" && body !== null ? body : {}),
    taskId,
  });
  return c.json(await workspace(c.env).createComment(input, auth.actor), 201);
});

taskRoutes.delete("/comments/:commentId", async (c) => {
  const auth = requireAuth(c);
  const commentId = parseOrThrow(Id, c.req.param("commentId"), "commentId");
  await workspace(c.env).deleteComment(commentId, auth.actor);
  return c.json({ ok: true, deleted: commentId });
});
