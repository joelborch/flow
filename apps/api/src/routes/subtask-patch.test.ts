import { describe, expect, it, vi } from "vitest";
import { taskRoutes } from "./tasks.js";
import { authOf, authedApp, workspaceEnv } from "./testkit.js";

const auth = authOf("member");

function createTestApp(stub: Record<string, unknown>) {
  return {
    app: authedApp(auth, taskRoutes),
    env: workspaceEnv(stub),
  };
}

describe("PATCH /api/subtasks/:subtaskId", () => {
  it("throws 400 Bad Request on empty body and does not call any DO method", async () => {
    const updateSubtask = vi.fn();
    const toggleSubtask = vi.fn();
    const { app, env } = createTestApp({ updateSubtask, toggleSubtask });

    const res = await app.request(
      "/api/subtasks/sb_123",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      env
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe(
      "PATCH /subtasks/:id needs at least one of title, assigneeId, dueDate, note, done"
    );
    expect(updateSubtask).not.toHaveBeenCalled();
    expect(toggleSubtask).not.toHaveBeenCalled();
  });

  it("calls toggleSubtask({ subtaskId, done: false }) and returns 200 OK on { done: false }", async () => {
    const subtask = { id: "sb_123", title: "Task step", done: false };
    const toggleSubtask = vi.fn().mockResolvedValue(subtask);
    const updateSubtask = vi.fn();
    const { app, env } = createTestApp({ updateSubtask, toggleSubtask });

    const res = await app.request(
      "/api/subtasks/sb_123",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ done: false }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(subtask);
    expect(toggleSubtask).toHaveBeenCalledWith(
      { subtaskId: "sb_123", done: false },
      auth.actor
    );
    expect(updateSubtask).not.toHaveBeenCalled();
  });

  it("calls updateSubtask({ subtaskId, assigneeId: null }) and returns 200 OK without calling toggleSubtask on { assigneeId: null }", async () => {
    const subtask = { id: "sb_123", title: "Task step", assigneeId: null };
    const updateSubtask = vi.fn().mockResolvedValue(subtask);
    const toggleSubtask = vi.fn();
    const { app, env } = createTestApp({ updateSubtask, toggleSubtask });

    const res = await app.request(
      "/api/subtasks/sb_123",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigneeId: null }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(subtask);
    expect(updateSubtask).toHaveBeenCalledWith(
      { subtaskId: "sb_123", assigneeId: null },
      auth.actor
    );
    expect(toggleSubtask).not.toHaveBeenCalled();
  });
});
