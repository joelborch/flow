// @vitest-environment happy-dom
import { act } from "preact/test-utils";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { List, Space, User } from "@flow/shared";
import {
  flush,
  lists,
  me,
  putTask,
  resetIndexes,
  spaces,
  users,
  type StoreTask,
} from "../store/state.js";
import { MyWork, myWorkKey } from "./MyWork.js";

const AVERY: User = {
  id: "us_avery",
  email: "avery@example.com",
  name: "Avery Stone",
  role: "owner",
  deactivated: false,
  createdAt: 0,
};
const BLAKE: User = {
  id: "us_blake",
  email: "blake@example.com",
  name: "Blake Rivers",
  role: "admin",
  deactivated: false,
  createdAt: 0,
};
const SPACE: Space = {
  id: "sp_1",
  name: "Operations",
  color: null,
  position: 0,
  archived: false,
  visibility: "workspace",
  createdAt: 0,
};
const LIST: List = {
  id: "ls_1",
  spaceId: SPACE.id,
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

function delegatedTask(index: number): StoreTask {
  const now = Date.now();
  return {
    id: `tk_${index}`,
    listId: LIST.id,
    title: `Delegated task ${index}`,
    statusId: "st_open",
    assigneeId: BLAKE.id,
    assignedBy: AVERY.id,
    assignedAt: now - index,
    waitingOn: null,
    priority: null,
    dueDate: now + index * 86_400_000,
    snoozedUntil: null,
    blockedNote: null,
    tags: [],
    position: index,
    createdAt: now,
    updatedAt: now,
    handoff: null,
  };
}

let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  resetIndexes();
  flush();
  spaces.value = [SPACE];
  lists.value = [LIST];
  users.value = [AVERY, BLAKE];
  me.value = AVERY;
});

afterEach(() => {
  act(() => render(null, root));
  document.body.innerHTML = "";
  resetIndexes();
  flush();
  spaces.value = [];
  lists.value = [];
  users.value = [];
  me.value = null;
});

describe("My Work With others rail", () => {
  it("starts collapsed, then shows five items across Delegated and Their turn and expands the rest", () => {
    for (let i = 1; i <= 6; i++) putTask(delegatedTask(i));
    flush();
    act(() => render(<MyWork />, root));

    const aside = root.querySelector("aside");
    expect(aside?.textContent).toContain("With others");
    expect(aside?.querySelectorAll("li")).toHaveLength(0);

    const header = aside?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(header).not.toBeNull();
    act(() => header?.click());
    expect(header?.getAttribute("aria-expanded")).toBe("true");
    expect(aside?.textContent).toContain("Delegated");
    expect(aside?.textContent).toContain("Blake Rivers");
    expect(aside?.querySelectorAll("li")).toHaveLength(5);

    const viewAll = Array.from(aside?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.trim() === "View all 6"
    );
    expect(viewAll).toBeDefined();
    act(() => viewAll?.click());
    expect(aside?.querySelectorAll("li")).toHaveLength(6);
    expect(aside?.textContent).toContain("Show less");
  });

  it("shows both Delegated and Their turn subgroups and renders my-turn tasks in main buckets with owner chip", () => {
    const now = Date.now();
    putTask({
      ...delegatedTask(1),
      id: "tk_delegated",
      title: "Delegated to Blake",
      assigneeId: BLAKE.id,
      assignedBy: AVERY.id,
      waitingOn: null,
    });
    putTask({
      ...delegatedTask(2),
      id: "tk_waiting",
      title: "My task waiting on Blake",
      assigneeId: AVERY.id,
      assignedBy: AVERY.id,
      waitingOn: BLAKE.id,
    });
    putTask({
      ...delegatedTask(3),
      id: "tk_my_turn",
      title: "Blake task handed to me",
      assigneeId: BLAKE.id,
      assignedBy: AVERY.id,
      waitingOn: AVERY.id,
      dueDate: now,
    });
    flush();
    act(() => render(<MyWork />, root));

    const main = root.querySelector("main");
    expect(main?.textContent).toContain("Blake task handed to me");
    expect(main?.textContent).toContain("Blake");
    expect(main?.textContent).not.toContain("My task waiting on Blake");

    const aside = root.querySelector("aside");
    const header = aside?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    act(() => header?.click());
    expect(aside?.textContent).toContain("Delegated");
    expect(aside?.textContent).toContain("Their turn");
    expect(aside?.textContent).toContain("Delegated to Blake");
    expect(aside?.textContent).toContain("My task waiting on Blake");
    expect(aside?.textContent).not.toContain("Blake task handed to me");
  });
});

describe("myWorkKey", () => {
  const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...extra }) as KeyboardEvent;
  const rows = [{} as HTMLElement, {} as HTMLElement];

  it("moves with J/K and the arrows, and starts a task with N", () => {
    expect(myWorkKey(key("j"), rows, null)).toBe("next");
    expect(myWorkKey(key("ArrowDown"), rows, null)).toBe("next");
    expect(myWorkKey(key("k"), rows, rows[1]!)).toBe("prev");
    expect(myWorkKey(key("ArrowUp"), rows, rows[1]!)).toBe("prev");
    expect(myWorkKey(key("N"), rows, null)).toBe("new");
  });

  it("enters the list from the top when nothing is focused, whichever way you press", () => {
    expect(myWorkKey(key("k"), rows, null)).toBe("next");
  });

  it("leaves browser shortcuts and an empty list alone", () => {
    expect(myWorkKey(key("j", { metaKey: true }), rows, null)).toBeNull();
    expect(myWorkKey(key("j"), [], null)).toBeNull();
    expect(myWorkKey(key("x"), rows, null)).toBeNull();
  });
});
