import { describe, expect, it } from "vitest";
import { AutomationRule } from "@flow/shared";
import {
  bindSeedScopes,
  SEED_AUTOMATION_RULES,
  SEED_LIST_PLACEHOLDERS,
  SEED_PLACEHOLDERS,
  SEED_SPACE_PLACEHOLDERS,
  SEED_USER_PLACEHOLDERS,
} from "./seeds.js";

const asRule = (seed: (typeof SEED_AUTOMATION_RULES)[number]) => ({
  ...seed,
  id: "ar_seed",
  createdAt: 0,
  updatedAt: 0,
});

describe("seed rules", () => {
  it("every seed parses as an AutomationRule", () => {
    for (const seed of SEED_AUTOMATION_RULES) {
      const parsed = AutomationRule.safeParse(asRule(seed));
      expect(parsed.success, `${seed.key}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
    }
  });

  it("ships every rule disabled", () => {
    expect(SEED_AUTOMATION_RULES.every((r) => r.enabled === false)).toBe(true);
  });

  it("has unique keys", () => {
    const keys = SEED_AUTOMATION_RULES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("scopes every rule to a placeholder id awaiting binding", () => {
    for (const seed of SEED_AUTOMATION_RULES) {
      const id = seed.scope.kind === "list" ? seed.scope.listId : seed.scope.spaceId;
      expect(SEED_PLACEHOLDERS, seed.key).toContain(id);
    }
  });

  it("only points webhooks at example endpoints", () => {
    for (const seed of SEED_AUTOMATION_RULES) {
      for (const action of seed.actions) {
        if (action.kind === "call_webhook") {
          expect(new URL(action.url).hostname.endsWith("example.com"), seed.key).toBe(true);
        }
        if (action.kind === "send_email") {
          for (const addr of action.to) expect(addr.endsWith("@example.com"), seed.key).toBe(true);
        }
      }
    }
  });
});

describe("bindSeedScopes", () => {
  it("rewrites scope and assignee ids in one pass", () => {
    const bound = bindSeedScopes(SEED_AUTOMATION_RULES, {
      [SEED_LIST_PLACEHOLDERS.ourProjects]: "ls_real_our_projects",
      [SEED_LIST_PLACEHOLDERS.contentCycle]: "ls_real_content_cycle",
      [SEED_SPACE_PLACEHOLDERS.marketing]: "sp_real_marketing",
      [SEED_USER_PLACEHOLDERS.publisher]: "us_real_publisher",
    });

    const reviewRule = bound.find((r) => r.key === "content-cycle/review-to-ready");
    expect(reviewRule?.scope).toEqual({ kind: "list", listId: "ls_real_content_cycle" });
    const subtask = reviewRule?.actions.find((a) => a.kind === "create_subtask");
    expect(subtask && "assigneeId" in subtask ? subtask.assigneeId : null).toBe(
      "us_real_publisher"
    );

    for (const rule of bound) {
      expect(AutomationRule.safeParse(asRule(rule)).success, rule.key).toBe(true);
    }
  });

  it("throws when a placeholder is left unbound", () => {
    expect(() => bindSeedScopes(SEED_AUTOMATION_RULES, {})).toThrow(/unbound placeholders/);
  });
});
