import { describe, expect, it } from "vitest";
import type { Subtask, User } from "@flow/shared";
import { devSnapshot } from "./dev-snapshot.js";
import { demoRequest, demoTaskDetail, type DemoSource } from "./demo.js";
import type { StoreTask } from "../store/state.js";

function source(): DemoSource & { all: StoreTask[]; subtasksOf: (id: string) => Subtask[]; people: User[] } {
  const snap = devSnapshot(48);
  const tasks = new Map(snap.tasks.map((t) => [t.id, t as StoreTask]));
  return {
    all: [...tasks.values()],
    people: snap.users,
    subtasksOf: (id) => snap.subtasks.filter((s) => s.taskId === id),
    task: (id) => tasks.get(id),
    subtasks: (id) => snap.subtasks.filter((s) => s.taskId === id),
    users: () => snap.users,
  };
}

describe("demo mode", () => {
  it("answers a task's detail from the sample board, with a description and its subtasks", () => {
    const src = source();
    const task = src.all.find((t) => src.subtasksOf(t.id).length > 0)!;
    const answer = demoRequest("GET", `/api/tasks/${task.id}`, src);
    expect(answer.answered).toBe(true);
    if (!answer.answered) return;
    const detail = answer.value as ReturnType<typeof demoTaskDetail>;
    expect(detail.task.id).toBe(task.id);
    expect(detail.task.description.length).toBeGreaterThan(20);
    expect(detail.subtasks).toEqual(src.subtasksOf(task.id));
    expect(detail.emailReplyTo).toBeNull();
  });

  it("gives the sample handoff an agent exchange in its comments", () => {
    const src = source();
    const handoff = src.all.find((t) => t.handoff !== null)!;
    const detail = demoTaskDetail(handoff, [], src.people);
    expect(detail.comments).toHaveLength(2);
    expect(detail.comments.every((c) => c.via === "mcp")).toBe(true);
    expect(detail.comments[0]!.authorId).toBe(handoff.handoff!.requestedBy);
  });

  it("answers /api/me and a task's comments, and nothing it doesn't model", () => {
    const src = source();
    const task = src.all[0]!;
    expect(demoRequest("GET", "/api/me", src)).toEqual({ answered: true, value: src.people[0] });
    expect(demoRequest("GET", `/api/tasks/${task.id}/comments`, src)).toMatchObject({
      answered: true,
      value: { comments: expect.any(Array) },
    });
    expect(demoRequest("GET", "/api/tasks/tk_missing", src)).toEqual({ answered: false });
    expect(demoRequest("GET", "/api/automations", src)).toEqual({ answered: false });
  });

  it("turns every write away", () => {
    const src = source();
    const task = src.all[0]!;
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(demoRequest(method, `/api/tasks/${task.id}`, src)).toEqual({ answered: false });
    }
  });

  it("has the demo owner delegate some work, so My Work's assigned-out rail has rows", () => {
    const delegated = devSnapshot(48).tasks.filter((t) => t.assignedBy === "us_alice");
    expect(delegated.length).toBeGreaterThan(0);
    expect(delegated.every((t) => t.assigneeId !== "us_alice" && t.assignedAt !== null)).toBe(true);
  });
});
