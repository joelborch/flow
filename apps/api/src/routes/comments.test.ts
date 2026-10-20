import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Actor, ApiKey, User } from "@flow/shared";
import type { AppEnv, AuthContext, Env } from "../env.js";
import { onError } from "../errors.js";
import { CommentOnTaskArgs } from "../mcp/schemas.js";
import { apiKeyRoutes } from "./api-keys.js";
import { taskRoutes } from "./tasks.js";

// POST /api/tasks/:taskId/comments with emailToRequester, and PATCH
// /api/api-keys/:id, which allows a key to send those. Whether the ticket can
// be answered is the DO's rule and is tested there; under test here is that a
// key nobody allowed gets a plain 403 before the DO is called, that only an
// owner or admin can allow one, and that MCP's comment tool never offers the
// option at all.

const user: User = {
  id: "us_owner",
  email: "owner@example.com",
  name: "Owner",
  role: "owner",
  deactivated: false,
  createdAt: 1_700_000_000_000,
};

function apiKey(canEmailRequesters: boolean): ApiKey {
  return {
    id: "ak_1",
    userId: "us_owner",
    name: "cli",
    tokenHash: "0".repeat(64),
    createdAt: 0,
    lastUsedAt: null,
    revokedAt: null,
    canEmailRequesters,
  };
}

function appWith(
  actor: Actor,
  key: ApiKey | null = null,
  stub: Record<string, unknown> = {},
  who: User = user
) {
  const createComment = vi.fn().mockResolvedValue({ id: "cm_1" });
  const setApiKeyEmailRequesters = vi.fn().mockResolvedValue({ ...apiKey(true) });
  const auth: AuthContext = { user: who, apiKey: key, actor };
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    return next();
  });
  app.route("/api", taskRoutes);
  app.route("/api", apiKeyRoutes);
  const env = {
    WORKSPACE: { idFromName: () => ({}), get: () => ({ createComment, setApiKeyEmailRequesters, ...stub }) },
  } as unknown as Env;
  const send = (method: string, path: string, body: unknown) =>
    app.request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
  return {
    createComment,
    setApiKeyEmailRequesters,
    post: (body: unknown) => send("POST", "/api/tasks/tk_1/comments", body),
    patchKey: (body: unknown) => send("PATCH", "/api/api-keys/ak_1", body),
  };
}

const PERSON: Actor = { userId: "us_owner", via: "ui", apiKeyId: null, automationRuleId: null };
const API_KEY: Actor = { userId: "us_owner", via: "api", apiKeyId: "ak_1", automationRuleId: null };

describe("POST /api/tasks/:taskId/comments with emailToRequester", () => {
  it("passes a person's reply through to the DO", async () => {
    const { post, createComment } = appWith(PERSON);
    const res = await post({ body: "Done", emailToRequester: true });
    expect(res.status).toBe(201);
    expect(createComment).toHaveBeenCalledWith(
      { taskId: "tk_1", body: "Done", emailToRequester: true },
      PERSON
    );
  });

  it("passes a reply from a key an owner allowed to email requesters", async () => {
    const { post, createComment } = appWith(API_KEY, apiKey(true));
    expect((await post({ body: "Done", emailToRequester: true })).status).toBe(201);
    expect(createComment).toHaveBeenCalledWith({ taskId: "tk_1", body: "Done", emailToRequester: true }, API_KEY);
  });

  it("turns away a key nobody allowed, with a 403 before the DO is called", async () => {
    const { post, createComment } = appWith(API_KEY, apiKey(false));
    const res = await post({ body: "Done", emailToRequester: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/allowed to email requesters/) });
    expect(createComment).not.toHaveBeenCalled();
  });

  it("still lets an api key post an ordinary comment", async () => {
    const { post, createComment } = appWith(API_KEY);
    expect((await post({ body: "Note" })).status).toBe(201);
    expect(createComment).toHaveBeenCalledWith({ taskId: "tk_1", body: "Note" }, API_KEY);
  });
});

describe("flow_comment_on_task", () => {
  it("has no email option, and strips one an agent sends anyway", () => {
    expect(Object.keys(CommentOnTaskArgs.shape)).not.toContain("emailToRequester");
    expect(CommentOnTaskArgs.parse({ taskId: "tk_1", body: "Done", emailToRequester: true })).toEqual({
      taskId: "tk_1",
      body: "Done",
    });
  });
});

describe("PATCH /api/api-keys/:apiKeyId", () => {
  it("lets an owner in the app allow a key, returning it without the hash", async () => {
    const { patchKey, setApiKeyEmailRequesters } = appWith(PERSON);
    const res = await patchKey({ canEmailRequesters: true });
    expect(res.status).toBe(200);
    expect(setApiKeyEmailRequesters).toHaveBeenCalledWith("ak_1", true, PERSON);
    const body = (await res.json()) as { apiKey: Record<string, unknown> };
    expect(body.apiKey).toMatchObject({ id: "ak_1", canEmailRequesters: true, tokenFingerprint: "00000000" });
    expect(body.apiKey).not.toHaveProperty("tokenHash");
  });

  it("works from an owner's api key, since the CLI is where this is set", async () => {
    const fromKey = appWith(API_KEY, apiKey(false));
    expect((await fromKey.patchKey({ canEmailRequesters: true })).status).toBe(200);
    expect(fromKey.setApiKeyEmailRequesters).toHaveBeenCalledWith("ak_1", true, API_KEY);
  });

  it("is 403 for a member", async () => {
    const member = appWith(PERSON, null, {}, { ...user, id: "us_member", role: "member" });
    expect((await member.patchKey({ canEmailRequesters: true })).status).toBe(403);
    expect(member.setApiKeyEmailRequesters).not.toHaveBeenCalled();
  });

  it("is 422 without a boolean", async () => {
    const { patchKey } = appWith(PERSON);
    expect((await patchKey({ canEmailRequesters: "yes" })).status).toBe(422);
  });
});
