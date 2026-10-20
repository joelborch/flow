import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { User } from "@flow/shared";
import type { AppEnv, AuthContext, Env } from "../env.js";
import { onError } from "../errors.js";
import { handoffRoutes, listHandoffsInputFromQuery } from "./handoffs.js";

// Real Hono routes against a stubbed DO binding. Who may move a handoff where
// is the DO's rule and is tested there; what is under test here is the
// validation, the query parsing and the error mapping on the way out.

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

const task = {
  id: "tk_h1",
  listId: "ls_bugs",
  title: "Pull March sessions",
  tags: ["handoff"],
  handoff: {
    requestedBy: "us_member",
    state: "requested",
    returnFormat: null,
    contextTaskIds: [],
    stateChangedAt: 1_780_000_000_000,
  },
};

function appWith(stub: Record<string, unknown>) {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    return next();
  });
  app.route("/api", handoffRoutes);
  const env = {
    WORKSPACE: { idFromName: () => ({}), get: () => stub },
  } as unknown as Env;
  return {
    request: (path: string, init: RequestInit = {}) => app.request(path, init, env),
  };
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("listHandoffsInputFromQuery", () => {
  const parse = (qs: string) =>
    listHandoffsInputFromQuery(new URL(`https://flow.example.com/api/handoffs${qs}`));

  it("sets only the keys that were supplied, so the contract's defaults apply", () => {
    expect(parse("")).toEqual({});
    expect(parse("?direction=&states=&limit=")).toEqual({});
  });

  it("reads direction, comma-separated or repeated states, and a numeric limit", () => {
    expect(parse("?direction=outgoing&states=done,declined&limit=10")).toEqual({
      direction: "outgoing",
      states: ["done", "declined"],
      limit: 10,
    });
    expect(parse("?states=working&states=needs_input")).toEqual({
      states: ["working", "needs_input"],
    });
  });

  it("takes state as another name for states rather than silently ignoring it", () => {
    expect(parse("?state=done")).toEqual({ states: ["done"] });
  });

  it("hands a non-numeric limit to Zod as NaN so the error names the field", () => {
    expect(parse("?limit=ten")).toEqual({ limit: Number.NaN });
  });
});

describe("POST /api/handoffs", () => {
  const body = {
    listId: "ls_bugs",
    toUserId: "us_sam",
    title: "Pull March sessions",
    ask: "Sessions by landing page for March.",
  };

  it("files the handoff as the caller and answers 201 { task }", async () => {
    const requestHandoff = vi.fn().mockResolvedValue(task);
    const res = await appWith({ requestHandoff }).request("/api/handoffs", post(body));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ task });
    expect(requestHandoff).toHaveBeenCalledWith(body, auth.actor);
  });

  it("422s an empty ask with the contract's own sentence, before the DO", async () => {
    const requestHandoff = vi.fn();
    const res = await appWith({ requestHandoff }).request(
      "/api/handoffs",
      post({ ...body, ask: "" })
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid request body: ask: Describe what you need."
    );
    expect(requestHandoff).not.toHaveBeenCalled();
  });

  it("names every missing field in one line", async () => {
    const res = await appWith({ requestHandoff: vi.fn() }).request("/api/handoffs", post({}));
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: string };
    for (const field of ["listId", "toUserId", "title", "ask"]) {
      expect(error, field).toContain(`${field}:`);
    }
  });

  it("passes a DO refusal through as a 422 with its sentence", async () => {
    const message = "us_sam is deactivated and can't receive a handoff.";
    const requestHandoff = vi.fn().mockRejectedValue(new Error(message));
    const res = await appWith({ requestHandoff }).request("/api/handoffs", post(body));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: message });
  });
});

describe("GET /api/handoffs", () => {
  it("defaults to incoming with a 50-row limit and answers { tasks }", async () => {
    const listHandoffs = vi.fn().mockResolvedValue([task]);
    const res = await appWith({ listHandoffs }).request("/api/handoffs");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tasks: [task] });
    expect(listHandoffs).toHaveBeenCalledWith({ direction: "incoming", limit: 50 }, auth.actor);
  });

  it("parses the query into ListHandoffsInput", async () => {
    const listHandoffs = vi.fn().mockResolvedValue([]);
    const res = await appWith({ listHandoffs }).request(
      "/api/handoffs?direction=outgoing&states=done,declined&limit=10"
    );
    expect(res.status).toBe(200);
    expect(listHandoffs).toHaveBeenCalledWith(
      { direction: "outgoing", states: ["done", "declined"], limit: 10 },
      auth.actor
    );
  });

  it.each([
    ["?direction=sideways", "direction"],
    ["?states=blocked", "states"],
    ["?limit=ten", "limit"],
    ["?limit=500", "limit"],
  ])("422s %s, naming the field", async (qs, field) => {
    const listHandoffs = vi.fn();
    const res = await appWith({ listHandoffs }).request(`/api/handoffs${qs}`);
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("invalid handoff query params:");
    expect(error).toContain(field);
    expect(listHandoffs).not.toHaveBeenCalled();
  });
});

describe("POST /api/tasks/:taskId/handoff", () => {
  it("posts the reply as the caller and answers { task, comment }", async () => {
    const comment = { id: "cm_1", taskId: "tk_h1", authorId: "us_member", body: "Done", via: "api" };
    const replyHandoff = vi.fn().mockResolvedValue({ task, comment });
    const res = await appWith({ replyHandoff }).request(
      "/api/tasks/tk_h1/handoff",
      post({ message: "Done", state: "done" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ task, comment });
    expect(replyHandoff).toHaveBeenCalledWith(
      { taskId: "tk_h1", message: "Done", state: "done" },
      auth.actor
    );
  });

  it("takes taskId from the path, over any copy in the body", async () => {
    const replyHandoff = vi.fn().mockResolvedValue({ task, comment: null });
    await appWith({ replyHandoff }).request(
      "/api/tasks/tk_h1/handoff",
      post({ taskId: "tk_other", state: "working" })
    );
    expect(replyHandoff.mock.calls[0]![0]).toEqual({ taskId: "tk_h1", state: "working" });
  });

  it("422s a body with neither a message nor a state, before the DO", async () => {
    const replyHandoff = vi.fn();
    const res = await appWith({ replyHandoff }).request("/api/tasks/tk_h1/handoff", post({}));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain(
      "Send a message, a new state, or both."
    );
    expect(replyHandoff).not.toHaveBeenCalled();
  });

  it("422s an unknown state", async () => {
    const replyHandoff = vi.fn();
    const res = await appWith({ replyHandoff }).request(
      "/api/tasks/tk_h1/handoff",
      post({ state: "blocked" })
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain("state:");
    expect(replyHandoff).not.toHaveBeenCalled();
  });

  it("maps the DO's errors: a permission refusal is a 422, a missing task a 404", async () => {
    const refusal = "Only the recipient can mark this handoff done.";
    const refused = await appWith({
      replyHandoff: vi.fn().mockRejectedValue(new Error(refusal)),
    }).request("/api/tasks/tk_h1/handoff", post({ state: "done" }));
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: refusal });

    const missing = await appWith({
      replyHandoff: vi.fn().mockRejectedValue(new Error("Task tk_h1 not found.")),
    }).request("/api/tasks/tk_h1/handoff", post({ state: "done" }));
    expect(missing.status).toBe(404);
  });

  it("400s malformed JSON", async () => {
    const res = await appWith({ replyHandoff: vi.fn() }).request("/api/tasks/tk_h1/handoff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});
