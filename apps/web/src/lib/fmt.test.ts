import { describe, expect, it } from "vitest";
import {
  daysUntil,
  dueLabel,
  initials,
  snoozePreset,
  snoozeUntilLabel,
  visibleTags,
} from "./fmt.js";

describe("initials", () => {
  it.each([
    ["Ada Lovelace", "AL"],
    ["ada", "AD"],
    ["  ada   byron lovelace  ", "AL"],
    ["", "?"],
    ["   ", "?"],
  ])("formats %j as %s", (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});

describe("visibleTags", () => {
  it("drops ext: tags and preserves the remaining tags in order", () => {
    const tags = ["ext:clickup:123", "bug", "external", "ext:", "team:design"];
    expect(visibleTags(tags)).toEqual(["bug", "external", "team:design"]);
  });
});

describe("daysUntil and dueLabel", () => {
  const now = new Date(2026, 0, 7, 15).getTime();

  it.each([
    [new Date(2026, 0, 6, 9), -1, "Yesterday"],
    [new Date(2026, 0, 7, 9), 0, "Today"],
    [new Date(2026, 0, 8, 9), 1, "Tomorrow"],
    [new Date(2026, 0, 9, 9), 2, "Fri"],
    [new Date(2026, 0, 10, 9), 3, "Sat"],
    [new Date(2026, 0, 11, 9), 4, "Sun"],
    [new Date(2026, 0, 12, 9), 5, "Mon"],
    [new Date(2026, 0, 13, 9), 6, "Tue"],
    [new Date(2026, 0, 14, 9), 7, "14 Jan"],
    [new Date(2026, 2, 12, 9), 64, "12 Mar"],
    [new Date(2027, 0, 7, 9), 365, "7 Jan 27"],
  ])("formats %s (%i days away) as %s", (date, days, label) => {
    expect(daysUntil(date.getTime(), now)).toBe(days);
    expect(dueLabel(date.getTime(), now)).toBe(label);
  });
});

describe("snoozePreset", () => {
  it.each([
    {
      day: "Wednesday",
      now: new Date(2026, 0, 7, 15, 30, 45, 123),
      tomorrow: new Date(2026, 0, 8, 9),
      week: new Date(2026, 0, 12, 9),
    },
    {
      day: "Monday before 9am",
      now: new Date(2026, 0, 5, 7, 30, 45, 123),
      tomorrow: new Date(2026, 0, 6, 9),
      week: new Date(2026, 0, 12, 9),
    },
  ])("returns tomorrow and next Monday at 9am from $day", ({ now, tomorrow, week }) => {
    expect(snoozePreset("tomorrow", now.getTime())).toBe(tomorrow.getTime());
    expect(snoozePreset("week", now.getTime())).toBe(week.getTime());
  });
});

describe("snoozeUntilLabel", () => {
  const now = new Date(2026, 0, 7, 15).getTime();

  it.each([
    [new Date(2026, 0, 6, 9), "Snoozed until yesterday"],
    [new Date(2026, 0, 7, 9), "Snoozed until today"],
    [new Date(2026, 0, 8, 9), "Snoozed until tomorrow"],
    [new Date(2026, 0, 9, 9), "Snoozed until Fri"],
    [new Date(2026, 2, 12, 9), "Snoozed until 12 Mar"],
  ])("formats %s as %s", (date, expected) => {
    expect(snoozeUntilLabel(date.getTime(), now)).toBe(expected);
  });
});
