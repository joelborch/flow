/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import type {
  Actor, ApiKey, Attachment, AuditEntry, AutomationRule, AutomationRunLog, BoardSnapshot,
  BulkResult, BulkUpdateInput, Comment, CreateTaskInput, List, ListHandoffsInput, MoveTaskInput,
  NotificationPref, ReplyHandoffInput, RequestHandoffInput, SearchTasksInput, SearchTasksResult,
  SetEmailIntakeInput, Space, SpaceVisibility, Subtask, Task, TaskDetail, UpdateTaskInput,
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
export {
  SIDE_EFFECTS_BATCH_BYTES, SIDE_EFFECTS_BATCH_SIZE, SIDE_EFFECTS_MESSAGE_BYTES,
  TRUNCATION_MARKER, chunkSideEffects, fitSideEffect, sideEffectBytes,
} from "./side-effect-size.js";
export { between as positionBetween, POSITION_STEP } from "./position.js";
export { REPLAY_GAP_LIMIT } from "./sync-floor.js";
export {
  QUERY_DEFAULT_ROWS, QUERY_MAX_ROWS, QUERY_MEMBER_MAX_ROWS, QUERY_MEMBER_PER_MINUTE,
  QUERY_VIEWS, QueryRejected, type QueryResult,
} from "./query.js";

/**
 * The workspace Durable Object: single SQLite writer holding spaces, lists,
 * tasks, automation rules, and WebSocket hibernation state.
 */
export class Workspace extends DurableObject<Env> implements WorkspaceRpc {
  private readonly sql: SqlStorage;
  private readonly queryLimiter = new QueryRateLimiter();
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
      armedAlarm: null,
      maxSeq: () => this.maxSeq(),
      runTurn: (actor, fn, silent = false) => executeTurn(this.host, actor, fn, silent),
      runTaskTurn: (actor, fn) => executeTaskTurn(this.host, actor, fn),
      armAlarm: () => armAlarm(this.host),
      getSnapshot: (forUserId) => getSnapshot(this.host, forUserId),
    };

    if (needsMigration(this.sql)) {
      ctx.blockConcurrencyWhile(async () => {
        const applied = runMigrations(this.sql, (fn) => ctx.storage.transactionSync(fn));
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
      ctx.blockConcurrencyWhile(async () => {
        await armAlarm(this.host);
      });
    }
  }

  private maxSeq(): number {
    return this.sql.exec<{ v: number }>("SELECT COALESCE(MAX(seq), 0) AS v FROM changes").one().v;
  }

  // --- WebSockets (Hibernation API) ----------------------------------------
  fetch(req: Request): Response { return handleWsFetch(this.host, req); }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return handleWsMessage(this.host, ws, message);
  }
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    handleWsClose(ws, code, reason);
  }
  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> { handleWsError(error); }

  // --- Reads & notification prefs ------------------------------------------
  getNotificationPrefs(userId: string): NotificationPref { return getNotificationPrefs(this.sql, userId); }
  setNotificationPrefs(userId: string, patch: Partial<NotificationPref>): NotificationPref {
    return setNotificationPrefs(this.sql, userId, patch);
  }
  visibleSpaceIds(userId: string): string[] | null {
    const visible = visibleSpaceIds(this.sql, userId);
    return visible === null ? null : [...visible];
  }
  listSpaceMembers(spaceId: string): string[] {
    requireSpace(this.sql, spaceId);
    return listSpaceMemberIds(this.sql, spaceId);
  }
  getSnapshot(forUserId?: string): BoardSnapshot { return getSnapshot(this.host, forUserId); }
  getWorkspaceMap(forUserId?: string) { return getWorkspaceMap(this.host, forUserId); }
  getTaskDetail(taskId: string, forUserId?: string): TaskDetail {
    return getTaskDetail(this.host, taskId, forUserId);
  }
  getTaskDetails(taskIds: string[], forUserId?: string) {
    return getTaskDetails(this.host, taskIds, forUserId);
  }
  searchTasks(input: SearchTasksInput, actor?: string | Actor): SearchTasksResult {
    return searchTasks(this.sql, input, actor);
  }
  listUsers(): User[] { return listUsers(this.sql); }
  getUserByEmail(email: string): User | null { return getUserByEmail(this.sql, email); }
  claimOwner(email: string): User | null { return claimOwner(this.host, email); }
  listSubtasks(taskId: string): Subtask[] { return listSubtasks(this.sql, taskId); }
  listComments(taskId: string): Comment[] { return listComments(this.sql, taskId); }
  listAttachments(taskId: string): Attachment[] { return listAttachments(this.sql, taskId); }
  getAttachment(attachmentId: string): Attachment | null { return getAttachment(this.sql, attachmentId); }
  listAutomations(): AutomationRule[] { return listAutomations(this.sql); }
  listAutomationRuns(
    filter: { ruleId?: string; taskId?: string; before?: number; limit?: number } = {}
  ): AutomationRunLog[] { return listAutomationRuns(this.sql, filter); }
  recordDeliveryFailure(input: {
    ruleId: string; taskId: string; kind: "webhook" | "email"; detail: string;
  }): { ok: true } { return recordDeliveryFailure(this.sql, input); }
  getAuditLog(
    filter: {
      entity?: string; action?: string; userId?: string; apiKeyId?: string;
      before?: number; after?: number; limit?: number;
    } = {}
  ): { entries: AuditEntry[]; nextBefore: number | null } { return getAuditLog(this.sql, filter); }
  async wipeSandbox(): Promise<{ ok: true }> { return wipeSandbox(this.host); }
  seedSandbox(now: number = Date.now()): { ok: true } { return seedSandbox(this.host, now); }
  runQuery(text: string, maxRows: number | undefined, forUserId: string): QueryResult {
    return runQuery(this.host, text, maxRows, forUserId);
  }
  resolveApiKey(tokenHash: string): { key: ApiKey; user: User } | null {
    return resolveApiKey(this.sql, tokenHash);
  }
  listApiKeys(): ApiKey[] { return listApiKeys(this.sql); }
  getListByInboundToken(inboundToken: string): List | null {
    return getListByInboundToken(this.sql, inboundToken);
  }
  getListWithSecrets(listId: string): List | null { return getListWithSecrets(this.sql, listId); }

  // --- Tasks, subtasks, comments, handoffs, attachments --------------------
  createTask(input: CreateTaskInput, actor: string | Actor): Task { return createTask(this.host, input, actor); }
  updateTask(input: UpdateTaskInput, actor: string | Actor): Task { return updateTask(this.host, input, actor); }
  moveTask(input: MoveTaskInput, actor: string | Actor): Task { return moveTask(this.host, input, actor); }
  bulkUpdate(input: BulkUpdateInput, actor: string | Actor): BulkResult {
    return bulkUpdate(this.host, input, actor);
  }
  deleteTask(taskId: string, actor: string | Actor): { ok: true; r2Keys: string[] } {
    return deleteTask(this.host, taskId, actor);
  }
  clearPendingObjectDeletes(r2Keys: string[]): { ok: true; cleared: number } {
    return clearPendingObjectDeletes(this.sql, r2Keys);
  }
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
  createComment(input: ParsedCommentInput, actor: string | Actor): Comment {
    return createComment(this.host, input, actor);
  }
  markEmailReply(commentId: string, status: "sent" | "failed"): { ok: boolean } {
    return markEmailReply(this.host, commentId, status);
  }
  deleteComment(commentId: string, actor: string | Actor): { ok: true } {
    return deleteComment(this.host, commentId, actor);
  }
  requestHandoff(input: RequestHandoffInput, actor: string | Actor): Task {
    return requestHandoff(this.host, input, actor);
  }
  replyHandoff(input: ReplyHandoffInput, actor: string | Actor): { task: Task; comment: Comment | null } {
    return replyHandoff(this.host, input, actor);
  }
  listHandoffs(input: ListHandoffsInput, actor: string | Actor): Task[] {
    return listHandoffs(this.sql, input, actor);
  }
  createAttachment(input: CreateAttachmentInput, actor: string | Actor): Attachment {
    return createAttachment(this.host, input, actor);
  }
  setAttachmentDriveStorage(input: SetAttachmentDriveStorageInput, actor: string | Actor): Attachment {
    return setAttachmentDriveStorage(this.host, input, actor);
  }
  markAttachmentDriveCleanupComplete(
    attachmentId: string, driveFileId: string, actor: string | Actor
  ): Attachment { return markAttachmentDriveCleanupComplete(this.host, attachmentId, driveFileId, actor); }
  deleteAttachment(attachmentId: string, actor: string | Actor): { ok: true; r2Key: string } {
    return deleteAttachment(this.host, attachmentId, actor);
  }

  // --- Spaces, lists, email intake, users, keys, automations ---------------
  createSpace(input: ParsedSpaceInput, actor: string | Actor): Space {
    return createSpace(this.host, input, actor);
  }
  updateSpace(
    input: { spaceId: string; name?: string; color?: string | null; archived?: boolean; position?: number },
    actor: string | Actor
  ): Space { return updateSpace(this.host, input, actor); }
  setSpaceVisibility(input: { spaceId: string; visibility: SpaceVisibility }, actor: string | Actor): Space {
    return setSpaceVisibility(this.host, input, actor);
  }
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
  setListInboundToken(
    input: { listId: string; enabled: boolean }, actor: string | Actor
  ): { listId: string; inboundToken: string | null } { return setListInboundToken(this.host, input, actor); }
  deleteList(listId: string, actor: string | Actor): { ok: true } {
    return deleteList(this.host, listId, actor);
  }
  listEmailIntakes() { return listEmailIntakes(this.sql); }
  setEmailIntake(listId: string, input: SetEmailIntakeInput | null, actor: string | Actor) {
    return setEmailIntake(this.host, listId, input, actor);
  }
  checkEmailIntake(input: { alias: string; sender: string; messageId: string }): EmailIntakeCheck {
    return checkEmailIntake(this.sql, input);
  }
  ingestEmail(input: IngestEmailInput, actor: string | Actor): IngestEmailResult {
    return ingestEmail(this.host, input, actor);
  }
  upsertUser(input: UpsertUserInput, actor: string | Actor): User { return upsertUser(this.host, input, actor); }
  createApiKey(input: CreateApiKeyInput, actor: string | Actor): ApiKey {
    return createApiKey(this.host, input, actor);
  }
  revokeApiKey(keyId: string, actor: string | Actor): { ok: true } {
    return revokeApiKey(this.host, keyId, actor);
  }
  setApiKeyEmailRequesters(keyId: string, allowed: boolean, actor: string | Actor): ApiKey {
    return setApiKeyEmailRequesters(this.host, keyId, allowed, actor);
  }
  upsertAutomation(input: UpsertAutomationInput, actor: string | Actor): AutomationRule {
    return upsertAutomation(this.host, input, actor);
  }
  deleteAutomation(ruleId: string, actor: string | Actor): { ok: true } {
    return deleteAutomation(this.host, ruleId, actor);
  }

  // --- Alarm & scheduled jobs ----------------------------------------------
  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> { return handleAlarm(this.host, alarmInfo); }
  private runJob(job: JobRow, now: number): Promise<Record<string, number>> { return runJob(this.host, job, now); }
  scheduleJob(input: { runAt: number; kind: string; payload?: unknown; everyMs?: number }): void {
    scheduleJob(this.host, input);
  }
  runBackupNow(): Promise<Record<string, number>> { return runBackupNow(this.host); }
  getBackupStatus(now: number = Date.now()): BackupStatus { return getBackupStatus(this.sql, now); }
}
