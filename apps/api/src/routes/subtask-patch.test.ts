import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { User } from "@flow/shared";
import type { AppEnv, AuthContext, Env } from "../env.js";
import { onError } from "../errors.js";
import { taskRoutes } from "./tasks.js";

const user: User = {
  id: "us_member",
  email: "member@example.com",
  name: "member",
  role: "member",
  deactivated: false,
  createdAt: 1_700_000_000_000,
};

const auth: AuthContext = {
  user,
  apiKey: null,
  actor: { userId: "us_member", via: "api", apiKeyId: null, automationRuleId: null },
};

function createTestApp(stub: Record<string, unknown>) {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    return next();
  });
  app.route("/api", taskRoutes);
  const env = {
    WORKSPACE: { idFromName: () => ({}), get: () => stub },
  } as unknown as Env;
  return { app, env };
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
