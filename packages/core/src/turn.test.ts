import { describe, expect, it } from "vitest";
import type { Actor } from "@flow/shared";
import { auditActor, diffOf, toActor } from "./turn.js";

const human: Actor = {
  userId: "us_alice",
  via: "api",
  apiKeyId: "ak_claude",
  automationRuleId: null,
};

describe("auditActor", () => {
  it("passes the actor through untouched outside an automation", () => {
    expect(auditActor(human, null)).toBe(human);
  });

  it("attributes an automation-applied change to the firing rule", () => {
    expect(auditActor(human, "ar_review")).toEqual({
      userId: "us_alice",
      via: "automation",
      apiKeyId: null,
      automationRuleId: "ar_review",
    });
  });

  it("keeps the original user so the trail still says who set the chain off", () => {
    expect(auditActor(human, "ar_review").userId).toBe("us_alice");
  });

  it("clears the api key, which did not make this particular change", () => {
    expect(auditActor(human, "ar_review").apiKeyId).toBeNull();
  });

  it("works the same for a UI actor with no key", () => {
    const ui = toActor("us_amy", "ui");
    expect(auditActor(ui, "ar_x")).toEqual({
      userId: "us_amy",
      via: "automation",
      apiKeyId: null,
      automationRuleId: "ar_x",
    });
  });

  it("re-attributes an already-automation actor to the rule that is running now", () => {
    const sweep: Actor = {
      userId: "us_owner",
      via: "automation",
      apiKeyId: null,
      automationRuleId: null,
    };
    expect(auditActor(sweep, "ar_due").automationRuleId).toBe("ar_due");
  });
});

describe("diffOf", () => {
  it("reports only the keys that actually changed", () => {
    const before = { title: "a", statusId: "st_1", tags: ["x"] };
    const after = { title: "a", statusId: "st_2", tags: ["x"] };
    expect(diffOf(before, after, ["title", "statusId", "tags"])).toEqual({ statusId: "st_2" });
  });

  it("compares arrays by value, not identity", () => {
    const before = { tags: ["x"] };
    expect(diffOf(before, { tags: ["x"] }, ["tags"])).toEqual({});
    expect(diffOf(before, { tags: ["x", "y"] }, ["tags"])).toEqual({ tags: ["x", "y"] });
  });
});
