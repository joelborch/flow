/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import type {
  Actor, ApiKey, Attachment, AuditEntry, AutomationRule, AutomationRunLog, BoardSnapshot,
  BulkResult, BulkUpdateInput, Comment, CreateTaskInput, EmailIntake, List, ListHandoffsInput, MoveTaskInput,
  NotificationPref, ReplyHandoffInput, RequestHandoffInput, SearchTasksInput, SearchTasksResult,
  SetEmailIntakeInput, Space, SpaceVisibility, Status, Subtask, Task, TaskDetail, UpdateTaskInput,
  UpsertAutomationInput, User, WorkspaceRpc,
} from "@flow/shared";
import { armAlarm, getBackupStatus, handleAlarm, runBackupNow, runJob, scheduleJob } from "./alarm.js";
import { deleteAutomation, listAutomationRuns, upsertAutomation } from "./automation-apply.js";
import type { JobRow } from "./rows.js";
import {
  type BackupStatus, type CreateApiKeyInput, type CreateAttachmentInput, type Env,
  type ParsedCommentInput, type ParsedListInput, type ParsedSpaceInput, type ParsedSubtaskInput,
  type ParsedToggleInput, type SetAttachmentDriveStorageInput, type UpsertUserInput,
  type WorkspaceHost, getAttachment, listAttachments, listAutomations, listComments, listSubtasks,
  listUsers, markEmailReply, recordDeliveryFailure, requireSpace,
} from "./db-helpers.js";
import { checkEmailIntake, ingestEmail, listEmailIntakes, setEmailIntake } from "./email-intake-store.js";
import type { EmailIntakeCheck, IngestEmailInput, IngestEmailResult } from "./email-intake.js";
import { listHandoffs, replyHandoff, requestHandoff } from "./handoffs-store.js";
import { executeTaskTurn, executeTurn, getNotificationPrefs, setNotificationPrefs } from "./notify-drain.js";
import { QueryRateLimiter, type QueryResult } from "./query.js";
import {
  getAuditLog, getListByInboundToken, getListWithSecrets, getSnapshot, getTaskDetail, getTaskDetails,
  getUserByEmail, getWorkspaceMap, listApiKeys, resolveApiKey, runQuery, searchTasks,
} from "./reads.js";
import { SandboxWriteBudget } from "./sandbox-seed.js";
import {
  ASSIGNMENT_ATTRIBUTION_MIGRATION_ID, CHANGES_SPACE_ID_MIGRATION_ID, needsMigration,
  runMigrations, seedIfEmpty, seedJobs,
} from "./schema.js";
import { bumpResyncFloor } from "./sync-floor.js";
import {
  bulkUpdate, clearPendingObjectDeletes, createAttachment, createComment, createSubtask, createTask,
  deleteAttachment, deleteComment, deleteSubtask, deleteTask, markAttachmentDriveCleanupComplete,
  moveTask, setAttachmentDriveStorage, toggleSubtask, updateSubtask, updateTask,
} from "./task-mutations.js";
import { listSpaceMemberIds, visibleSpaceIds } from "./visibility.js";
import {
  claimOwner, createApiKey, createList, createSpace, deleteList, deleteSpace, revokeApiKey,
  seedSandbox, setApiKeyEmailRequesters, setListInboundToken, setSpaceMembers, setSpaceVisibility,
  updateList, updateSpace, upsertUser, wipeSandbox,
} from "./workspace-mutations.js";
import { handleWsClose, handleWsError, handleWsFetch, handleWsMessage } from "./ws.js";

export {
  SANDBOX_KEY_NAME, SANDBOX_MEMBER_ID, SANDBOX_WRITES_PER_MINUTE, SandboxBusy, SandboxWriteBudget,
} from "./sandbox-seed.js";
export type {
  EmailIngestAttachment, EmailIntakeCheck, IngestEmailInput, IngestEmailResult,
} from "./email-intake.js";
export {
  EMAIL_INGEST_PERMANENT_ERROR, EMAIL_INTAKE_HOURLY_LIMIT, EMAIL_INTAKE_LIST_HOURLY_LIMIT,
  EMAIL_INTAKE_TAG, EMAIL_INTAKE_UNVERIFIED_TAG, EMAIL_REPLY_REFERENCE_LIMIT, SYNTHETIC_ID_PREFIX,
  messageIdsIn, normalizeMessageId, replySubject, senderAllowed, type EmailReplyTarget,
} from "./email-intake.js";
export { ID_PREFIX, INBOUND_TOKEN_PREFIX, id, token } from "./id.js";
export { HANDOFF_TAG, OPEN_HANDOFF_STATES } from "./handoffs.js";
export {
  AUDIT_PRUNE_BATCH, AUDIT_PRUNE_MAX_BATCHES, AUDIT_RETENTION_DAYS, AUTOMATION_RUNS_RETENTION,
  BACKUP_RETENTION, BACKUP_STALE_MS, CHANGES_RETENTION, SNAPSHOT_CLOSED_WINDOW_MS, type BackupStatus,
  type CreateApiKeyInput, type CreateAttachmentInput, type Env, type SetAttachmentDriveStorageInput,
  type UpsertUserInput,
} from "./db-helpers.js";
// Queues' per-message (128KB) and per-sendBatch (100 msgs / 256KB) limits:
// oversized payloads are truncated to fit, and chunking respects both caps.
export {
  SIDE_EFFECTS_BATCH_BYTES, SIDE_EFFECTS_BATCH_SIZE, SIDE_EFFECTS_MESSAGE_BYTES,
  TRUNCATION_MARKER, chunkSideEffects, fitSideEffect, sideEffectBytes,
} from "./side-effect-size.js";
/** Re-exported so callers can reuse the fractional-ordering maths. */
export { between as positionBetween, POSITION_STEP } from "./position.js";
// REPLAY_GAP_LIMIT lives in ./sync-floor.ts with the rest of the
// snapshot-vs-replay decision; re-exported below to keep the surface stable.
export { REPLAY_GAP_LIMIT } from "./sync-floor.js";
export {
  QUERY_DEFAULT_ROWS, QUERY_MAX_ROWS, QUERY_MEMBER_MAX_ROWS, QUERY_MEMBER_PER_MINUTE,
  QUERY_VIEWS, QueryRejected, type QueryResult,
} from "./query.js";

/**
 * The workspace Durable Object: a single instance holds the entire workspace
 * (all spaces/lists/tasks) in its SQLite storage. It is the ONLY writer.
 *
 * Every mutation runs as one synchronous turn — rows, one Delta per entity
 * change in `changes`, an audit row, inline automation evaluation — and only
 * then broadcasts to hibernating WebSockets and enqueues outbound side effects.
 */
export class Workspace extends DurableObject<Env> implements WorkspaceRpc {
  private readonly sql: SqlStorage;
  /** Members' runQuery budget; in memory, so an eviction resets it. */
  private readonly queryLimiter = new QueryRateLimiter();
  /** Sandbox only: one write budget every visitor shares (see SandboxWriteBudget). */
  private readonly sandboxWrites = new SandboxWriteBudget();
  private readonly host: WorkspaceHost;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.host = {
      ctx,
      env,
      sql: this.sql,
      queryLimiter: this.queryLimiter,
      sandboxWrites: this.sandboxWrites,
      /** Cached view of the armed alarm so mutations rarely await getAlarm(). */
      armedAlarm: null,
      maxSeq: () => this.maxSeq(),
      runTurn: (actor, fn, silent = false) => executeTurn(this.host, actor, fn, silent),
      runTaskTurn: (actor, fn) => executeTaskTurn(this.host, actor, fn),
      armAlarm: () => armAlarm(this.host),
      getSnapshot: (forUserId) => getSnapshot(this.host, forUserId),
    };

    // Hot path: one SELECT on _migrations plus seedJobs' per-kind guards
    // (three COUNTs on a table with a handful of rows). Only a genuinely
    // out-of-date instance — or one missing a newly-added job kind — pays
    // for blockConcurrencyWhile.
    if (needsMigration(this.sql)) {
      ctx.blockConcurrencyWhile(async () => {
        // Explicit SAVEPOINT/BEGIN through sql.exec is forbidden in the DO
        // runtime; transactionSync is the sanctioned per-migration atomicity
        // (it rolls back automatically when the callback throws).
        const applied = runMigrations(this.sql, (fn) => ctx.storage.transactionSync(fn));
        // Pre-0007 changes rows carry no space_id, so replaying them can
        // withhold legitimate delete-deltas from members (fail-closed
        // fallback in filterReplay). Bump the resync floor to the current
        // MAX(seq) exactly once when either snapshot-affecting migration first
        // applies, so every client's next hello takes one full snapshot.
        if (
          applied.includes(CHANGES_SPACE_ID_MIGRATION_ID) ||
          applied.includes(ASSIGNMENT_ATTRIBUTION_MIGRATION_ID)
        ) {
          bumpResyncFloor(this.sql, this.maxSeq());
        }
        seedIfEmpty(this.sql);
        if (env.SANDBOX !== "true") seedJobs(this.sql);
        await armAlarm(this.host);
      });
    } else if (env.SANDBOX !== "true" && seedJobs(this.sql) > 0) {
      // A job kind added after this workspace last migrated (seedJobs used to
      // run only on an empty scheduled_jobs table, which left new kinds dead
      // on existing workspaces). Re-arm so the new job's run_at is honored.
      ctx.blockConcurrencyWhile(async () => {
        await armAlarm(this.host);
      });
    }
  }

  private maxSeq(): number {
    return this.sql.exec<{ v: number }>("SELECT COALESCE(MAX(seq), 0) AS v FROM changes").one().v;
  }

  // =========================================================================
  // WebSockets (Hibernation API)
  // =========================================================================

  /**
   * WebSocket upgrade at `/ws`. The api Worker authenticates the request and
   * forwards it with `?userId=us_…`; the DO does not re-authenticate.
   */
  fetch(req: Request): Response { return handleWsFetch(this.host, req); }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return handleWsMessage(this.host, ws, message);
  }
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    handleWsClose(ws, code, reason);
  }
  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> { handleWsError(error); }

  // =========================================================================
  // Notification preferences (per user, self-service via the REST layer)
  // =========================================================================

  getNotificationPrefs(userId: string): NotificationPref { return getNotificationPrefs(this.sql, userId); }
  /** Merge the patch onto the user's current prefs and persist the full set. */
  setNotificationPrefs(userId: string, patch: Partial<NotificationPref>): NotificationPref {
    return setNotificationPrefs(this.sql, userId, patch);
  }

  /**
   * Every space id this user may see, or null for owners and admins — null is
   * the "no filtering needed" signal, not "sees nothing".
   */
  visibleSpaceIds(userId: string): string[] | null {
    const visible = visibleSpaceIds(this.sql, userId);
    return visible === null ? null : [...visible];
  }
  /** Members of a space, oldest first. Owner/admin-gated by the caller. */
  listSpaceMembers(spaceId: string): string[] {
    requireSpace(this.sql, spaceId);
    return listSpaceMemberIds(this.sql, spaceId);
  }

  // =========================================================================
  // Reads
  // =========================================================================

  /**
   * Full board state. Closed tasks whose closedAt is older than 60 days are
   * omitted to keep the payload bounded — they stay queryable via searchTasks
   * with `includeClosed: true`.
   *
   * `forUserId` applies per-space permissions: spaces the user cannot see, and
   * every list, task and subtask under them, are absent from the result.
   * Omitting it returns the unfiltered workspace and is for internal callers
   * only — every request-serving path passes the authenticated user's id.
   */
  getSnapshot(forUserId?: string): BoardSnapshot { return getSnapshot(this.host, forUserId); }

  /**
   * Lightweight hierarchy for MCP `flow_get_workspace_map` and pickers.
   * `forUserId` filters it by per-space permissions, exactly as getSnapshot does.
   */
  getWorkspaceMap(forUserId?: string): {
    seq: number;
    spaces: Array<
      Space & { lists: Array<{ id: string; name: string; archived: boolean; statuses: Status[]; openTasks: number }> }
    >;
    users: User[];
  } { return getWorkspaceMap(this.host, forUserId); }

  /**
   * One task with its children. `forUserId` refuses the read when the task
   * lives in a space that user cannot see — with the same sentence a blocked
   * write gets, rather than a bare 404, so nobody wastes time on a "missing"
   * task that is simply someone else's.
   */
  getTaskDetail(taskId: string, forUserId?: string): TaskDetail {
    return getTaskDetail(this.host, taskId, forUserId);
  }

  /**
   * Many tasks' details in one DO turn, so a reader such as the monthly backup
   * makes one RPC per page instead of one per task, and every detail in the
   * batch comes from the same workspace state. A missing or hidden task becomes
   * an entry in `errors` with getTaskDetail's message rather than failing the
   * whole batch.
   */
  getTaskDetails(
    taskIds: string[],
    forUserId?: string
  ): { details: TaskDetail[]; errors: Array<{ taskId: string; error: string }> } {
    return getTaskDetails(this.host, taskIds, forUserId);
  }

  /**
   * `actor` is optional for internal callers; when present, results are limited
   * to the spaces that user may see (including `total`, so paging stays honest).
   */
  searchTasks(input: SearchTasksInput, actor?: string | Actor): SearchTasksResult {
    return searchTasks(this.sql, input, actor);
  }
  listUsers(): User[] { return listUsers(this.sql); }
  getUserByEmail(email: string): User | null { return getUserByEmail(this.sql, email); }

  /**
   * First-login bootstrap: lets OWNER_EMAIL claim the seeded owner@placeholder.flow row.
   */
  claimOwner(email: string): User | null { return claimOwner(this.host, email); }
  listSubtasks(taskId: string): Subtask[] { return listSubtasks(this.sql, taskId); }
  listComments(taskId: string): Comment[] { return listComments(this.sql, taskId); }
  listAttachments(taskId: string): Attachment[] { return listAttachments(this.sql, taskId); }
  /** Single attachment row — the api Worker needs r2Key to stream a download. */
  getAttachment(attachmentId: string): Attachment | null { return getAttachment(this.sql, attachmentId); }
  listAutomations(): AutomationRule[] { return listAutomations(this.sql); }

  /**
   * Automation run log, newest first.
   *
   * `before` is a keyset cursor (the previous page's smallest `id`), matching
   * how getAuditLog pages: an offset would skip or repeat rows as new runs land
   * between requests.
   */
  listAutomationRuns(
    filter: { ruleId?: string; taskId?: string; before?: number; limit?: number } = {}
  ): AutomationRunLog[] { return listAutomationRuns(this.sql, filter); }

  /**
   * Correct the "queued" automation_runs row a webhook/email action wrote at
   * enqueue time (runAction in the automation engine always logs `ok: true`
   * before delivery is attempted, since delivery happens out-of-band in the
   * queue consumer). Called by the side-effects consumer for a permanent
   * (non-retryable) failure, and by the flow-dlq consumer once retries are
   * exhausted. Writes a plain bookkeeping row directly — this runs outside any
   * mutation turn, so there is no delta to broadcast and no audit trail entry,
   * same as writeRunLog. Never throws: a failure here must not crash the queue
   * consumer that called it.
   */
  recordDeliveryFailure(input: {
    ruleId: string; taskId: string; kind: "webhook" | "email"; detail: string;
  }): { ok: true } { return recordDeliveryFailure(this.sql, input); }

  getAuditLog(
    filter: {
      entity?: string;
      /** Mutation name, e.g. "task.update". */
      action?: string;
      userId?: string;
      apiKeyId?: string;
      /** Keyset cursor: the previous page's `nextBefore`. */
      before?: number;
      /** Inclusive lower timestamp bound (`at >= after`). */
      after?: number;
      limit?: number;
    } = {}
  ): { entries: AuditEntry[]; nextBefore: number | null } { return getAuditLog(this.sql, filter); }

  /**
   * Deletes this workspace outright: its alarm, then every row. Only the
   * sandbox Worker calls it, on the previous hour's workspace once visitors
   * have moved on to a fresh one, and it refuses anywhere SANDBOX isn't on, so
   * a stray call can never empty a real workspace.
   */
  async wipeSandbox(): Promise<{ ok: true }> { return wipeSandbox(this.host); }
  seedSandbox(now: number = Date.now()): { ok: true } { return seedSandbox(this.host, now); }

  /**
   * Read-only SQL over the query views (see ./query.ts), as forUserId sees
   * them: every space for an owner/admin, only their visible spaces for a
   * member, who also gets a lower row cap and a per-minute budget.
   */
  runQuery(text: string, maxRows: number | undefined, forUserId: string): QueryResult {
    return runQuery(this.host, text, maxRows, forUserId);
  }
  /** Auth hot path: resolve a bearer token hash, stamping last_used_at. */
  resolveApiKey(tokenHash: string): { key: ApiKey; user: User } | null {
    return resolveApiKey(this.sql, tokenHash);
  }
  listApiKeys(): ApiKey[] { return listApiKeys(this.sql); }

  /**
   * Resolve the list behind an inbound webhook bearer token.
   *
   * One of only two reads that carry `inboundToken`; the caller (the inbound
   * route) uses it for auth and never puts the list in a response body.
   */
  getListByInboundToken(inboundToken: string): List | null {
    return getListByInboundToken(this.sql, inboundToken);
  }

  /**
   * One list WITH its inbound token. Admin-only by contract — the api Worker
   * gates it — and the reason `getSnapshot()` can null the token unconditionally
   * without breaking the "show me the intake credential" flow.
   */
  getListWithSecrets(listId: string): List | null { return getListWithSecrets(this.sql, listId); }

  // =========================================================================
  // Task mutations
  // =========================================================================
  createTask(input: CreateTaskInput, actor: string | Actor): Task { return createTask(this.host, input, actor); }
  updateTask(input: UpdateTaskInput, actor: string | Actor): Task { return updateTask(this.host, input, actor); }
  moveTask(input: MoveTaskInput, actor: string | Actor): Task { return moveTask(this.host, input, actor); }

  /**
   * Per-item results: one bad row never rolls back the good ones, and the
   * caller can retry exactly the failures.
   */
  bulkUpdate(input: BulkUpdateInput, actor: string | Actor): BulkResult {
    return bulkUpdate(this.host, input, actor);
  }
  /** Returns the r2Keys of any deleted attachments so the caller can clean up R2. */
  deleteTask(taskId: string, actor: string | Actor): { ok: true; r2Keys: string[] } {
    return deleteTask(this.host, taskId, actor);
  }

  /**
   * Drops rows from pending_object_deletes once the caller has actually
   * removed the R2 objects (a delete route's waitUntil, or the backup job's
   * sweep). Not wrapped in runTurn: this is bookkeeping cleanup for storage
   * that already has no workspace-visible representation, not a mutation —
   * it has no actor, produces no delta, and belongs in no audit log.
   */
  clearPendingObjectDeletes(r2Keys: string[]): { ok: true; cleared: number } {
    return clearPendingObjectDeletes(this.sql, r2Keys);
  }

  // =========================================================================
  // Subtasks (Asana-style: done/not-done, no statuses)
  // =========================================================================
  createSubtask(input: ParsedSubtaskInput, actor: string | Actor): Subtask {
    return createSubtask(this.host, input, actor);
  }
  updateSubtask(
    input: {
      subtaskId: string; title?: string; assigneeId?: string | null;
      dueDate?: number | null; note?: string | null; position?: number;
    },
    actor: string | Actor
  ): Subtask { return updateSubtask(this.host, input, actor); }
  toggleSubtask(input: ParsedToggleInput, actor: string | Actor): Subtask {
    return toggleSubtask(this.host, input, actor);
  }
  deleteSubtask(subtaskId: string, actor: string | Actor): { ok: true } {
    return deleteSubtask(this.host, subtaskId, actor);
  }

  // =========================================================================
  // Comments
  // =========================================================================
  createComment(input: ParsedCommentInput, actor: string | Actor): Comment {
    return createComment(this.host, input, actor);
  }
  /**
   * The queue consumer's report on an emailed comment: "sent" once the mail
   * service accepted it, "failed" once delivery gave up. Only a comment still
   * "sending" moves, so a late or repeated report can't flip a settled one.
   */
  markEmailReply(commentId: string, status: "sent" | "failed"): { ok: boolean } {
    return markEmailReply(this.host, commentId, status);
  }
  deleteComment(commentId: string, actor: string | Actor): { ok: true } {
    return deleteComment(this.host, commentId, actor);
  }

  // =========================================================================
  // Agent handoffs (see ./handoffs.ts for the state rules)
  // =========================================================================

  /**
   * File a request for a teammate's agent. One task turn through
   * applyTaskCreate, so task_created automations fire and the recipient gets
   * the assignment email (see notifyForDelta).
   */
  requestHandoff(input: RequestHandoffInput, actor: string | Actor): Task {
    return requestHandoff(this.host, input, actor);
  }
  /**
   * Answer, ask back, or move a handoff along, in one turn: the message (if
   * any) is a comment through applyCommentCreate, so `via` is recorded and a
   * snoozed task wakes; the state change (if any) is one task update carrying
   * the new `handoff` and, for done/declined or a reopen, the status move.
   */
  replyHandoff(input: ReplyHandoffInput, actor: string | Actor): { task: Task; comment: Comment | null } {
    return replyHandoff(this.host, input, actor);
  }
  /**
   * Handoffs assigned to the actor (incoming) or filed by them (outgoing),
   * newest state change first, limited to spaces the actor can see. Explicit
   * `states` filter on the handoff state alone, so asking for done or declined
   * returns the (closed) tasks behind them. The default (open states) also
   * skips closed tasks: someone closing a handoff task by hand, without
   * touching its state, has still taken it off everyone's plate.
   */
  listHandoffs(input: ListHandoffsInput, actor: string | Actor): Task[] {
    return listHandoffs(this.sql, input, actor);
  }

  // =========================================================================
  // Attachments — the api Worker does the R2 upload, the DO owns the metadata
  // =========================================================================
  createAttachment(input: CreateAttachmentInput, actor: string | Actor): Attachment {
    return createAttachment(this.host, input, actor);
  }
  /**
   * Make a verified Drive file canonical while retaining the R2 key until a
   * separate, read-back-gated cleanup call succeeds.
   */
  setAttachmentDriveStorage(input: SetAttachmentDriveStorageInput, actor: string | Actor): Attachment {
    return setAttachmentDriveStorage(this.host, input, actor);
  }
  /** Mark cleanup complete only for the exact Drive file the caller read back. */
  markAttachmentDriveCleanupComplete(
    attachmentId: string, driveFileId: string, actor: string | Actor
  ): Attachment { return markAttachmentDriveCleanupComplete(this.host, attachmentId, driveFileId, actor); }
  /**
   * Returns the r2Key so the caller can delete the object from R2 (and clear
   * the pending_object_deletes row this parks in the same turn).
   */
  deleteAttachment(attachmentId: string, actor: string | Actor): { ok: true; r2Key: string } {
    return deleteAttachment(this.host, attachmentId, actor);
  }

  // =========================================================================
  // Spaces & lists
  // =========================================================================
  createSpace(input: ParsedSpaceInput, actor: string | Actor): Space {
    return createSpace(this.host, input, actor);
  }
  updateSpace(
    input: { spaceId: string; name?: string; color?: string | null; archived?: boolean; position?: number },
    actor: string | Actor
  ): Space { return updateSpace(this.host, input, actor); }
  /**
   * Flip visibility between workspace and private; going private ensures at
   * least one member (creator, or acting admin if created_by is null) and
   * triggers client resync.
   */
  setSpaceVisibility(input: { spaceId: string; visibility: SpaceVisibility }, actor: string | Actor): Space {
    return setSpaceVisibility(this.host, input, actor);
  }
  /**
   * Replace a space's member list. `userIds` is the complete set afterwards, so
   * the caller never has to diff — the UI always knows the whole list.
   *
   * Unknown user ids are rejected rather than silently dropped: a typo'd id
   * would otherwise look like a granted permission that never works.
   */
  setSpaceMembers(
    input: { spaceId: string; userIds: string[] }, actor: string | Actor
  ): { spaceId: string; userIds: string[] } { return setSpaceMembers(this.host, input, actor); }
  deleteSpace(spaceId: string, actor: string | Actor): { ok: true } {
    return deleteSpace(this.host, spaceId, actor);
  }
  createList(input: ParsedListInput, actor: string | Actor): List { return createList(this.host, input, actor); }
  updateList(
    input: { listId: string; name?: string; archived?: boolean; position?: number; spaceId?: string },
    actor: string | Actor
  ): List { return updateList(this.host, input, actor); }
  /** Issue (or rotate) the bearer token for the list's inbound webhook. */
  setListInboundToken(
    input: { listId: string; enabled: boolean }, actor: string | Actor
  ): { listId: string; inboundToken: string | null } { return setListInboundToken(this.host, input, actor); }
  deleteList(listId: string, actor: string | Actor): { ok: true } {
    return deleteList(this.host, listId, actor);
  }

  // =========================================================================
  // Email intake (see ./email-intake.ts)
  // =========================================================================

  /** Every list's intake, by alias. Holds sender allowlists: the Worker admin-gates it. */
  listEmailIntakes(): EmailIntake[] { return listEmailIntakes(this.sql); }
  /**
   * Create or replace (`input`) or remove (`null`) one list's intake.
   *
   * Owner/admin only, checked here as well as on the route: an intake lets
   * people outside the workspace write into it, so the sole writer does not
   * take the caller's word for it. Intakes are not in the snapshot, so this
   * writes an audit row and no delta.
   */
  setEmailIntake(listId: string, input: SetEmailIntakeInput | null, actor: string | Actor): EmailIntake | null {
    return setEmailIntake(this.host, listId, input, actor);
  }
  /** Read-only and cheap: the Worker's pre-check before it parses or uploads. */
  checkEmailIntake(input: { alias: string; sender: string; messageId: string }): EmailIntakeCheck {
    return checkEmailIntake(this.sql, input);
  }
  /**
   * Route one parsed message in one turn: a comment on the ticket it replies
   * to, or a new ticket in the intake's list, plus its attachments and the
   * email_messages row that dedupes it. The Worker's pre-check ran before an
   * await, so every refusal is re-derived here and returned the same way.
   *
   * Conditions a retry can never fix throw with EMAIL_INGEST_PERMANENT_ERROR
   * as the message prefix, so the Worker rejects instead of asking for a retry.
   */
  ingestEmail(input: IngestEmailInput, actor: string | Actor): IngestEmailResult {
    return ingestEmail(this.host, input, actor);
  }

  // =========================================================================
  // Users, API keys, automation rules
  // =========================================================================

  /** Upsert by id when given, otherwise by email (case-insensitive). */
  upsertUser(input: UpsertUserInput, actor: string | Actor): User { return upsertUser(this.host, input, actor); }
  createApiKey(input: CreateApiKeyInput, actor: string | Actor): ApiKey {
    return createApiKey(this.host, input, actor);
  }
  revokeApiKey(keyId: string, actor: string | Actor): { ok: true } {
    return revokeApiKey(this.host, keyId, actor);
  }
  /**
   * Allow or stop one key emailing a ticket's requester (see requireEmailReply).
   * Owner or admin, from the app or an api key (there is no switch in the web
   * app); never over MCP. Audited either way.
   */
  setApiKeyEmailRequesters(keyId: string, allowed: boolean, actor: string | Actor): ApiKey {
    return setApiKeyEmailRequesters(this.host, keyId, allowed, actor);
  }
  upsertAutomation(input: UpsertAutomationInput, actor: string | Actor): AutomationRule {
    return upsertAutomation(this.host, input, actor);
  }
  deleteAutomation(ruleId: string, actor: string | Actor): { ok: true } {
    return deleteAutomation(this.host, ruleId, actor);
  }

  // =========================================================================
  // Alarm: one alarm multiplexes every scheduled job
  // =========================================================================
  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> { return handleAlarm(this.host, alarmInfo); }
  private runJob(job: JobRow, now: number): Promise<Record<string, number>> { return runJob(this.host, job, now); }
  /** Queue a one-off job; automations can use this via ctx.sql too. */
  scheduleJob(input: { runAt: number; kind: string; payload?: unknown; everyMs?: number }): void {
    scheduleJob(this.host, input);
  }
  /** Manual trigger for the daily backup (admin route); same code path as the
   *  scheduled job, including the prune, the orphan sweep and the outcome
   *  recorded in `job_status`. */
  runBackupNow(): Promise<Record<string, number>> { return runBackupNow(this.host); }
  /**
   * The backup's last recorded outcome. `stale` compares against `now`, so it
   * also catches a backup that stopped running without ever reporting a
   * failure (an isolate killed mid-dump never reaches the catch). The error
   * text and object key are for admins; /api/health exposes only the times
   * and the flag.
   */
  getBackupStatus(now: number = Date.now()): BackupStatus { return getBackupStatus(this.sql, now); }
}