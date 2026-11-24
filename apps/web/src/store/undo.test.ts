import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { offerUndo, toasts, undoLast } from "../lib/toast.js";
import { undoInputFor } from "./mutations.js";
import type { StoreTask } from "./state.js";

const base = {
  id: "tk_1",
  assigneeId: "us_avery",
  waitingOn: "us_blake",
  priority: "normal",
  dueDate: 100,
  snoozedUntil: null,
  tags: ["ops"],
} as unknown as StoreTask;

describe("undoInputFor", () => {
  it("returns the update that puts each changed field back", () => {
    expect(undoInputFor(base, { taskId: "tk_1", priority: "urgent" }, "To Do")).toEqual({
      input: { taskId: "tk_1", priority: "normal" },
      label: "Priority changed",
    });
    expect(undoInputFor(base, { taskId: "tk_1", dueDate: null, tags: [] }, "To Do")).toEqual({
      input: { taskId: "tk_1", dueDate: 100, tags: ["ops"] },
      label: "Task updated",
    });
  });

  it("hands the turn back when undoing a status change or a reassignment, which clear it", () => {
    expect(undoInputFor(base, { taskId: "tk_1", status: "Done" }, "To Do")?.input).toEqual({
      taskId: "tk_1",
      status: "To Do",
      waitingOn: "us_blake",
    });
    expect(undoInputFor(base, { taskId: "tk_1", assigneeId: "us_casey" }, "To Do")?.input).toEqual({
      taskId: "tk_1",
      assigneeId: "us_avery",
      waitingOn: "us_blake",
    });
  });

  it("offers nothing for a change that changes nothing, or for typing", () => {
    expect(undoInputFor(base, { taskId: "tk_1", priority: "normal" }, "To Do")).toBeNull();
    expect(undoInputFor(base, { taskId: "tk_1", status: "to do" }, "To Do")).toBeNull();
    expect(undoInputFor(base, { taskId: "tk_1", title: "New title" }, "To Do")).toBeNull();
  });
});

describe("offerUndo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    toasts.value = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows one toast for changes made together, and reverses all of them", async () => {
    const ran: string[] = [];
    offerUndo("Status changed", () => ran.push("a"));
    offerUndo("Status changed", () => ran.push("b"));
    await Promise.resolve();
    expect(toasts.value.map((t) => t.message)).toEqual(["2 tasks changed"]);
    expect(undoLast()).toBe(true);
    expect(ran).toEqual(["a", "b"]);
    expect(toasts.value).toEqual([]);
    // Nothing left to undo.
    expect(undoLast()).toBe(false);
  });

  it("keeps only the newest change undoable, and lets it expire", async () => {
    const ran: string[] = [];
    offerUndo("Priority changed", () => ran.push("first"));
    await Promise.resolve();
    offerUndo("Due date changed", () => ran.push("second"));
    await Promise.resolve();
    expect(toasts.value.map((t) => t.message)).toEqual(["Due date changed"]);
    vi.advanceTimersByTime(8000);
    expect(undoLast()).toBe(false);
    expect(ran).toEqual([]);
  });

  it("withdraws the offer for a change the server refused", async () => {
    const withdrawA = offerUndo("Status changed", () => undefined);
    offerUndo("Status changed", () => undefined);
    await Promise.resolve();
    withdrawA();
    // One of the two still stands.
    expect(toasts.value).toHaveLength(1);
    const withdrawOnly = offerUndo("Priority changed", () => undefined);
    await Promise.resolve();
    withdrawOnly();
    expect(toasts.value).toEqual([]);
    expect(undoLast()).toBe(false);
  });
});
