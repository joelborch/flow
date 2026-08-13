import type { CalendarRecurrence } from "@flow/shared";

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timeZone);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatters.set(timeZone, created);
  return created;
}

function localParts(epochMs: number, timeZone: string): LocalParts {
  const values = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(epochMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  } as LocalParts;
}

function localAsUtc(parts: LocalParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
}

/** Convert a wall-clock time in an IANA zone to epoch ms without a date library. */
function epochForLocal(parts: LocalParts, timeZone: string): number {
  const target = localAsUtc(parts);
  let guess = target;
  // Two passes cover offset changes around DST boundaries. Recurring task times
  // are ordinary daytime values, so ambiguous/non-existent wall times do not apply.
  for (let pass = 0; pass < 3; pass += 1) {
    const observed = localAsUtc(localParts(guess, timeZone));
    const corrected = guess + (target - observed);
    if (corrected === guess) return guess;
    guess = corrected;
  }
  return guess;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(parts: LocalParts, days: number): LocalParts {
  const value = new Date(localAsUtc(parts));
  value.setUTCDate(value.getUTCDate() + days);
  return {
    ...parts,
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function addMonths(parts: LocalParts, months: number): LocalParts {
  const index = parts.year * 12 + parts.month - 1 + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return { ...parts, year, month, day: Math.min(parts.day, daysInMonth(year, month)) };
}

function addYears(parts: LocalParts, years: number): LocalParts {
  const year = parts.year + years;
  return { ...parts, year, day: Math.min(parts.day, daysInMonth(year, parts.month)) };
}

export function nextRecurringDue(
  currentDueMs: number,
  recurrence: CalendarRecurrence,
  timeZone: string
): number {
  // Validate the zone up front so a malformed rule fails its action visibly.
  formatter(timeZone).format(new Date(currentDueMs));
  const current = localParts(currentDueMs, timeZone);
  let next: LocalParts;
  switch (recurrence.kind) {
    case "weekdays": {
      next = addDays(current, 1);
      while ([0, 6].includes(new Date(localAsUtc(next)).getUTCDay())) {
        next = addDays(next, 1);
      }
      break;
    }
    case "weekly":
      next = addDays(current, 7 * recurrence.interval);
      break;
    case "monthly":
      next = addMonths(current, recurrence.interval);
      break;
    case "yearly":
      next = addYears(current, recurrence.interval);
      break;
  }
  return epochForLocal(next, timeZone);
}
