/// <reference types="@cloudflare/workers-types" />
import type { DurableObject } from "cloudflare:workers";
import type { BackupStatus, Workspace } from "@flow/core";
import type { ApiKey, SearchTasksResult, User } from "@flow/shared";
import { workspaceName, type Env } from "./env.js";
import { ApiError } from "./errors.js";

/**
 * Turn every method on a class/interface into an async RPC method, matching
 * how Cloudflare's DurableObjectStub exposes synchronous DO methods over RPC.
 */
type PromisifyMethods<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/**
 * The RPC surface this Worker calls on the Workspace DO, derived directly
 * from `@flow/core`'s `Workspace` class so drift is a typecheck failure.
 */
export type WorkspaceApi = PromisifyMethods<
  Omit<
    Workspace,
    keyof DurableObject | "fetch" | "alarm" | "webSocketMessage" | "webSocketClose" | "webSocketError"
  >
>;

/**
 * The slice of BackupStatus that is safe on the unauthenticated /api/health:
 * times and the stale flag, never the error text or the bucket key.
 */
export function publicBackupHealth(status: BackupStatus): PublicBackupHealth {
  return {
    lastSuccessAt: status.lastSuccessAt,
    lastFailureAt: status.lastFailureAt,
    stale: status.stale,
  };
}

export type PublicBackupHealth = {
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  stale: boolean;
};

/** How long an isolate reuses the last good answer for /api/health. */
export const HEALTH_CACHE_MS = 60_000;
let healthCache: { at: number; backup: PublicBackupHealth } | null = null;

/**
 * `publicBackupHealth`, cached per isolate. /api/health is public, so without
 * this every uptime ping (or anyone hammering it) is an RPC into the one DO
 * that serves every mutation. Backups move once a day, so a minute-old answer
 * loses nothing. Only successes are cached: an unreachable DO is re-checked on
 * every call, so the 503 stays live.
 */
export async function cachedBackupHealth(env: Env, now = Date.now()): Promise<PublicBackupHealth> {
  if (healthCache && now - healthCache.at < HEALTH_CACHE_MS) return healthCache.backup;
  const backup = publicBackupHealth(await workspace(env).getBackupStatus());
  healthCache = { at: now, backup };
  return backup;
}

/** Test hook: forget the cached health answer. */
export function resetHealthCache(): void {
  healthCache = null;
}

/**
 * Error messages that look like runtime faults rather than crafted domain
 * errors. Domain throws in packages/core are written for callers ("unknown
 * status 'X' for list Y; valid statuses are ...") and should surface as 422s;
 * anything matching this stays an opaque 500.
 */
const INTERNAL_ERROR_RE =
  /not a function|Cannot read|Cannot access|undefined is|is not defined|SQLITE_|internal error|Network connection lost|Durable Object.*(reset|storage)/i;

/**
 * "Task tk_x not found.", "List ls_y not found. Known lists: …" — the DO's
 * missing-entity throws. They are 404s, not 422s: the request was well-formed,
 * the thing simply is not there, and a client retrying the same body will never
 * succeed. Everything else stays a 422.
 *
 * Word-bounded so "not founded" or a message merely quoting the phrase inside a
 * larger validation error does not get misclassified.
 */
const NOT_FOUND_RE = /\bnot found\b/i;

/**
 * A spent budget the caller can wait out, so a 429: QueryRateLimiter's
 * "too many queries: …" and the sandbox's "too many changes in the sandbox: …".
 */
const RATE_LIMITED_RE = /^too many (queries|changes in the sandbox)\b/i;

/** Status for a domain error thrown inside the DO. Exported for tests. */
export function statusForDoError(message: string): 404 | 422 | 429 {
  if (RATE_LIMITED_RE.test(message)) return 429;
  return NOT_FOUND_RE.test(message) ? 404 : 422;
}

export function workspace(env: Env): WorkspaceApi {
  const id = env.WORKSPACE.idFromName(workspaceName(env));
  const stub = env.WORKSPACE.get(id) as unknown as WorkspaceApi;
  // Wrap every RPC so a domain error thrown inside the DO reaches the caller
  // as a readable 422 instead of being flattened to "internal error". Agents
  // navigate by these messages.
  return new Proxy(stub, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          // Call through the stub directly: RPC method proxies implement
          // neither .apply() nor real Promises, so invoke and await in place.
          return await (target as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[
            prop
          ]!(...args);
        } catch (err) {
          if (err instanceof ApiError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          if (!INTERNAL_ERROR_RE.test(msg)) throw new ApiError(statusForDoError(msg), msg);
          throw err;
        }
      };
    },
  });
}

/** Raw stub for the /ws upgrade, which goes through the DO's fetch handler. */
export function workspaceStub(env: Env): DurableObjectStub<Workspace> {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceName(env)));
}

// ---------------------------------------------------------------------------
// Composed lookups.
//
// These exist because the DO has no by-email / by-id / by-name user or key
// lookup, only `listUsers()` and `listApiKeys()`. This is a single-workspace,
// single-company deployment — tens of users, a handful of keys — so filtering a
// full list in the Worker costs one RPC and no measurable time. If the member
// count ever makes that wrong, they become DO methods; the call sites here do
// not change.
// ---------------------------------------------------------------------------

/** Cloudflare Access email -> workspace user. Case-insensitive. */
export async function findUserByEmail(env: Env, email: string): Promise<User | null> {
  const wanted = email.trim();
  if (wanted === "") return null;
  return workspace(env).getUserByEmail(wanted);
}

/**
 * findUserByEmail plus the first-login bootstrap: when the email is the
 * configured OWNER_EMAIL and no user matches, the DO lets it claim the seeded
 * placeholder owner (see seedIfEmpty in @flow/core). Everyone else still gets
 * a plain lookup — membership is by invitation, not by knocking.
 */
export async function resolveMemberEmail(env: Env, email: string): Promise<User | null> {
  const found = await findUserByEmail(env, email);
  if (found) return found;
  const ownerEmail = (env.OWNER_EMAIL || "").trim().toLowerCase();
  if (ownerEmail === "" || email.trim().toLowerCase() !== ownerEmail) return null;
  return workspace(env).claimOwner(ownerEmail);
}

export async function findUserById(env: Env, userId: string): Promise<User | null> {
  const users = await workspace(env).listUsers();
  return users.find((u) => u.id === userId) ?? null;
}

/** Named-key lookup, used to attribute inbound webhooks to the gleap key. */
export async function findApiKeyByName(
  env: Env,
  names: readonly string[]
): Promise<{ key: ApiKey; user: User } | null> {
  const ws = workspace(env);
  const keys = await ws.listApiKeys();
  const live = keys.filter((k) => k.revokedAt === null);
  for (const name of names) {
    const key = live.find((k) => k.name === name);
    if (!key) continue;
    const user = (await ws.listUsers()).find((u) => u.id === key.userId);
    if (user) return { key, user };
  }
  return null;
}

/**
 * Idempotency lookup for inbound webhooks.
 *
 * The DO has no by-external-id method, but the inbound route records the source
 * id as an `ext:<externalId>` tag, so a tag search answers the same question
 * using an existing indexed path.
 */
export async function findTaskByExternalIdTag(
  env: Env,
  tag: string
): Promise<SearchTasksResult["tasks"][number] | null> {
  const result = await workspace(env).searchTasks({
    tags: [tag],
    includeClosed: true,
    limit: 1,
  });
  return result.tasks[0] ?? null;
}
