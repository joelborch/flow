import { describe, expect, it } from "vitest";
import { buildTaskView } from "./match.js";
import { buildVars, formatDueDate, render, renderTemplate, taskUrl } from "./template.js";
import { HOSTNAME, makeFacts, makeTask, STATUS_NAMES, taskDelta } from "./testkit.js";

const view = (facts = makeFacts()) =>
  buildTaskView(facts, null, HOSTNAME, (id) => STATUS_NAMES[id] ?? null);

describe("renderTemplate", () => {
  it("substitutes known keys and tolerates whitespace", () => {
    const vars = { "task.title": "Ship it" };
    expect(renderTemplate("{{task.title}}", vars)).toBe("Ship it");
    expect(renderTemplate("{{  task.title  }}", vars)).toBe("Ship it");
  });

  it("leaves unknown placeholders verbatim so typos are visible", () => {
    expect(renderTemplate("hi {{task.nope}}", { "task.title": "x" })).toBe("hi {{task.nope}}");
  });

  it("substitutes every occurrence", () => {
    expect(renderTemplate("{{a}}-{{a}}", { a: "1" })).toBe("1-1");
  });

  it("does not re-scan substituted values", () => {
    expect(renderTemplate("{{a}}", { a: "{{a}}" })).toBe("{{a}}");
  });

  it("passes non-template strings through untouched", () => {
    expect(renderTemplate("Publish", {})).toBe("Publish");
  });
});

describe("buildVars", () => {
  it("exposes the documented variable set", () => {
    const vars = buildVars(view());
    expect(Object.keys(vars).sort()).toEqual([
      "list.name",
      "space.name",
      "task.assignee",
      "task.description",
      "task.dueDate",
      "task.status",
      "task.title",
      "task.url",
    ]);
  });

  it("renders the full documented template surface", () => {
    const facts = makeFacts({
      task: makeTask({
        id: "tk_abc",
        title: "Write the launch article",
        statusId: "st_review",
        dueDate: Date.UTC(2026, 6, 27, 15, 0, 0),
        description: "draft one",
      }),
      assignee: { id: "us_bob", name: "Bob", email: "bob@example.com" },
    });
    const out = render(
      "{{task.title}} | {{task.status}} | {{task.url}} | {{task.assignee}} | " +
        "{{task.dueDate}} | {{task.description}} | {{list.name}} | {{space.name}}",
      view(facts)
    );
    expect(out).toBe(
      "Write the launch article | IN REVIEW | https://flow.example.com/t/tk_abc | " +
        "Bob | 2026-07-27 | draft one | Content Cycle | Marketing"
    );
  });

  it("swaps {{task.assignee}} to the email address for recipient lists", () => {
    const facts = makeFacts({
      assignee: { id: "us_bob", name: "Bob", email: "bob@example.com" },
    });
    expect(render("{{task.assignee}}", view(facts), "email")).toBe("bob@example.com");
    expect(render("{{task.assignee}}", view(facts), "name")).toBe("Bob");
  });

  it("renders an unassigned task's assignee as empty", () => {
    expect(render("[{{task.assignee}}]", view())).toBe("[]");
  });
});

describe("formatDueDate / taskUrl", () => {
  it("formats epoch ms as a UTC date and null as empty", () => {
    expect(formatDueDate(Date.UTC(2026, 0, 2))).toBe("2026-01-02");
    expect(formatDueDate(null)).toBe("");
  });

  it("builds /t/:id urls", () => {
    expect(taskUrl(HOSTNAME, "tk_9")).toBe("https://flow.example.com/t/tk_9");
  });
});

describe("buildTaskView derived fields", () => {
  it("derives added tags from the previous tag list, case-insensitively", () => {
    const facts = makeFacts({ task: makeTask({ tags: ["QA", "urgent"] }) });
    const v = buildTaskView(
      facts,
      taskDelta({ tags: ["QA", "urgent"] }, { tags: ["urgent"] }),
      HOSTNAME,
      () => null
    );
    expect(v.addedTags).toEqual(["QA"]);
  });

  it("treats every tag on a freshly created task as added", () => {
    const facts = makeFacts({ task: makeTask({ tags: ["qa"] }) });
    const v = buildTaskView(facts, taskDelta(null, null, "create"), HOSTNAME, () => null);
    expect(v.addedTags).toEqual(["qa"]);
  });

  it("resolves the previous status name from prev.statusId", () => {
    const facts = makeFacts({ task: makeTask({ statusId: "st_sent" }) });
    const v = buildTaskView(
      facts,
      taskDelta({ statusId: "st_sent" }, { statusId: "st_editing" }),
      HOSTNAME,
      (id) => STATUS_NAMES[id] ?? null
    );
    expect(v.prevStatusName).toBe("EDITING");
    expect(v.statusName).toBe("SENT TO CLIENT");
  });
});
