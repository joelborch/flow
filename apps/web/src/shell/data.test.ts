import { afterEach, describe, expect, it } from "vitest";
import type { List, Subtask } from "@flow/shared";
import {
  flush,
  lists,
  putSubtask,
  putTask,
  resetIndexes,
  type StoreTask,
} from "../store/state.js";
import { assignedOutBy, myOpenTasks, waitingOnOthersTasks } from "./data.js";

const AVERY = "us_avery";
const BLAKE = "us_blake";
const NOW = 1_800_000_000_000;

const list: List = {
  id: "ls_1",
  spaceId: "sp_1",
  name: "Inbox",
  position: 0,
  archived: false,
  inboundToken: null,
  createdAt: NOW,
  statuses: [
    { id: "st_open", name: "To Do", color: "#999", type: "open", position: 0 },
    { id: "st_done", name: "Done", color: "#0a0", type: "closed", position: 1 },
  ],
};

function task(patch: Partial<StoreTask> & Pick<StoreTask, "id" | "title">): StoreTask {
  const { id, title, ...rest } = patch;
  return {
    id,
    listId: list.id,
    title,
    statusId: "st_open",
    assigneeId: BLAKE,
    assignedBy: AVERY,
    assignedAt: NOW,
    waitingOn: null,
    priority: null,
    dueDate: null,
    snoozedUntil: null,
    blockedNote: null,
    tags: [],
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
    handoff: null,
    ...rest,
  };
}

function subtask(patch: Partial<Subtask> & Pick<Subtask, "id" | "taskId" | "title">): Subtask {
  const { id, taskId, title, ...rest } = patch;
  return {
    id,
    taskId,
    title,
    done: false,
    assigneeId: BLAKE,
    assignedBy: AVERY,
    assignedAt: NOW,
    dueDate: null,
    note: null,
    position: 0,
    createdAt: NOW,
    ...rest,
  };
}

afterEach(() => {
  resetIndexes();
  flush();
  lists.value = [];
});

describe("assignedOutBy", () => {
  it("returns only open work currently delegated by the viewer", () => {
    lists.value = [list];
    putTask(task({ id: "tk_keep", title: "Keep", dueDate: NOW + 1_000 }));
    putTask(task({ id: "tk_self", title: "Self", assigneeId: AVERY }));
    putTask(task({ id: "tk_other", title: "Other assigner", assignedBy: BLAKE }));
    putTask(task({ id: "tk_closed", title: "Closed", statusId: "st_done" }));
    putTask(task({ id: "tk_parent", title: "Parent" }));
    putSubtask(subtask({ id: "sb_keep", taskId: "tk_parent", title: "Delegated step", dueDate: NOW }));
    putSubtask(subtask({ id: "sb_done", taskId: "tk_parent", title: "Done step", done: true }));
    flush();

    expect(assignedOutBy(AVERY).map((item) => (
      item.kind === "task" ? item.task.id : item.subtask.id
    ))).toEqual(["sb_keep", "tk_keep", "tk_parent"]);
  });
});

describe("ballHolder routing in myOpenTasks, assignedOutBy, and waitingOnOthersTasks", () => {
  it("routes tasks to the ball holder and moves handed-off owned tasks to waitingOnOthersTasks", () => {
    lists.value = [list];
    putTask(task({ id: "tk_owned_active", title: "Mine", assigneeId: AVERY, waitingOn: null }));
    putTask(task({ id: "tk_owned_legacy", title: "Legacy cache", assigneeId: AVERY, waitingOn: undefined as unknown as null }));
    putTask(task({ id: "tk_owned_waiting", title: "Ball on Blake", assigneeId: AVERY, waitingOn: BLAKE }));
    putTask(task({ id: "tk_blake_my_turn", title: "Blake task my turn", assigneeId: BLAKE, assignedBy: AVERY, waitingOn: AVERY }));
    putTask(task({ id: "tk_blake_delegated", title: "Blake delegated", assigneeId: BLAKE, assignedBy: AVERY, waitingOn: null }));
    flush();

    expect(myOpenTasks(AVERY).map((t) => t.id).sort()).toEqual(["tk_blake_my_turn", "tk_owned_active", "tk_owned_legacy"]);
    expect(waitingOnOthersTasks(AVERY).map((t) => t.id)).toEqual(["tk_owned_waiting"]);
    expect(assignedOutBy(AVERY).map((i) => (i.kind === "task" ? i.task.id : i.subtask.id))).toEqual(["tk_blake_delegated"]);
  });
});
