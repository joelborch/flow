import { describe, expect, it } from "vitest";
import {
  BulkCreateTasksArgs,
  CommentOnTaskArgs,
  CreateSubtasksArgs,
  CreateTaskArgs,
  GetAuditLogArgs,
  GetTaskArgs,
  GetWorkspaceMapArgs,
  ListMyWorkArgs,
  MoveTaskArgs,
  SearchTasksArgs,
  ToggleSubtaskArgs,
  UpdateTaskArgs,
  UpsertAutomationArgs,
} from "./schemas.js";

describe("flow_get_workspace_map input", () => {
  it("needs no arguments and skips the tag scan unless asked", () => {
    expect(GetWorkspaceMapArgs.parse({})).toEqual({
      includeTags: false,
      includeArchived: false,
      format: "concise",
    });
  });
});

describe("flow_create_task input", () => {
  it("requires listId and a non-empty title", () => {
    expect(CreateTaskArgs.safeParse({ title: "Fix it" }).success).toBe(false);
    expect(CreateTaskArgs.safeParse({ listId: "ls_bugs", title: "" }).success).toBe(false);
  });

  it("defaults the description and leaves status unset for the list's open status", () => {
    const parsed = CreateTaskArgs.parse({ listId: "ls_bugs", title: "Fix it" });
    expect(parsed.description).toBe("");
    expect(parsed.status).toBeUndefined();
  });

  it("takes a status NAME, not an id — any string is accepted and the DO validates it", () => {
    expect(CreateTaskArgs.parse({ listId: "ls_bugs", title: "x", status: "In Progress" }).status).toBe(
      "In Progress"
    );
  });

  it("rejects an unknown priority but allows an explicit null", () => {
    expect(
      CreateTaskArgs.safeParse({ listId: "ls_bugs", title: "x", priority: "P0" }).success
    ).toBe(false);
    expect(CreateTaskArgs.parse({ listId: "ls_bugs", title: "x", priority: null }).priority).toBeNull();
  });

  it("rejects a non-integer or negative dueDate, since timestamps are epoch ms", () => {
    expect(CreateTaskArgs.safeParse({ listId: "ls_bugs", title: "x", dueDate: 1.5 }).success).toBe(
      false
    );
    expect(CreateTaskArgs.safeParse({ listId: "ls_bugs", title: "x", dueDate: -1 }).success).toBe(
      false
    );
    expect(
      CreateTaskArgs.safeParse({ listId: "ls_bugs", title: "x", dueDate: "2026-03-10" }).success
    ).toBe(false);
  });

  it("accepts inline subtasks", () => {
    const parsed = CreateTaskArgs.parse({
      listId: "ls_bugs",
      title: "x",
      subtasks: [{ title: "Reproduce" }, { title: "Patch", assigneeId: "us_alice" }],
    });
    expect(parsed.subtasks).toHaveLength(2);
  });
});

describe("flow_update_task / flow_move_task input", () => {
  it("requires a taskId and nothing else", () => {
    expect(UpdateTaskArgs.safeParse({}).success).toBe(false);
    expect(UpdateTaskArgs.parse({ taskId: "tk_1" })).toEqual({ taskId: "tk_1" });
    expect(MoveTaskArgs.parse({ taskId: "tk_1" })).toEqual({ taskId: "tk_1" });
  });

  it("distinguishes clearing a field (null) from leaving it alone (absent)", () => {
    const cleared = UpdateTaskArgs.parse({ taskId: "tk_1", assigneeId: null, dueDate: null });
    expect(cleared.assigneeId).toBeNull();
    expect("assigneeId" in UpdateTaskArgs.parse({ taskId: "tk_1" })).toBe(false);
  });

  it("takes a fractional move position", () => {
    expect(MoveTaskArgs.parse({ taskId: "tk_1", position: 1.5 }).position).toBe(1.5);
  });
});

describe("flow_search_tasks input", () => {
  it("is entirely optional and defaults to 50 concise open tasks", () => {
    expect(SearchTasksArgs.parse({})).toEqual({
      includeClosed: false,
      limit: 50,
      format: "concise",
    });
  });

  it("takes status as an array of NAMES", () => {
    expect(SearchTasksArgs.parse({ status: ["Triage", "In Progress"] }).status).toEqual([
      "Triage",
      "In Progress",
    ]);
    expect(SearchTasksArgs.safeParse({ status: "Triage" }).success).toBe(false);
  });

  it("caps limit at 200", () => {
    expect(SearchTasksArgs.safeParse({ limit: 201 }).success).toBe(false);
    expect(SearchTasksArgs.safeParse({ limit: 0 }).success).toBe(false);
  });
});

describe("flow_list_my_work input", () => {
  it("defaults to the caller's open work, one concise page of 50", () => {
    const parsed = ListMyWorkArgs.parse({});
    expect(parsed.assigneeId).toBeUndefined();
    expect(parsed.cursor).toBeUndefined();
    expect(parsed).toMatchObject({ includeClosed: false, limit: 50, format: "concise" });
  });

  it("takes a cursor, like every other pageable tool", () => {
    expect(ListMyWorkArgs.parse({ cursor: "tk_1|1780000000000" }).cursor).toBe(
      "tk_1|1780000000000"
    );
  });
});

describe("bulk and batch inputs", () => {
  it("bulk create demands at least one task and caps the batch at 200", () => {
    expect(BulkCreateTasksArgs.safeParse({ tasks: [] }).success).toBe(false);
    expect(
      BulkCreateTasksArgs.safeParse({
        tasks: Array.from({ length: 201 }, () => ({ listId: "ls_bugs", title: "x" })),
      }).success
    ).toBe(false);
    expect(
      BulkCreateTasksArgs.parse({ tasks: [{ listId: "ls_bugs", title: "x" }] }).tasks
    ).toHaveLength(1);
  });

  it("bulk create rejects the batch when one entry is invalid", () => {
    const result = BulkCreateTasksArgs.safeParse({
      tasks: [{ listId: "ls_bugs", title: "ok" }, { title: "no list" }],
    });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]!.path).toEqual(["tasks", 1, "listId"]);
  });

  it("create_subtasks needs a parent taskId and one to a hundred subtasks", () => {
    expect(CreateSubtasksArgs.safeParse({ subtasks: [{ title: "x" }] }).success).toBe(false);
    expect(CreateSubtasksArgs.safeParse({ taskId: "tk_1", subtasks: [] }).success).toBe(false);
    expect(
      CreateSubtasksArgs.safeParse({
        taskId: "tk_1",
        subtasks: Array.from({ length: 101 }, () => ({ title: "x" })),
      }).success
    ).toBe(false);
    expect(
      CreateSubtasksArgs.parse({ taskId: "tk_1", subtasks: [{ title: "Reproduce" }] }).subtasks
    ).toEqual([{ title: "Reproduce" }]);
  });

  it("subtasks carry no status — the field is not in the schema", () => {
    const parsed = CreateSubtasksArgs.parse({
      taskId: "tk_1",
      subtasks: [{ title: "x", status: "Triage" } as never],
    });
    expect(parsed.subtasks[0]).not.toHaveProperty("status");
  });
});

describe("small write inputs", () => {
  it("toggle_subtask requires an explicit done boolean", () => {
    expect(ToggleSubtaskArgs.safeParse({ subtaskId: "sb_1" }).success).toBe(false);
    expect(ToggleSubtaskArgs.parse({ subtaskId: "sb_1", done: true }).done).toBe(true);
  });

  it("comment_on_task rejects an empty body", () => {
    expect(CommentOnTaskArgs.safeParse({ taskId: "tk_1", body: "" }).success).toBe(false);
    expect(CommentOnTaskArgs.parse({ taskId: "tk_1", body: "on it" }).body).toBe("on it");
  });

  it("get_task requires a taskId", () => {
    expect(GetTaskArgs.safeParse({}).success).toBe(false);
    expect(GetTaskArgs.safeParse({ taskId: "tk" }).success).toBe(false); // ids are >= 4 chars
  });
});

describe("flow_upsert_automation input", () => {
  const rule = {
    name: "Notify on urgent bugs",
    scope: { kind: "list", listId: "ls_bugs" },
    trigger: { kind: "status_changed", to: ["Triage"] },
    actions: [{ kind: "add_tags", tags: ["triaged"] }],
  };

  it("ships rules disabled with no conditions unless told otherwise", () => {
    const parsed = UpsertAutomationArgs.parse(rule);
    expect(parsed.enabled).toBe(false);
    expect(parsed.conditions).toEqual([]);
    expect(parsed.id).toBeUndefined();
  });

  it("requires at least one action and rejects an unknown trigger or action kind", () => {
    expect(UpsertAutomationArgs.safeParse({ ...rule, actions: [] }).success).toBe(false);
    expect(
      UpsertAutomationArgs.safeParse({ ...rule, trigger: { kind: "task_deleted" } }).success
    ).toBe(false);
    expect(
      UpsertAutomationArgs.safeParse({ ...rule, actions: [{ kind: "set_status" }] }).success
    ).toBe(false);
  });

  it("names statuses in triggers and actions", () => {
    const parsed = UpsertAutomationArgs.parse({
      ...rule,
      actions: [{ kind: "set_status", statusName: "Shipped" }],
    });
    expect(parsed.actions[0]).toEqual({ kind: "set_status", statusName: "Shipped" });
  });
});

describe("flow_get_audit_log input", () => {
  it("defaults to the 50 newest entries", () => {
    expect(GetAuditLogArgs.parse({})).toEqual({ limit: 50 });
  });

  it("caps limit at 500", () => {
    expect(GetAuditLogArgs.safeParse({ limit: 501 }).success).toBe(false);
  });

  it("takes cursor, and still accepts the legacy before", () => {
    expect(GetAuditLogArgs.parse({ cursor: 41823 }).cursor).toBe(41823);
    expect(GetAuditLogArgs.parse({ before: 41823 }).before).toBe(41823);
  });
});
