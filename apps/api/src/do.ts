/// <reference types="@cloudflare/workers-types" />
import type { z } from "zod";
import type { ImportBatch, ImportResult, Workspace } from "@flow/core";
import {
  CreateListInput as CreateListSchema,
  CreateSpaceInput as CreateSpaceSchema,
  CreateSubtaskInput as CreateSubtaskSchema,
  ToggleSubtaskInput as ToggleSubtaskSchema,
  CreateCommentInput as CreateCommentSchema,
} from "@flow/shared";
import type {
  Actor,
  ApiKey,
  Attachment,
  AuditEntry,
  AutomationRule,
  AutomationRunLog,
  BoardSnapshot,
  BulkResult,
  BulkUpdateInput,
  Comment,
  CreateTaskInput,
  List,
  MoveTaskInput,
  NotificationPref,
  SearchTasksInput,
  SearchTasksResult,
  Space,
  SpaceVisibility,
  Subtask,
  Task,
  TaskDetail,
  UpdateTaskInput,
  UpsertAutomationInput,
  User,
  WorkspaceRpc,
} from "@flow/shared";
import { WORKSPACE_NAME, type Env } from "./env.js";
import { ApiError } from "./errors.js";

/**
 * `CreateSpaceInput`, `CreateListInput`, `CreateSubtaskInput`,
 * `ToggleSubtaskInput` and `CreateCommentInput` ship from @flow/shared as Zod
 * schemas without companion `export type` aliases, unlike their siblings.
 * Inferring here keeps the contract the single source of truth without
 * redeclaring a shape.
 */
type CreateSpaceInput = z.infer<typeof CreateSpaceSchema>;
type CreateListInput = z.infer<typeof CreateListSchema>;
type CreateSubtaskInput = z.infer<typeof CreateSubtaskSchema>;
type ToggleSubtaskInput = z.infer<typeof ToggleSubtaskSchema>;
type CreateCommentInput = z.infer<typeof CreateCommentSchema>;

type Ok = { ok: true };

/**
 * The RPC surface this Worker calls on the Workspace DO.
 *
 * `WorkspaceRpc` in @flow/shared is the authoritative contract but covers only
 * the eight task-centric methods and types their returns as `unknown`. This
 * interface extends it with everything else the REST surface needs and gives
 * every method a concrete return type, so drift between the Worker and the DO is
 * a typecheck failure rather than a runtime surprise.
 *
 * It is written to match what packages/core actually implements, including its
 * `actor: string | Actor` convention — passing the full `Actor` gets `via` and
 * `apiKeyId` into the audit trail, which is what CLAUDE.md requires and what the
 * contract's bare `actorUserId: string` has nowhere to put.
 */
export interface WorkspaceApi extends WorkspaceRpc {
  claimOwner(email: string): Promise<User | null>;
  // --- reads ----------------------------------------------------------------
  /**
   * `forUserId` applies per-space permissions: private spaces the user is not a
   * member of, and everything under them, are absent from the result. Owners and
   * admins see everything. Omitting it returns the unfiltered workspace, which
   * is for internal use only — every route and tool passes `auth.user.id`.
   */
  getSnapshot(forUserId?: string): Promise<BoardSnapshot>;
  /** Throws "Space … is private" rather than returning a task the user can't see. */
  getTaskDetail(taskId: string, forUserId?: string): Promise<TaskDetail>;
  searchTasks(input: SearchTasksInput, actor?: string | Actor): Promise<SearchTasksResult>;
  listUsers(): Promise<User[]>;
  listSubtasks(taskId: string): Promise<Subtask[]>;
  listComments(taskId: string): Promise<Comment[]>;
  listAttachments(taskId: string): Promise<Attachment[]>;
  listAutomations(): Promise<AutomationRule[]>;

  // --- notification preferences (self-service) ------------------------------
  getNotificationPrefs(userId: string): Promise<NotificationPref>;
  setNotificationPrefs(
    userId: string,
    patch: Partial<NotificationPref>
  ): Promise<NotificationPref>;

  // --- identity -------------------------------------------------------------
  /** Bearer lookup by sha256 hex; ignores revoked keys and stamps lastUsedAt. */
  resolveApiKey(tokenHash: string): Promise<{ key: ApiKey; user: User } | null>;
  listApiKeys(): Promise<ApiKey[]>;
  createApiKey(
    input: { userId: string; name: string; tokenHash: string },
    actor: string | Actor
  ): Promise<ApiKey>;
  revokeApiKey(keyId: string, actor: string | Actor): Promise<Ok>;

  // --- tasks ----------------------------------------------------------------
  createTask(input: CreateTaskInput, actor: string | Actor): Promise<Task>;
  updateTask(input: UpdateTaskInput, actor: string | Actor): Promise<Task>;
  moveTask(input: MoveTaskInput, actor: string | Actor): Promise<Task>;
  bulkUpdate(input: BulkUpdateInput, actor: string | Actor): Promise<BulkResult>;
  deleteTask(taskId: string, actor: string | Actor): Promise<Ok>;

  // --- subtasks / comments --------------------------------------------------
  createSubtask(input: CreateSubtaskInput, actor: string | Actor): Promise<Subtask>;
  toggleSubtask(input: ToggleSubtaskInput, actor: string | Actor): Promise<Subtask>;
  updateSubtask(
    input: { subtaskId: string; title?: string; assigneeId?: string | null; dueDate?: number | null; position?: number },
    actor: string | Actor
  ): Promise<Subtask>;
  deleteSubtask(subtaskId: string, actor: string | Actor): Promise<Ok>;
  createComment(input: CreateCommentInput, actor: string | Actor): Promise<Comment>;
  deleteComment(commentId: string, actor: string | Actor): Promise<Ok>;

  // --- spaces / lists -------------------------------------------------------
  createSpace(input: CreateSpaceInput, actor: string | Actor): Promise<Space>;
  updateSpace(
    input: { spaceId: string; name?: string; color?: string | null; archived?: boolean; position?: number },
    actor: string | Actor
  ): Promise<Space>;
  deleteSpace(spaceId: string, actor: string | Actor): Promise<Ok>;
  /**
   * Per-space permissions. Both are owner/admin-only — enforced by
   * `requireAdmin` on the route AND again inside the DO against the actor's
   * stored role, since these two decide who can see what.
   */
  setSpaceVisibility(
    input: { spaceId: string; visibility: SpaceVisibility },
    actor: string | Actor
  ): Promise<Space>;
  setSpaceMembers(
    input: { spaceId: string; userIds: string[] },
    actor: string | Actor
  ): Promise<{ spaceId: string; userIds: string[] }>;
  /** Member user ids for one space. Empty for a workspace-visible space. */
  listSpaceMembers(spaceId: string): Promise<string[]>;
  createList(input: CreateListInput, actor: string | Actor): Promise<List>;
  updateList(
    input: { listId: string; name?: string; archived?: boolean; position?: number; spaceId?: string },
    actor: string | Actor
  ): Promise<List>;
  deleteList(listId: string, actor: string | Actor): Promise<Ok>;
  /** Enable (minting a fresh token) or disable inbound intake for a list. */
  setListInboundToken(
    input: { listId: string; enabled: boolean },
    actor: string | Actor
  ): Promise<{ listId: string; inboundToken: string | null }>;
  /** Inbound auth: resolve the list that owns a presented token. */
  getListByInboundToken(inboundToken: string): Promise<List | null>;
  /**
   * One list WITH its `inboundToken` populated. Every other read — including
   * `getSnapshot()` — returns `inboundToken: null`, so this is the only way to
   * see the intake credential. Admin-gate every call site.
   */
  getListWithSecrets(listId: string): Promise<List | null>;

  // --- attachments ----------------------------------------------------------
  /**
   * Metadata row, written after the R2 object lands.
   *
   * `id` is optional and additive: the Worker builds the R2 key as
   * `at/<taskId>/<id>/<filename>` before uploading, so honouring it keeps the
   * key and the attachment id identical. packages/core currently generates its
   * own id and ignores this field, which is harmless — the key then embeds the
   * upload id instead — but see the agent report for the one-line fix.
   */
  createAttachment(
    input: {
      taskId: string;
      filename: string;
      r2Key: string;
      size: number;
      mimeType: string;
      id?: string;
    },
    actor: string | Actor
  ): Promise<Attachment>;
  deleteAttachment(
    attachmentId: string,
    actor: string | Actor
  ): Promise<{ ok: true; r2Key: string }>;
  getAttachment(attachmentId: string): Promise<Attachment | null>;

  /**
   * Hierarchy + statuses + users, no task rows — one call for MCP's map tool.
   * `forUserId` filters it by per-space permissions, like `getSnapshot`.
   */
  getWorkspaceMap(forUserId?: string): Promise<ReturnType<Workspace["getWorkspaceMap"]>>;

  // --- import ---------------------------------------------------------------
  /** Upserts by id-then-clickupId; never fires automations or per-row deltas. */
  importBatch(batch: ImportBatch, actor: string | Actor): Promise<ImportResult>;

  // --- automations ----------------------------------------------------------
  upsertAutomation(input: UpsertAutomationInput, actor: string | Actor): Promise<AutomationRule>;
  deleteAutomation(ruleId: string, actor: string | Actor): Promise<Ok>;
  /**
   * The `automation_runs` log the engine writes on every firing, newest first.
   * `before` is a keyset cursor over the row id, like `getAuditLog`.
   */
  listAutomationRuns(filter?: {
    ruleId?: string;
    taskId?: string;
    before?: number;
    limit?: number;
  }): Promise<AutomationRunLog[]>;

  // --- audit ----------------------------------------------------------------
  /**
   * packages/core filters on `entity`/`before`/`limit` only. `apiKeyId`,
   * `userId` and `action` are passed through (ignored today) and additionally
   * applied Worker-side by `queryAudit` below, so the documented filters are
   * correct now and become a single indexed query once the DO supports them.
   */
  getAuditLog(filter: {
    entity?: string;
    before?: number;
    limit?: number;
    apiKeyId?: string;
    userId?: string;
    action?: string;
  }): Promise<{ entries: AuditEntry[]; nextBefore: number | null }>;
}

/**
 * The single workspace DO stub, typed as the surface above.
 *
 * The cast is deliberate and confined here: `DurableObjectStub<Workspace>` erases
 * nothing at runtime, but the DO's methods are synchronous in-class and become
 * promise-returning across the RPC boundary, which the stub type does not model
 * for a superset interface.
 */
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

/** Status for a domain error thrown inside the DO. Exported for tests. */
export function statusForDoError(message: string): 404 | 422 {
  return NOT_FOUND_RE.test(message) ? 404 : 422;
}

export function workspace(env: Env): WorkspaceApi {
  const id = env.WORKSPACE.idFromName(WORKSPACE_NAME);
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
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(WORKSPACE_NAME));
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
  const wanted = email.trim().toLowerCase();
  if (wanted === "") return null;
  const users = await workspace(env).listUsers();
  return users.find((u) => u.email.toLowerCase() === wanted) ?? null;
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

/**
 * Audit query with the filters the REST contract promises.
 *
 * `entity`/`before`/`limit` go to the DO. `apiKeyId`/`userId`/`action` are
 * applied here, paging until the page is full or the log is exhausted, so a
 * filter that the DO cannot index still returns a correctly-sized page instead
 * of a short one.
 */
export async function queryAudit(
  env: Env,
  filter: {
    entity?: string;
    apiKeyId?: string;
    userId?: string;
    action?: string;
    before?: number;
    after?: number;
    limit: number;
  }
): Promise<{ entries: AuditEntry[]; cursor: number | null }> {
  const needsLocalFilter =
    filter.apiKeyId !== undefined ||
    filter.userId !== undefined ||
    filter.action !== undefined ||
    filter.after !== undefined;

  const matches = (entry: AuditEntry): boolean => {
    if (filter.apiKeyId !== undefined && entry.actor.apiKeyId !== filter.apiKeyId) return false;
    if (filter.userId !== undefined && entry.actor.userId !== filter.userId) return false;
    if (filter.action !== undefined && entry.action !== filter.action) return false;
    if (filter.after !== undefined && entry.at < filter.after) return false;
    return true;
  };

  const ws = workspace(env);
  const collected: AuditEntry[] = [];
  let before = filter.before;
  // Bounded so a narrow filter over a huge log cannot run away.
  const MAX_PAGES = 10;
  const pageSize = needsLocalFilter ? Math.min(500, Math.max(filter.limit * 4, 100)) : filter.limit;

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await ws.getAuditLog({
      ...(filter.entity !== undefined ? { entity: filter.entity } : {}),
      ...(before !== undefined ? { before } : {}),
      limit: pageSize,
      // Passed through for the day the DO indexes them.
      ...(filter.apiKeyId !== undefined ? { apiKeyId: filter.apiKeyId } : {}),
      ...(filter.userId !== undefined ? { userId: filter.userId } : {}),
      ...(filter.action !== undefined ? { action: filter.action } : {}),
    });

    for (const entry of result.entries) {
      if (matches(entry)) collected.push(entry);
      if (collected.length >= filter.limit) break;
    }

    if (collected.length >= filter.limit || result.nextBefore === null) break;
    // `after` bounds the walk: once we are past it, older pages cannot match.
    const oldest = result.entries[result.entries.length - 1];
    if (filter.after !== undefined && oldest && oldest.at < filter.after) break;
    before = result.nextBefore;
  }

  const entries = collected.slice(0, filter.limit);
  const last = entries[entries.length - 1];
  return {
    entries,
    cursor: entries.length === filter.limit && last ? last.id : null,
  };
}
