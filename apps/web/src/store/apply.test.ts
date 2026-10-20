import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Delta, List, Subtask, Task, TaskDetail } from "@flow/shared";

vi.mock("../lib/api.js", () => ({
  api: { taskDetail: vi.fn() },
}));

import { api } from "../lib/api.js";
import { applyDeltas, hydrate } from "./apply.js";
import { comments, getSubtask, lists, statusById, subtasks, taskIndex } from "./state.js";

const taskDetail = vi.mocked(api.taskDetail);

const LIST: List = {
  id: "ls_1",
  spaceId: "sp_1",
  name: "Printing",
  position: 0,
  archived: false,
  inboundToken: null,
  createdAt: 0,
  statuses: [
    { id: "st_open", name: "To Do", color: "#777", type: "open", position: 0 },
    { id: "st_done", name: "Done", color: "#0a0", type: "closed", position: 1 },
  ],
};

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    listId: LIST.id,
    title: `Task ${id}`,
    description: "",
    statusId: "st_open",
    assigneeId: null,
    assignedBy: null,
    assignedAt: null,
    priority: null,
    dueDate: null,
    startDate: null,
    snoozedUntil: null,
    blockedNote: null,
    tags: [],
    position: 1,
    createdBy: "us_1",
    createdAt: 1,
    updatedAt: 1,
    closedAt: null,
    clickupId: null,
    ...patch,
  };
}

function subtask(id: string, taskId: string, patch: Partial<Subtask> = {}): Subtask {
  return {
    id,
    taskId,
    title: `Subtask ${id}`,
    done: false,
    assigneeId: null,
    assignedBy: null,
    assignedAt: null,
    dueDate: null,
    note: null,
    position: 1,
    createdAt: 1,
    ...patch,
  };
}

function detail(t: Task, extra: Partial<TaskDetail> = {}): TaskDetail {
  return { task: t, subtasks: [], comments: [], attachments: [], ...extra };
}

let seq = 10;
function delta(
  entity: Delta["entity"],
  op: Delta["op"],
  id: string,
  data: Record<string, unknown> | null
): Delta {
  return { seq: ++seq, entity, op, id, data, actorUserId: "us_2", at: 0 };
}

/** Let the background fetch and its `.then` chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  taskDetail.mockReset();
  seq = 10;
  const { description: _d, startDate: _s, createdBy: _c, closedAt: _a, clickupId: _k, ...known } =
    task("tk_known");
  hydrate({
    seq,
    spaces: [],
    lists: [LIST],
    tasks: [{ ...known, hasDescription: false }],
    subtasks: [subtask("sb_known", "tk_known")],
    users: [],
    automationRules: [],
  });
});

afterEach(() => {
  vi.clearAllTimers();
});

describe("task deltas", () => {
  it("inserts a task on create", () => {
    applyDeltas([delta("task", "create", "tk_new", { ...task("tk_new") })]);
    expect(taskIndex.get("tk_new")?.title).toBe("Task tk_new");
    expect(taskDetail).not.toHaveBeenCalled();
  });

  it("merges an update into a task it holds", () => {
    applyDeltas([delta("task", "update", "tk_known", { statusId: "st_done", updatedAt: 5 })]);
    const t = taskIndex.get("tk_known");
    expect(t?.statusId).toBe("st_done");
    expect(t?.title).toBe("Task tk_known");
    expect(t?.listId).toBe(LIST.id);
    expect(taskDetail).not.toHaveBeenCalled();
  });

  it("never inserts a partial row for an update to an unknown id", async () => {
    taskDetail.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
    applyDeltas([delta("task", "update", "tk_old", { statusId: "st_open", updatedAt: 5 })]);
    expect(taskIndex.has("tk_old")).toBe(false);
    await settle();
    // A 404/403 (private or gone) is swallowed and still inserts nothing.
    expect(taskIndex.has("tk_old")).toBe(false);
    expect(taskDetail).toHaveBeenCalledWith("tk_old", { authRedirect: false });
  });

  it("fetches an unknown task whole and replays updates that raced the fetch", async () => {
    let resolve!: (d: TaskDetail) => void;
    taskDetail.mockReturnValue(new Promise((r) => (resolve = r)));

    applyDeltas([delta("task", "update", "tk_old", { statusId: "st_open", updatedAt: 5 })]);
    applyDeltas([delta("task", "update", "tk_old", { title: "Renamed", updatedAt: 6 })]);
    // One fetch per id, however many updates arrive while it is out.
    expect(taskDetail).toHaveBeenCalledTimes(1);
    expect(taskIndex.has("tk_old")).toBe(false);

    // The server answered from before the rename landed.
    resolve(
      detail(task("tk_old", { title: "Original", statusId: "st_open", updatedAt: 5 }), {
        subtasks: [subtask("sb_old", "tk_old")],
      })
    );
    await settle();

    const t = taskIndex.get("tk_old");
    expect(t?.title).toBe("Renamed");
    expect(t?.listId).toBe(LIST.id);
    expect(t?.updatedAt).toBe(6);
    expect(subtasks.value.get("tk_old")?.map((s) => s.id)).toEqual(["sb_old"]);
    expect(comments.value.get("tk_old")).toEqual([]);
  });

  it("drops the fetched task when it was deleted while the fetch was out", async () => {
    let resolve!: (d: TaskDetail) => void;
    taskDetail.mockReturnValue(new Promise((r) => (resolve = r)));
    applyDeltas([delta("task", "update", "tk_old", { statusId: "st_done" })]);
    applyDeltas([delta("task", "delete", "tk_old", null)]);
    resolve(detail(task("tk_old")));
    await settle();
    expect(taskIndex.has("tk_old")).toBe(false);
  });

  it("runs at most four fetches at once and starts the next as one finishes", async () => {
    const resolvers = new Map<string, (d: TaskDetail) => void>();
    taskDetail.mockImplementation((id: string) => new Promise((r) => resolvers.set(id, r)));
    const ids = ["tk_a", "tk_b", "tk_c", "tk_d", "tk_e", "tk_f"];
    applyDeltas(ids.map((id) => delta("task", "update", id, { title: "x" })));
    expect(taskDetail).toHaveBeenCalledTimes(4);

    resolvers.get("tk_a")!(detail(task("tk_a")));
    await settle();
    expect(taskDetail).toHaveBeenCalledTimes(5);

    for (const id of ids) resolvers.get(id)?.(detail(task(id)));
    await settle();
    await settle();
    expect(taskDetail).toHaveBeenCalledTimes(6);
    for (const id of ids) resolvers.get(id)?.(detail(task(id)));
    await settle();
    expect(ids.every((id) => taskIndex.has(id))).toBe(true);
  });

  it("discards an answer to a fetch that a fresh snapshot superseded", async () => {
    let resolve!: (d: TaskDetail) => void;
    taskDetail.mockReturnValue(new Promise((r) => (resolve = r)));
    applyDeltas([delta("task", "update", "tk_old", { statusId: "st_open" })]);
    // A resync snapshot lands (say it just revoked access to tk_old's space).
    hydrate({ seq: 50, spaces: [], lists: [LIST], tasks: [], subtasks: [], users: [], automationRules: [] });
    resolve(detail(task("tk_old")));
    await settle();
    expect(taskIndex.has("tk_old")).toBe(false);
  });

  it("drops a task still closed beyond the snapshot window, but adopts one reopened", async () => {
    const longAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    taskDetail.mockImplementation(async (id: string) =>
      detail(task(id, { statusId: "st_done", closedAt: longAgo }))
    );
    applyDeltas([delta("task", "update", "tk_archived", { tags: ["x"] })]);
    await settle();
    expect(taskIndex.has("tk_archived")).toBe(false);

    applyDeltas([delta("task", "update", "tk_reopened", { statusId: "st_open", closedAt: null })]);
    await settle();
    expect(taskIndex.get("tk_reopened")?.statusId).toBe("st_open");
  });

  it("ignores a fetched answer that is not a whole task", async () => {
    taskDetail.mockResolvedValue({ task: { id: "tk_old" } } as unknown as TaskDetail);
    applyDeltas([delta("task", "update", "tk_old", { statusId: "st_done" })]);
    await settle();
    expect(taskIndex.has("tk_old")).toBe(false);
  });
});

describe("subtask deltas", () => {
  it("inserts on create", () => {
    applyDeltas([delta("subtask", "create", "sb_new", { ...subtask("sb_new", "tk_known") })]);
    expect(getSubtask("sb_new")?.title).toBe("Subtask sb_new");
  });

  it("merges an update into a subtask it holds", () => {
    applyDeltas([delta("subtask", "update", "sb_known", { done: true })]);
    expect(getSubtask("sb_known")).toMatchObject({ done: true, title: "Subtask sb_known" });
  });

  it("ignores an update for an unknown id", () => {
    applyDeltas([delta("subtask", "update", "sb_ghost", { done: true })]);
    expect(getSubtask("sb_ghost")).toBeUndefined();
  });
});

describe("row deltas (lists and friends)", () => {
  it("ignores an update for an unknown list instead of inserting one with no statuses", () => {
    applyDeltas([delta("list", "update", "ls_ghost", { name: "Renamed" })]);
    expect(lists.value.map((l) => l.id)).toEqual([LIST.id]);
    // The derived status map is what used to throw on a statuses-less list.
    expect(() => statusById.value).not.toThrow();
  });

  it("inserts a list on create and merges a later update", () => {
    const created: List = { ...LIST, id: "ls_2", name: "Second", position: 1 };
    applyDeltas([delta("list", "create", "ls_2", { ...created })]);
    applyDeltas([delta("list", "update", "ls_2", { name: "Renamed" })]);
    const l = lists.value.find((x) => x.id === "ls_2");
    expect(l?.name).toBe("Renamed");
    expect(l?.statuses).toHaveLength(2);
  });
});
