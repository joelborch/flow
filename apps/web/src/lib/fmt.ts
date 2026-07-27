// Small display formatters shared by the board and (optionally) the shell.
import type { Priority, User } from "@flow/shared";

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]!;
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  return (first[0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Stable per-user hue so an avatar keeps the same colour everywhere. */
export function avatarHue(user: Pick<User, "id">): number {
  let h = 0;
  for (let i = 0; i < user.id.length; i++) h = (h * 31 + user.id.charCodeAt(i)) % 360;
  return h;
}

const DAY = 86_400_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole days from today to `ts` — negative in the past, 0 today. */
export function daysUntil(ts: number, now = Date.now()): number {
  return Math.round((startOfDay(ts) - startOfDay(now)) / DAY);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Terse date for a card chip: "Today", "Tue", "12 Mar". */
export function dueLabel(ts: number, now = Date.now()): string {
  const d = daysUntil(ts, now);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d === -1) return "Yesterday";
  const date = new Date(ts);
  if (d > 1 && d < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  const label = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? label
    : `${label} ${String(date.getFullYear()).slice(2)}`;
}

export function isOverdue(ts: number, now = Date.now()): boolean {
  return daysUntil(ts, now) < 0;
}

/**
 * Is this task parked right now? The server's hourly sweep is what actually
 * clears an expired snooze, so a card can sit here with a wake time up to an
 * hour in the past; reading the clock rather than waiting for the delta means
 * the board un-hides it the moment it is due, and the sweep's delta just
 * confirms what the UI already showed.
 */
export function isSnoozed(snoozedUntil: number | null, now = Date.now()): boolean {
  return snoozedUntil !== null && snoozedUntil > now;
}

/** Card chip copy: "zZ Tomorrow", "zZ 12 Mar". */
export function snoozeLabel(ts: number, now = Date.now()): string {
  return `zZ ${dueLabel(ts, now)}`;
}

/** Panel copy: "Snoozed until tomorrow", "Snoozed until Fri", "Snoozed until 12 Mar". */
export function snoozeUntilLabel(ts: number, now = Date.now()): string {
  const label = dueLabel(ts, now);
  // "Tomorrow" is a common noun mid-sentence; "Fri" and "12 Mar" are not.
  const relative = label === "Today" || label === "Tomorrow" || label === "Yesterday";
  return `Snoozed until ${relative ? label.toLowerCase() : label}`;
}

/** Tomorrow / next Monday at 9am local — the two snooze presets. */
export function snoozePreset(kind: "tomorrow" | "week", now = Date.now()): number {
  const d = new Date(now);
  d.setHours(9, 0, 0, 0);
  if (kind === "tomorrow") {
    d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // Next Monday; a snooze taken on a Monday lands on the following one, never
  // "in a few hours".
  const daysToMonday = ((8 - d.getDay()) % 7) || 7;
  d.setDate(d.getDate() + daysToMonday);
  return d.getTime();
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

export const PRIORITY_COLOR: Record<Priority, string> = {
  urgent: "var(--color-danger)",
  high: "var(--color-warn)",
  normal: "var(--color-accent)",
  // Muted but readable as text — line tokens fail contrast when used as labels.
  low: "var(--color-muted)",
};

export const PRIORITY_ORDER: Priority[] = ["urgent", "high", "normal", "low"];
