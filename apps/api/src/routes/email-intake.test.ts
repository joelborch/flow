import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { EmailIntake, Role, User } from "@flow/shared";
import type { AppEnv, AuthContext, Env } from "../env.js";
import { onError } from "../errors.js";
import { emailIntakeRoutes } from "./email-intake.js";

// Real routes and the real workspace() error mapping, over a stubbed DO binding.

const userOf = (role: Role): User => ({
  id: `us_${role}`,
  email: `${role}@example.com`,
  name: role,
  role,
  deactivated: false,
  createdAt: 1_700_000_000_000,
});

const authOf = (role: Role): AuthContext => ({
  user: userOf(role),
  apiKey: null,
  actor: { userId: `us_${role}`, via: "ui", apiKeyId: null, automationRuleId: null },
});

const intake: EmailIntake = {
  listId: "ls_acme",
  alias: "acme",
  allowedSenders: ["@example.com", "front.desk@example.org"],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

let stub: { listEmailIntakes: ReturnType<typeof vi.fn>; setEmailIntake: ReturnType<typeof vi.fn> };

function envWith(domain?: string): Env {
  return {
    WORKSPACE: { idFromName: () => ({}), get: () => stub },
    ...(domain === undefined ? {} : { EMAIL_INTAKE_DOMAIN: domain }),
  } as unknown as Env;
}

function appAs(role: Role): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use("*", async (c, next) => {
    c.set("auth", authOf(role));
    return next();
  });
  app.route("/api", emailIntakeRoutes);
  return app;
}

const put = (body: unknown) => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  stub = {
    listEmailIntakes: vi.fn().mockResolvedValue([intake]),
    setEmailIntake: vi.fn().mockResolvedValue(intake),
  };
});

describe("email intake routes — admin gate", () => {
  it.each([
    ["GET", "/api/email-intakes", {}],
    ["PUT", "/api/lists/ls_acme/email-intake", put({ alias: "acme", allowedSenders: ["@example.com"] })],
    ["DELETE", "/api/lists/ls_acme/email-intake", { method: "DELETE" }],
  ] as const)("403s a member on %s %s", async (_method, path, init) => {
    const res = await appAs("member").request(path, init, envWith("tickets.example.com"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("owner or admin");
    expect(stub.listEmailIntakes).not.toHaveBeenCalled();
    expect(stub.setEmailIntake).not.toHaveBeenCalled();
  });
});

describe("GET /api/email-intakes", () => {
  it("returns the intake domain beside every intake", async () => {
    const res = await appAs("admin").request("/api/email-intakes", {}, envWith("tickets.example.com"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ domain: "tickets.example.com", intakes: [intake] });
  });

  it("reports a null domain when none is configured", async () => {
    const res = await appAs("owner").request("/api/email-intakes", {}, envWith());
    expect(await res.json()).toEqual({ domain: null, intakes: [intake] });
  });
});

describe("PUT /api/lists/:listId/email-intake", () => {
  it("normalizes the input and passes the caller's actor", async () => {
    const res = await appAs("owner").request(
      "/api/lists/ls_acme/email-intake",
      put({ alias: " Acme ", allowedSenders: ["@Example.com", " Front.Desk@example.org "] }),
      envWith()
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ intake });
    expect(stub.setEmailIntake).toHaveBeenCalledWith(
      "ls_acme",
      { alias: "acme", allowedSenders: ["@example.com", "front.desk@example.org"] },
      authOf("owner").actor
    );
  });

  it.each([
    [{ alias: "-acme", allowedSenders: ["@example.com"] }, "alias: Alias must be 1–40 lowercase"],
    [{ alias: "acme", allowedSenders: [] }, "allowedSenders: Add at least one allowed sender or domain."],
    [{ alias: "acme", allowedSenders: ["not-an-address"] }, "Each allowed sender must be an address"],
    [{ allowedSenders: ["@example.com"] }, "alias:"],
  ])("422s an invalid body with the contract's message", async (body, message) => {
    const res = await appAs("admin").request("/api/lists/ls_acme/email-intake", put(body), envWith());
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("invalid request body");
    expect(error).toContain(message);
    expect(stub.setEmailIntake).not.toHaveBeenCalled();
  });

  it("maps a missing list to 404 and a taken alias to 422", async () => {
    stub.setEmailIntake.mockRejectedValueOnce(new Error("List ls_missing not found."));
    const missing = await appAs("admin").request(
      "/api/lists/ls_missing/email-intake",
      put({ alias: "acme", allowedSenders: ["@example.com"] }),
      envWith()
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "List ls_missing not found." });

    stub.setEmailIntake.mockRejectedValueOnce(new Error('Alias "acme" is already used by list ls_other.'));
    const taken = await appAs("admin").request(
      "/api/lists/ls_acme/email-intake",
      put({ alias: "acme", allowedSenders: ["@example.com"] }),
      envWith()
    );
    expect(taken.status).toBe(422);
    expect(((await taken.json()) as { error: string }).error).toContain("already used");
  });
});

describe("DELETE /api/lists/:listId/email-intake", () => {
  it("removes the intake through setEmailIntake(listId, null)", async () => {
    stub.setEmailIntake.mockResolvedValueOnce(null);
    const res = await appAs("admin").request("/api/lists/ls_acme/email-intake", { method: "DELETE" }, envWith());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(stub.setEmailIntake).toHaveBeenCalledWith("ls_acme", null, authOf("admin").actor);
  });
});
