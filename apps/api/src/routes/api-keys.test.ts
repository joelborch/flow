import { describe, expect, it } from "vitest";
import {
  createKeyDenial,
  managesAllKeys,
  revokeKeyDenial,
  visibleApiKeys,
  type KeyViewer,
} from "./api-keys.js";

const owner: KeyViewer = { id: "us_owner", role: "owner" };
const admin: KeyViewer = { id: "us_admin", role: "admin" };
const member: KeyViewer = { id: "us_mem", role: "member" };
const other: KeyViewer = { id: "us_other", role: "member" };

const key = (id: string, userId: string) => ({ id, userId });
const ALL = [key("ak_1", "us_owner"), key("ak_2", "us_mem"), key("ak_3", "us_other")];

describe("managesAllKeys", () => {
  it("is true for owner and admin only", () => {
    expect(managesAllKeys("owner")).toBe(true);
    expect(managesAllKeys("admin")).toBe(true);
    expect(managesAllKeys("member")).toBe(false);
  });
});

describe("GET /api/api-keys — visibleApiKeys", () => {
  it("gives a member only the keys that impersonate them", () => {
    expect(visibleApiKeys(ALL, member)).toEqual([key("ak_2", "us_mem")]);
    expect(visibleApiKeys(ALL, other)).toEqual([key("ak_3", "us_other")]);
  });

  it("gives owner and admin every key, including other people's", () => {
    expect(visibleApiKeys(ALL, owner)).toEqual(ALL);
    expect(visibleApiKeys(ALL, admin)).toEqual(ALL);
  });

  it("is a copy, so the caller cannot mutate the DO's array", () => {
    const seen = visibleApiKeys(ALL, owner);
    seen.pop();
    expect(ALL).toHaveLength(3);
  });

  it("hands a member with no keys an empty list rather than everyone's", () => {
    expect(visibleApiKeys(ALL, { id: "us_new", role: "member" })).toEqual([]);
  });
});

describe("POST /api/api-keys — createKeyDenial", () => {
  it("lets any member mint a key that acts as themselves", () => {
    expect(createKeyDenial(member, member.id)).toBeNull();
  });

  it("refuses a member minting a key that impersonates somebody else", () => {
    const denial = createKeyDenial(member, other.id);
    expect(denial).toContain("owner or admin");
    expect(denial).toContain("act as yourself");
  });

  it("lets owner and admin mint a key for anyone", () => {
    expect(createKeyDenial(owner, member.id)).toBeNull();
    expect(createKeyDenial(admin, other.id)).toBeNull();
    expect(createKeyDenial(admin, admin.id)).toBeNull();
  });
});

describe("DELETE /api/api-keys/:id — revokeKeyDenial", () => {
  it("lets a member revoke their own key", () => {
    expect(revokeKeyDenial(member, key("ak_2", "us_mem"))).toBeNull();
  });

  it("refuses a member revoking a key that impersonates somebody else", () => {
    const denial = revokeKeyDenial(member, key("ak_3", "us_other"));
    expect(denial).toContain("only its owner");
  });

  it("lets owner and admin revoke any key", () => {
    expect(revokeKeyDenial(owner, key("ak_3", "us_other"))).toBeNull();
    expect(revokeKeyDenial(admin, key("ak_2", "us_mem"))).toBeNull();
  });
});
