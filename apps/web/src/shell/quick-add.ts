import { signal } from "@preact/signals";
import { parse as parseEnglish } from "chrono-node/en";
import type { List, Space, User } from "@flow/shared";

/** Structural names the personal quick-add target is resolved against — see
 *  resolveQuickAddDestination below. */
export const PERSONAL_SPACE_NAME = "Personal";
export const WORK_INBOX_LIST_NAME = "Inbox";

export const quickAddOpen = signal(false);

export function openQuickAdd(): void {
  quickAddOpen.value = true;
}

export function closeQuickAdd(): void {
  quickAddOpen.value = false;
}

/**
 * Quick add is an owner convenience, not a per-user preference: it only makes
 * sense once the workspace has a personal inbox set up for its owner, and
 * "owner" is a role every workspace already has exactly one (or a few) of,
 * rather than a hardcoded account.
 */
export function canUseQuickAdd(me: Pick<User, "role"> | null | undefined): boolean {
  return me?.role === "owner";
}

export type QuickAddDestination = {
  listId: string;
  status: string;
  assigneeId: string;
  label: string;
};

/**
 * Resolves the personal quick-add target structurally instead of against
 * fixed ids: the target is the current user's own private space named
 * "Personal" (owners see every private space regardless of membership — see
 * settings/Spaces.tsx) and the list named "Inbox" inside it. There is
 * deliberately no fallback list — if that space/list hasn't been set up yet,
 * the feature is simply off for this workspace.
 */
export function resolveQuickAddDestination(
  me: Pick<User, "id" | "role"> | null | undefined,
  spaces: readonly Space[],
  lists: readonly List[]
): QuickAddDestination | null {
  if (!canUseQuickAdd(me) || !me) return null;

  const space = spaces.find(
    (s) => s.name === PERSONAL_SPACE_NAME && s.visibility === "private" && !s.archived
  );
  if (!space) return null;

  const list = lists.find(
    (l) => l.name === WORK_INBOX_LIST_NAME && l.spaceId === space.id && !l.archived
  );
  if (!list) return null;

  const status = list.statuses.find((item) => item.name === "To Do" && item.type === "open");
  if (!status) return null;

  return {
    listId: list.id,
    status: status.name,
    assigneeId: me.id,
    label: `${space.name} / ${list.name}`,
  };
}

export type RecognizedDueDate = {
  title: string;
  dueDate: number;
  text: string;
  index: number;
};

function localNoon(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
}

/**
 * Recognize one date-only phrase at the end of a task title. `ignoredInput`
 * models a dismissed interpretation: recognition resumes as soon as the user
 * changes the input.
 */
export function recognizeDueDate(
  input: string,
  reference = new Date(),
  ignoredInput: string | null = null
): RecognizedDueDate | null {
  if (input === ignoredInput) return null;
  const candidate = input.trimEnd();
  if (!candidate) return null;

  const alias = /(?:^|\s)(TOM|tom)$/.exec(candidate);
  if (alias) {
    const index = alias.index + alias[0].length - alias[1]!.length;
    const date = new Date(reference);
    date.setDate(date.getDate() + 1);
    return {
      title: candidate.slice(0, alias.index).trimEnd(),
      dueDate: localNoon(date.getFullYear(), date.getMonth() + 1, date.getDate()),
      text: alias[1]!,
      index,
    };
  }

  const results = parseEnglish(candidate, reference, { forwardDate: true });
  const result = results.find((item) => item.index + item.text.length === candidate.length);
  if (!result || result.start.isCertain("hour") || result.start.isCertain("minute")) return null;
  if (!result.start.isCertain("day") && !result.start.isCertain("weekday")) return null;

  // "every Monday" is recurrence, which Flow's date-only quick add must not
  // silently flatten into one Monday.
  const before = candidate.slice(0, result.index);
  if (/(?:^|\s)(?:every|each)\s*$/i.test(before)) return null;

  const year = result.start.get("year");
  const month = result.start.get("month");
  const day = result.start.get("day");
  if (!year || !month || !day) return null;

  return {
    title: before.trimEnd(),
    dueDate: localNoon(year, month, day),
    text: result.text,
    index: result.index,
  };
}

type ShortcutEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  target: EventTarget | null;
};

function isTypingElement(target: EventTarget | Element | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return false;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" ||
    element.isContentEditable === true
  );
}

export function shouldOpenQuickAdd(
  event: ShortcutEvent,
  activeElement: Element | null,
  blockingModalOpen: boolean
): boolean {
  if (event.key.toLowerCase() !== "q" || event.repeat) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (blockingModalOpen) return false;
  return !isTypingElement(event.target) && !isTypingElement(activeElement);
}
