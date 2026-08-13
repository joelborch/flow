import { describe, expect, it } from "vitest";
import { AUTOMATION_MAX_DEPTH, WebhookPayload } from "@flow/shared";
import { evaluateAutomations, isDepthExceeded, loadEnabledRules } from "./engine.js";
import { makeCtx, makeFacts, makeRule, makeTask, subtaskDelta, taskDelta } from "./testkit.js";

describe("loadEnabledRules", () => {
  it("returns only enabled rules and skips malformed json", () => {
    const ctx = makeCtx({
      rules: [
        makeRule({ id: "ar_on", enabled: true }),
        makeRule({ id: "ar_off", enabled: false }),
        // A rule missing `actions` — must be dropped, not thrown on.
        { ...makeRule({ id: "ar_bad" }), actions: [] },
      ],
    });
    expect(loadEnabledRules(ctx.sql).map((r) => r.id)).toEqual(["ar_on"]);
  });

  it("falls back to a single `json` column when the columnar read fails", () => {
    const rules = [makeRule({ id: "ar_json" }), makeRule({ id: "ar_json_off", enabled: false })];
    const sql = {
      exec(query: string) {
        if (query.includes("SELECT json")) {
          return { toArray: () => rules.map((r) => ({ json: JSON.stringify(r) })) };
        }
        throw new Error("no such column: scope");
      },
    } as unknown as SqlStorage;
    expect(loadEnabledRules(sql).map((r) => r.id)).toEqual(["ar_json"]);
  });

  it("returns nothing rather than throwing when the table is unreadable", () => {
    const sql = {
      exec() {
        throw new Error("no such table: automation_rules");
      },
    } as unknown as SqlStorage;
    expect(loadEnabledRules(sql)).toEqual([]);
  });
});

describe("depth cap", () => {
  it("isDepthExceeded trips exactly at AUTOMATION_MAX_DEPTH", () => {
    expect(AUTOMATION_MAX_DEPTH).toBe(5);
    expect(isDepthExceeded(AUTOMATION_MAX_DEPTH - 1)).toBe(false);
    expect(isDepthExceeded(AUTOMATION_MAX_DEPTH)).toBe(true);
    expect(isDepthExceeded(AUTOMATION_MAX_DEPTH + 1)).toBe(true);
  });

  it("passes depth + 1 into applyAction so nested turns count", () => {
    const ctx = makeCtx({
      rules: [makeRule({ actions: [{ kind: "set_status", statusName: "APPROVED" }] })],
      depth: 2,
    });
    evaluateAutomations(ctx, taskDelta(null, null, "create"));
    expect(ctx.applied).toHaveLength(1);
    expect(ctx.applied[0]?.depth).toBe(3);
    expect(ctx.applied[0]?.taskId).toBe("tk_1");
  });

  it("passes the firing rule's id so the DO can attribute the audit row", () => {
    const ctx = makeCtx({
      rules: [
        makeRule({ id: "ar_publish", actions: [{ kind: "set_status", statusName: "APPROVED" }] }),
      ],
    });
    evaluateAutomations(ctx, taskDelta(null, null, "create"));
    expect(ctx.applied[0]?.ruleId).toBe("ar_publish");
  });

  it("tags each action with its own rule when two rules match one delta", () => {
    const ctx = makeCtx({
      rules: [
        makeRule({ id: "ar_one", actions: [{ kind: "add_tags", tags: ["one"] }] }),
        makeRule({ id: "ar_two", actions: [{ kind: "add_tags", tags: ["two"] }] }),
      ],
    });
    evaluateAutomations(ctx, taskDelta(null, null, "create"));
    expect(ctx.applied.map((a) => a.ruleId)).toEqual(["ar_one", "ar_two"]);
  });

  it("runs the last allowed hop at depth 4", () => {
    const ctx = makeCtx({ rules: [makeRule()], depth: AUTOMATION_MAX_DEPTH - 1 });
    evaluateAutomations(ctx, taskDelta(null, null, "create"));
    expect(ctx.applied).toHaveLength(1);
    expect(ctx.runs[0]?.results).toEqual([
      { action: "add_tags", ok: true, dryRun: false, detail: "tags += touched" },
    ]);
  });

  it("hard stops at the cap, applying nothing but still logging a run", () => {
    const ctx = makeCtx({
      rules: [
        makeRule({
          actions: [
            { kind: "add_tags", tags: ["touched"] },
            { kind: "call_webhook", url: "https://example.com/hook", secret: null },
          ],
        }),
      ],
      depth: AUTOMATION_MAX_DEPTH,
    });
    evaluateAutomations(ctx, taskDelta(null, null, "create"));

    expect(ctx.applied).toEqual([]);
    expect(ctx.queued).toEqual([]);
    expect(ctx.runs).toHaveLength(1);
    expect(ctx.runs[0]?.depth).toBe(AUTOMATION_MAX_DEPTH);
    const results = ctx.runs[0]?.results as { action: string; ok: boolean; detail: string }[];
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe("*");
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.detail).toContain("depth cap (5)");
    expect(results[0]?.detail).toContain("2 action(s) skipped");
  });
});

describe("evaluateAutomations", () => {
  it("ignores rules scoped to another list", () => {
    const ctx = makeCtx({ rules: [makeRule({ scope: { kind: "list", listId: "ls_other" } })] });
    evaluateAutomations(ctx, taskDelta(null, null, "create"));
    expect(ctx.runs).toEqual([]);
  });

  it("skips a rule whose conditions fail and logs nothing for it", () => {
    const ctx = makeCtx({
      rules: [makeRule({ conditions: [{ kind: "status_is", names: ["IN REVIEW"] }] })],
    });
    evaluateAutomations(ctx, taskDelta(null, null, "create"));
    expect(ctx.runs).toEqual([]);
    expect(ctx.applied).toEqual([]);
  });

  it("runs actions in declared order", () => {
    const ctx = makeCtx({
      rules: [
        makeRule({
          actions: [
            { kind: "set_status", statusName: "APPROVED" },
            { kind: "create_subtask", title: "publish {{task.title}}", assigneeId: "us_bob", dueInDays: null },
            { kind: "add_tags", tags: ["done"] },
          ],
        }),
      ],
    });
    evaluateAutomations(ctx, taskDelta(null, null, "create"));
    expect(ctx.applied.map((a) => a.action.kind)).toEqual([
      "set_status",
      "create_subtask",
      "add_tags",
    ]);
  });

  it("renders create_subtask titles before handing them to the DO", () => {
    const ctx = makeCtx({
      rules: [
        makeRule({
          trigger: { kind: "tag_added", tags: ["assign"] },
          actions: [{ kind: "create_subtask", title: "{{task.title}}", assigneeId: null, dueInDays: null }],
        }),
      ],
      facts: makeFacts({ task: makeTask({ title: "Redo the hero image", tags: ["assign"] }) }),
    });
    evaluateAutomations(ctx, taskDelta({ tags: ["assign"] }, { tags: [] }));
    const action = ctx.applied[0]?.action;
    expect(action?.kind).toBe("create_subtask");
    expect(action && "title" in action ? action.title : null).toBe("Redo the hero image");
  });

  it("renders create_task fields before handing the cross-list create to the DO", () => {
    const ctx = makeCtx({
      rules: [
        makeRule({
          actions: [
            {
              kind: "create_task",
              listId: "ls_verification",
              title: "{{task.title}}",
              description: "{{task.description}}",
              statusName: "TO DO",
              assigneeId: null,
              priority: null,
              dueInDays: null,
              tags: [],
            },
          ],
        }),
      ],
      facts: makeFacts({
        task: makeTask({ title: "Refresh the pricing page", description: "Replace the old rate card" }),
      }),
    });
    evaluateAutomations(ctx, taskDelta(null, null, "create"));

    expect(ctx.applied[0]?.action).toEqual({
      kind: "create_task",
      listId: "ls_verification",
      title: "Refresh the pricing page",
      description: "Replace the old rate card",
      statusName: "TO DO",
      assigneeId: null,
      priority: null,
      dueInDays: null,
      tags: [],
    });
  });

  it("hands remove_tags to the DO as an internal action", () => {
    const ctx = makeCtx({
      rules: [
        makeRule({
          actions: [{ kind: "remove_tags", tags: ["from-content-pipeline"] }],
        }),
      ],
    });
    evaluateAutomations(ctx, taskDelta(null, null, "create"));
    expect(ctx.applied[0]?.action).toEqual({
      kind: "remove_tags",
      tags: ["from-content-pipeline"],
    });
  });

  it("hands a calendar recurrence action to the DO unchanged", () => {
    const action = {
      kind: "create_next_recurring_task" as const,
      recurrence: { kind: "monthly" as const, interval: 3 },
      timeZone: "America/New_York",
      identityTag: "todoist-source-quarterly",
      statusName: "To Do",
    };
    const ctx = makeCtx({ rules: [makeRule({ actions: [action] })] });
    evaluateAutomations(ctx, taskDelta(null, null, "create"));
    expect(ctx.applied[0]?.action).toEqual(action);
  });

  it("enqueues a signed webhook envelope rather than calling out inline", () => {
    const ctx = makeCtx({
      rules: [
        makeRule({
          trigger: { kind: "tag_added", tags: ["qa"] },
          actions: [{ kind: "call_webhook", url: "https://hooks.example.com/api/hook", secret: "s3cret" }],
        }),
      ],
      facts: makeFacts({
        task: makeTask({
          title: "Proofread the draft article",
          description: "Review https://docs.google.com/document/d/example/edit",
          tags: ["qa"],
          priority: "high",
          dueDate: 1_700_086_400_000,
          clickupId: "86legacy",
        }),
        assignee: { id: "us_bob", name: "Bob", email: "bob@example.com" },
      }),
    });
    evaluateAutomations(ctx, taskDelta({ tags: ["qa"] }, { tags: [] }));

    expect(ctx.applied).toEqual([]);
    expect(ctx.queued).toHaveLength(1);
    const payload = ctx.queued[0];
    expect(payload?.kind).toBe("webhook");
    if (payload?.kind !== "webhook") throw new Error("expected webhook");
    expect(payload.url).toBe("https://hooks.example.com/api/hook");
    expect(payload.secret).toBe("s3cret");
    expect(payload.body.event).toBe("task.tag_added");
    expect(payload.body.task?.id).toBe("tk_1");
    expect(payload.body.payload).toEqual(
      expect.objectContaining({
        id: "tk_1",
        flow_id: "tk_1",
        clickup_id: "86legacy",
        name: "Proofread the draft article",
        title: "Proofread the draft article",
        description: "Review https://docs.google.com/document/d/example/edit",
        text_content: "Review https://docs.google.com/document/d/example/edit",
        status: { status: "To Do" },
        list: { id: "ls_1", name: "Content Cycle" },
        space: { id: "sp_1", name: "Marketing" },
        assignees: [{ id: "us_bob", username: "Bob", email: "bob@example.com" }],
        priority: { priority: "high" },
        due_date: "1700086400000",
        tags: [{ name: "qa" }],
        url: "https://flow.example.com/t/tk_1",
      })
    );
    expect(payload.body.workspace).toBe("flow.example.com");
    expect(WebhookPayload.safeParse(payload.body).success).toBe(true);
    // Automation-only extras must not leak onto the wire.
    expect("prev" in payload.body.delta).toBe(false);
    expect("taskId" in payload.body.delta).toBe(false);
  });

  it("renders email templates and flags dry-run in the run log", () => {
    const ctx = makeCtx({
      rules: [
        makeRule({
          actions: [
            {
              kind: "send_email",
              to: ["{{task.assignee}}", "ops@example.com"],
              cc: ["reviewer@example.com"],
              bcc: ["audit@example.com"],
              subject: "[{{space.name}}] {{task.title}}",
              body: "See {{task.url}}",
            },
          ],
        }),
      ],
      facts: makeFacts({
        task: makeTask({ title: "Publish" }),
        assignee: { id: "us_bob", name: "Bob", email: "bob@example.com" },
      }),
    });
    evaluateAutomations(ctx, taskDelta(null, null, "create"));

    const payload = ctx.queued[0];
    if (payload?.kind !== "email") throw new Error("expected email");
    expect(payload.to).toEqual(["bob@example.com", "ops@example.com"]);
    expect(payload.cc).toEqual(["reviewer@example.com"]);
    expect(payload.bcc).toEqual(["audit@example.com"]);
    expect(payload.subject).toBe("[Marketing] Publish");
    expect(payload.body).toBe("See https://flow.example.com/t/tk_1");
    const results = ctx.runs[0]?.results as { dryRun: boolean }[];
    expect(results[0]?.dryRun).toBe(true);
  });

  it("drops unresolvable recipients and fails the action when none remain", () => {
    const ctx = makeCtx({
      rules: [
        makeRule({
          actions: [{ kind: "send_email", to: ["{{task.assignee}}"], subject: "s", body: "b" }],
        }),
      ],
      emailDryRun: false,
    });
    evaluateAutomations(ctx, taskDelta(null, null, "create"));
    expect(ctx.queued).toEqual([]);
    const results = ctx.runs[0]?.results as { ok: boolean; detail: string }[];
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.detail).toBe("no resolvable recipients");
  });

  it("records a failing action without aborting the rest of the rule", () => {
    const ctx = makeCtx({
      rules: [
        makeRule({
          actions: [
            { kind: "set_status", statusName: "boom" },
            { kind: "add_tags", tags: ["still-ran"] },
          ],
        }),
      ],
    });
    ctx.applyAction = (action, taskId, depth) => {
      if (action.kind === "set_status") throw new Error("unknown status");
      ctx.applied.push({ action, taskId, depth });
    };
    evaluateAutomations(ctx, taskDelta(null, null, "create"));

    const results = ctx.runs[0]?.results as { action: string; ok: boolean; detail: string }[];
    expect(results.map((r) => [r.action, r.ok])).toEqual([
      ["set_status", false],
      ["add_tags", true],
    ]);
    expect(results[0]?.detail).toBe("unknown status");
    expect(ctx.applied.map((a) => a.action.kind)).toEqual(["add_tags"]);
  });

  it("fires an all_subtasks_done + status_is rule (the review-complete case)", () => {
    const ctx = makeCtx({
      rules: [
        makeRule({
          trigger: { kind: "all_subtasks_done" },
          conditions: [{ kind: "status_is", names: ["IN REVIEW"] }],
          actions: [
            { kind: "set_status", statusName: "APPROVED" },
            { kind: "create_subtask", title: "publish the launch article", assigneeId: "us_bob", dueInDays: null },
          ],
        }),
      ],
      facts: makeFacts({ task: makeTask({ statusId: "st_review" }), subtaskTotal: 2, subtaskDone: 2 }),
    });
    evaluateAutomations(ctx, subtaskDelta());
    expect(ctx.applied.map((a) => a.action.kind)).toEqual(["set_status", "create_subtask"]);
    expect(ctx.runs[0]?.trigger).toBe("task.all_subtasks_done");
  });

  it("never throws when the task has vanished mid-turn", () => {
    const ctx = makeCtx({ rules: [makeRule()] });
    ctx.loadTaskFacts = () => null;
    expect(() => evaluateAutomations(ctx, taskDelta(null, null, "create"))).not.toThrow();
    expect(ctx.runs).toEqual([]);
  });

});
