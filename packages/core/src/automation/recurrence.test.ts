import { describe, expect, it } from "vitest";
import { dueDateWithCutoff, nextRecurringDue } from "./recurrence.js";

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

describe("dueDateWithCutoff", () => {
  const NY = "America/New_York";
  // Noon New York: 16:00 UTC while daylight time runs, 17:00 UTC after Nov 1.
  const noonEdt = (month: number, day: number) => Date.UTC(2026, month - 1, day, 16);
  const noonEst = (month: number, day: number) => Date.UTC(2026, month - 1, day, 17);
  const at = (month: number, day: number, hourUtc: number, minute = 0) =>
    Date.UTC(2026, month - 1, day, hourUtc, minute);

  it("is due the same day before the cutoff and the next day from it on", () => {
    // Thursday Oct 15: 9:59 a.m. EDT is 13:59 UTC, 10:00 a.m. is 14:00 UTC.
    expect(dueDateWithCutoff(at(10, 15, 13, 59), 10, NY, true)).toBe(noonEdt(10, 15));
    expect(dueDateWithCutoff(at(10, 15, 14, 0), 10, NY, true)).toBe(noonEdt(10, 16));
  });

  it("uses the New York day, not the UTC day, for a late-evening arrival", () => {
    // 11 p.m. Thursday in New York is already Friday in UTC.
    expect(dueDateWithCutoff(at(10, 16, 3, 0), 10, NY, true)).toBe(noonEdt(10, 16));
  });

  it("rolls a Friday-afternoon arrival to Monday on business days, to Saturday otherwise", () => {
    const fridayAfternoon = at(10, 16, 15, 0); // 11 a.m. EDT
    expect(dueDateWithCutoff(fridayAfternoon, 10, NY, true)).toBe(noonEdt(10, 19));
    expect(dueDateWithCutoff(fridayAfternoon, 10, NY, false)).toBe(noonEdt(10, 17));
  });

  it("sends any weekend arrival to Monday on business days, whatever the hour", () => {
    expect(dueDateWithCutoff(at(10, 17, 12, 0), 10, NY, true)).toBe(noonEdt(10, 19)); // Sat 8 a.m.
    expect(dueDateWithCutoff(at(10, 19, 3, 0), 10, NY, true)).toBe(noonEdt(10, 19)); // Sun 11 p.m.
  });

  it("lands on local noon across the November daylight-saving change", () => {
    // Friday Oct 30, 3 p.m. EDT -> Monday Nov 2, after clocks fall back.
    expect(dueDateWithCutoff(at(10, 30, 19, 0), 10, NY, true)).toBe(noonEst(11, 2));
  });

  it("rejects an unknown timezone instead of guessing", () => {
    expect(() => dueDateWithCutoff(at(10, 15, 14), 10, "Not/AZone", true)).toThrow();
  });
});
