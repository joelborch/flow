import { describe, expect, it } from "vitest";
import {
  Comment,
  CreateCommentInput,
  CreateSubtaskInput,
  CreateTaskInput,
  LIMITS,
  Subtask,
  Task,
  UpdateTaskInput,
} from "@flow/shared";
import { truncateImportTitle } from "./import.js";

// The contract caps live in packages/shared; @flow/core is the nearest package
// with a test runner, so they are exercised from here.

const baseTask = {
  id: "tk_1",
  listId: "ls_1",
  statusId: "st_1",
  position: 1,
  createdBy: "us_1",
  createdAt: 0,
  updatedAt: 0,
};

const issues = (result: { success: boolean; error?: { issues: { message: string }[] } }): string =>
  result.success ? "" : result.error!.issues.map((i) => i.message).join("; ");

describe("input caps", () => {
  it("accepts a title exactly at the cap and rejects one over it", () => {
    const ok = CreateTaskInput.safeParse({
      listId: "ls_1",
      title: "a".repeat(LIMITS.titleMax),
    });
    expect(ok.success).toBe(true);

    const over = CreateTaskInput.safeParse({
      listId: "ls_1",
      title: "a".repeat(LIMITS.titleMax + 1),
    });
    expect(over.success).toBe(false);
    expect(issues(over)).toContain("500 characters or fewer");
  });

  it("caps the title on UpdateTaskInput and the Task entity too", () => {
    expect(
      UpdateTaskInput.safeParse({ taskId: "tk_1", title: "a".repeat(LIMITS.titleMax + 1) }).success
    ).toBe(false);
    expect(
      Task.safeParse({ ...baseTask, title: "a".repeat(LIMITS.titleMax + 1) }).success
    ).toBe(false);
  });

  it("caps descriptions at 100000 characters", () => {
    expect(LIMITS.descriptionMax).toBe(100_000);
    expect(
      CreateTaskInput.safeParse({
        listId: "ls_1",
        title: "ok",
        description: "d".repeat(LIMITS.descriptionMax),
      }).success
    ).toBe(true);
    const over = CreateTaskInput.safeParse({
      listId: "ls_1",
      title: "ok",
      description: "d".repeat(LIMITS.descriptionMax + 1),
    });
    expect(over.success).toBe(false);
    expect(issues(over)).toContain("100000 characters or fewer");
  });

  it("caps comment bodies at 20000 characters", () => {
    expect(
      CreateCommentInput.safeParse({ taskId: "tk_1", body: "b".repeat(LIMITS.commentBodyMax) })
        .success
    ).toBe(true);
    const over = CreateCommentInput.safeParse({
      taskId: "tk_1",
      body: "b".repeat(LIMITS.commentBodyMax + 1),
    });
    expect(over.success).toBe(false);
    expect(issues(over)).toContain("20000 characters or fewer");
    expect(
      Comment.safeParse({
        id: "cm_1",
        taskId: "tk_1",
        authorId: "us_1",
        body: "b".repeat(LIMITS.commentBodyMax + 1),
        createdAt: 0,
      }).success
    ).toBe(false);
  });

  it("caps subtask titles at 500 characters everywhere they are declared", () => {
    const over = CreateSubtaskInput.safeParse({
      taskId: "tk_1",
      title: "s".repeat(LIMITS.subtaskTitleMax + 1),
    });
    expect(over.success).toBe(false);
    expect(issues(over)).toContain("Subtask title");

    expect(
      Subtask.safeParse({
        id: "sb_1",
        taskId: "tk_1",
        title: "s".repeat(LIMITS.subtaskTitleMax + 1),
        position: 1,
        createdAt: 0,
      }).success
    ).toBe(false);

    expect(
      CreateTaskInput.safeParse({
        listId: "ls_1",
        title: "ok",
        subtasks: [{ title: "s".repeat(LIMITS.subtaskTitleMax + 1) }],
      }).success
    ).toBe(false);
  });

  it("caps a tag at 100 chars and a task at 50 tags", () => {
    const longTag = CreateTaskInput.safeParse({
      listId: "ls_1",
      title: "ok",
      tags: ["t".repeat(LIMITS.tagMax + 1)],
    });
    expect(longTag.success).toBe(false);
    expect(issues(longTag)).toContain("100 characters or fewer");

    const tooMany = UpdateTaskInput.safeParse({
      taskId: "tk_1",
      tags: Array.from({ length: LIMITS.tagsMax + 1 }, (_, i) => `t${i}`),
    });
    expect(tooMany.success).toBe(false);
    expect(issues(tooMany)).toContain("at most 50 tags");

    expect(
      UpdateTaskInput.safeParse({
        taskId: "tk_1",
        tags: Array.from({ length: LIMITS.tagsMax }, (_, i) => `t${i}`),
      }).success
    ).toBe(true);
  });
});

describe("truncateImportTitle", () => {
  it("leaves anything within the import cap untouched", () => {
    expect(truncateImportTitle("short")).toBe("short");
    const exact = "x".repeat(LIMITS.importTitleMax);
    expect(truncateImportTitle(exact)).toBe(exact);
  });

  it("truncates rather than rejecting, marking the cut", () => {
    const out = truncateImportTitle("y".repeat(LIMITS.importTitleMax + 500));
    expect(out).toHaveLength(LIMITS.importTitleMax);
    expect(out.endsWith("…")).toBe(true);
  });

  it("is looser than the interactive title cap", () => {
    expect(LIMITS.importTitleMax).toBeGreaterThan(LIMITS.titleMax);
  });
});
