import { describe, expect, it } from "vitest";
import {
  ASSIGNEE_HINT_LIMIT,
  type UserHint,
  requireAssignee,
  unknownAssigneeMessage,
} from "./users.js";

const USERS: UserHint[] = [
  { id: "us_alice", name: "Alice", deactivated: false },
  { id: "us_amy", name: "Amy", deactivated: false },
  { id: "us_gone", name: "Former Contractor", deactivated: true },
];

/** Minimal SqlStorage stand-in over a fixed user table. */
function fakeSql(users: UserHint[]): SqlStorage {
  return {
    exec(query: string, ...bindings: unknown[]) {
      if (query.includes("COUNT(*)")) {
        return { toArray: () => [{ n: users.length }], one: () => ({ n: users.length }) };
      }
      if (query.includes("WHERE id = ?")) {
        const hit = users.filter((u) => u.id === bindings[0]).map((u) => ({ id: u.id }));
        return { toArray: () => hit };
      }
      const limit = Number(bindings[0] ?? users.length);
      return {
        toArray: () =>
          users
            .slice(0, limit)
            .map((u) => ({ id: u.id, name: u.name, deactivated: u.deactivated ? 1 : 0 })),
      };
    },
  } as unknown as SqlStorage;
}

describe("unknownAssigneeMessage", () => {
  it("names the offending id and lists every valid one", () => {
    const msg = unknownAssigneeMessage("us_nope", USERS);
    expect(msg).toContain('Unknown assigneeId "us_nope"');
    expect(msg).toContain('us_alice ("Alice")');
    expect(msg).toContain('us_amy ("Amy")');
  });

  it("marks deactivated users as still assignable rather than hiding them", () => {
    const msg = unknownAssigneeMessage("us_nope", USERS);
    expect(msg).toContain('us_gone ("Former Contractor", deactivated)');
    expect(msg).toContain("Deactivated users are still assignable");
  });

  it("says so plainly when there are no users at all", () => {
    expect(unknownAssigneeMessage("us_nope", [])).toContain("has no users yet");
  });

  it("caps the enumeration and counts the remainder", () => {
    const many: UserHint[] = Array.from({ length: ASSIGNEE_HINT_LIMIT }, (_, i) => ({
      id: `us_${i}`,
      name: `User ${i}`,
    }));
    const msg = unknownAssigneeMessage("us_nope", many, 60);
    expect(msg).toContain(`and ${60 - ASSIGNEE_HINT_LIMIT} more`);
    expect(msg).not.toContain("us_40");
  });
});

describe("requireAssignee", () => {
  const sql = fakeSql(USERS);

  it("accepts an existing user", () => {
    expect(() => requireAssignee(sql, "us_alice")).not.toThrow();
  });

  it("accepts a deactivated user — imported history references them", () => {
    expect(() => requireAssignee(sql, "us_gone")).not.toThrow();
  });

  it("treats null and undefined as unassigned", () => {
    expect(() => requireAssignee(sql, null)).not.toThrow();
    expect(() => requireAssignee(sql, undefined)).not.toThrow();
  });

  it("rejects an id that matches no user, with the valid ids in the message", () => {
    expect(() => requireAssignee(sql, "us_ghost")).toThrow(/Unknown assigneeId "us_ghost"/);
    expect(() => requireAssignee(sql, "us_ghost")).toThrow(/us_alice \("Alice"\)/);
  });
});
