import { describe, expect, it } from "vitest";
import { nextRecurringDue } from "./recurrence.js";

const zone = "America/New_York";
const epoch = (iso: string) => Date.parse(iso);

describe("nextRecurringDue", () => {
  it("moves a Friday weekday task to Monday at the same local time", () => {
    expect(nextRecurringDue(epoch("2026-08-14T09:00:00-04:00"), { kind: "weekdays" }, zone)).toBe(
      epoch("2026-08-17T09:00:00-04:00")
    );
  });

  it("preserves local time when a weekly task crosses DST", () => {
    expect(
      nextRecurringDue(
        epoch("2026-10-30T12:00:00-04:00"),
        { kind: "weekly", interval: 1 },
        zone
      )
    ).toBe(epoch("2026-11-06T12:00:00-05:00"));
  });

  it("clamps month-end and preserves calendar month intervals", () => {
    expect(
      nextRecurringDue(
        epoch("2026-01-31T12:00:00-05:00"),
        { kind: "monthly", interval: 1 },
        zone
      )
    ).toBe(epoch("2026-02-28T12:00:00-05:00"));
    expect(
      nextRecurringDue(
        epoch("2026-11-03T12:00:00-05:00"),
        { kind: "monthly", interval: 3 },
        zone
      )
    ).toBe(epoch("2027-02-03T12:00:00-05:00"));
  });

  it("handles leap-day yearly schedules", () => {
    expect(
      nextRecurringDue(
        epoch("2028-02-29T12:00:00-05:00"),
        { kind: "yearly", interval: 1 },
        zone
      )
    ).toBe(epoch("2029-02-28T12:00:00-05:00"));
  });
});
