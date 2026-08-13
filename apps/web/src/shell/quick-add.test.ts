import type { List, Space, User } from "@flow/shared";
import { describe, expect, it } from "vitest";
import {
  PERSONAL_SPACE_NAME,
  WORK_INBOX_LIST_NAME,
  canUseQuickAdd,
  recognizeDueDate,
  resolveQuickAddDestination,
  shouldOpenQuickAdd,
} from "./quick-add.js";

const reference = new Date(2026, 7, 12, 9, 30);

function localNoon(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
}

describe("recognizeDueDate", () => {
  it.each([
    ["Call the dentist TOM", "Call the dentist", "TOM", 2026, 8, 13],
    ["Call the dentist tom", "Call the dentist", "tom", 2026, 8, 13],
    ["Call the dentist tomorrow", "Call the dentist", "tomorrow", 2026, 8, 13],
    ["Call the dentist in 3 days", "Call the dentist", "in 3 days", 2026, 8, 15],
    ["Call the dentist in three days", "Call the dentist", "in three days", 2026, 8, 15],
    ["Call the dentist Monday", "Call the dentist", "Monday", 2026, 8, 17],
    ["Call the dentist Aug 20", "Call the dentist", "Aug 20", 2026, 8, 20],
    ["Call the dentist 8/20", "Call the dentist", "8/20", 2026, 8, 20],
    ["Call the dentist 2026-08-20", "Call the dentist", "2026-08-20", 2026, 8, 20],
  ])("parses the date-only suffix in %s", (input, title, text, year, month, day) => {
    expect(recognizeDueDate(input, reference)).toMatchObject({
      title,
      text,
      dueDate: localNoon(year, month, day),
    });
  });

  it.each([
    "Call Tom",
    "Call May",
    "Tomorrowland research",
    "Monday planning notes for the team",
    "Call the dentist tomorrow at 3pm",
    "Call the dentist every Monday",
    "Call the dentist each Friday",
  ])("does not consume ambiguous, non-suffix, timed, or recurring text: %s", (input) => {
    expect(recognizeDueDate(input, reference)).toBeNull();
  });

  it("keeps a dismissed match as ordinary title text until the input changes", () => {
    const input = "Call the dentist tomorrow";
    expect(recognizeDueDate(input, reference, input)).toBeNull();
    expect(recognizeDueDate(`${input}!`, reference, input)).toBeNull();
    expect(recognizeDueDate("Call the dentist Friday", reference, input)?.text).toBe("Friday");
  });

  it("exposes an empty title when the input contains only a date", () => {
    expect(recognizeDueDate("tomorrow", reference)?.title).toBe("");
  });

  it("uses calendar arithmetic and local noon across a DST boundary", () => {
    const beforeSpringForward = new Date(2026, 2, 7, 9);
    const result = recognizeDueDate("File report in 2 days", beforeSpringForward);
    expect(result?.dueDate).toBe(localNoon(2026, 3, 9));
    const due = new Date(result!.dueDate);
    expect(due.getHours()).toBe(12);
    expect(due.getDate()).toBe(9);
  });
});

const owner: User = {
  id: "us_alice",
  email: "alice@example.com",
  name: "Alice",
  role: "owner",
  deactivated: false,
  createdAt: 0,
};

const member: User = {
  id: "us_bob",
  email: "bob@example.com",
  name: "Bob",
  role: "member",
  deactivated: false,
  createdAt: 0,
};

describe("canUseQuickAdd", () => {
  it("is true only for the owner role", () => {
    expect(canUseQuickAdd(owner)).toBe(true);
    expect(canUseQuickAdd(member)).toBe(false);
    expect(canUseQuickAdd({ ...member, role: "admin" })).toBe(false);
    expect(canUseQuickAdd(null)).toBe(false);
    expect(canUseQuickAdd(undefined)).toBe(false);
  });
});

function targetFixture(): { list: List; space: Space } {
  return {
    list: {
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
    },
    space: {
      id: "sp_personal",
      name: PERSONAL_SPACE_NAME,
      color: null,
      position: 0,
      archived: false,
      visibility: "private",
      createdAt: 0,
    },
  };
}

describe("resolveQuickAddDestination", () => {
  it("returns the owner's private Personal / Inbox target", () => {
    const { list, space } = targetFixture();
    expect(resolveQuickAddDestination(owner, [space], [list])).toEqual({
      listId: list.id,
      status: "To Do",
      assigneeId: owner.id,
      label: "Personal / Inbox",
    });
  });

  it("fails closed for a non-owner, or when the owner id is unset", () => {
    const { list, space } = targetFixture();
    expect(resolveQuickAddDestination(member, [space], [list])).toBeNull();
    expect(resolveQuickAddDestination({ ...owner, role: "admin" }, [space], [list])).toBeNull();
    expect(resolveQuickAddDestination(null, [space], [list])).toBeNull();
    expect(resolveQuickAddDestination(undefined, [space], [list])).toBeNull();
  });

  it("fails closed when no Personal space exists, or the Inbox list is missing, moved, archived, or lacks To Do", () => {
    const { list, space } = targetFixture();
    expect(resolveQuickAddDestination(owner, [], [list])).toBeNull();
    expect(resolveQuickAddDestination(owner, [space], [])).toBeNull();
    expect(
      resolveQuickAddDestination(owner, [space], [{ ...list, spaceId: "sp_other" }])
    ).toBeNull();
    expect(
      resolveQuickAddDestination(owner, [space], [{ ...list, archived: true }])
    ).toBeNull();
    expect(
      resolveQuickAddDestination(owner, [space], [{ ...list, statuses: list.statuses.slice(1) }])
    ).toBeNull();
  });

  it("fails closed unless the Personal space is active and private", () => {
    const { list, space } = targetFixture();
    expect(
      resolveQuickAddDestination(owner, [{ ...space, archived: true }], [list])
    ).toBeNull();
    expect(
      resolveQuickAddDestination(owner, [{ ...space, visibility: "workspace" }], [list])
    ).toBeNull();
  });
});

function key(overrides: Record<string, unknown> = {}) {
  return {
    key: "q",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    target: null,
    ...overrides,
  } as unknown as KeyboardEvent;
}

describe("shouldOpenQuickAdd", () => {
  it("accepts an unmodified, non-repeated Q outside a field or modal", () => {
    expect(shouldOpenQuickAdd(key(), null, false)).toBe(true);
  });

  it("rejects modifiers, repeats, other keys, and blocking dialogs", () => {
    expect(shouldOpenQuickAdd(key({ metaKey: true }), null, false)).toBe(false);
    expect(shouldOpenQuickAdd(key({ shiftKey: true }), null, false)).toBe(false);
    expect(shouldOpenQuickAdd(key({ repeat: true }), null, false)).toBe(false);
    expect(shouldOpenQuickAdd(key({ key: "n" }), null, false)).toBe(false);
    expect(shouldOpenQuickAdd(key(), null, true)).toBe(false);
  });

  it("rejects a typing event target or active element", () => {
    const input = { tagName: "INPUT", isContentEditable: false } as HTMLElement;
    const editor = { tagName: "DIV", isContentEditable: true } as HTMLElement;
    expect(shouldOpenQuickAdd(key({ target: input }), null, false)).toBe(false);
    expect(shouldOpenQuickAdd(key(), editor, false)).toBe(false);
  });
});
