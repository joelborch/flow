import { describe, expect, it } from "vitest";
import { List, Space, Status, Subtask, Task, User, Comment } from "@flow/shared";
import {
  buildDescription,
  buildStatuses,
  commentBody,
  listNaming,
  mapPriority,
  mapStatusType,
  pickAssignee,
  resolveStatusId,
  rewriteClickUpLinks,
  transform,
  type FolderInfo,
  type TransformInput,
  type TransformOptions,
} from "../src/transform.js";
import { IdMap, deriveId } from "../src/idmap.js";
import { WarnTally } from "../src/log.js";
import { makeScope } from "../src/scope.js";
import { isTaskInScope, selectInScope } from "../src/scope.js";
import type { CuTask, CuUser } from "../src/clickup-types.js";
import {
  cuStatus,
  listByName,
  realAttachments,
  realComments,
  realFolders,
  realLists,
  realSpaces,
  realTasks,
  realTeam,
  synthFolder,
  synthList,
  taskByReason,
} from "./fixtures.js";

function opts(over: Partial<TransformOptions> = {}): TransformOptions {
  return {
    idMap: new IdMap({ version: 1, importedAt: 1_700_000_000_000, entries: {} }),
    scope: makeScope(120, Date.parse("2026-07-27T12:00:00Z")),
    warnings: new WarnTally(),
    ...over,
  };
}

function fullInput(): TransformInput {
  return {
    team: realTeam(),
    spaces: realSpaces(),
    foldersBySpace: realFolders(),
    lists: realLists(),
    tasks: realTasks(),
    commentsByTask: realComments(),
    attachmentsByTask: realAttachments(),
  };
}

// ---------------------------------------------------------------------------
describe("status type mapping", () => {
  it("maps ClickUp's four types onto Flow's three", () => {
    expect(mapStatusType("open")).toBe("open");
    expect(mapStatusType("closed")).toBe("closed");
    // ClickUp has a separate "done" type; Flow has no equivalent, so it is
    // terminal like closed.
    expect(mapStatusType("done")).toBe("closed");
    expect(mapStatusType("custom")).toBe("custom");
    expect(mapStatusType("OPEN")).toBe("open");
    expect(mapStatusType("anything-else")).toBe("custom");
  });

  it("preserves order and colour, and puts open first / closed last", () => {
    const l = listByName("Globex CRM");
    const statuses = buildStatuses(l.statuses ?? [], opts(), "Globex CRM");

    expect(statuses.length).toBe((l.statuses ?? []).length);
    expect(statuses[0]!.type).toBe("open");
    expect(statuses[statuses.length - 1]!.type).toBe("closed");
    expect(statuses.filter((s) => s.type === "open")).toHaveLength(1);
    expect(statuses.filter((s) => s.type === "closed")).toHaveLength(1);
    expect(statuses.map((s) => s.position)).toEqual(statuses.map((_, i) => i));

    const source = [...(l.statuses ?? [])].sort((a, b) => a.orderindex - b.orderindex);
    expect(statuses.map((s) => s.name)).toEqual(source.map((s) => s.status));
    expect(statuses.map((s) => s.color)).toEqual(source.map((s) => s.color));
    for (const s of statuses) expect(Status.safeParse(s).success).toBe(true);
  });

  it("keeps every real list to exactly one open and one closed", () => {
    for (const l of realLists()) {
      const statuses = buildStatuses(l.statuses ?? [], opts(), l.name);
      expect(statuses.filter((s) => s.type === "open"), l.name).toHaveLength(1);
      expect(statuses.filter((s) => s.type === "closed"), l.name).toHaveLength(1);
      expect(statuses.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("demotes extra open/closed statuses to custom rather than dropping them", () => {
    const warnings = new WarnTally();
    const statuses = buildStatuses(
      [
        cuStatus("backlog", "open", 0),
        cuStatus("triaged", "open", 1),
        cuStatus("shipped", "closed", 2),
        cuStatus("archived", "closed", 3),
      ],
      opts({ warnings }),
      "Multi"
    );
    expect(statuses.map((s) => [s.name, s.type])).toEqual([
      ["backlog", "open"],
      ["triaged", "custom"],
      ["shipped", "custom"],
      ["archived", "closed"],
    ]);
    const kinds = warnings.entries.map((e) => e.kind);
    expect(kinds).toContain("extra open status demoted to custom");
    expect(kinds).toContain("extra closed status demoted to custom");
  });

  it("synthesizes missing ends so the list satisfies the min(2) contract", () => {
    const onlyCustom = buildStatuses([cuStatus("thinking", "custom", 0)], opts(), "Odd");
    expect(onlyCustom.map((s) => s.type)).toEqual(["open", "custom", "closed"]);
    expect(onlyCustom[0]!.name).toBe("To Do");
    expect(onlyCustom[2]!.name).toBe("Done");

    const empty = buildStatuses([], opts(), "Empty");
    expect(empty.map((s) => s.type)).toEqual(["open", "closed"]);
    expect(List.shape.statuses.safeParse(empty).success).toBe(true);
  });

  it("reorders a list whose closed status is not last in ClickUp", () => {
    const statuses = buildStatuses(
      [cuStatus("to do", "open", 0), cuStatus("done", "closed", 1), cuStatus("qa", "custom", 2)],
      opts(),
      "Reorder"
    );
    expect(statuses.map((s) => s.name)).toEqual(["to do", "qa", "done"]);
  });
});

// ---------------------------------------------------------------------------
describe("folder collapsing", () => {
  const folder = (over: Partial<FolderInfo> = {}): FolderInfo => ({
    id: "f1",
    name: "Production",
    hidden: false,
    archived: false,
    listCount: 2,
    ...over,
  });

  it('prefixes "Folder / List" for a real, live, non-empty folder', () => {
    const r = listNaming(synthList({ id: "l1", name: "Social & Distribution" }), folder());
    expect(r).toEqual({ skip: false, name: "Production / Social & Distribution", folderPrefixed: true });
  });

  it("does not prefix ClickUp's hidden folder wrapper", () => {
    // ClickUp invents a folder named literally "hidden" for every list that
    // sits directly in a space — most lists in a typical workspace do.
    const r = listNaming(synthList({ id: "l2", name: "Ongoing tasks" }), folder({ name: "hidden", hidden: true }));
    expect(r).toEqual({ skip: false, name: "Ongoing tasks", folderPrefixed: false });
  });

  it("skips lists in an archived folder entirely", () => {
    const r = listNaming(synthList({ id: "l3" }), folder({ archived: true, name: "Old Q3" }));
    expect(r.skip).toBe(true);
    if (r.skip) expect(r.reason).toContain("archived");
  });

  it("does not prefix when the folder has no live lists", () => {
    const r = listNaming(synthList({ id: "l4", name: "Orphan" }), folder({ listCount: 0 }));
    expect(r).toEqual({ skip: false, name: "Orphan", folderPrefixed: false });
  });

  it("leaves a folderless list alone", () => {
    const r = listNaming(synthList({ id: "l5", name: "Inbox" }), null);
    expect(r).toEqual({ skip: false, name: "Inbox", folderPrefixed: false });
  });

  it("collapses real fixture lists the way the live hierarchy implies", () => {
    const { bundle } = transform(fullInput(), opts());
    const names = bundle.lists.map((l) => l.name);
    // "Social & Distribution" lives in the real, live "Production" folder.
    expect(names).toContain("Production / Social & Distribution");
    expect(names).toContain("Production / Content Refreshes");
    // These sit directly in their space behind a hidden wrapper.
    expect(names).toContain("Ongoing tasks");
    expect(names).toContain("Globex CRM");
    expect(names.some((n) => n.startsWith("hidden /"))).toBe(false);
  });

  it("drops the tasks of a skipped archived-folder list", () => {
    const input = fullInput();
    const target = input.lists.find((l) => l.name === "Globex CRM")!;
    target.folder = { id: "arch1", name: "Retired", hidden: false, archived: true };
    input.foldersBySpace["90000000005"] = [
      synthFolder({ id: "arch1", name: "Retired", archived: true, lists: [{ ...target }] }),
    ];

    const { bundle, skippedLists } = transform(input, opts());
    expect(skippedLists.has(target.id)).toBe(true);
    expect(bundle.lists.some((l) => l.name.includes("Globex CRM"))).toBe(false);
    expect(bundle.tasks.some((t) => t.clickupId === "9a1cust01")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("subtask done-mapping", () => {
  it("is done iff the ClickUp subtask's own status type is terminal", () => {
    const { bundle } = transform(fullInput(), opts());
    const parent = bundle.tasks.find((t) => t.clickupId === "9a1mix000");
    expect(parent).toBeDefined();

    const kids = bundle.subtasks.filter((s) => s.taskId === parent!.id);
    // Fixture parent has 3 subtasks in "in progress" (custom) and 2 in
    // "complete" (closed).
    expect(kids).toHaveLength(5);
    expect(kids.filter((k) => k.done)).toHaveLength(2);
    expect(kids.filter((k) => !k.done)).toHaveLength(3);

    const source = realTasks().filter((t) => t.parent === "9a1mix000");
    for (const s of source) {
      const mapped = kids.find((k) => k.title === s.name.trim());
      expect(mapped, s.name).toBeDefined();
      expect(mapped!.done, `${s.name} (${s.status.status}/${s.status.type})`).toBe(
        s.status.type === "closed"
      );
    }
  });

  it("carries title, assignee and due date but never a status", () => {
    const { bundle } = transform(fullInput(), opts());
    for (const s of bundle.subtasks) {
      expect(Subtask.safeParse(s).success).toBe(true);
      expect(s.title.length).toBeGreaterThan(0);
      expect(s).not.toHaveProperty("statusId");
    }
    const withAssignee = bundle.subtasks.filter((s) => s.assigneeId !== null);
    expect(withAssignee.length).toBeGreaterThan(0);
  });

  it("emits a subtask as a Subtask and never also as a Task", () => {
    const o = opts();
    const { bundle } = transform(fullInput(), o);
    const subtaskCuIds = new Set(realTasks().filter((t) => t.parent).map((t) => t.id));
    for (const t of bundle.tasks) {
      expect(subtaskCuIds.has(t.clickupId ?? ""), `${t.clickupId} leaked into tasks`).toBe(false);
    }
    // 9 subtasks in the fixture, but one (9a1old001) sits under a parent that
    // also closed years ago, so the scope filter drops the pair together.
    const keep = selectInScope(realTasks(), o.scope);
    expect(bundle.subtasks.length).toBe(
      realTasks().filter((t) => t.parent && keep.has(t.id)).length
    );
    expect(bundle.subtasks).toHaveLength(8);
    expect(bundle.subtasks.some((s) => s.title === taskByReason("closed-long-ago-out-of-scope").name)).toBe(
      false
    );
  });

  it("numbers subtask positions per parent starting at 0", () => {
    const { bundle } = transform(fullInput(), opts());
    const byParent = new Map<string, number[]>();
    for (const s of bundle.subtasks) {
      byParent.set(s.taskId, [...(byParent.get(s.taskId) ?? []), s.position]);
    }
    for (const positions of byParent.values()) {
      expect([...positions].sort((a, b) => a - b)).toEqual(positions.map((_, i) => i));
    }
  });

  it("throws rather than silently flattening two-level nesting", () => {
    const input = fullInput();
    const grandchild = { ...input.tasks.find((t) => t.parent === "9a1mix000")! };
    const deeper: CuTask = { ...grandchild, id: "deep1", parent: grandchild.id, top_level_parent: "9a1mix000" };
    input.tasks = [...input.tasks, deeper];
    expect(() => transform(input, opts())).toThrow(/nesting deeper than one level/);
  });

  it("confirms the fixture workspace is exactly one level deep", () => {
    const tasks = realTasks();
    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    for (const t of tasks) {
      if (!t.parent) continue;
      expect(byId.get(t.parent)?.parent ?? null, `${t.id} has a grandparent`).toBeNull();
      expect(t.top_level_parent).toBe(t.parent);
    }
  });
});

// ---------------------------------------------------------------------------
describe("link rewriting", () => {
  const resolve = (id: string): string | null => (id === "9a1gone404" ? "tk_abc123def456" : null);

  it("rewrites a bare task link", () => {
    const r = rewriteClickUpLinks("see https://app.clickup.com/t/9a1gone404 for context", resolve);
    expect(r.text).toBe("see /t/tk_abc123def456 for context");
    expect(r.rewritten).toBe(1);
  });

  it("rewrites the target inside a markdown link and keeps the label", () => {
    const r = rewriteClickUpLinks("[the old bug](https://app.clickup.com/t/9a1gone404)", resolve);
    expect(r.text).toBe("[the old bug](/t/tk_abc123def456)");
  });

  it("handles the team-scoped link form", () => {
    const r = rewriteClickUpLinks("https://app.clickup.com/t/9999999/9a1gone404", resolve);
    expect(r.text).toBe("/t/tk_abc123def456");
    expect(r.rewritten).toBe(1);
  });

  it("strips query strings and trailing path segments off the old link", () => {
    const r = rewriteClickUpLinks("https://app.clickup.com/t/9a1gone404?block=abc", resolve);
    expect(r.text).toBe("/t/tk_abc123def456");
  });

  it("leaves unknown ids untouched rather than making a dead internal link", () => {
    const src = "https://app.clickup.com/t/doesnotexist";
    const r = rewriteClickUpLinks(src, resolve);
    expect(r.text).toBe(src);
    expect(r.rewritten).toBe(0);
    expect(r.unresolved).toEqual(["doesnotexist"]);
  });

  it("rewrites several links in one body and honours a custom prefix", () => {
    const r = rewriteClickUpLinks(
      "a https://app.clickup.com/t/9a1gone404 b https://app.clickup.com/t/9a1gone404",
      resolve,
      "https://flow.example.com/t/"
    );
    expect(r.rewritten).toBe(2);
    expect(r.text).toBe(
      "a https://flow.example.com/t/tk_abc123def456 b https://flow.example.com/t/tk_abc123def456"
    );
  });

  it("rewrites the real cross-references found in the fixture descriptions", () => {
    // 9a1link001 and 9a1link002 both link to 9a1gone404, which is NOT in the
    // fixture set — so with only the fixtures loaded both stay unresolved.
    const { bundle, rewrite } = transform(fullInput(), opts());
    expect(rewrite.unresolved).toContain("9a1gone404");
    const linker = bundle.tasks.find((t) => t.clickupId === "9a1link001");
    expect(linker!.description).toContain("app.clickup.com/t/9a1gone404");

    // Once the target is in scope, both descriptions point at the Flow task.
    const input = fullInput();
    const seed = input.tasks.find((t) => !t.parent)!;
    input.tasks = [
      ...input.tasks,
      { ...seed, id: "9a1gone404", parent: null, top_level_parent: null, name: "The linked task" },
    ];
    const second = transform(input, opts());
    const target = second.bundle.tasks.find((t) => t.clickupId === "9a1gone404")!;
    const rewritten = second.bundle.tasks.find((t) => t.clickupId === "9a1link001")!;
    expect(second.rewrite.links).toBeGreaterThanOrEqual(2);
    expect(rewritten.description).toContain(`/t/${target.id}`);
    expect(rewritten.description).not.toContain("app.clickup.com/t/9a1gone404");
  });

  it("rewrites links inside comment bodies too", () => {
    const input = fullInput();
    const cs = input.commentsByTask["9a1recent1"]!;
    cs[0] = { ...cs[0]!, comment_text: "dupe of https://app.clickup.com/t/9a1cust01" };
    const { bundle } = transform(input, opts());
    const target = bundle.tasks.find((t) => t.clickupId === "9a1cust01")!;
    const comment = bundle.comments.find((c) => c.body.startsWith("dupe of"))!;
    expect(comment.body).toBe(`dupe of /t/${target.id}`);
  });
});

// ---------------------------------------------------------------------------
describe("single assignee", () => {
  it("keeps the first assignee and warns about the rest", () => {
    const warnings = new WarnTally();
    const users = [
      { id: 1, username: "A", email: "a@x.com" },
      { id: 2, username: "B", email: "b@x.com" },
    ] satisfies CuUser[];
    expect(pickAssignee(users, opts({ warnings }), "t1")?.id).toBe(1);
    expect(warnings.entries.map((e) => e.kind)).toContain("multi-assignee task truncated to first");
  });

  it("maps an unassigned ClickUp task to null, not a placeholder user", () => {
    expect(pickAssignee([], opts(), "t1")).toBeNull();
    const { bundle } = transform(fullInput(), opts());
    const unassigned = bundle.tasks.filter((t) => t.assigneeId === null);
    expect(unassigned.length).toBeGreaterThan(0);
  });

  it("truncates the two real multi-assignee tasks to their first assignee", () => {
    const multi = realTasks().filter((t) => t.assignees.length > 1);
    expect(multi.length).toBe(2);

    const { bundle } = transform(fullInput(), opts());
    for (const src of multi) {
      const flow =
        bundle.tasks.find((t) => t.clickupId === src.id) ??
        bundle.subtasks.find((s) => s.title === src.name.trim());
      expect(flow, src.id).toBeDefined();
      const expected = new IdMap({ version: 1, importedAt: 1_700_000_000_000, entries: {} }).id(
        "user",
        String(src.assignees[0]!.id)
      );
      expect(flow!.assigneeId).toBe(expected);
    }
  });

  it("emits exactly one assigneeId field, never an array", () => {
    const { bundle } = transform(fullInput(), opts());
    for (const t of bundle.tasks) {
      expect(Array.isArray(t.assigneeId)).toBe(false);
      expect(Task.safeParse(t).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe("descriptions and custom fields", () => {
  it("prefers markdown_description over the stripped plain text", () => {
    const task: CuTask = {
      ...taskByReason("status-type-open"),
      markdown_description: "## Heading\n\n**bold**",
      description: "Heading bold",
      custom_fields: [],
    };
    expect(buildDescription(task)).toBe("## Heading\n\n**bold**");
  });

  it("falls back to plain description when markdown is absent", () => {
    const task: CuTask = {
      ...taskByReason("status-type-open"),
      markdown_description: null,
      description: "just text",
      custom_fields: [],
    };
    expect(buildDescription(task)).toBe("just text");
  });

  it('appends the "Google Doc" custom field as a link line', () => {
    const src = taskByReason("google-doc-custom-field");
    const url = src.custom_fields.find((f) => f.name === "Google Doc")!.value as string;
    // Strip the templated "Google Doc Link: <url>" line these tasks carry so
    // the append path is what is under test here.
    const body = buildDescription({
      ...src,
      markdown_description: "## Brief\n\nWrite the thing.",
      description: "Brief Write the thing.",
    });
    expect(body).toBe(`## Brief\n\nWrite the thing.\n\n📄 [Google Doc](${url})`);
    expect(body.trimEnd().endsWith(")")).toBe(true);
  });

  it("does not append a second copy when the template already inlines the URL", () => {
    // QUIRK preserved from the source workspace: every task with a non-empty
    // "Google Doc" field is a content-template task whose body already ends in
    // "Google Doc Link: <same url>". Appending would print the URL twice, so
    // the dedup guard suppresses it for every one of them.
    const src = taskByReason("google-doc-custom-field");
    const url = src.custom_fields.find((f) => f.name === "Google Doc")!.value as string;
    const body = buildDescription(src);
    expect(body).toContain(url);
    expect(body).not.toContain("📄");
    expect(body.split(url).length - 1).toBe(1);
  });

  it("appends nothing when the Google Doc field is present but empty", () => {
    const body = buildDescription(taskByReason("google-doc-field-empty"));
    expect(body).not.toContain("📄");
  });

  it("produces a Google Doc line even for a task with no description at all", () => {
    const task: CuTask = {
      ...taskByReason("empty-description"),
      markdown_description: "",
      description: "",
      text_content: "",
      custom_fields: [
        { id: "f1", name: "Google Doc", type: "text", value: "https://docs.google.com/document/d/xyz/edit" },
      ],
    };
    expect(buildDescription(task)).toBe("📄 [Google Doc](https://docs.google.com/document/d/xyz/edit)");
  });

  it("does not duplicate the link when the body already contains the URL", () => {
    const url = "https://docs.google.com/document/d/xyz/edit";
    const task: CuTask = {
      ...taskByReason("status-type-open"),
      markdown_description: `see ${url}`,
      custom_fields: [{ id: "f1", name: "Google Doc", type: "text", value: url }],
    };
    expect(buildDescription(task)).toBe(`see ${url}`);
  });
});

// ---------------------------------------------------------------------------
describe("tasks", () => {
  it("maps priority names straight across and drops unknown ones", () => {
    expect(mapPriority({ id: "1", priority: "urgent" })).toBe("urgent");
    expect(mapPriority({ id: "2", priority: "High" })).toBe("high");
    expect(mapPriority({ id: "3", priority: "normal" })).toBe("normal");
    expect(mapPriority({ id: "4", priority: "low" })).toBe("low");
    expect(mapPriority(null)).toBeNull();
    const warnings = new WarnTally();
    expect(mapPriority({ id: "9", priority: "blocker" }, opts({ warnings }))).toBeNull();
    expect(warnings.entries.map((e) => e.kind)).toContain("unknown priority dropped");
  });

  it("flattens tags to bare names", () => {
    const { bundle } = transform(fullInput(), opts());
    const tagged = bundle.tasks.find((t) => t.clickupId === "9a1tags01");
    expect(tagged!.tags).toEqual(["template-copy"]);
    for (const t of bundle.tasks) for (const tag of t.tags) expect(typeof tag).toBe("string");
  });

  it("sets clickupId on every task for provenance and idempotency", () => {
    const { bundle } = transform(fullInput(), opts());
    for (const t of bundle.tasks) expect(t.clickupId).toMatch(/^[0-9a-z]+$/i);
    expect(new Set(bundle.tasks.map((t) => t.clickupId)).size).toBe(bundle.tasks.length);
  });

  it("sets closedAt only for tasks in a terminal status", () => {
    const { bundle } = transform(fullInput(), opts());
    const src = new Map(realTasks().map((t) => [t.id, t] as const));
    for (const t of bundle.tasks) {
      const cu = src.get(t.clickupId!)!;
      if (cu.status.type === "closed") expect(t.closedAt, t.clickupId!).not.toBeNull();
      else expect(t.closedAt, t.clickupId!).toBeNull();
    }
  });

  it("parses ClickUp's string timestamps into numbers", () => {
    const { bundle } = transform(fullInput(), opts());
    for (const t of bundle.tasks) {
      expect(typeof t.createdAt).toBe("number");
      expect(typeof t.updatedAt).toBe("number");
      if (t.dueDate !== null) expect(Number.isInteger(t.dueDate)).toBe(true);
    }
    const withDue = bundle.tasks.filter((t) => t.dueDate !== null);
    expect(withDue.length).toBeGreaterThan(0);
  });

  it("falls back through id, name and type when a status is not in the list set", () => {
    const l = listByName("Globex CRM");
    const o = opts();
    const statuses = buildStatuses(l.statuses ?? [], o, "Globex CRM");
    const task = taskByReason("status-type-custom");

    // Name match, even though the derived status id was never registered.
    expect(resolveStatusId(task, statuses, o)).toBe(
      statuses.find((s) => s.name === task.status.status)!.id
    );

    // Nothing matches by id or name -> fall back to the same mapped type.
    const renamed: CuTask = {
      ...task,
      status: { ...task.status, id: "gone", status: "renamed-away", type: "custom" },
    };
    const resolved = statuses.find((s) => s.id === resolveStatusId(renamed, statuses, o))!;
    expect(resolved.type).toBe("custom");
    expect(o.warnings!.entries.map((e) => e.kind)).toContain("task status not in list status set");
  });
});

// ---------------------------------------------------------------------------
describe("users", () => {
  it("marks non-members as deactivated but keeps them referenceable", () => {
    const { bundle } = transform(fullInput(), opts());
    const memberIds = new Set(realTeam().members.map((m) => m.user.id));
    const nonMemberEmails = new Set(
      realTasks()
        .flatMap((t) => [t.creator, ...t.assignees])
        .filter((u) => !memberIds.has(u.id))
        .map((u) => u.email?.toLowerCase())
    );
    expect(nonMemberEmails.size).toBeGreaterThan(0);
    for (const email of nonMemberEmails) {
      const u = bundle.users.find((x) => x.email === email);
      expect(u, email).toBeDefined();
      expect(u!.deactivated, email).toBe(true);
    }
    // Assignees still resolve to a real user row.
    const ids = new Set(bundle.users.map((u) => u.id));
    for (const t of bundle.tasks) {
      if (t.assigneeId) expect(ids.has(t.assigneeId)).toBe(true);
      expect(ids.has(t.createdBy)).toBe(true);
    }
  });

  it("defaults the ClickUp team owner to owner and everyone else to member", () => {
    const { bundle } = transform(fullInput(), opts());
    expect(bundle.users.find((u) => u.email === "alice@example.com")!.role).toBe("owner");
    for (const u of bundle.users) {
      if (u.email !== "alice@example.com") expect(u.role, u.email).toBe("member");
      expect(User.safeParse(u).success).toBe(true);
    }
  });

  it("assigns owner and admin from the role-override config", () => {
    const { bundle } = transform(
      fullInput(),
      opts({ roleOverrides: { "alice@example.com": "owner", "bob@example.com": "admin" } })
    );
    expect(bundle.users.find((u) => u.email === "alice@example.com")!.role).toBe("owner");
    expect(bundle.users.find((u) => u.email === "bob@example.com")!.role).toBe("admin");
    for (const u of bundle.users) {
      if (!u.email.startsWith("alice@") && !u.email.startsWith("bob@")) {
        expect(u.role, u.email).toBe("member");
      }
      expect(User.safeParse(u).success).toBe(true);
    }
  });

  it("gives ClickBot and email-less guests a valid synthetic email", () => {
    const input = fullInput();
    input.commentsByTask = {
      "9a1recent1": [
        {
          id: "c-bot",
          comment_text: "automation fired",
          user: { id: -1, username: "ClickBot", email: "clickbot@clickup.com" },
          date: "1784843498487",
        },
      ],
    };
    input.tasks = [
      ...input.tasks,
      {
        ...input.tasks[0]!,
        id: "ghost1",
        parent: null,
        assignees: [{ id: 999, username: null, email: null }],
      },
    ];
    const { bundle } = transform(input, opts());
    const bot = bundle.users.find((u) => u.name.startsWith("ClickBot"))!;
    expect(bot.deactivated).toBe(true);
    const ghost = bundle.users.find((u) => u.email === "clickup-999@import.invalid")!;
    expect(ghost.name).toBe("ClickUp user 999");
    expect(User.safeParse(ghost).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("comments and attachments", () => {
  it("uses comment_text, falling back to the rich-text segments", () => {
    expect(commentBody({ id: "1", comment_text: "hello", user: { id: 1, username: "a", email: "a@x.com" }, date: "1" })).toBe("hello");
    expect(
      commentBody({
        id: "2",
        comment_text: "",
        comment: [{ text: "part one " }, { text: "part two" }],
        user: { id: 1, username: "a", email: "a@x.com" },
        date: "1",
      })
    ).toBe("part one part two");
  });

  it("skips an attachment-only comment that has no importable body", () => {
    const input = fullInput();
    input.commentsByTask = {
      "9a1recent1": [
        { id: "empty1", comment_text: "", comment: [], user: { id: 1000001, username: "Alice Chen", email: "alice@example.com" }, date: "1784811821610" },
        { id: "real1", comment_text: "actual text", user: { id: 1000001, username: "Alice Chen", email: "alice@example.com" }, date: "1784811821611" },
      ],
    };
    const o = opts();
    const { bundle } = transform(input, o);
    expect(bundle.comments.map((c) => c.body)).toEqual(["actual text"]);
    expect(o.warnings!.entries.map((e) => e.kind)).toContain("empty comment skipped");
  });

  it("orders comments oldest first and validates against the contract", () => {
    const { bundle } = transform(fullInput(), opts());
    expect(bundle.comments.length).toBeGreaterThan(0);
    for (let i = 1; i < bundle.comments.length; i++) {
      expect(bundle.comments[i]!.createdAt).toBeGreaterThanOrEqual(bundle.comments[i - 1]!.createdAt);
    }
    for (const c of bundle.comments) expect(Comment.safeParse(c).success).toBe(true);
  });

  it("emits attachment metadata with the ClickUp source URL, not an r2Key", () => {
    const { bundle } = transform(fullInput(), opts());
    expect(bundle.attachments.length).toBeGreaterThan(0);
    const a = bundle.attachments[0]!;
    expect(a.sourceUrl).toMatch(/^https:\/\/t9999999\.p\.clickup-attachments\.com\//);
    expect(a.mimeType).toBe("image/jpeg");
    expect(a.size).toBeGreaterThan(0);
    expect(a).not.toHaveProperty("r2Key");
    const taskIds = new Set(bundle.tasks.map((t) => t.id));
    for (const att of bundle.attachments) expect(taskIds.has(att.taskId)).toBe(true);
  });

  it("drops comments and attachments whose task fell out of scope", () => {
    const input = fullInput();
    input.commentsByTask = { "does-not-exist": [{ id: "c1", comment_text: "orphan", user: { id: 1000001, username: "A", email: "a@x.com" }, date: "1" }] };
    input.attachmentsByTask = { "does-not-exist": [{ id: "a1", date: "1", title: "x.pdf", url: "https://x/y" }] };
    const { bundle } = transform(input, opts());
    expect(bundle.comments).toHaveLength(0);
    expect(bundle.attachments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("scope filter", () => {
  const scope = makeScope(120, Date.parse("2026-07-27T12:00:00Z"));

  it("keeps every task in a non-terminal status regardless of age", () => {
    const old: CuTask = {
      ...taskByReason("status-type-open"),
      date_updated: "1600000000000",
      date_closed: null,
    };
    expect(isTaskInScope(old, scope)).toBe(true);
  });

  it("drops a task closed long before the window", () => {
    expect(isTaskInScope(taskByReason("closed-long-ago-out-of-scope"), scope)).toBe(false);
  });

  it("keeps a task closed inside the window", () => {
    expect(isTaskInScope(taskByReason("closed-recently-in-scope"), scope)).toBe(true);
  });

  it("keeps a stale closed subtask when its parent is in scope", () => {
    const parent = taskByReason("parent-with-mixed-subtasks");
    const staleKid: CuTask = {
      ...realTasks().find((t) => t.parent === parent.id && t.status.type === "closed")!,
      date_closed: "1600000000000",
      date_done: "1600000000000",
      date_updated: "1600000000000",
    };
    expect(isTaskInScope(staleKid, scope)).toBe(false);
    const keep = selectInScope([parent, staleKid], scope);
    // Dropping it would silently rewrite the parent's checklist.
    expect(keep.has(staleKid.id)).toBe(true);
  });

  it("pulls in an out-of-scope parent so an in-scope subtask has a home", () => {
    const parent: CuTask = {
      ...taskByReason("closed-long-ago-out-of-scope"),
      id: "stale-parent",
      parent: null,
    };
    const kid: CuTask = { ...taskByReason("status-type-open"), id: "live-kid", parent: "stale-parent" };
    const keep = selectInScope([parent, kid], scope);
    expect(keep.has("stale-parent")).toBe(true);
    expect(keep.has("live-kid")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("determinism", () => {
  it("derives the same id for the same ClickUp entity every time", () => {
    expect(deriveId("task", "9a1cust01")).toBe(deriveId("task", "9a1cust01"));
    expect(deriveId("task", "9a1cust01")).toMatch(/^tk_[0-9A-Za-z]{12}$/);
    expect(deriveId("task", "9a1cust01")).not.toBe(deriveId("subtask", "9a1cust01"));
    expect(deriveId("space", "1")).toMatch(/^sp_/);
    expect(deriveId("list", "1")).toMatch(/^ls_/);
    expect(deriveId("user", "1")).toMatch(/^us_/);
    expect(deriveId("comment", "1")).toMatch(/^cm_/);
  });

  it("produces byte-identical output across two independent runs", () => {
    const a = transform(fullInput(), opts());
    const b = transform(fullInput(), opts());
    expect(JSON.stringify(b.bundle)).toBe(JSON.stringify(a.bundle));
  });

  it("validates the whole fixture bundle against @flow/shared", () => {
    const { bundle } = transform(fullInput(), opts());
    for (const s of bundle.spaces) expect(Space.safeParse(s).success, s.name).toBe(true);
    for (const l of bundle.lists) expect(List.safeParse(l).success, l.name).toBe(true);
    for (const t of bundle.tasks) expect(Task.safeParse(t).success, t.title).toBe(true);
    for (const s of bundle.subtasks) expect(Subtask.safeParse(s).success, s.title).toBe(true);
    for (const u of bundle.users) expect(User.safeParse(u).success, u.email).toBe(true);
    for (const c of bundle.comments) expect(Comment.safeParse(c).success, c.id).toBe(true);

    // Referential integrity across the bundle.
    const spaceIds = new Set(bundle.spaces.map((s) => s.id));
    const listIds = new Set(bundle.lists.map((l) => l.id));
    const taskIds = new Set(bundle.tasks.map((t) => t.id));
    const userIds = new Set(bundle.users.map((u) => u.id));
    for (const l of bundle.lists) expect(spaceIds.has(l.spaceId), l.name).toBe(true);
    for (const t of bundle.tasks) {
      expect(listIds.has(t.listId), t.title).toBe(true);
      const statuses = bundle.lists.find((l) => l.id === t.listId)!.statuses;
      expect(statuses.some((s) => s.id === t.statusId), t.title).toBe(true);
    }
    for (const s of bundle.subtasks) expect(taskIds.has(s.taskId), s.title).toBe(true);
    for (const c of bundle.comments) {
      expect(taskIds.has(c.taskId)).toBe(true);
      expect(userIds.has(c.authorId)).toBe(true);
    }
  });
});
