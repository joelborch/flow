// @vitest-environment happy-dom
import { act } from "preact/test-utils";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Handoff, List, Task, User } from "@flow/shared";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, api: { ...actual.api, replyHandoff: vi.fn() } };
});
vi.mock("../shell/nav.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shell/nav.js")>();
  return { ...actual, openTask: vi.fn() };
});

import { api, ApiError } from "../lib/api.js";
import { toasts } from "../lib/toast.js";
import { openTask } from "../shell/nav.js";
import { flush, lists, me, putTask, resetIndexes, tasks, users, type StoreTask } from "../store/state.js";
import { HandoffStrip, handoffStatesFor } from "./HandoffStrip.js";

const DAY = 86_400_000;

function user(id: string, name: string, role: User["role"] = "member"): User {
  return { id, email: `${id}@example.com`, name, role, deactivated: false, createdAt: 0 };
}
const MARA = user("us_mara", "Mara Whitfield"); // requester
const BLAKE = user("us_blake", "Blake Rivers"); // recipient
const ANA = user("us_ana", "Ana Prieto", "admin");
const DEVON = user("us_dev", "Devon Cruz");

const LIST: List = {
  id: "ls_1",
  spaceId: "sp_1",
  name: "Website",
  position: 0,
  archived: false,
  inboundToken: null,
  createdAt: 0,
  statuses: [
    { id: "st_open", name: "To Do", color: "#777", type: "open", position: 0 },
    { id: "st_done", name: "Done", color: "#0a0", type: "closed", position: 1 },
  ],
};

const HANDOFF: Handoff = {
  requestedBy: MARA.id,
  state: "working",
  returnFormat: "A table of page, sessions and change date",
  contextTaskIds: ["tk_ctx", "tk_gone"],
  stateChangedAt: 1,
};

function task(id: string, patch: Partial<StoreTask> = {}): StoreTask {
  return {
    id,
    listId: LIST.id,
    title: `Task ${id}`,
    statusId: "st_open",
    assigneeId: BLAKE.id,
    assignedBy: MARA.id,
    assignedAt: 1,
    priority: null,
    dueDate: null,
    snoozedUntil: null,
    blockedNote: null,
    tags: ["handoff"],
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    handoff: null,
    ...patch,
  };
}

/** Reads the task from the store, as the panel does, so optimistic edits show. */
function Harness({ id }: { id: string }) {
  const t = tasks.value.get(id);
  return t ? <HandoffStrip task={t} /> : null;
}

let root: HTMLDivElement;

function mount(t: StoreTask, viewer: User): void {
  putTask(t);
  flush();
  me.value = viewer;
  act(() => render(<Harness id={t.id} />, root));
}

function trigger(): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
}

function menuLabels(): string[] {
  act(() => trigger()!.click());
  return Array.from(root.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent?.trim() ?? "");
}

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  resetIndexes();
  lists.value = [LIST];
  users.value = [MARA, BLAKE, ANA, DEVON];
  putTask(task("tk_ctx", { title: "Homepage redesign brief", handoff: null }));
  flush();
  vi.mocked(api.replyHandoff).mockReset();
  vi.mocked(openTask).mockReset();
  toasts.value = [];
});

afterEach(() => {
  act(() => render(null, root));
  root.remove();
  resetIndexes();
  flush();
  lists.value = [];
  users.value = [];
  me.value = null;
});

describe("HandoffStrip", () => {
  it("renders nothing for an ordinary task, or one from a pre-handoff boot cache", () => {
    mount(task("tk_plain"), BLAKE);
    expect(root.innerHTML).toBe("");

    const cached = task("tk_cached");
    delete (cached as Partial<StoreTask>).handoff;
    mount(cached, BLAKE);
    expect(root.innerHTML).toBe("");
  });

  it("shows who asked, who it's for, when it's needed, the state, return and context", () => {
    mount(task("tk_h", { handoff: HANDOFF, dueDate: Date.now() + DAY }), DEVON);
    const text = root.textContent ?? "";
    expect(text).toContain("From Mara Whitfield (via agent)");
    expect(text).toContain("Blake Rivers");
    expect(text).toContain("needs by tomorrow");
    expect(text).toContain("Working");
    expect(text).toContain("Return: A table of page, sessions and change date");

    const links = Array.from(root.querySelectorAll("button")).filter((b) => b.getAttribute("aria-haspopup") === null);
    expect(links.map((b) => b.textContent)).toEqual(["Homepage redesign brief", "tk_gone"]);
    act(() => links[0]!.click());
    expect(openTask).toHaveBeenCalledWith("tk_ctx");
  });

  it("says Unassigned and leaves out what the handoff doesn't carry", () => {
    mount(
      task("tk_h", { assigneeId: null, handoff: { ...HANDOFF, returnFormat: null, contextTaskIds: [] } }),
      DEVON
    );
    const text = root.textContent ?? "";
    expect(text).toContain("Unassigned");
    expect(text).not.toContain("needs by");
    expect(text).not.toContain("Return:");
    expect(text).not.toContain("Context:");
  });

  it("offers every state to the recipient", () => {
    mount(task("tk_h", { handoff: HANDOFF }), BLAKE);
    expect(trigger()?.getAttribute("aria-label")).toBe("Handoff state: Working");
    expect(menuLabels()).toEqual(["Requested", "Working", "Needs input", "Done", "Declined"]);
  });

  it("offers every state to an admin who is neither party", () => {
    mount(task("tk_h", { handoff: HANDOFF }), ANA);
    expect(menuLabels()).toEqual(["Requested", "Working", "Needs input", "Done", "Declined"]);
  });

  it("offers the requester only Decline", () => {
    mount(task("tk_h", { handoff: HANDOFF }), MARA);
    expect(menuLabels()).toEqual(["Decline"]);
  });

  it("shows everyone else a read-only pill", () => {
    mount(task("tk_h", { handoff: HANDOFF }), DEVON);
    expect(trigger()).toBeNull();
    expect(root.textContent).toContain("Handoff state: Working");
  });

  it("gives a requester nothing to do once the handoff is finished", () => {
    const declined = task("tk_h", { handoff: { ...HANDOFF, state: "declined" } });
    const done = task("tk_h", { handoff: { ...HANDOFF, state: "done" } });
    expect(handoffStatesFor(declined, MARA)).toEqual([]);
    expect(handoffStatesFor(done, MARA)).toEqual([]);
    expect(handoffStatesFor(declined, BLAKE)).toHaveLength(5);
    expect(handoffStatesFor(task("tk_plain"), BLAKE)).toEqual([]);
  });

  it("sends the chosen state and keeps the server's answer", async () => {
    const answer = { ...task("tk_h"), handoff: { ...HANDOFF, state: "done" as const, stateChangedAt: 2 } };
    vi.mocked(api.replyHandoff).mockResolvedValue({
      task: { ...answer, statusId: "st_done" } as unknown as Task,
      comment: null,
    });
    mount(task("tk_h", { handoff: HANDOFF }), BLAKE);
    menuLabels();
    const done = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (b) => b.textContent?.trim() === "Done"
    )!;
    await act(async () => done.click());

    expect(api.replyHandoff).toHaveBeenCalledWith("tk_h", { state: "done" });
    await vi.waitFor(() => expect(tasks.value.get("tk_h")?.statusId).toBe("st_done"));
    expect(trigger()?.getAttribute("aria-label")).toBe("Handoff state: Done");
  });

  it("rolls back and toasts when the server refuses", async () => {
    vi.mocked(api.replyHandoff).mockRejectedValue(new ApiError(403, "Only the recipient can do that"));
    mount(task("tk_h", { handoff: HANDOFF }), MARA);
    menuLabels();
    await act(async () => root.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());

    expect(api.replyHandoff).toHaveBeenCalledWith("tk_h", { state: "declined" });
    await vi.waitFor(() => expect(toasts.value.map((t) => t.kind)).toEqual(["error"]));
    expect(toasts.value[0]!.message).toContain("Only the recipient can do that");
    expect(tasks.value.get("tk_h")?.handoff?.state).toBe("working");
  });
});
