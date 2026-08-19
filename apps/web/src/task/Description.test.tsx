// @vitest-environment happy-dom
import { act } from "preact/test-utils";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../store/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/index.js")>();
  return { ...actual, updateTask: vi.fn() };
});

import { Description } from "./Description.js";
import { updateTask, type StoreTask } from "../store/index.js";

let root: HTMLDivElement;

const sampleTask: StoreTask = {
  id: "tk_test1",
  listId: "ls_1",
  statusId: "st_1",
  title: "Test Task",
  description: "## Heading 2\n\nThis is **bold** text.",
  hasDescription: true,
  priority: "urgent",
  assigneeId: null,
  dueDate: null,
  startDate: null,
  snoozedUntil: null,
  blockedNote: null,
  tags: [],
  position: 0,
  createdBy: "us_1",
  createdAt: 0,
  updatedAt: 0,
  closedAt: null,
  clickupId: null,
};

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  vi.clearAllMocks();
});

afterEach(() => {
  render(null, root);
  root.remove();
});

describe("Description component", () => {
  it("renders empty state placeholder when task has no description", () => {
    const emptyTask: StoreTask = {
      ...sampleTask,
      description: "",
      hasDescription: false,
    };

    act(() => {
      render(<Description task={emptyTask} />, root);
    });

    expect(root.textContent).toContain("Add a description");
  });

  it("renders markdown in read mode when description is present", () => {
    act(() => {
      render(<Description task={sampleTask} />, root);
    });

    const h2 = root.querySelector("h2");
    const strong = root.querySelector("strong");
    expect(h2).not.toBeNull();
    expect(h2?.textContent).toBe("Heading 2");
    expect(strong?.textContent).toBe("bold");
    expect(root.querySelector("button")?.textContent).toBe("Edit");
  });

  const enterEditMode = async (editBtn: HTMLButtonElement | undefined) => {
    act(() => {
      editBtn?.click();
    });
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      if (root.querySelector(".tiptap")) break;
    }
  };

  it("switches to edit mode when clicking Edit button", async () => {
    act(() => {
      render(<Description task={sampleTask} />, root);
    });

    const editBtn = Array.from(root.querySelectorAll("button")).find(
      (b) => b.textContent === "Edit"
    );
    expect(editBtn).toBeDefined();

    await enterEditMode(editBtn);

    expect(root.querySelector(".tiptap")).not.toBeNull();
    expect(root.textContent).toContain("⌘↵ to save · esc to cancel");
  });

  it("exits edit mode on Escape and stops event propagation", async () => {
    act(() => {
      render(<Description task={sampleTask} />, root);
    });

    const editBtn = Array.from(root.querySelectorAll("button")).find(
      (b) => b.textContent === "Edit"
    );
    await enterEditMode(editBtn);

    const editorEl = root.querySelector(".tiptap");
    expect(editorEl).not.toBeNull();

    let documentEscHeard = false;
    const docListener = (e: KeyboardEvent) => {
      if (e.key === "Escape") documentEscHeard = true;
    };
    document.addEventListener("keydown", docListener);

    act(() => {
      const escEvent = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      editorEl?.dispatchEvent(escEvent);
    });

    document.removeEventListener("keydown", docListener);

    // Editor should be closed and document listener should NOT have heard the bubbled event
    expect(root.querySelector(".tiptap")).toBeNull();
    expect(documentEscHeard).toBe(false);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("exits edit mode without mutation when Done is clicked on unmodified text", async () => {
    act(() => {
      render(<Description task={sampleTask} />, root);
    });

    const editBtn = Array.from(root.querySelectorAll("button")).find(
      (b) => b.textContent === "Edit"
    );
    await act(async () => {
      editBtn?.click();
    });

    const doneBtn = Array.from(root.querySelectorAll("button")).find(
      (b) => b.textContent === "Done"
    );
    expect(doneBtn).toBeDefined();

    act(() => {
      doneBtn?.click();
    });

    expect(root.querySelector(".tiptap")).toBeNull();
    expect(updateTask).not.toHaveBeenCalled();
  });
});
