import type { List, Subtask } from "@flow/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { lists, subtasks, tasks, type StoreTask } from "../store/index.js";
import { myOpenSubtasks } from "./data.js";

const ME = "us_me0000000000000000";
const OTHER = "us_other000000000000";

const list: List = {
  id: "li_a0000000000000000000",
  spaceId: "sp_a0000000000000000000",
  name: "Inbox",
  position: 1,
  archived: false,
  statuses: [
    { id: "st_open0000000000000000", name: "TO DO", color: "#888", type: "open", position: 1 },
    { id: "st_done0000000000000000", name: "DONE", color: "#4a4", type: "closed", position: 2 },
  ],
} as List;

let n = 0;
function task(over: Partial<StoreTask>): StoreTask {
  n += 1;
  return {
    id: `tk_t${String(n).padStart(19, "0")}`,
    listId: list.id,
    title: `Task ${n}`,
    statusId: "st_open0000000000000000",
    assigneeId: null,
    priority: null,
    dueDate: null,
    snoozedUntil: null,
    blockedNote: null,
    tags: [],
    position: n,
    createdAt: 1000 + n,
    updatedAt: 1000 + n,
    ...over,
  } as StoreTask;
}

function sub(over: Partial<Subtask> & { taskId: string }): Subtask {
  n += 1;
  return {
    id: `sb_s${String(n).padStart(19, "0")}`,
    title: `Step ${n}`,
    done: false,
    assigneeId: ME,
    dueDate: null,
    position: n,
    createdAt: 1000 + n,
    ...over,
  } as Subtask;
}

function seed(taskList: StoreTask[], subtaskList: Subtask[]): void {
  lists.value = [list];
  tasks.value = new Map(taskList.map((t) => [t.id, t]));
  const grouped = new Map<string, Subtask[]>();
  for (const s of subtaskList) {
    const arr = grouped.get(s.taskId);
    if (arr) arr.push(s);
    else grouped.set(s.taskId, [s]);
  }
  subtasks.value = grouped;
}

describe("myOpenSubtasks", () => {
  beforeEach(() => {
    n = 0;
    seed([], []);
  });

  it("returns my undone subtasks on open parents, due date then title", () => {
    const parent = task({});
    seed(
      [parent],
      [
        sub({ taskId: parent.id, title: "b no due", dueDate: null }),
        sub({ taskId: parent.id, title: "later", dueDate: 2000 }),
        sub({ taskId: parent.id, title: "sooner", dueDate: 1000 }),
        sub({ taskId: parent.id, title: "a no due", dueDate: null }),
      ]
    );
    const got = myOpenSubtasks(ME);
    expect(got.map((x) => x.subtask.title)).toEqual(["sooner", "later", "a no due", "b no due"]);
    expect(got.every((x) => x.parent.id === parent.id)).toBe(true);
  });

  it("excludes done subtasks, other people's subtasks, and unassigned ones", () => {
    const parent = task({});
    seed(
      [parent],
      [
        sub({ taskId: parent.id, title: "mine" }),
        sub({ taskId: parent.id, title: "done", done: true }),
        sub({ taskId: parent.id, title: "theirs", assigneeId: OTHER }),
        sub({ taskId: parent.id, title: "nobody's", assigneeId: null }),
      ]
    );
    expect(myOpenSubtasks(ME).map((x) => x.subtask.title)).toEqual(["mine"]);
  });

  it("excludes subtasks whose parent is closed or missing from the store", () => {
    const open = task({});
    const closed = task({ statusId: "st_done0000000000000000" });
    seed(
      [open, closed],
      [
        sub({ taskId: open.id, title: "on open parent" }),
        sub({ taskId: closed.id, title: "on closed parent" }),
        sub({ taskId: "tk_gone0000000000000000", title: "orphan" }),
      ]
    );
    expect(myOpenSubtasks(ME).map((x) => x.subtask.title)).toEqual(["on open parent"]);
  });

  it("returns nothing for a missing user id", () => {
    const parent = task({});
    seed([parent], [sub({ taskId: parent.id })]);
    expect(myOpenSubtasks(null)).toEqual([]);
    expect(myOpenSubtasks(undefined)).toEqual([]);
  });
});
