import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { me, type StoreTask } from "../store/index.js";
import { assigneeFilter, cardFilter, clearFilters, mineOnly, search } from "./filters.js";

function task(patch: Partial<StoreTask> = {}): StoreTask {
  return {
    id: "tk_1",
    listId: "ls_1",
    title: "Review proposal",
    statusId: "st_open",
    assigneeId: null,
    assignedBy: null,
    assignedAt: null,
    priority: null,
    dueDate: null,
    snoozedUntil: null,
    blockedNote: null,
    tags: [],
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    handoff: null,
    ...patch,
  };
}

function reset(): void {
  clearFilters();
  me.value = null;
}

beforeEach(reset);
afterEach(reset);

describe("cardFilter", () => {
  it("matches a title substring with a trimmed, case-insensitive query", () => {
    search.value = "  PROPOS  ";
    expect(cardFilter.value(task())).toBe(true);
    expect(cardFilter.value(task({ title: "Send invoice" }))).toBe(false);
  });

  it("matches a visible tag substring case-insensitively", () => {
    search.value = "  VOIC  ";
    expect(cardFilter.value(task({ tags: ["Finance", "Invoice"] }))).toBe(true);
    expect(cardFilter.value(task({ tags: ["Finance"] }))).toBe(false);
  });

  it("does not match machine-only ext: tags", () => {
    search.value = "invoice";
    expect(cardFilter.value(task({ tags: ["ext:invoice", "Finance"] }))).toBe(false);
    expect(cardFilter.value(task({ tags: ["ext:invoice", "Invoice"] }))).toBe(true);
  });

  it("requires both a search match and the selected assignee", () => {
    search.value = "invoice";
    assigneeFilter.value = "us_1";
    expect(cardFilter.value(task({ title: "Send invoice", assigneeId: "us_1" }))).toBe(true);
    expect(cardFilter.value(task({ tags: ["Invoice"], assigneeId: "us_1" }))).toBe(true);
    expect(cardFilter.value(task({ tags: ["Invoice"], assigneeId: "us_2" }))).toBe(false);
    expect(cardFilter.value(task({ tags: ["Invoice"] }))).toBe(false);
    expect(cardFilter.value(task({ assigneeId: "us_1" }))).toBe(false);
  });

  it("combines search with mine only, taking precedence over the assignee filter", () => {
    me.value = {
      id: "us_me", email: "me@example.com", name: "Me",
      role: "member", deactivated: false, createdAt: 0,
    };
    mineOnly.value = true;
    assigneeFilter.value = "us_other";
    search.value = "invoice";
    expect(cardFilter.value(task({ tags: ["Invoice"], assigneeId: "us_me" }))).toBe(true);
    expect(cardFilter.value(task({ tags: ["Invoice"], assigneeId: "us_other" }))).toBe(false);
    expect(cardFilter.value(task({ assigneeId: "us_me" }))).toBe(false);
  });
});
