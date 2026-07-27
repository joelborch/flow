import { describe, expect, it } from "vitest";
import { DUE_BUCKETS, dueBucket, groupByDueBucket } from "./work.js";
import { buildNameIndex, type WorkspaceMap } from "./context.js";
import { distinctTags, taskView } from "./views.js";

const DAY = 86_400_000;
/** Fixed instant: 2026-03-10T12:00:00.000Z, mid-day so both edges are testable. */
const NOW = Date.UTC(2026, 2, 10, 12, 0, 0);
const utcNoon = (day: number) => Date.UTC(2026, 2, day, 12, 0, 0);

describe("dueBucket", () => {
  it("buckets by whole UTC day, not by instant", () => {
    // 09:00 today is still today's work at 12:00, and 23:59 today is not "later".
    expect(dueBucket(Date.UTC(2026, 2, 10, 9, 0, 0), NOW)).toBe("today");
    expect(dueBucket(Date.UTC(2026, 2, 10, 23, 59, 59), NOW)).toBe("today");
    expect(dueBucket(Date.UTC(2026, 2, 10, 0, 0, 0), NOW)).toBe("today");
  });

  it("treats anything before today as overdue", () => {
    expect(dueBucket(Date.UTC(2026, 2, 9, 23, 59, 59), NOW)).toBe("overdue");
    expect(dueBucket(NOW - 30 * DAY, NOW)).toBe("overdue");
    expect(dueBucket(0, NOW)).toBe("overdue");
  });

  it("puts the next seven days in thisWeek and day eight in later", () => {
    expect(dueBucket(utcNoon(11), NOW)).toBe("thisWeek");
    expect(dueBucket(utcNoon(17), NOW)).toBe("thisWeek");
    expect(dueBucket(utcNoon(18), NOW)).toBe("later");
    expect(dueBucket(utcNoon(40), NOW)).toBe("later");
  });

  it("reports a missing due date as noDate", () => {
    expect(dueBucket(null, NOW)).toBe("noDate");
    expect(dueBucket(undefined, NOW)).toBe("noDate");
  });
});

describe("groupByDueBucket", () => {
  const rows = [
    { id: "later", dueDate: utcNoon(25) },
    { id: "overdue-old", dueDate: utcNoon(1) },
    { id: "none", dueDate: null },
    { id: "today", dueDate: utcNoon(10) },
    { id: "week-late", dueDate: utcNoon(17) },
    { id: "overdue-recent", dueDate: utcNoon(9) },
    { id: "week-early", dueDate: utcNoon(11) },
    { id: "none-2", dueDate: null },
  ];

  it("always returns all five buckets", () => {
    const grouped = groupByDueBucket([], NOW);
    expect(Object.keys(grouped)).toEqual([...DUE_BUCKETS]);
    for (const bucket of DUE_BUCKETS) expect(grouped[bucket]).toEqual([]);
  });

  it("places every row in exactly one bucket", () => {
    const grouped = groupByDueBucket(rows, NOW);
    const total = DUE_BUCKETS.reduce((n, bucket) => n + grouped[bucket].length, 0);
    expect(total).toBe(rows.length);
    expect(grouped.overdue.map((r) => r.id)).toEqual(["overdue-old", "overdue-recent"]);
    expect(grouped.today.map((r) => r.id)).toEqual(["today"]);
    expect(grouped.thisWeek.map((r) => r.id)).toEqual(["week-early", "week-late"]);
    expect(grouped.later.map((r) => r.id)).toEqual(["later"]);
    expect(grouped.noDate.map((r) => r.id)).toEqual(["none", "none-2"]);
  });

  it("sorts dated buckets soonest-first and leaves undated rows in search order", () => {
    const grouped = groupByDueBucket(rows, NOW);
    expect(grouped.overdue[0]!.dueDate).toBeLessThan(grouped.overdue[1]!.dueDate!);
    expect(grouped.noDate.map((r) => r.id)).toEqual(["none", "none-2"]);
  });
});

// ---------------------------------------------------------------------------
// Name resolution + result shaping
// ---------------------------------------------------------------------------

const map: WorkspaceMap = {
  seq: 12,
  spaces: [
    {
      id: "sp_eng",
      name: "Engineering",
      color: null,
      position: 1,
      archived: false,
      createdAt: 0,
      lists: [
        {
          id: "ls_bugs",
          name: "Bugs",
          archived: false,
          openTasks: 3,
          statuses: [
            { id: "st_todo", name: "Triage", color: "#888", type: "open", position: 1 },
            { id: "st_done", name: "Shipped", color: "#0a0", type: "closed", position: 2 },
          ],
        },
      ],
    },
  ],
  users: [
    {
      id: "us_alice",
      email: "alice@example.com",
      name: "Alice",
      role: "owner",
      deactivated: false,
      createdAt: 0,
    },
  ],
} as WorkspaceMap;

describe("buildNameIndex", () => {
  const names = buildNameIndex(map);

  it("resolves statuses, lists, spaces and users to names", () => {
    expect(names.statusName("st_todo")).toBe("Triage");
    expect(names.listName("ls_bugs")).toBe("Bugs");
    expect(names.spaceNameForList("ls_bugs")).toBe("Engineering");
    expect(names.userName("us_alice")).toBe("Alice");
    expect(names.statusesForList("ls_bugs").map((s) => s.name)).toEqual(["Triage", "Shipped"]);
  });

  it("degrades to the raw id rather than to null, so results stay actionable", () => {
    expect(names.statusName("st_missing")).toBe("st_missing");
    expect(names.listName("ls_missing")).toBe("ls_missing");
    expect(names.userName("us_missing")).toBe("us_missing");
    expect(names.userName(null)).toBeNull();
  });
});

describe("taskView", () => {
  it("replaces ids with names and keeps the ids the write tools need", () => {
    const view = taskView(
      {
        id: "tk_1",
        listId: "ls_bugs",
        title: "Checkout fails",
        statusId: "st_todo",
        assigneeId: "us_alice",
        priority: "urgent",
        dueDate: NOW,
        tags: ["bug"],
        position: 1,
        updatedAt: NOW,
      },
      buildNameIndex(map)
    );
    expect(view).toMatchObject({
      status: "Triage",
      list: "Bugs",
      space: "Engineering",
      assignee: "Alice",
      listId: "ls_bugs",
      assigneeId: "us_alice",
    });
    expect(view).not.toHaveProperty("statusId");
    expect(view).not.toHaveProperty("position");
  });
});

describe("distinctTags", () => {
  it("de-duplicates and sorts the tags in use", () => {
    expect(
      distinctTags([{ tags: ["p1", "bug"] }, { tags: ["bug"] }, { tags: [] }, { tags: ["Api"] }])
    ).toEqual(["Api", "bug", "p1"]);
  });
});
