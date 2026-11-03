import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { User } from "@flow/shared";
import type { AppEnv, AuthContext, Env } from "../env.js";
import { onError } from "../errors.js";
import { taskRoutes, TASK_DETAILS_MAX } from "./tasks.js";

// POST /api/tasks/details is the bulk form of GET /api/tasks/:taskId. The
// per-task visibility rules are tested on the DO in visibility-storage.test.ts;
// here the DO is a stub.

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
  actor: { userId: user.id, via: "api", apiKeyId: null, automationRuleId: null },
};

function setup() {
  const getTaskDetails = vi.fn(async (ids: string[]) => ({ details: [], errors: ids.map((taskId) => ({ taskId, error: "nope" })) }));
  const env = { WORKSPACE: { idFromName: () => ({}), get: () => ({ getTaskDetails }) } } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    return next();
  });
  app.route("/api", taskRoutes);
  const post = (body: unknown) =>
    app.request(
      "/api/tasks/details",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      env
    );
  return { post, getTaskDetails };
}

describe("POST /api/tasks/details", () => {
  it("reads the ids in one DO call, deduplicated, as the caller", async () => {
    const { post, getTaskDetails } = setup();
    const res = await post({ taskIds: ["tk_a", "tk_b", "tk_a"] });
    expect(res.status).toBe(200);
    expect(getTaskDetails).toHaveBeenCalledTimes(1);
    expect(getTaskDetails).toHaveBeenCalledWith(["tk_a", "tk_b"], "us_member");
    expect(await res.json()).toEqual({
      details: [],
      errors: [
        { taskId: "tk_a", error: "nope" },
        { taskId: "tk_b", error: "nope" },
      ],
    });
  });

  it("422s an empty or oversized batch without reaching the DO", async () => {
    const { post, getTaskDetails } = setup();
    expect((await post({ taskIds: [] })).status).toBe(422);
    const tooMany = Array.from({ length: TASK_DETAILS_MAX + 1 }, (_, i) => `tk_${i}`);
    expect((await post({ taskIds: tooMany })).status).toBe(422);
    expect(getTaskDetails).not.toHaveBeenCalled();
  });
});
