// @vitest-environment happy-dom
import { act } from "preact/test-utils";
import { render } from "preact";
import type { List, Space, Task, User } from "@flow/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../store/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/index.js")>();
  return { ...actual, createTask: vi.fn() };
});

import { QuickAddDialog } from "./QuickAddDialog.js";
import { createTask, lists, me, spaces } from "../store/index.js";
import {
  PERSONAL_SPACE_NAME,
  WORK_INBOX_LIST_NAME,
  closeQuickAdd,
  openQuickAdd,
  quickAddOpen,
} from "./quick-add.js";

const targetList: List = {
  id: "ls_inbox",
  spaceId: "sp_personal",
  name: WORK_INBOX_LIST_NAME,
  position: 0,
  archived: false,
  inboundToken: null,
  createdAt: 0,
  statuses: [
    { id: "st_todo", name: "To Do", type: "open", color: "#999", position: 0 },
    { id: "st_done", name: "Done", type: "closed", color: "#090", position: 1 },
  ],
};

const personalSpace: Space = {
  id: "sp_personal",
  name: PERSONAL_SPACE_NAME,
  color: null,
  position: 0,
  archived: false,
  visibility: "private",
  createdAt: 0,
};

const owner: User = {
  id: "us_alice",
  email: "alice@example.com",
  name: "Alice",
  role: "owner",
  deactivated: false,
  createdAt: 0,
};

let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  me.value = owner;
  spaces.value = [personalSpace];
  lists.value = [targetList];
  vi.mocked(createTask).mockReset();
  act(() => {
    render(<QuickAddDialog />, root);
  });
});

afterEach(() => {
  act(() => {
    closeQuickAdd();
    render(null, root);
  });
  document.body.innerHTML = "";
});

function typeTitle(value: string): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>('input[placeholder^="Task title"]')!;
  input.value = value;
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

describe("QuickAddDialog", () => {
  it("opens with Q and preserves the exact draft when creation fails", async () => {
    vi.mocked(createTask).mockResolvedValue(null);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));
    });
    expect(quickAddOpen.value).toBe(true);

    const input = typeTitle("Call the dentist tomorrow");
    const form = root.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(quickAddOpen.value).toBe(true);
    expect(input.value).toBe("Call the dentist tomorrow");
  });

  it("submits the stripped title and resolved private target, then closes on success", async () => {
    const created = { id: "tk_created" } as Task;
    vi.mocked(createTask).mockResolvedValue(created);
    act(openQuickAdd);
    typeTitle("Call the dentist 2026-08-20");

    await act(async () => {
      root.querySelector<HTMLFormElement>("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
    });

    expect(createTask).toHaveBeenCalledWith({
      listId: targetList.id,
      title: "Call the dentist",
      description: "",
      status: "To Do",
      assigneeId: owner.id,
      dueDate: new Date(2026, 7, 20, 12, 0, 0, 0).getTime(),
    });
    expect(quickAddOpen.value).toBe(false);
  });

  it("fails closed for a member (non-owner)", () => {
    me.value = { ...owner, id: "us_bob", email: "bob@example.com", role: "member" };
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));
    });
    expect(quickAddOpen.value).toBe(false);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("fails closed when the owner has no Personal space set up", () => {
    spaces.value = [];
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));
    });
    expect(quickAddOpen.value).toBe(false);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("stays closed behind another modal but opens over the compatible task panel", () => {
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));
    });
    expect(quickAddOpen.value).toBe(false);

    modal.setAttribute("data-quick-add-compatible", "");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));
    });
    expect(quickAddOpen.value).toBe(true);
  });
});
