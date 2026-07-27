import { describe, expect, it } from "vitest";
import type { Actor, Role } from "@flow/shared";
import { toSpaceVisibility } from "./rows.js";
import {
  canSeeSpace,
  isPrivilegedRole,
  isSystemActor,
  privateSpaceError,
  visibleSpaceIds,
} from "./visibility.js";

const actor = (via: Actor["via"]): Actor => ({
  userId: "us_alice",
  via,
  apiKeyId: null,
  automationRuleId: null,
});

describe("canSeeSpace", () => {
  it("shows every workspace-visible space to a plain member", () => {
    expect(canSeeSpace("member", { visibility: "workspace", isMember: false })).toBe(true);
  });

  it("hides a private space from a member who is not in it", () => {
    expect(canSeeSpace("member", { visibility: "private", isMember: false })).toBe(false);
  });

  it("shows a private space to a member who is in it", () => {
    expect(canSeeSpace("member", { visibility: "private", isMember: true })).toBe(true);
  });

  it.each<Role>(["owner", "admin"])("shows every private space to an %s", (role) => {
    expect(canSeeSpace(role, { visibility: "private", isMember: false })).toBe(true);
  });

  it("treats an unknown user as a member, never as an admin", () => {
    // A stale WebSocket attachment or a deleted actor must not inherit the
    // admin's see-everything, and must not lose the public spaces either.
    expect(canSeeSpace(null, { visibility: "private", isMember: false })).toBe(false);
    expect(canSeeSpace(null, { visibility: "workspace", isMember: false })).toBe(true);
  });

  it("ignores membership on a workspace-visible space", () => {
    expect(canSeeSpace("member", { visibility: "workspace", isMember: true })).toBe(true);
  });
});

describe("isPrivilegedRole", () => {
  it("is exactly owner and admin", () => {
    expect(isPrivilegedRole("owner")).toBe(true);
    expect(isPrivilegedRole("admin")).toBe(true);
    expect(isPrivilegedRole("member")).toBe(false);
    expect(isPrivilegedRole(null)).toBe(false);
    expect(isPrivilegedRole(undefined)).toBe(false);
  });
});

describe("isSystemActor", () => {
  it("exempts automations and imports, which the workspace itself decided on", () => {
    expect(isSystemActor(actor("automation"))).toBe(true);
    expect(isSystemActor(actor("import"))).toBe(true);
  });

  it("does not exempt a person, whatever they came in through", () => {
    for (const via of ["ui", "api", "mcp", "webhook"] as const) {
      expect(isSystemActor(actor(via))).toBe(false);
    }
  });
});

describe("privateSpaceError", () => {
  it("names the space and the way out", () => {
    expect(privateSpaceError("sp_abc")).toBe(
      "Space sp_abc is private; ask an owner/admin for access."
    );
  });

  it("does not read as a missing space", () => {
    // statusForDoError in apps/api keys 404 off "not found"; this must not be
    // one, and a person must not go hunting for an id that does exist.
    expect(privateSpaceError("sp_abc")).not.toMatch(/not found/i);
  });
});

describe("toSpaceVisibility", () => {
  it("maps the two real values", () => {
    expect(toSpaceVisibility("private")).toBe("private");
    expect(toSpaceVisibility("workspace")).toBe("workspace");
  });

  it("fails open for anything unrecognised, so a space never vanishes", () => {
    expect(toSpaceVisibility(null)).toBe("workspace");
    expect(toSpaceVisibility("")).toBe("workspace");
    expect(toSpaceVisibility("PRIVATE")).toBe("workspace");
  });
});

// ---------------------------------------------------------------------------
// visibleSpaceIds against a stub SqlStorage. Only the three queries this
// function makes are answered; anything else throws, so a change in the queries
// shows up as a failing test rather than a silently wrong permission set.
// ---------------------------------------------------------------------------

interface Fixture {
  users: Record<string, Role>;
  spaces: Array<{ id: string; visibility: string }>;
  members: Array<{ space_id: string; user_id: string }>;
}

function fakeSql(f: Fixture): SqlStorage {
  const exec = (query: string, ...params: unknown[]): unknown => {
    const rows = (values: unknown[]) => ({ toArray: () => values, one: () => values[0] });
    if (query.includes("SELECT role FROM users")) {
      const role = f.users[params[0] as string];
      return rows(role === undefined ? [] : [{ role }]);
    }
    if (query.includes("FROM space_members WHERE user_id")) {
      return rows(f.members.filter((m) => m.user_id === params[0]).map((m) => ({ space_id: m.space_id })));
    }
    if (query.includes("SELECT id, visibility FROM spaces")) return rows(f.spaces);
    throw new Error(`unexpected query: ${query}`);
  };
  return { exec } as unknown as SqlStorage;
}

const fixture: Fixture = {
  users: { us_alice: "owner", us_bob: "admin", us_amy: "member", us_sam: "member" },
  spaces: [
    { id: "sp_public", visibility: "workspace" },
    { id: "sp_legacy", visibility: "" },
    { id: "sp_secret", visibility: "private" },
  ],
  members: [{ space_id: "sp_secret", user_id: "us_amy" }],
};

describe("visibleSpaceIds", () => {
  it("returns null for owners and admins — the 'no filtering' signal", () => {
    expect(visibleSpaceIds(fakeSql(fixture), "us_alice")).toBeNull();
    expect(visibleSpaceIds(fakeSql(fixture), "us_bob")).toBeNull();
  });

  it("gives a member the public spaces plus the private ones they are in", () => {
    expect([...(visibleSpaceIds(fakeSql(fixture), "us_amy") ?? [])].sort()).toEqual([
      "sp_legacy",
      "sp_public",
      "sp_secret",
    ]);
  });

  it("omits a private space a member is not in", () => {
    expect([...(visibleSpaceIds(fakeSql(fixture), "us_sam") ?? [])].sort()).toEqual([
      "sp_legacy",
      "sp_public",
    ]);
  });

  it("gives an unknown user id the public spaces only, never everything", () => {
    expect([...(visibleSpaceIds(fakeSql(fixture), "us_ghost") ?? [])].sort()).toEqual([
      "sp_legacy",
      "sp_public",
    ]);
  });
});
