// Formatting helpers. Date/priority/initials formatting
// is shared with the board through lib/fmt so a chip reads the same everywhere;
// what's here is what only the shell and the task panel need.
import { dueLabel, isOverdue as isOverdueTs } from "../lib/fmt.js";

export { initials, dueLabel as formatDue } from "../lib/fmt.js";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function today(): number {
  return startOfDay(Date.now());
}

/** Nullable wrapper: an unset due date is never overdue. */
export function isOverdue(ts: number | null): boolean {
  return ts !== null && isOverdueTs(ts);
}

/** "just now", "4m ago", "3h ago", "2d ago", then a date. */
export function relativeTime(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return dueLabel(ts);
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Epoch ms -> "YYYY-MM-DD" in the viewer's local timezone. */
export function toDateInput(ts: number | null): string {
  if (ts === null) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * "YYYY-MM-DD" -> epoch ms at local noon. Noon rather than midnight so no
 * timezone shift can move the date to the day before on read-back.
 */
export function fromDateInput(v: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0).getTime();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
