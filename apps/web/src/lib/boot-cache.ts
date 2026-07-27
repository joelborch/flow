// The boot cache: last known snapshot + seq in localStorage, so a reload paints
// the real board immediately and the socket only has to replay the deltas since.
//
// THE STORAGE KEY AND THE RECORD LAYOUT ARE MIRRORED BY THE INLINE SCRIPT IN
// index.html. That script opens the WebSocket before the bundle has even been
// fetched, and to send a useful `hello` it needs the seq — which it lifts out of
// this record with a regex rather than parsing a megabyte of JSON in <head>.
// That works only because `seq` is serialised BEFORE `snapshot` (see `write`
// below), so the first `"seq":` in the string is the top-level one. Change the
// key, the field name, or the field order here and you must change it there too.

import type { BoardSnapshot, User } from "@flow/shared";

/**
 * Cache format version. Anything persisted under a different stamp is thrown
 * away on boot rather than migrated — the cache is a pure optimisation and the
 * socket will refill it in one round trip.
 *
 * 1 — snapshots carried full `Task` rows.
 * 2 — snapshots carry `SnapshotTask` (no description/startDate/createdBy/
 *     closedAt/clickupId, plus `hasDescription`).
 */
export const SCHEMA_STAMP = 2;

/** Mirrored in index.html. */
export const BOOT_KEY = "flow.boot";
/** The /api/me answer, so the first paint knows who you are. */
export const ME_KEY = "flow.me";

export type BootCache = {
  v: number;
  userId: string;
  seq: number;
  snapshot: BoardSnapshot;
};

let disabled = false;

export function readBootCache(): BootCache | null {
  try {
    const raw = localStorage.getItem(BOOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BootCache>;
    if (
      parsed.v !== SCHEMA_STAMP ||
      typeof parsed.userId !== "string" ||
      typeof parsed.seq !== "number" ||
      !parsed.snapshot ||
      !Array.isArray(parsed.snapshot.tasks)
    ) {
      clearBootCache();
      return null;
    }
    return parsed as BootCache;
  } catch {
    // Corrupt entry or private mode. Either way, boot as if there were none.
    clearBootCache();
    return null;
  }
}

/**
 * Persist the board. Key order matters: `seq` must be written before
 * `snapshot` so index.html can find it without parsing (see the file header).
 */
export function writeBootCache(userId: string, seq: number, snapshot: BoardSnapshot): void {
  if (disabled) return;
  const record: BootCache = { v: SCHEMA_STAMP, userId, seq, snapshot };
  try {
    localStorage.setItem(BOOT_KEY, JSON.stringify(record));
  } catch {
    // Out of quota, or storage denied. Drop the stale entry and stop trying for
    // this page — a half-written board is worse than none.
    disabled = true;
    clearBootCache();
  }
}

export function clearBootCache(): void {
  try {
    localStorage.removeItem(BOOT_KEY);
  } catch {
    /* nothing we can do, and nothing depends on it */
  }
}

export function readCachedMe(): User | null {
  try {
    const raw = localStorage.getItem(ME_KEY);
    if (!raw) return null;
    const user = JSON.parse(raw) as Partial<User>;
    return typeof user.id === "string" && typeof user.email === "string" ? (user as User) : null;
  } catch {
    return null;
  }
}

export function writeCachedMe(user: User): void {
  try {
    localStorage.setItem(ME_KEY, JSON.stringify(user));
  } catch {
    /* optional; the app works without it */
  }
}

/** Whose board this page hydrated from, or null if it booted cold. */
let bootUserId: string | null = null;

export function setBootUserId(userId: string): void {
  bootUserId = userId;
}

/**
 * The identity check for a cached boot. We hydrate before we know who the
 * request will authenticate as, so the real /api/me answer has to be reconciled
 * afterwards: a different user means the board on screen is someone else's, and
 * the only safe move is to wipe both caches and reload into a clean fetch.
 * Returns true when it is reloading, so callers can stop.
 */
export function reconcileBootUser(user: User): boolean {
  if (bootUserId !== null && bootUserId !== user.id) {
    clearBootCache();
    try {
      localStorage.removeItem(ME_KEY);
    } catch {
      /* the reload is what matters */
    }
    location.reload();
    return true;
  }
  bootUserId = user.id;
  writeCachedMe(user);
  return false;
}
