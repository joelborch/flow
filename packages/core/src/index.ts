/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import { ClientMsg as ClientMsgSchema } from "@flow/shared";
import type {
  Action,
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
  CreateCommentInput,
  CreateListInput,
  CreateSpaceInput,
  CreateSubtaskInput,
  CreateTaskInput,
  Delta,
  List,
  MoveTaskInput,
  NotificationPref,
  Role,
  SearchTasksInput,
  SearchTasksResult,
  ServerMsg,
  Space,
  SpaceVisibility,
  Status,
  Subtask,
  Task,
  TaskDetail,
  ToggleSubtaskInput,
  UpdateTaskInput,
  UpsertAutomationInput,
  User,
  WorkspaceRpc,
} from "@flow/shared";
import { AUTOMATION_MAX_DEPTH, mergeNotificationPrefs } from "@flow/shared";

import { evaluateAutomations } from "./automation/engine.js";
import { pruneDueFires, sweepDueDateAutomations } from "./automation/schedule.js";
import type {
  AutomationContext,
  AutomationDelta,
  AutomationScheduleContext,
  SideEffectPayload,
  TaskFacts,
} from "./automation/types.js";
import { id, token } from "./id.js";
import {
  type ImportBatch,
  type ImportCounts,
  type ImportResult,
  emptyCounts,
  truncateImportTitle,
} from "./import.js";
import {
  between,
  columnHasCollapsed,
  needsRebalance,
  nextPosition,
  nextSubtaskPosition,
  nextTaskPosition,
  rebalanceTaskColumn,
} from "./position.js";
import {
  type ApiKeyRow,
  type AttachmentRow,
  type AuditRow,
  type ChangeRow,
  type CommentRow,
  type JobRow,
  type ListRow,
  type RuleRow,
  type SnapshotTaskRowSql,
  type SpaceRow,
  type SubtaskRow,
  type TaskRowSql,
  type UserRow,
  tagsText,
  toApiKey,
  toAttachment,
  toAuditEntry,
  toComment,
  toList,
  toListWithSecrets,
  toRule,
  toSnapshotTask,
  toSpace,
  toSubtask,
  toTask,
  toUser,
} from "./rows.js";
import {
  type NotifyKind,
  PREF_KEY,
  notificationTag,
  readNotificationPrefs,
  recipientsFor,
  renderNotification,
  taskUrl,
  writeNotificationPrefs,
} from "./notifications.js";
import {
  PLACEHOLDER_EMAIL_DOMAIN,
  needsMigration,
  runMigrations,
  seedIfEmpty,
  seedJobs,
} from "./schema.js";
import { searchTasks as runSearch } from "./search.js";
import { type SnoozedRow, WAKE_SWEEP_LIMIT, wakeCandidates, wakesOnComment } from "./snooze.js";
import {
  getStatus,
  insertStatuses,
  listStatuses,
  normalizeStatusSpecs,
  openStatus,
  resolveStatusName,
} from "./statuses.js";
import { type ScopedDelta, Turn, diffOf, toActor } from "./turn.js";
import { requireAssignee } from "./users.js";
import {
  canSeeSpace,
  isSpaceMember,
  isSystemActor,
  listSpaceMemberIds,
  privateSpaceError,
  privateSpaceIds,
  isPrivilegedRole,
  roleOf,
  visibleSpaceIds,
} from "./visibility.js";

export type { ImportBatch, ImportResult, ImportCounts } from "./import.js";
export { ID_PREFIX, INBOUND_TOKEN_PREFIX, id, token } from "./id.js";

export interface Env {
  WORKSPACE: DurableObjectNamespace<Workspace>;
  ATTACHMENTS: R2Bucket;
  SIDE_EFFECTS: Queue;
  ASSETS: Fetcher;
  /**
   * Both come from wrangler `vars` and are read by the automation engine
   * (`{{task.url}}` and the send_email dry-run flag). Optional here so a test
   * harness can omit them; apps/api narrows them to required strings.
   */
  APP_HOSTNAME?: string;
  EMAIL_DRY_RUN?: string;
}

// Zod schemas carry defaults, so the *output* type is what the DO receives.
// Deriving these from the schemas keeps packages/shared the only definition.
type ParsedListInput = ReturnType<typeof CreateListInput.parse>;
type ParsedSpaceInput = ReturnType<typeof CreateSpaceInput.parse>;
type ParsedSubtaskInput = ReturnType<typeof CreateSubtaskInput.parse>;
type ParsedToggleInput = ReturnType<typeof ToggleSubtaskInput.parse>;
type ParsedCommentInput = ReturnType<typeof CreateCommentInput.parse>;

const DAY_MS = 86_400_000;

/** Closed tasks older than this drop out of the board snapshot. */
export const SNAPSHOT_CLOSED_WINDOW_MS = 60 * DAY_MS;
/** Replay gap above which a reconnecting client gets a fresh snapshot. */
export const REPLAY_GAP_LIMIT = 5_000;
/** Rows kept by the prune_changes job. */
export const CHANGES_RETENTION = 50_000;

interface ConnState {
  userId: string;
}

/**
 * Header the api Worker uses to hand the authenticated user id to the DO on the
 * `/ws` upgrade (`WS_USER_HEADER` in apps/api/src/env.ts — same string, and the
 * two packages cannot import from each other). The Worker strips any
 * client-supplied copy first, which is what makes it safe to trust.
 */
const WS_USER_HEADER = "X-Flow-User-Id";

export interface UpsertUserInput {
  id?: string;
  email: string;
  name?: string;
  role?: Role;
  deactivated?: boolean;
  clickupId?: string | null;
}

export interface CreateApiKeyInput {
  userId: string;
  name: string;
  /** sha256 hex of the bearer token. The plaintext never reaches the DO. */
  tokenHash: string;
}

export interface CreateAttachmentInput {
  /**
   * Optional caller-assigned id. The api Worker mints it before uploading
   * because the R2 key embeds it; when omitted the DO generates one.
   */
  id?: string;
  taskId: string;
  filename: string;
  r2Key: string;
  size: number;
  mimeType: string;
}

const TASK_COLUMNS = `id, list_id, title, description, status_id, assignee_id,
  priority, due_date, start_date, snoozed_until, blocked_note, tags, position,
  created_by, created_at, updated_at, closed_at, clickup_id`;

/**
 * The snapshot projection: board-render columns only, with the description
 * collapsed to a boolean in SQL. Keep it in step with `SnapshotTask` in
 * packages/shared/src/events.ts and `toSnapshotTask` in ./rows.ts.
 */
const SNAPSHOT_TASK_COLUMNS = `id, list_id, title, status_id, assignee_id, priority,
  due_date, tags, position, created_at, updated_at, snoozed_until, blocked_note,
  (description != '') AS has_description`;

/** Every space read goes through this, so `visibility` can never be forgotten. */
const SPACE_COLUMNS = `id, name, color, position, archived, visibility, created_at, clickup_id`;

const LIST_COLUMNS = `id, space_id, name, position, archived, inbound_token, created_at, clickup_id`;

const TASK_DIFF_KEYS = [
  "listId",
  "title",
  "description",
  "statusId",
  "assigneeId",
  "priority",
  "dueDate",
  "startDate",
  "snoozedUntil",
  "blockedNote",
  "tags",
  "position",
  "closedAt",
] as const;

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
  /** Cached view of the armed alarm so mutations rarely await getAlarm(). */
  private armedAlarm: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Hot path: one SELECT on _migrations, then nothing. Only a genuinely
    // out-of-date instance pays for blockConcurrencyWhile.
    if (needsMigration(this.sql)) {
      ctx.blockConcurrencyWhile(async () => {
        runMigrations(this.sql);
        seedIfEmpty(this.sql);
        seedJobs(this.sql);
        await this.armAlarm();
      });
    }
  }

  // =========================================================================
  // WebSockets (Hibernation API)
  // =========================================================================

  /**
   * WebSocket upgrade at `/ws`. The api Worker authenticates the request and
   * forwards it with `?userId=us_…`; the DO does not re-authenticate.
   */
  fetch(req: Request): Response {
    const url = new URL(req.url);
    if (url.pathname !== "/ws") {
      return new Response("workspace do: unknown path", { status: 404 });
    }
    if ((req.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    // The Worker sends the id as a header; the `?userId=` form is kept as a
    // fallback for direct-to-DO callers (tests, a curl against the stub).
    const state: ConnState = {
      userId: req.headers.get(WS_USER_HEADER) ?? url.searchParams.get("userId") ?? "",
    };
    server.serializeAttachment(state);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const parsed = ClientMsgSchema.safeParse(safeJson(message));
    if (!parsed.success) return; // ignore malformed frames
    const msg = parsed.data;

    if (msg.type === "ping") {
      this.send(ws, { type: "pong" });
      return;
    }

    // hello: catch the client up, then it lives on broadcast deltas alone. The
    // snapshot and the replay are both filtered by the identity this socket was
    // accepted with, so a member never receives private-space rows either way.
    const userId = this.connUserId(ws);
    const maxSeq = this.maxSeq();
    if (msg.sinceSeq === null) {
      this.send(ws, { type: "snapshot", snapshot: this.getSnapshot(userId) });
      return;
    }
    const { min } = this.sql
      .exec<{ min: number | null }>("SELECT MIN(seq) AS min FROM changes")
      .one();
    const pruned = min !== null && msg.sinceSeq < min - 1;
    if (msg.sinceSeq > maxSeq || maxSeq - msg.sinceSeq > REPLAY_GAP_LIMIT || pruned) {
      this.send(ws, { type: "snapshot", snapshot: this.getSnapshot(userId) });
      return;
    }
    const deltas = this.filterReplay(this.replay(msg.sinceSeq), userId);
    if (deltas.length > 0) this.send(ws, { type: "deltas", deltas });
  }

  /**
   * Apply per-space permissions to a replayed range.
   *
   * The `changes` log stores no space id, so each delta is resolved the same way
   * a live one is, memoised by entity id. The whole pass is skipped when the
   * workspace has no private spaces or the user is an owner/admin — which is the
   * normal case, and keeps reconnects as cheap as they were.
   *
   * A `delete` delta whose row is already gone resolves to no space and is let
   * through: it carries an id and nothing else, and applying it client-side is a
   * no-op for a client that never held the row.
   */
  private filterReplay(deltas: Delta[], userId: string): Delta[] {
    if (deltas.length === 0) return deltas;
    if (privateSpaceIds(this.sql).size === 0) return deltas;
    const visible = visibleSpaceIds(this.sql, userId);
    if (visible === null) return deltas;

    const memo = new Map<string, string | null>();
    return deltas.filter((d) => {
      const key = `${d.entity}:${d.id}`;
      if (!memo.has(key)) memo.set(key, this.spaceIdForDelta(d.entity, d.id, undefined));
      const spaceId = memo.get(key) ?? null;
      return spaceId === null || visible.has(spaceId);
    });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // 1000-1015 are reserved; anything outside is rejected by close().
    ws.close(code >= 1000 && code <= 1015 && code !== 1005 ? code : 1000, reason);
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error("websocket error", error);
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error("websocket send failed", err);
    }
  }

  private broadcast(msg: ServerMsg): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Connection is going away; close/error handlers clean up.
      }
    }
  }

  /** The user id stamped on a hibernated socket at accept time. */
  private connUserId(ws: WebSocket): string {
    try {
      return (ws.deserializeAttachment() as ConnState | null)?.userId ?? "";
    } catch {
      return "";
    }
  }

  /**
   * Broadcast a turn's deltas, dropping the ones each connection may not see.
   *
   * The common case is that no private space was touched, and then this is the
   * old single-payload broadcast — one JSON.stringify, one send per socket. Only
   * when a delta comes from a private space do we go per-connection, and even
   * then the visible-space lookup is memoised per user for the call, so ten
   * sockets belonging to three people cost three lookups.
   */
  private broadcastDeltas(scoped: ScopedDelta[]): void {
    if (scoped.length === 0) return;
    const restricted = privateSpaceIds(this.sql);
    const touchesPrivate =
      restricted.size > 0 && scoped.some((s) => s.spaceId !== null && restricted.has(s.spaceId));
    if (!touchesPrivate) {
      this.broadcast({ type: "deltas", deltas: scoped.map((s) => s.delta) });
      return;
    }

    const seen = new Map<string, Set<string> | null>();
    const visibleFor = (userId: string): Set<string> | null => {
      if (!seen.has(userId)) seen.set(userId, visibleSpaceIds(this.sql, userId));
      return seen.get(userId) ?? null;
    };

    for (const ws of this.ctx.getWebSockets()) {
      const visible = visibleFor(this.connUserId(ws));
      const deltas =
        visible === null
          ? scoped.map((s) => s.delta)
          : scoped
              .filter((s) => s.spaceId === null || visible.has(s.spaceId))
              .map((s) => s.delta);
      if (deltas.length === 0) continue;
      this.send(ws, { type: "deltas", deltas });
    }
  }

  /**
   * Tell affected clients to pull a fresh, correctly-filtered snapshot.
   *
   * A visibility flip or a membership change cannot be expressed as a patch —
   * a client that just lost access holds a whole subtree it must forget, and one
   * that just gained access has never seen the rows. `resync` is the existing
   * escape hatch for exactly that, and it goes only to the connections whose
   * view actually changed: owners and admins already see everything, so their
   * boards are untouched.
   */
  private resyncFor(affects: (userId: string) => boolean): void {
    for (const ws of this.ctx.getWebSockets()) {
      const userId = this.connUserId(ws);
      if (isPrivilegedRole(roleOf(this.sql, userId))) continue;
      if (!affects(userId)) continue;
      this.send(ws, { type: "resync" });
    }
  }

  private replay(sinceSeq: number): Delta[] {
    return this.sql
      .exec<ChangeRow>(
        `SELECT seq, op, entity, entity_id, data, actor_user_id, at
         FROM changes WHERE seq > ? ORDER BY seq LIMIT ?`,
        sinceSeq,
        REPLAY_GAP_LIMIT
      )
      .toArray()
      .map(
        (r): Delta => ({
          seq: r.seq,
          op: r.op as Delta["op"],
          entity: r.entity as Delta["entity"],
          id: r.entity_id,
          data: r.data === null ? null : (JSON.parse(r.data) as Record<string, unknown>),
          actorUserId: r.actor_user_id,
          at: r.at,
        })
      );
  }

  private maxSeq(): number {
    return this.sql.exec<{ v: number }>("SELECT COALESCE(MAX(seq), 0) AS v FROM changes").one().v;
  }

  // =========================================================================
  // Mutation turns
  // =========================================================================

  private runTurn<T>(actor: Actor, fn: (t: Turn) => T, silent = false): T {
    const t = new Turn(this.sql, actor, Date.now(), silent, (entity, entityId, taskId) =>
      this.spaceIdForDelta(entity, entityId, taskId)
    );
    const result = fn(t);
    this.drainAutomations(t);
    // After automations, so a rule that reassigns or moves a task also notifies.
    this.drainNotifications(t);
    this.flush(t);
    return result;
  }

  /**
   * A mutation turn whose result is a Task, re-read after the automation drain.
   *
   * Automations run inline in this same turn, so by the time the turn ends the
   * row may no longer look like what the mutation itself wrote — a rule can have
   * moved the task, changed its status or retagged it. Returning the pre-drain
   * value made `move()` report the status the caller asked for while the board
   * (fed by deltas) showed the automation's. Re-reading closes that gap.
   *
   * The row can only be missing if something deleted the task mid-turn, which
   * nothing does today; the pre-drain value is the honest fallback.
   */
  private runTaskTurn(actor: Actor, fn: (t: Turn) => Task): Task {
    const before = this.runTurn(actor, fn);
    const row = this.taskRow(before.id);
    return row === null ? before : toTask(row);
  }

  /**
   * Feed every delta produced in this turn to the automation engine, including
   * deltas the automations themselves produced (depth-stamped, capped at
   * AUTOMATION_MAX_DEPTH). A rule that throws never fails the user's mutation.
   */
  private drainAutomations(t: Turn): void {
    if (t.silent) return;
    const HARD_CAP = 5_000;
    let i = 0;
    let evaluated = 0;
    while (i < t.entries.length) {
      const entry = t.entries[i]!;
      i++;
      if (entry.evaluated) continue;
      entry.evaluated = true;
      // Deltas at or past the cap are still handed over: the engine recognises
      // the depth itself and writes a clean "depth cap" automation_runs entry
      // instead of silently dropping the chain. It takes no actions, so the
      // loop still terminates.
      if (++evaluated > HARD_CAP) {
        console.error("automation fan-out cap reached; stopping evaluation for this turn");
        break;
      }
      try {
        evaluateAutomations(this.automationContext(t, entry.depth), entry.delta);
      } catch (err) {
        console.error("automation evaluation failed", entry.delta.entity, entry.delta.id, err);
      }
    }
  }

  // =========================================================================
  // System email notifications
  //
  // Independent of automation rules: always-on per each recipient's prefs. Runs
  // after the automation drain so a rule-driven reassign/move/status change also
  // notifies. Silent (import) turns emit no deltas, so — like automations — this
  // never fires on import. A recipient is never emailed about their own action.
  // =========================================================================

  private drainNotifications(t: Turn): void {
    if (t.silent) return;
    // Snapshot: notification enqueues never append deltas, but iterate a copy so
    // the loop bound is fixed regardless.
    for (const entry of [...t.entries]) {
      try {
        this.notifyForDelta(t, entry.delta);
      } catch (err) {
        console.error("notification failed", entry.delta.entity, entry.delta.id, err);
      }
    }
  }

  private notifyForDelta(t: Turn, delta: AutomationDelta): void {
    const actorId = delta.actorUserId;
    const data = delta.data ?? {};

    if (delta.entity === "task" && delta.op === "update") {
      const facts = this.loadTaskFacts(delta.id);
      if (facts === null) return;

      if ("assigneeId" in data) {
        const newAssigneeId = (data["assigneeId"] as string | null) ?? null;
        for (const rid of recipientsFor("assigned", { assigneeId: null, creatorId: facts.task.createdBy, newAssigneeId }, actorId)) {
          this.sendNotification(t, "assigned", facts, rid, actorId, {});
        }
      }
      if ("statusId" in data) {
        const statusName = getStatus(this.sql, String(data["statusId"]))?.name ?? facts.statusName;
        for (const rid of recipientsFor("status", { assigneeId: facts.task.assigneeId, creatorId: facts.task.createdBy }, actorId)) {
          this.sendNotification(t, "status", facts, rid, actorId, { statusName });
        }
      }
      return;
    }

    if (delta.entity === "comment" && delta.op === "create") {
      const taskId = (delta.taskId ?? (data["taskId"] as string | undefined)) ?? undefined;
      if (taskId === undefined) return;
      const facts = this.loadTaskFacts(taskId);
      if (facts === null) return;
      const commentBody = String(data["body"] ?? "");
      for (const rid of recipientsFor("comment", { assigneeId: facts.task.assigneeId, creatorId: facts.task.createdBy }, actorId)) {
        this.sendNotification(t, "comment", facts, rid, actorId, { commentBody });
      }
    }
  }

  /**
   * Resolve one recipient, gate on their prefs and a real email, render the
   * template and enqueue a kind:"email" side effect. Dry-run is applied
   * transitively by the queue consumer (EMAIL_DRY_RUN).
   */
  private sendNotification(
    t: Turn,
    kind: NotifyKind,
    facts: TaskFacts,
    recipientId: string,
    actorId: string,
    extra: { statusName?: string; commentBody?: string }
  ): void {
    const recipient = this.userById(recipientId);
    // No user, deactivated, or no real (non-placeholder) email => skip.
    if (recipient === null || recipient.deactivated || !hasRealEmail(recipient.email)) return;

    const prefs = readNotificationPrefs(this.sql, recipientId);
    if (!prefs[PREF_KEY[kind]]) return;

    const actor = this.userById(actorId);
    const rendered = renderNotification(kind, {
      taskTitle: facts.task.title,
      // APP_HOSTNAME is required deployment config; "localhost" keeps links
      // well-formed (never a real domain) if a deployment forgets to set it.
      taskUrl: taskUrl(this.env.APP_HOSTNAME ?? "localhost", facts.task.id),
      actorName: actor?.name ?? "Someone",
      ...(extra.statusName !== undefined ? { statusName: extra.statusName } : {}),
      ...(extra.commentBody !== undefined ? { commentBody: extra.commentBody } : {}),
    });

    const payload: SideEffectPayload = {
      kind: "email",
      to: [recipient.email],
      subject: rendered.subject,
      body: rendered.body,
      ruleId: notificationTag(kind),
      taskId: facts.task.id,
    };
    t.enqueue(payload);
  }

  private userById(userId: string): User | null {
    const row = this.sql
      .exec<UserRow>(
        `SELECT id, email, name, role, deactivated, created_at, needs_email_update, clickup_id
         FROM users WHERE id = ?`,
        userId
      )
      .toArray()[0];
    return row ? toUser(row) : null;
  }

  // =========================================================================
  // Notification preferences (per user, self-service via the REST layer)
  // =========================================================================

  getNotificationPrefs(userId: string): NotificationPref {
    return readNotificationPrefs(this.sql, userId);
  }

  /** Merge the patch onto the user's current prefs and persist the full set. */
  setNotificationPrefs(userId: string, patch: Partial<NotificationPref>): NotificationPref {
    const current = readNotificationPrefs(this.sql, userId);
    const next = mergeNotificationPrefs({ ...current, ...patch });
    writeNotificationPrefs(this.sql, userId, next, Date.now());
    return next;
  }

  private flush(t: Turn): void {
    this.broadcastDeltas(t.scopedBroadcastable());

    if (t.sideEffects.length > 0) {
      const batch = t.sideEffects.map((body) => ({ body }));
      this.ctx.waitUntil(
        this.env.SIDE_EFFECTS.sendBatch(batch).catch((err: unknown) =>
          console.error("side effect enqueue failed", err)
        )
      );
    }

    // Cheap indexed MIN; only re-arms when an automation queued a new job.
    const { next } = this.sql
      .exec<{ next: number | null }>("SELECT MIN(run_at) AS next FROM scheduled_jobs")
      .one();
    if (next !== null && next !== this.armedAlarm) this.ctx.waitUntil(this.armAlarm());
  }

  private automationContext(t: Turn, depth: number): AutomationContext {
    return {
      sql: this.sql,
      now: t.now,
      // Same fallback as sendNotification: APP_HOSTNAME is required config,
      // "localhost" is a neutral stand-in that can never leak traffic.
      appHostname: this.env.APP_HOSTNAME ?? "localhost",
      depth,
      emailDryRun: this.env.EMAIL_DRY_RUN !== "false",
      loadTaskFacts: (taskId: string) => this.loadTaskFacts(taskId),
      statusNameById: (statusId: string) => getStatus(this.sql, statusId)?.name ?? null,
      applyAction: (action: Action, taskId: string, d: number, ruleId?: string) =>
        this.applyAction(t, action, taskId, d, ruleId),
      enqueueSideEffect: (payload: SideEffectPayload) => t.enqueue(payload),
    };
  }

  /** Everything the engine needs about one task, resolved by name not id. */
  private loadTaskFacts(taskId: string): TaskFacts | null {
    const row = this.taskRow(taskId);
    if (row === null) return null;
    const task = toTask(row);
    const listRow = this.sql
      .exec<ListRow>(
        `SELECT ${LIST_COLUMNS}
         FROM lists WHERE id = ?`,
        task.listId
      )
      .toArray()[0];
    if (!listRow) return null;
    const spaceRow = this.sql
      .exec<SpaceRow>(
        `SELECT ${SPACE_COLUMNS} FROM spaces WHERE id = ?`,
        listRow.space_id
      )
      .toArray()[0];

    const assigneeRow =
      task.assigneeId === null
        ? undefined
        : this.sql
            .exec<{ id: string; name: string; email: string }>(
              "SELECT id, name, email FROM users WHERE id = ?",
              task.assigneeId
            )
            .toArray()[0];

    const counts = this.sql
      .exec<{ total: number; done: number }>(
        "SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM subtasks WHERE task_id = ?",
        taskId
      )
      .one();

    return {
      task,
      statusName: getStatus(this.sql, task.statusId)?.name ?? "",
      list: { id: listRow.id, name: listRow.name, spaceId: listRow.space_id },
      space: { id: listRow.space_id, name: spaceRow?.name ?? "" },
      assignee: assigneeRow
        ? { id: assigneeRow.id, name: assigneeRow.name, email: assigneeRow.email }
        : null,
      subtaskTotal: counts.total,
      subtaskDone: counts.done,
    };
  }

  /**
   * Re-entry point for automation actions. Mutations land in the SAME turn as
   * the trigger, so the client receives one coherent batch of deltas, and the
   * deltas they produce are stamped with `depth` — which is how the cap holds.
   *
   * `depth` is the engine's `ctx.depth + 1`: the depth at which this action
   * executes. Outbound actions (call_webhook, send_email) never arrive here —
   * the engine queues those itself.
   *
   * Template strings (`{{task.title}}` etc.) are the engine's responsibility:
   * whatever `title` arrives on a create_subtask action is used verbatim.
   */
  private applyAction(
    t: Turn,
    action: Action,
    taskId: string,
    depth: number,
    ruleId?: string
  ): void {
    if (depth > AUTOMATION_MAX_DEPTH) {
      throw new Error(
        `Automation depth cap of ${AUTOMATION_MAX_DEPTH} reached for task ${taskId}; ` +
          `action not applied (likely a rule loop).`
      );
    }
    const outer = t.depth;
    const outerRule = t.automationRuleId;
    t.depth = depth;
    // Everything audited between here and the `finally` was decided by this
    // rule, so it is attributed to the automation rather than to t.actor's
    // plain API call. Saved and restored because rules nest.
    t.automationRuleId = ruleId ?? outerRule;
    try {
      switch (action.kind) {
        case "set_status":
          this.applyTaskUpdate(t, { taskId, status: action.statusName }, "automation.set_status");
          break;
        case "set_assignee":
          this.applyTaskUpdate(t, { taskId, assigneeId: action.userId }, "automation.set_assignee");
          break;
        case "set_priority":
          this.applyTaskUpdate(t, { taskId, priority: action.priority }, "automation.set_priority");
          break;
        case "add_tags": {
          const current = toTask(this.requireTaskRow(taskId)).tags;
          const seen = new Set(current.map((x) => x.toLowerCase()));
          const merged = [...current];
          for (const tag of action.tags) {
            const clean = tag.trim();
            if (clean !== "" && !seen.has(clean.toLowerCase())) {
              seen.add(clean.toLowerCase());
              merged.push(clean);
            }
          }
          if (merged.length !== current.length) {
            this.applyTaskUpdate(t, { taskId, tags: merged }, "automation.add_tags");
          }
          break;
        }
        case "create_subtask":
          this.applySubtaskCreate(t, {
            taskId,
            title: action.title,
            assigneeId: action.assigneeId,
            dueDate:
              action.dueInDays === null || action.dueInDays === undefined
                ? null
                : t.now + action.dueInDays * DAY_MS,
          });
          break;
        case "move_to_list":
          this.applyTaskMove(t, { taskId, listId: action.listId }, "automation.move_to_list");
          break;
        case "call_webhook":
        case "send_email":
          // Outbound I/O never happens inline; the engine enqueues these
          // directly, so reaching here means a rule was mis-routed.
          console.error("applyAction received an outbound action", action.kind);
          break;
      }
    } finally {
      t.depth = outer;
      t.automationRuleId = outerRule;
    }
  }

  // =========================================================================
  // Per-space permissions
  //
  // One rule, applied in three shapes: reads filter, writes throw, and the
  // broadcast drops. Everything below a space inherits the space's decision, so
  // all three start by resolving the entity to a space id.
  // =========================================================================

  private spaceIdForList(listId: string): string | null {
    return (
      this.sql
        .exec<{ space_id: string }>("SELECT space_id FROM lists WHERE id = ?", listId)
        .toArray()[0]?.space_id ?? null
    );
  }

  private spaceIdForTask(taskId: string): string | null {
    return (
      this.sql
        .exec<{ space_id: string }>(
          `SELECT l.space_id AS space_id FROM tasks t JOIN lists l ON l.id = t.list_id
           WHERE t.id = ?`,
          taskId
        )
        .toArray()[0]?.space_id ?? null
    );
  }

  private spaceIdForSubtask(subtaskId: string): string | null {
    return (
      this.sql
        .exec<{ space_id: string }>(
          `SELECT l.space_id AS space_id FROM subtasks s
             JOIN tasks t ON t.id = s.task_id JOIN lists l ON l.id = t.list_id
           WHERE s.id = ?`,
          subtaskId
        )
        .toArray()[0]?.space_id ?? null
    );
  }

  private spaceIdForComment(commentId: string): string | null {
    return (
      this.sql
        .exec<{ space_id: string }>(
          `SELECT l.space_id AS space_id FROM comments c
             JOIN tasks t ON t.id = c.task_id JOIN lists l ON l.id = t.list_id
           WHERE c.id = ?`,
          commentId
        )
        .toArray()[0]?.space_id ?? null
    );
  }

  private spaceIdForAttachment(attachmentId: string): string | null {
    return (
      this.sql
        .exec<{ space_id: string }>(
          `SELECT l.space_id AS space_id FROM attachments a
             JOIN tasks t ON t.id = a.task_id JOIN lists l ON l.id = t.list_id
           WHERE a.id = ?`,
          attachmentId
        )
        .toArray()[0]?.space_id ?? null
    );
  }

  /**
   * The space a delta belongs to, for the per-connection broadcast filter.
   *
   * `user` and `automation_rule` deltas belong to no space and go to everyone.
   * Child-entity deltas resolve through their parent task, which is why `emit`
   * passes `taskId` along — a subtask id joined back to a space would be a
   * three-table hop that a delete delta could no longer make anyway.
   */
  private spaceIdForDelta(
    entity: Delta["entity"],
    entityId: string,
    taskId: string | undefined
  ): string | null {
    switch (entity) {
      case "space":
        return entityId;
      case "list":
        return this.spaceIdForList(entityId);
      case "task":
        return this.spaceIdForTask(entityId);
      case "subtask":
      case "comment":
      case "attachment":
        if (taskId !== undefined) return this.spaceIdForTask(taskId);
        return entity === "subtask"
          ? this.spaceIdForSubtask(entityId)
          : entity === "comment"
            ? this.spaceIdForComment(entityId)
            : this.spaceIdForAttachment(entityId);
      default:
        return null;
    }
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
    this.requireSpace(spaceId);
    return listSpaceMemberIds(this.sql, spaceId);
  }

  /**
   * The write guard. Throws the descriptive error when the actor cannot see the
   * space the mutation lands in.
   *
   * A null `spaceId` means the entity resolved to nothing — the row is missing,
   * and the caller's own `requireX` produces the better "not found" message a
   * moment later, so this stays out of the way. System actors (automations,
   * import) are exempt by design.
   */
  private assertSpaceWritable(actor: Actor, spaceId: string | null): void {
    if (spaceId === null || isSystemActor(actor)) return;
    const row = this.sql
      .exec<SpaceRow>(`SELECT ${SPACE_COLUMNS} FROM spaces WHERE id = ?`, spaceId)
      .toArray()[0];
    if (!row) return;
    const space = toSpace(row);
    if (space.visibility !== "private") return;
    const allowed = canSeeSpace(roleOf(this.sql, actor.userId), {
      visibility: space.visibility,
      isMember: isSpaceMember(this.sql, spaceId, actor.userId),
    });
    if (!allowed) throw new Error(privateSpaceError(spaceId));
  }

  private assertTaskWritable(actor: Actor, taskId: string): void {
    this.assertSpaceWritable(actor, this.spaceIdForTask(taskId));
  }

  private assertListWritable(actor: Actor, listId: string): void {
    this.assertSpaceWritable(actor, this.spaceIdForList(listId));
  }

  /**
   * Defence in depth for the two membership mutations. The routes already gate
   * them with `requireAdmin`, but these change who can see what, so the DO — the
   * only writer — checks the actor's stored role itself rather than trusting
   * that every future caller remembers to.
   */
  private requirePrivileged(actor: Actor, action: string): void {
    if (isSystemActor(actor)) return;
    const role = roleOf(this.sql, actor.userId);
    if (!isPrivilegedRole(role)) {
      throw new Error(
        `${action} requires the owner or admin role; ${actor.userId} is a ${role ?? "non-member"}.`
      );
    }
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
  getSnapshot(forUserId?: string): BoardSnapshot {
    const cutoff = Date.now() - SNAPSHOT_CLOSED_WINDOW_MS;
    const seq = this.maxSeq();
    // Only an absent id means "unfiltered". An empty one is an unidentified
    // caller — a socket accepted without an id, say — and gets the same
    // treatment as an unknown member: workspace-visible spaces and nothing else.
    const visible = forUserId === undefined ? null : visibleSpaceIds(this.sql, forUserId);

    const spaces = this.sql
      .exec<SpaceRow>(
        `SELECT ${SPACE_COLUMNS} FROM spaces ORDER BY position`
      )
      .toArray()
      .map(toSpace)
      .filter((sp) => visible === null || visible.has(sp.id));
    // The visible-list set is what the task and subtask filters key off, so the
    // hierarchy can only ever be filtered consistently: no orphan list under a
    // hidden space, no task whose list is gone.
    const visibleListIds =
      visible === null
        ? null
        : new Set(
            this.sql
              .exec<{ id: string; space_id: string }>("SELECT id, space_id FROM lists")
              .toArray()
              .filter((r) => visible.has(r.space_id))
              .map((r) => r.id)
          );

    // One pass over statuses, grouped in memory, instead of a query per list.
    const statusesByList = new Map<string, Status[]>();
    for (const s of this.sql
      .exec<{
        id: string;
        list_id: string;
        name: string;
        color: string;
        type: string;
        position: number;
      }>("SELECT id, list_id, name, color, type, position FROM statuses ORDER BY list_id, position")
      .toArray()) {
      const bucket = statusesByList.get(s.list_id);
      const status: Status = {
        id: s.id,
        name: s.name,
        color: s.color,
        type: s.type as Status["type"],
        position: s.position,
      };
      if (bucket) bucket.push(status);
      else statusesByList.set(s.list_id, [status]);
    }

    const lists = this.sql
      .exec<ListRow>(
        `SELECT ${LIST_COLUMNS}
         FROM lists ORDER BY space_id, position`
      )
      .toArray()
      .filter((r) => visibleListIds === null || visibleListIds.has(r.id))
      .map((r) => toList(r, statusesByList.get(r.id) ?? []));

    const tasks = this.sql
      .exec<SnapshotTaskRowSql>(
        `SELECT ${SNAPSHOT_TASK_COLUMNS} FROM tasks
         WHERE closed_at IS NULL OR closed_at >= ?
         ORDER BY list_id, status_id, position`,
        cutoff
      )
      .toArray()
      .filter((r) => visibleListIds === null || visibleListIds.has(r.list_id))
      .map(toSnapshotTask);

    const visibleTaskIds = visibleListIds === null ? null : new Set(tasks.map((t) => t.id));
    const subtasks = this.sql
      .exec<SubtaskRow>(
        `SELECT s.id, s.task_id, s.title, s.done, s.assignee_id, s.due_date, s.position, s.created_at
         FROM subtasks s JOIN tasks t ON t.id = s.task_id
         WHERE t.closed_at IS NULL OR t.closed_at >= ?
         ORDER BY s.task_id, s.position`,
        cutoff
      )
      .toArray()
      .filter((r) => visibleTaskIds === null || visibleTaskIds.has(r.task_id))
      .map(toSubtask);

    return {
      seq,
      spaces,
      lists,
      tasks,
      subtasks,
      users: this.listUsers(),
      automationRules: this.listAutomations(),
    };
  }

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
  } {
    const visible = forUserId === undefined ? null : visibleSpaceIds(this.sql, forUserId);
    const counts = new Map<string, number>();
    for (const r of this.sql
      .exec<{ list_id: string; n: number }>(
        "SELECT list_id, COUNT(*) AS n FROM tasks WHERE closed_at IS NULL GROUP BY list_id"
      )
      .toArray()) {
      counts.set(r.list_id, r.n);
    }
    const snapshotLists = this.sql
      .exec<ListRow>(
        `SELECT ${LIST_COLUMNS}
         FROM lists ORDER BY space_id, position`
      )
      .toArray();
    const spaces = this.sql
      .exec<SpaceRow>(
        `SELECT ${SPACE_COLUMNS} FROM spaces ORDER BY position`
      )
      .toArray()
      .map(toSpace)
      .filter((sp) => visible === null || visible.has(sp.id));

    return {
      seq: this.maxSeq(),
      spaces: spaces.map((sp) => ({
        ...sp,
        lists: snapshotLists
          .filter((l) => l.space_id === sp.id)
          .map((l) => ({
            id: l.id,
            name: l.name,
            archived: l.archived !== 0,
            statuses: listStatuses(this.sql, l.id),
            openTasks: counts.get(l.id) ?? 0,
          })),
      })),
      users: this.listUsers(),
    };
  }

  /**
   * One task with its children. `forUserId` refuses the read when the task
   * lives in a space that user cannot see — with the same sentence a blocked
   * write gets, rather than a bare 404, so nobody wastes time on a "missing"
   * task that is simply someone else's.
   */
  getTaskDetail(taskId: string, forUserId?: string): TaskDetail {
    const row = this.requireTaskRow(taskId);
    if (forUserId !== undefined) {
      this.assertSpaceWritable(toActor(forUserId), this.spaceIdForTask(taskId));
    }
    return {
      task: toTask(row),
      subtasks: this.listSubtasks(taskId),
      comments: this.listComments(taskId),
      attachments: this.listAttachments(taskId),
    };
  }

  /**
   * `actor` is optional for internal callers; when present, results are limited
   * to the spaces that user may see (including `total`, so paging stays honest).
   */
  searchTasks(input: SearchTasksInput, actor?: string | Actor): SearchTasksResult {
    const visible = actor === undefined ? null : visibleSpaceIds(this.sql, toActor(actor).userId);
    return runSearch(this.sql, input, visible);
  }

  listUsers(): User[] {
    return this.sql
      .exec<UserRow>(
        `SELECT id, email, name, role, deactivated, created_at, needs_email_update, clickup_id
         FROM users ORDER BY created_at`
      )
      .toArray()
      .map(toUser);
  }

  /** Users whose email is a placeholder from the import and needs a real one. */
  listUsersNeedingEmail(): User[] {
    return this.sql
      .exec<UserRow>(
        `SELECT id, email, name, role, deactivated, created_at, needs_email_update, clickup_id
         FROM users WHERE needs_email_update = 1 ORDER BY created_at`
      )
      .toArray()
      .map(toUser);
  }

  getUserByEmail(email: string): User | null {
    const row = this.sql
      .exec<UserRow>(
        `SELECT id, email, name, role, deactivated, created_at, needs_email_update, clickup_id
         FROM users WHERE lower(email) = lower(?)`,
        email.trim()
      )
      .toArray()[0];
    return row ? toUser(row) : null;
  }

  /**
   * First-login bootstrap. The schema seed can't read env, so a fresh
   * workspace holds one owner at owner@placeholder.flow. When the operator's
   * OWNER_EMAIL authenticates for the first time, it claims that seeded row —
   * same user id, real email, needs_email_update cleared — instead of being
   * turned away at the door. A no-op once the workspace has real users.
   */
  claimOwner(email: string): User | null {
    const trimmed = email.trim();
    if (trimmed === "") return null;
    const existing = this.getUserByEmail(trimmed);
    if (existing) return existing;
    const placeholder = this.getUserByEmail(`owner@${PLACEHOLDER_EMAIL_DOMAIN}`);
    if (!placeholder || placeholder.role !== "owner" || placeholder.deactivated) return null;
    return this.upsertUser({ id: placeholder.id, email: trimmed }, placeholder.id);
  }

  listSubtasks(taskId: string): Subtask[] {
    return this.sql
      .exec<SubtaskRow>(
        `SELECT id, task_id, title, done, assignee_id, due_date, position, created_at
         FROM subtasks WHERE task_id = ? ORDER BY position`,
        taskId
      )
      .toArray()
      .map(toSubtask);
  }

  listComments(taskId: string): Comment[] {
    return this.sql
      .exec<CommentRow>(
        "SELECT id, task_id, author_id, body, created_at FROM comments WHERE task_id = ? ORDER BY created_at",
        taskId
      )
      .toArray()
      .map(toComment);
  }

  listAttachments(taskId: string): Attachment[] {
    return this.sql
      .exec<AttachmentRow>(
        `SELECT id, task_id, filename, r2_key, size, mime_type, uploaded_by, created_at
         FROM attachments WHERE task_id = ? ORDER BY created_at`,
        taskId
      )
      .toArray()
      .map(toAttachment);
  }

  /** Single attachment row — the api Worker needs r2Key to stream a download. */
  getAttachment(attachmentId: string): Attachment | null {
    const row = this.sql
      .exec<AttachmentRow>(
        `SELECT id, task_id, filename, r2_key, size, mime_type, uploaded_by, created_at
         FROM attachments WHERE id = ?`,
        attachmentId
      )
      .toArray()[0];
    return row ? toAttachment(row) : null;
  }

  listAutomations(): AutomationRule[] {
    return this.sql
      .exec<RuleRow>(
        `SELECT id, name, enabled, scope, trigger, conditions, actions, created_at, updated_at
         FROM automation_rules ORDER BY created_at`
      )
      .toArray()
      .map(toRule);
  }

  /**
   * Automation run log, newest first.
   *
   * `before` is a keyset cursor (the previous page's smallest `id`), matching
   * how getAuditLog pages: an offset would skip or repeat rows as new runs land
   * between requests.
   */
  listAutomationRuns(
    filter: { ruleId?: string; taskId?: string; before?: number; limit?: number } = {}
  ): AutomationRunLog[] {
    const where: string[] = [];
    const params: SqlStorageValue[] = [];
    if (filter.ruleId !== undefined) {
      where.push("rule_id = ?");
      params.push(filter.ruleId);
    }
    if (filter.taskId !== undefined) {
      where.push("task_id = ?");
      params.push(filter.taskId);
    }
    if (filter.before !== undefined) {
      where.push("id < ?");
      params.push(filter.before);
    }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    return this.sql
      .exec<{
        id: number;
        rule_id: string;
        task_id: string;
        trigger: string;
        results: string;
        depth: number;
        at: number;
      }>(
        `SELECT id, rule_id, task_id, trigger, results, depth, at FROM automation_runs
         ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
         ORDER BY id DESC LIMIT ?`,
        ...params,
        limit
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        ruleId: r.rule_id,
        taskId: r.task_id,
        trigger: r.trigger,
        results: JSON.parse(r.results) as AutomationRunLog["results"],
        depth: r.depth,
        at: r.at,
      }));
  }

  getAuditLog(
    filter: {
      entity?: string;
      /** Mutation name, e.g. "task.update". */
      action?: string;
      userId?: string;
      apiKeyId?: string;
      /** Keyset cursor: the previous page's `nextBefore`. */
      before?: number;
      limit?: number;
    } = {}
  ): { entries: AuditEntry[]; nextBefore: number | null } {
    const where: string[] = [];
    const params: SqlStorageValue[] = [];
    if (filter.entity !== undefined) {
      where.push("entity = ?");
      params.push(filter.entity);
    }
    if (filter.action !== undefined) {
      where.push("action = ?");
      params.push(filter.action);
    }
    if (filter.userId !== undefined) {
      where.push("actor_user_id = ?");
      params.push(filter.userId);
    }
    if (filter.apiKeyId !== undefined) {
      where.push("api_key_id = ?");
      params.push(filter.apiKeyId);
    }
    if (filter.before !== undefined) {
      where.push("id < ?");
      params.push(filter.before);
    }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const rows = this.sql
      .exec<AuditRow>(
        `SELECT id, actor, action, entity, diff, at FROM audit
         ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
         ORDER BY id DESC LIMIT ?`,
        ...params,
        limit
      )
      .toArray();
    const last = rows[rows.length - 1];
    return {
      entries: rows.map(toAuditEntry),
      nextBefore: rows.length === limit && last ? last.id : null,
    };
  }

  /** Auth hot path: resolve a bearer token hash, stamping last_used_at. */
  resolveApiKey(tokenHash: string): { key: ApiKey; user: User } | null {
    const rows = this.sql
      .exec<ApiKeyRow>(
        `SELECT id, user_id, name, token_hash, created_at, last_used_at, revoked_at
         FROM api_keys WHERE token_hash = ?`,
        tokenHash
      )
      .toArray();
    const row = rows[0];
    if (!row || row.revoked_at !== null) return null;
    const users = this.sql
      .exec<UserRow>(
        `SELECT id, email, name, role, deactivated, created_at, needs_email_update, clickup_id
         FROM users WHERE id = ?`,
        row.user_id
      )
      .toArray();
    const user = users[0];
    if (!user) return null;
    // Not a delta-worthy change: no audit row, no broadcast.
    this.sql.exec("UPDATE api_keys SET last_used_at = ? WHERE id = ?", Date.now(), row.id);
    return { key: toApiKey(row), user: toUser(user) };
  }

  listApiKeys(): ApiKey[] {
    return this.sql
      .exec<ApiKeyRow>(
        `SELECT id, user_id, name, token_hash, created_at, last_used_at, revoked_at
         FROM api_keys ORDER BY created_at`
      )
      .toArray()
      .map(toApiKey);
  }

  /**
   * Resolve the list behind an inbound webhook bearer token.
   *
   * One of only two reads that carry `inboundToken`; the caller (the inbound
   * route) uses it for auth and never puts the list in a response body.
   */
  getListByInboundToken(inboundToken: string): List | null {
    const rows = this.sql
      .exec<ListRow>(
        `SELECT ${LIST_COLUMNS}
         FROM lists WHERE inbound_token = ?`,
        inboundToken
      )
      .toArray();
    const row = rows[0];
    return row ? toListWithSecrets(row, listStatuses(this.sql, row.id)) : null;
  }

  /**
   * One list WITH its inbound token. Admin-only by contract — the api Worker
   * gates it — and the reason `getSnapshot()` can null the token unconditionally
   * without breaking the "show me the intake credential" flow.
   */
  getListWithSecrets(listId: string): List | null {
    const rows = this.sql
      .exec<ListRow>(
        `SELECT ${LIST_COLUMNS}
         FROM lists WHERE id = ?`,
        listId
      )
      .toArray();
    const row = rows[0];
    return row ? toListWithSecrets(row, listStatuses(this.sql, row.id)) : null;
  }

  // =========================================================================
  // Task mutations
  // =========================================================================

  createTask(input: CreateTaskInput, actor: string | Actor): Task {
    return this.runTaskTurn(toActor(actor), (t) => {
      this.assertListWritable(t.actor, input.listId);
      return this.applyTaskCreate(t, input);
    });
  }

  private applyTaskCreate(t: Turn, input: CreateTaskInput): Task {
    const listRow = this.requireListRow(input.listId);
    const status =
      input.status === undefined
        ? openStatus(this.sql, listRow.id)
        : resolveStatusName(this.sql, listRow.id, input.status);

    // Unknown ids used to land in the row unchecked (assignee_id has no FK), so
    // the task silently pointed at nobody. Validate before anything is written.
    requireAssignee(this.sql, input.assigneeId);
    for (const sub of input.subtasks ?? []) requireAssignee(this.sql, sub.assigneeId);

    const tags = normalizeTags(input.tags ?? []);
    const taskId = id("tk_");
    const task: Task = {
      id: taskId,
      listId: listRow.id,
      title: input.title,
      description: input.description,
      statusId: status.id,
      assigneeId: input.assigneeId ?? null,
      priority: input.priority ?? null,
      dueDate: input.dueDate ?? null,
      startDate: input.startDate ?? null,
      // A brand-new task is never born asleep; snoozing is an explicit update.
      snoozedUntil: null,
      blockedNote: null,
      tags,
      position: nextTaskPosition(this.sql, listRow.id, status.id),
      createdBy: t.actor.userId,
      createdAt: t.now,
      updatedAt: t.now,
      closedAt: status.type === "closed" ? t.now : null,
      clickupId: null,
    };

    this.insertTaskRow(task);
    t.emit("create", "task", taskId, task as unknown as Record<string, unknown>);
    t.audit("task.create", taskId, { listId: task.listId, title: task.title });

    // Inline subtasks: each gets its own delta so clients patch incrementally.
    for (const sub of input.subtasks ?? []) {
      this.applySubtaskCreate(t, {
        taskId,
        title: sub.title,
        assigneeId: sub.assigneeId ?? null,
        dueDate: null,
      });
    }
    return task;
  }

  updateTask(input: UpdateTaskInput, actor: string | Actor): Task {
    return this.runTaskTurn(toActor(actor), (t) => {
      this.assertTaskWritable(t.actor, input.taskId);
      return this.applyTaskUpdate(t, input, "task.update");
    });
  }

  private applyTaskUpdate(t: Turn, input: UpdateTaskInput, action: string): Task {
    const row = this.requireTaskRow(input.taskId);
    const before = toTask(row);

    const sets: string[] = [];
    const params: SqlStorageValue[] = [];
    const set = (column: string, value: SqlStorageValue): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };

    if (input.title !== undefined && input.title !== before.title) set("title", input.title);
    if (input.description !== undefined && input.description !== before.description) {
      set("description", input.description);
    }
    if (input.assigneeId !== undefined && (input.assigneeId ?? null) !== before.assigneeId) {
      requireAssignee(this.sql, input.assigneeId);
      set("assignee_id", input.assigneeId ?? null);
    }
    if (input.priority !== undefined && (input.priority ?? null) !== before.priority) {
      set("priority", input.priority ?? null);
    }
    if (input.dueDate !== undefined && (input.dueDate ?? null) !== before.dueDate) {
      set("due_date", input.dueDate ?? null);
    }
    if (input.startDate !== undefined && (input.startDate ?? null) !== before.startDate) {
      set("start_date", input.startDate ?? null);
    }
    // Snooze and its note are ordinary nullable fields: null clears them, and
    // they ride the normal changed-fields delta. Nothing here touches the
    // status — a task wakes up exactly where it went to sleep.
    if (input.snoozedUntil !== undefined && (input.snoozedUntil ?? null) !== before.snoozedUntil) {
      set("snoozed_until", input.snoozedUntil ?? null);
    }
    if (input.blockedNote !== undefined && (input.blockedNote ?? null) !== before.blockedNote) {
      set("blocked_note", input.blockedNote ?? null);
    }
    if (input.tags !== undefined) {
      const tags = normalizeTags(input.tags);
      if (JSON.stringify(tags) !== JSON.stringify(before.tags)) {
        set("tags", JSON.stringify(tags));
        set("tags_text", tagsText(tags));
      }
    }
    if (input.status !== undefined) {
      const status = resolveStatusName(this.sql, before.listId, input.status);
      if (status.id !== before.statusId) {
        set("status_id", status.id);
        // Closed-type membership is what drives closedAt, both directions.
        if (status.type === "closed" && before.closedAt === null) set("closed_at", t.now);
        else if (status.type !== "closed" && before.closedAt !== null) set("closed_at", null);
        // The task joins the end of its new column.
        set("position", nextTaskPosition(this.sql, before.listId, status.id));
      }
    }

    if (sets.length === 0) return before; // no-op: no delta, no audit row

    set("updated_at", t.now);
    this.sql.exec(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...params, before.id);

    const after = toTask(this.requireTaskRow(before.id));
    const patch = diffOf(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
      TASK_DIFF_KEYS
    );
    patch.updatedAt = after.updatedAt;
    // `prev` lets status_changed / assignee_changed / tag_added rules see what
    // the value used to be; a Delta's data holds changed fields only.
    t.emit("update", "task", after.id, patch, { prev: prevOf(before as unknown as Record<string, unknown>, patch) });
    t.audit(action, after.id, patch);
    return after;
  }

  moveTask(input: MoveTaskInput, actor: string | Actor): Task {
    return this.runTaskTurn(toActor(actor), (t) => {
      // Both ends: you may not drag a task out of a space you cannot see, and
      // you may not smuggle one into a private space you are not a member of.
      this.assertTaskWritable(t.actor, input.taskId);
      if (input.listId !== undefined) this.assertListWritable(t.actor, input.listId);
      return this.applyTaskMove(t, input, "task.move");
    });
  }

  private applyTaskMove(t: Turn, input: MoveTaskInput, action: string): Task {
    const row = this.requireTaskRow(input.taskId);
    const before = toTask(row);
    const targetListId = input.listId ?? before.listId;
    if (input.listId !== undefined) this.requireListRow(input.listId);

    // Statuses are per-list, so a cross-list move must re-resolve the status.
    let status: Status;
    if (input.status !== undefined) {
      status = resolveStatusName(this.sql, targetListId, input.status);
    } else if (targetListId !== before.listId) {
      const old = getStatus(this.sql, before.statusId);
      const candidates = listStatuses(this.sql, targetListId);
      status =
        (old ? candidates.find((s) => s.name.toLowerCase() === old.name.toLowerCase()) : undefined) ??
        openStatus(this.sql, targetListId);
    } else {
      status = getStatus(this.sql, before.statusId) ?? openStatus(this.sql, targetListId);
    }

    let position: number;
    if (input.position !== undefined) {
      position = input.position;
    } else {
      // Clients omit `position` when their own midpoint would underflow, so
      // renumber the target column first and only then append. Either way the
      // Task returned below carries the authoritative final position.
      if (columnHasCollapsed(this.sql, targetListId, status.id)) {
        rebalanceTaskColumn(this.sql, targetListId, status.id);
      }
      position = nextTaskPosition(this.sql, targetListId, status.id);
    }

    const closedAt =
      status.type === "closed" ? (before.closedAt ?? t.now) : null;

    this.sql.exec(
      `UPDATE tasks SET list_id = ?, status_id = ?, position = ?, closed_at = ?, updated_at = ?
       WHERE id = ?`,
      targetListId,
      status.id,
      position,
      closedAt,
      t.now,
      before.id
    );

    // A client-supplied midpoint can collapse after enough inserts; renumber
    // the column once and re-read rather than let ordering go non-deterministic.
    const neighbours = this.sql
      .exec<{ prev: number | null; next: number | null }>(
        `SELECT (SELECT MAX(position) FROM tasks WHERE list_id = ? AND status_id = ? AND position < ?) AS prev,
                (SELECT MIN(position) FROM tasks WHERE list_id = ? AND status_id = ? AND position > ?) AS next`,
        targetListId,
        status.id,
        position,
        targetListId,
        status.id,
        position
      )
      .one();
    if (needsRebalance(neighbours.prev, position) || needsRebalance(position, neighbours.next)) {
      rebalanceTaskColumn(this.sql, targetListId, status.id);
    }

    const after = toTask(this.requireTaskRow(before.id));
    const patch = diffOf(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
      TASK_DIFF_KEYS
    );
    if (Object.keys(patch).length === 0) return after;
    patch.updatedAt = after.updatedAt;
    t.emit("update", "task", after.id, patch, { prev: prevOf(before as unknown as Record<string, unknown>, patch) });
    t.audit(action, after.id, patch);
    return after;
  }

  /**
   * Per-item results: one bad row never rolls back the good ones, and the
   * caller can retry exactly the failures.
   */
  bulkUpdate(input: BulkUpdateInput, actor: string | Actor): BulkResult {
    return this.runTurn(toActor(actor), (t) => {
      const results: BulkResult["results"] = [];
      for (const update of input.updates) {
        try {
          // Per item, like every other bulk failure: one task in a space the
          // caller cannot see fails that row and leaves the rest of the batch.
          this.assertTaskWritable(t.actor, update.taskId);
          const task = this.applyTaskUpdate(t, update, "task.bulk_update");
          results.push({ taskId: task.id, ok: true, error: null });
        } catch (err) {
          results.push({
            taskId: update.taskId ?? null,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { results };
    });
  }

  deleteTask(taskId: string, actor: string | Actor): { ok: true } {
    return this.runTurn(toActor(actor), (t) => {
      const row = this.requireTaskRow(taskId);
      const spaceId = this.spaceIdForTask(taskId);
      this.assertSpaceWritable(t.actor, spaceId);
      // Subtasks are in the snapshot, so they need their own delete deltas.
      // Comments and attachments are lazy-loaded per task and need none.
      const subtaskIds = this.sql
        .exec<{ id: string }>("SELECT id FROM subtasks WHERE task_id = ?", taskId)
        .toArray()
        .map((r) => r.id);

      this.sql.exec("DELETE FROM subtasks WHERE task_id = ?", taskId);
      this.sql.exec("DELETE FROM comments WHERE task_id = ?", taskId);
      this.sql.exec("DELETE FROM attachments WHERE task_id = ?", taskId);
      // The engine's due-date fired-guard would otherwise keep dead rows.
      this.sql.exec("DELETE FROM automation_due_fires WHERE task_id = ?", taskId);
      this.sql.exec("DELETE FROM tasks WHERE id = ?", taskId); // trigger clears FTS

      // The rows are gone by now, so the space is passed explicitly: the
      // broadcast filter still has to know which board these deletes belong to.
      for (const sid of subtaskIds) t.emit("delete", "subtask", sid, null, { taskId, spaceId });
      t.emit("delete", "task", taskId, null, { spaceId });
      t.audit("task.delete", taskId, { listId: row.list_id, title: row.title });
      return { ok: true } as const;
    });
  }

  // =========================================================================
  // Subtasks (Asana-style: done/not-done, no statuses)
  // =========================================================================

  createSubtask(input: ParsedSubtaskInput, actor: string | Actor): Subtask {
    return this.runTurn(toActor(actor), (t) => {
      this.assertTaskWritable(t.actor, input.taskId);
      return this.applySubtaskCreate(t, {
        taskId: input.taskId,
        title: input.title,
        assigneeId: input.assigneeId ?? null,
        dueDate: input.dueDate ?? null,
      });
    });
  }

  private applySubtaskCreate(
    t: Turn,
    input: { taskId: string; title: string; assigneeId: string | null; dueDate: number | null }
  ): Subtask {
    this.requireTaskRow(input.taskId);
    requireAssignee(this.sql, input.assigneeId);
    const subtask: Subtask = {
      id: id("sb_"),
      taskId: input.taskId,
      title: input.title,
      done: false,
      assigneeId: input.assigneeId,
      dueDate: input.dueDate,
      position: nextSubtaskPosition(this.sql, input.taskId),
      createdAt: t.now,
    };
    this.sql.exec(
      `INSERT INTO subtasks (id, task_id, title, done, assignee_id, due_date, position, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
      subtask.id,
      subtask.taskId,
      subtask.title,
      subtask.assigneeId,
      subtask.dueDate,
      subtask.position,
      subtask.createdAt
    );
    t.emit("create", "subtask", subtask.id, subtask as unknown as Record<string, unknown>, {
      taskId: subtask.taskId,
    });
    t.audit("subtask.create", subtask.id, { taskId: subtask.taskId, title: subtask.title });
    return subtask;
  }

  updateSubtask(
    input: { subtaskId: string; title?: string; assigneeId?: string | null; dueDate?: number | null; position?: number },
    actor: string | Actor
  ): Subtask {
    return this.runTurn(toActor(actor), (t) => {
      const before = this.requireSubtask(input.subtaskId);
      this.assertTaskWritable(t.actor, before.taskId);
      const sets: string[] = [];
      const params: SqlStorageValue[] = [];
      if (input.title !== undefined && input.title !== before.title) {
        sets.push("title = ?");
        params.push(input.title);
      }
      if (input.assigneeId !== undefined && (input.assigneeId ?? null) !== before.assigneeId) {
        requireAssignee(this.sql, input.assigneeId);
        sets.push("assignee_id = ?");
        params.push(input.assigneeId ?? null);
      }
      if (input.dueDate !== undefined && (input.dueDate ?? null) !== before.dueDate) {
        sets.push("due_date = ?");
        params.push(input.dueDate ?? null);
      }
      if (input.position !== undefined && input.position !== before.position) {
        sets.push("position = ?");
        params.push(input.position);
      }
      if (sets.length === 0) return before;
      this.sql.exec(`UPDATE subtasks SET ${sets.join(", ")} WHERE id = ?`, ...params, before.id);
      const after = this.requireSubtask(before.id);
      const patch = diffOf(
        before as unknown as Record<string, unknown>,
        after as unknown as Record<string, unknown>,
        ["title", "assigneeId", "dueDate", "position", "done"]
      );
      t.emit("update", "subtask", after.id, patch, { taskId: after.taskId });
      t.audit("subtask.update", after.id, patch);
      return after;
    });
  }

  toggleSubtask(input: ParsedToggleInput, actor: string | Actor): Subtask {
    return this.runTurn(toActor(actor), (t) => {
      const before = this.requireSubtask(input.subtaskId);
      this.assertTaskWritable(t.actor, before.taskId);
      if (before.done === input.done) return before;
      this.sql.exec("UPDATE subtasks SET done = ? WHERE id = ?", input.done ? 1 : 0, before.id);
      const after = this.requireSubtask(before.id);
      t.emit("update", "subtask", after.id, { done: after.done }, { taskId: after.taskId });
      t.audit("subtask.toggle", after.id, { done: after.done, taskId: after.taskId });
      // all_subtasks_done is a trigger the engine derives from this delta.
      return after;
    });
  }

  deleteSubtask(subtaskId: string, actor: string | Actor): { ok: true } {
    return this.runTurn(toActor(actor), (t) => {
      const before = this.requireSubtask(subtaskId);
      this.assertTaskWritable(t.actor, before.taskId);
      const spaceId = this.spaceIdForTask(before.taskId);
      this.sql.exec("DELETE FROM subtasks WHERE id = ?", subtaskId);
      t.emit("delete", "subtask", subtaskId, null, { taskId: before.taskId, spaceId });
      t.audit("subtask.delete", subtaskId, { taskId: before.taskId });
      return { ok: true } as const;
    });
  }

  // =========================================================================
  // Comments
  // =========================================================================

  createComment(input: ParsedCommentInput, actor: string | Actor): Comment {
    return this.runTurn(toActor(actor), (t) => {
      const taskRow = this.requireTaskRow(input.taskId);
      this.assertTaskWritable(t.actor, input.taskId);
      const comment: Comment = {
        id: id("cm_"),
        taskId: input.taskId,
        authorId: t.actor.userId,
        body: input.body,
        createdAt: t.now,
      };
      this.sql.exec(
        "INSERT INTO comments (id, task_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
        comment.id,
        comment.taskId,
        comment.authorId,
        comment.body,
        comment.createdAt
      );
      t.emit("create", "comment", comment.id, comment as unknown as Record<string, unknown>, {
        taskId: comment.taskId,
      });
      t.audit("comment.create", comment.id, { taskId: comment.taskId });
      // Activity wakes a snoozed task, in this same turn: the comment delta and
      // the task's snoozedUntil -> null delta commit and broadcast together, so
      // nobody ever sees the comment land on a card that is still asleep.
      if (wakesOnComment(taskRow.snoozed_until ?? null)) {
        this.applyTaskUpdate(t, { taskId: comment.taskId, snoozedUntil: null }, "task.wake");
      }
      return comment;
    });
  }

  deleteComment(commentId: string, actor: string | Actor): { ok: true } {
    return this.runTurn(toActor(actor), (t) => {
      const rows = this.sql
        .exec<CommentRow>(
          "SELECT id, task_id, author_id, body, created_at FROM comments WHERE id = ?",
          commentId
        )
        .toArray();
      const row = rows[0];
      if (!row) throw new Error(`Comment ${commentId} not found.`);
      this.assertTaskWritable(t.actor, row.task_id);
      const spaceId = this.spaceIdForTask(row.task_id);
      this.sql.exec("DELETE FROM comments WHERE id = ?", commentId);
      t.emit("delete", "comment", commentId, null, { spaceId });
      t.audit("comment.delete", commentId, { taskId: row.task_id });
      return { ok: true } as const;
    });
  }

  // =========================================================================
  // Attachments — the api Worker does the R2 upload, the DO owns the metadata
  // =========================================================================

  createAttachment(input: CreateAttachmentInput, actor: string | Actor): Attachment {
    return this.runTurn(toActor(actor), (t) => {
      this.requireTaskRow(input.taskId);
      this.assertTaskWritable(t.actor, input.taskId);
      const attachment: Attachment = {
        id: input.id ?? id("at_"),
        taskId: input.taskId,
        filename: input.filename,
        r2Key: input.r2Key,
        size: input.size,
        mimeType: input.mimeType,
        uploadedBy: t.actor.userId,
        createdAt: t.now,
      };
      this.sql.exec(
        `INSERT INTO attachments (id, task_id, filename, r2_key, size, mime_type, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        attachment.id,
        attachment.taskId,
        attachment.filename,
        attachment.r2Key,
        attachment.size,
        attachment.mimeType,
        attachment.uploadedBy,
        attachment.createdAt
      );
      t.emit("create", "attachment", attachment.id, attachment as unknown as Record<string, unknown>, {
        taskId: attachment.taskId,
      });
      t.audit("attachment.create", attachment.id, {
        taskId: attachment.taskId,
        filename: attachment.filename,
      });
      return attachment;
    });
  }

  /** Returns the r2Key so the caller can delete the object from R2. */
  deleteAttachment(attachmentId: string, actor: string | Actor): { ok: true; r2Key: string } {
    return this.runTurn(toActor(actor), (t) => {
      const rows = this.sql
        .exec<AttachmentRow>(
          `SELECT id, task_id, filename, r2_key, size, mime_type, uploaded_by, created_at
           FROM attachments WHERE id = ?`,
          attachmentId
        )
        .toArray();
      const row = rows[0];
      if (!row) throw new Error(`Attachment ${attachmentId} not found.`);
      this.assertTaskWritable(t.actor, row.task_id);
      const spaceId = this.spaceIdForTask(row.task_id);
      this.sql.exec("DELETE FROM attachments WHERE id = ?", attachmentId);
      t.emit("delete", "attachment", attachmentId, null, { spaceId });
      t.audit("attachment.delete", attachmentId, { taskId: row.task_id });
      return { ok: true as const, r2Key: row.r2_key };
    });
  }

  // =========================================================================
  // Spaces & lists
  // =========================================================================

  createSpace(input: ParsedSpaceInput, actor: string | Actor): Space {
    return this.runTurn(toActor(actor), (t) => {
      const space: Space = {
        id: id("sp_"),
        name: input.name,
        color: input.color ?? null,
        position: nextPosition(this.sql, "spaces"),
        archived: false,
        // Spaces are born workspace-visible; making one private is a separate,
        // audited mutation (`setSpaceVisibility`).
        visibility: "workspace",
        createdAt: t.now,
      };
      this.sql.exec(
        `INSERT INTO spaces (id, name, color, position, archived, visibility, created_at, created_by)
         VALUES (?, ?, ?, ?, 0, 'workspace', ?, ?)`,
        space.id,
        space.name,
        space.color,
        space.position,
        space.createdAt,
        t.actor.userId
      );
      t.emit("create", "space", space.id, space as unknown as Record<string, unknown>);
      t.audit("space.create", space.id, { name: space.name });
      return space;
    });
  }

  updateSpace(
    input: { spaceId: string; name?: string; color?: string | null; archived?: boolean; position?: number },
    actor: string | Actor
  ): Space {
    return this.runTurn(toActor(actor), (t) => {
      const before = this.requireSpace(input.spaceId);
      const sets: string[] = [];
      const params: SqlStorageValue[] = [];
      if (input.name !== undefined && input.name !== before.name) {
        sets.push("name = ?");
        params.push(input.name);
      }
      if (input.color !== undefined && (input.color ?? null) !== before.color) {
        sets.push("color = ?");
        params.push(input.color ?? null);
      }
      if (input.archived !== undefined && input.archived !== before.archived) {
        sets.push("archived = ?");
        params.push(input.archived ? 1 : 0);
      }
      if (input.position !== undefined && input.position !== before.position) {
        sets.push("position = ?");
        params.push(input.position);
      }
      if (sets.length === 0) return before;
      this.sql.exec(`UPDATE spaces SET ${sets.join(", ")} WHERE id = ?`, ...params, before.id);
      const after = this.requireSpace(before.id);
      const patch = diffOf(
        before as unknown as Record<string, unknown>,
        after as unknown as Record<string, unknown>,
        ["name", "color", "archived", "position"]
      );
      t.emit("update", "space", after.id, patch);
      t.audit("space.update", after.id, patch);
      return after;
    });
  }

  /**
   * Flip a space between workspace-wide and private.
   *
   * Going private auto-adds the space's creator, so an admin cannot lock the
   * person who built the space out of it with one click. Spaces from the ClickUp
   * import have no recorded creator, and there the acting admin is added
   * instead — the space needs at least one member, and the person doing the
   * flip is the honest answer.
   *
   * The change cannot be expressed as a patch for clients whose view of the
   * space just changed, so they are told to resync (see `resyncFor`).
   */
  setSpaceVisibility(
    input: { spaceId: string; visibility: SpaceVisibility },
    actor: string | Actor
  ): Space {
    const result = this.runTurn(toActor(actor), (t) => {
      this.requirePrivileged(t.actor, "Changing a space's visibility");
      const before = this.requireSpace(input.spaceId);
      if (before.visibility === input.visibility) return { space: before, changed: false };

      this.sql.exec(
        "UPDATE spaces SET visibility = ? WHERE id = ?",
        input.visibility,
        input.spaceId
      );

      if (input.visibility === "private") {
        const createdBy =
          this.sql
            .exec<{ created_by: string | null }>(
              "SELECT created_by FROM spaces WHERE id = ?",
              input.spaceId
            )
            .toArray()[0]?.created_by ?? null;
        this.addSpaceMember(input.spaceId, createdBy ?? t.actor.userId, t.now);
      }

      const after = this.requireSpace(input.spaceId);
      t.emit("update", "space", after.id, { visibility: after.visibility });
      t.audit("space.set_visibility", after.id, { visibility: after.visibility });
      return { space: after, changed: true };
    });

    if (result.changed) {
      // Everyone who is not an owner/admin may have gained or lost a subtree.
      this.resyncFor(() => true);
    }
    return result.space;
  }

  /**
   * Replace a space's member list. `userIds` is the complete set afterwards, so
   * the caller never has to diff — the UI always knows the whole list.
   *
   * Unknown user ids are rejected rather than silently dropped: a typo'd id
   * would otherwise look like a granted permission that never works.
   */
  setSpaceMembers(
    input: { spaceId: string; userIds: string[] },
    actor: string | Actor
  ): { spaceId: string; userIds: string[] } {
    const result = this.runTurn(toActor(actor), (t) => {
      this.requirePrivileged(t.actor, "Changing a space's members");
      const space = this.requireSpace(input.spaceId);

      const wanted: string[] = [];
      const seen = new Set<string>();
      for (const userId of input.userIds) {
        if (seen.has(userId)) continue;
        seen.add(userId);
        const exists = this.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE id = ?", userId)
          .one().n;
        if (exists === 0) throw new Error(`Cannot add unknown user ${userId} to space ${space.id}.`);
        wanted.push(userId);
      }

      const before = new Set(listSpaceMemberIds(this.sql, space.id));
      this.sql.exec("DELETE FROM space_members WHERE space_id = ?", space.id);
      for (const userId of wanted) this.addSpaceMember(space.id, userId, t.now);

      const changedUsers = new Set<string>();
      for (const userId of before) if (!seen.has(userId)) changedUsers.add(userId);
      for (const userId of wanted) if (!before.has(userId)) changedUsers.add(userId);

      // Membership is not board content: it is audited, but there is no member
      // delta to broadcast — the affected clients resync instead.
      t.audit("space.set_members", space.id, { userIds: wanted });
      return { spaceId: space.id, userIds: wanted, changedUsers, private: space.visibility === "private" };
    });

    // Only a private space's membership changes what anyone can see.
    if (result.private && result.changedUsers.size > 0) {
      this.resyncFor((userId) => result.changedUsers.has(userId));
    }
    return { spaceId: result.spaceId, userIds: result.userIds };
  }

  private addSpaceMember(spaceId: string, userId: string, now: number): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO space_members (space_id, user_id, created_at) VALUES (?, ?, ?)",
      spaceId,
      userId,
      now
    );
  }

  deleteSpace(spaceId: string, actor: string | Actor): { ok: true } {
    return this.runTurn(toActor(actor), (t) => {
      const before = this.requireSpace(spaceId);
      const { n } = this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM lists WHERE space_id = ?", spaceId)
        .one();
      if (n > 0) {
        throw new Error(
          `Space ${spaceId} ("${before.name}") still has ${n} list(s). ` +
            `Delete or move them first, or archive the space instead (updateSpace with archived: true).`
        );
      }
      this.sql.exec("DELETE FROM space_members WHERE space_id = ?", spaceId);
      this.sql.exec("DELETE FROM spaces WHERE id = ?", spaceId);
      t.emit("delete", "space", spaceId, null, { spaceId });
      t.audit("space.delete", spaceId, { name: before.name });
      return { ok: true } as const;
    });
  }

  createList(input: ParsedListInput, actor: string | Actor): List {
    return this.runTurn(toActor(actor), (t) => {
      this.assertSpaceWritable(t.actor, input.spaceId);
      return this.applyListCreate(t, input);
    });
  }

  private applyListCreate(t: Turn, input: ParsedListInput, clickupId: string | null = null): List {
    this.requireSpace(input.spaceId);
    const specs = normalizeStatusSpecs(input.statuses);
    const listId = id("ls_");
    const row: ListRow = {
      id: listId,
      space_id: input.spaceId,
      name: input.name,
      position: nextPosition(this.sql, "lists", input.spaceId),
      archived: 0,
      inbound_token: null,
      created_at: t.now,
      clickup_id: clickupId,
    };
    this.sql.exec(
      `INSERT INTO lists (id, space_id, name, position, archived, inbound_token, created_at, clickup_id)
       VALUES (?, ?, ?, ?, 0, NULL, ?, ?)`,
      row.id,
      row.space_id,
      row.name,
      row.position,
      row.created_at,
      row.clickup_id
    );
    const statuses = insertStatuses(this.sql, listId, specs);
    const list = toList(row, statuses);
    t.emit("create", "list", listId, list as unknown as Record<string, unknown>);
    t.audit("list.create", listId, { spaceId: list.spaceId, name: list.name });
    return list;
  }

  updateList(
    input: { listId: string; name?: string; archived?: boolean; position?: number; spaceId?: string },
    actor: string | Actor
  ): List {
    return this.runTurn(toActor(actor), (t) => {
      const row = this.requireListRow(input.listId);
      this.assertSpaceWritable(t.actor, row.space_id);
      if (input.spaceId !== undefined) this.assertSpaceWritable(t.actor, input.spaceId);
      const before = toList(row, listStatuses(this.sql, row.id));
      const sets: string[] = [];
      const params: SqlStorageValue[] = [];
      if (input.name !== undefined && input.name !== before.name) {
        sets.push("name = ?");
        params.push(input.name);
      }
      if (input.archived !== undefined && input.archived !== before.archived) {
        sets.push("archived = ?");
        params.push(input.archived ? 1 : 0);
      }
      if (input.position !== undefined && input.position !== before.position) {
        sets.push("position = ?");
        params.push(input.position);
      }
      if (input.spaceId !== undefined && input.spaceId !== before.spaceId) {
        this.requireSpace(input.spaceId);
        sets.push("space_id = ?");
        params.push(input.spaceId);
      }
      if (sets.length === 0) return before;
      this.sql.exec(`UPDATE lists SET ${sets.join(", ")} WHERE id = ?`, ...params, before.id);
      const after = toList(this.requireListRow(before.id), listStatuses(this.sql, before.id));
      const patch = diffOf(
        before as unknown as Record<string, unknown>,
        after as unknown as Record<string, unknown>,
        ["name", "archived", "position", "spaceId"]
      );
      t.emit("update", "list", after.id, patch);
      t.audit("list.update", after.id, patch);
      return after;
    });
  }

  /**
   * Replace a list's status set. Statuses matched by name keep their id (so
   * tasks stay put); removing a status that still holds tasks is refused with
   * the counts, because silently re-bucketing tasks loses information.
   */
  setListStatuses(
    input: { listId: string; statuses: Array<{ name: string; color?: string; type: Status["type"] }> },
    actor: string | Actor
  ): List {
    return this.runTurn(toActor(actor), (t) => {
      const row = this.requireListRow(input.listId);
      this.assertSpaceWritable(t.actor, row.space_id);
      const existing = listStatuses(this.sql, row.id);
      const specs = normalizeStatusSpecs(input.statuses);
      const wanted = new Set(specs.map((s) => s.name.toLowerCase()));

      const doomed = existing.filter((s) => !wanted.has(s.name.toLowerCase()));
      const blocking = doomed
        .map((s) => ({
          status: s,
          n: this.sql
            .exec<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status_id = ?", s.id)
            .one().n,
        }))
        .filter((x) => x.n > 0);
      if (blocking.length > 0) {
        throw new Error(
          `Cannot remove status(es) that still hold tasks: ${blocking
            .map((b) => `"${b.status.name}" (${b.n} task(s))`)
            .join(", ")}. Move those tasks first, or keep the status in the new set.`
        );
      }

      const byName = new Map(existing.map((s) => [s.name.toLowerCase(), s]));
      for (const s of doomed) this.sql.exec("DELETE FROM statuses WHERE id = ?", s.id);

      const statuses: Status[] = specs.map((spec, i) => {
        const prior = byName.get(spec.name.toLowerCase());
        if (prior) {
          this.sql.exec(
            "UPDATE statuses SET name = ?, color = ?, type = ?, position = ? WHERE id = ?",
            spec.name,
            spec.color,
            spec.type,
            i,
            prior.id
          );
          return { id: prior.id, name: spec.name, color: spec.color, type: spec.type, position: i };
        }
        const statusId = id("st_");
        this.sql.exec(
          "INSERT INTO statuses (id, list_id, name, color, type, position) VALUES (?, ?, ?, ?, ?, ?)",
          statusId,
          row.id,
          spec.name,
          spec.color,
          spec.type,
          i
        );
        return { id: statusId, name: spec.name, color: spec.color, type: spec.type, position: i };
      });

      // A status may have flipped to/from closed: reconcile closedAt.
      for (const s of statuses) {
        if (s.type === "closed") {
          this.sql.exec(
            "UPDATE tasks SET closed_at = ? WHERE status_id = ? AND closed_at IS NULL",
            t.now,
            s.id
          );
        } else {
          this.sql.exec(
            "UPDATE tasks SET closed_at = NULL WHERE status_id = ? AND closed_at IS NOT NULL",
            s.id
          );
        }
      }

      const after = toList(this.requireListRow(row.id), statuses);
      t.emit("update", "list", after.id, { statuses });
      t.audit("list.set_statuses", after.id, { statuses: statuses.map((s) => s.name) });
      return after;
    });
  }

  /** Issue (or rotate) the bearer token for the list's inbound webhook. */
  setListInboundToken(
    input: { listId: string; enabled: boolean },
    actor: string | Actor
  ): { listId: string; inboundToken: string | null } {
    return this.runTurn(toActor(actor), (t) => {
      const row = this.requireListRow(input.listId);
      this.assertSpaceWritable(t.actor, row.space_id);
      const inboundToken = input.enabled ? token() : null;
      this.sql.exec("UPDATE lists SET inbound_token = ? WHERE id = ?", inboundToken, row.id);
      // The delta goes to every connected member, so it carries `null` — the
      // same value the snapshot carries. Only this method's return value (which
      // the admin-only PATCH route shows once) has the plaintext.
      t.emit("update", "list", row.id, { inboundToken: null });
      t.audit("list.set_inbound_token", row.id, { enabled: input.enabled });
      return { listId: row.id, inboundToken };
    });
  }

  deleteList(listId: string, actor: string | Actor): { ok: true } {
    return this.runTurn(toActor(actor), (t) => {
      const row = this.requireListRow(listId);
      this.assertSpaceWritable(t.actor, row.space_id);
      const { n } = this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE list_id = ?", listId)
        .one();
      if (n > 0) {
        throw new Error(
          `List ${listId} ("${row.name}") still has ${n} task(s). Move or delete them first, ` +
            `or archive the list instead (updateList with archived: true).`
        );
      }
      this.sql.exec("DELETE FROM statuses WHERE list_id = ?", listId);
      this.sql.exec("DELETE FROM lists WHERE id = ?", listId);
      t.emit("delete", "list", listId, null, { spaceId: row.space_id });
      t.audit("list.delete", listId, { name: row.name });
      return { ok: true } as const;
    });
  }

  // =========================================================================
  // Users, API keys, automation rules
  // =========================================================================

  /** Upsert by id when given, otherwise by email (case-insensitive). */
  upsertUser(input: UpsertUserInput, actor: string | Actor): User {
    return this.runTurn(toActor(actor), (t) => this.applyUserUpsert(t, input));
  }

  private applyUserUpsert(t: Turn, input: UpsertUserInput): User {
    const email = input.email.trim();
    const existingRows = this.sql
      .exec<UserRow>(
        `SELECT id, email, name, role, deactivated, created_at, needs_email_update, clickup_id
         FROM users WHERE ${input.id !== undefined ? "id = ?" : "lower(email) = lower(?)"}`,
        input.id ?? email
      )
      .toArray();
    const existing = existingRows[0];

    if (!existing) {
      const user: User = {
        id: input.id ?? id("us_"),
        email,
        name: input.name ?? email,
        role: input.role ?? "member",
        deactivated: input.deactivated ?? false,
        createdAt: t.now,
      };
      const placeholder = email.endsWith("@placeholder.flow") ? 1 : 0;
      this.sql.exec(
        `INSERT INTO users (id, email, name, role, deactivated, created_at, needs_email_update, clickup_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        user.id,
        user.email,
        user.name,
        user.role,
        user.deactivated ? 1 : 0,
        user.createdAt,
        placeholder,
        input.clickupId ?? null
      );
      t.emit("create", "user", user.id, user as unknown as Record<string, unknown>);
      t.audit("user.create", user.id, { email: user.email, role: user.role });
      return user;
    }

    const before = toUser(existing);
    const sets: string[] = [];
    const params: SqlStorageValue[] = [];
    if (email !== "" && email.toLowerCase() !== before.email.toLowerCase()) {
      sets.push("email = ?", "needs_email_update = ?");
      params.push(email, email.endsWith("@placeholder.flow") ? 1 : 0);
    }
    if (input.name !== undefined && input.name !== before.name) {
      sets.push("name = ?");
      params.push(input.name);
    }
    if (input.role !== undefined && input.role !== before.role) {
      sets.push("role = ?");
      params.push(input.role);
    }
    if (input.deactivated !== undefined && input.deactivated !== before.deactivated) {
      sets.push("deactivated = ?");
      params.push(input.deactivated ? 1 : 0);
    }
    if (input.clickupId !== undefined && input.clickupId !== existing.clickup_id) {
      sets.push("clickup_id = ?");
      params.push(input.clickupId);
    }
    if (sets.length === 0) return before;
    this.sql.exec(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, ...params, before.id);
    const after = toUser(
      this.sql
        .exec<UserRow>(
          `SELECT id, email, name, role, deactivated, created_at, needs_email_update, clickup_id
           FROM users WHERE id = ?`,
          before.id
        )
        .one()
    );
    const patch = diffOf(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
      ["email", "name", "role", "deactivated"]
    );
    t.emit("update", "user", after.id, patch);
    t.audit("user.update", after.id, patch);
    return after;
  }

  createApiKey(input: CreateApiKeyInput, actor: string | Actor): ApiKey {
    return this.runTurn(toActor(actor), (t) => {
      const users = this.sql
        .exec<{ id: string }>("SELECT id FROM users WHERE id = ?", input.userId)
        .toArray();
      if (users.length === 0) {
        throw new Error(`Cannot create an API key for unknown user ${input.userId}.`);
      }
      const key: ApiKey = {
        id: id("ak_"),
        userId: input.userId,
        name: input.name,
        tokenHash: input.tokenHash,
        createdAt: t.now,
        lastUsedAt: null,
        revokedAt: null,
      };
      this.sql.exec(
        `INSERT INTO api_keys (id, user_id, name, token_hash, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
        key.id,
        key.userId,
        key.name,
        key.tokenHash,
        key.createdAt
      );
      // API keys are not board state: audited, but no delta / broadcast.
      t.audit("api_key.create", key.id, { userId: key.userId, name: key.name });
      return key;
    });
  }

  revokeApiKey(keyId: string, actor: string | Actor): { ok: true } {
    return this.runTurn(toActor(actor), (t) => {
      const rows = this.sql
        .exec<{ id: string }>("SELECT id FROM api_keys WHERE id = ?", keyId)
        .toArray();
      if (rows.length === 0) throw new Error(`API key ${keyId} not found.`);
      this.sql.exec("UPDATE api_keys SET revoked_at = ? WHERE id = ?", t.now, keyId);
      t.audit("api_key.revoke", keyId, null);
      return { ok: true } as const;
    });
  }

  upsertAutomation(input: UpsertAutomationInput, actor: string | Actor): AutomationRule {
    return this.runTurn(toActor(actor), (t) => {
      const scope = input.scope;
      if (scope.kind === "list") this.requireListRow(scope.listId);
      else this.requireSpace(scope.spaceId);

      const existingId = input.id;
      const isUpdate =
        existingId !== undefined &&
        this.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM automation_rules WHERE id = ?", existingId)
          .one().n > 0;

      const ruleId = isUpdate && existingId !== undefined ? existingId : id("ar_");
      const scopeId = scope.kind === "list" ? scope.listId : scope.spaceId;

      if (isUpdate) {
        this.sql.exec(
          `UPDATE automation_rules SET name = ?, enabled = ?, scope = ?, scope_kind = ?, scope_id = ?,
             trigger = ?, trigger_kind = ?, conditions = ?, actions = ?, updated_at = ?
           WHERE id = ?`,
          input.name,
          input.enabled ? 1 : 0,
          JSON.stringify(scope),
          scope.kind,
          scopeId,
          JSON.stringify(input.trigger),
          input.trigger.kind,
          JSON.stringify(input.conditions),
          JSON.stringify(input.actions),
          t.now,
          ruleId
        );
      } else {
        this.sql.exec(
          `INSERT INTO automation_rules
             (id, name, enabled, scope, scope_kind, scope_id, trigger, trigger_kind,
              conditions, actions, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ruleId,
          input.name,
          input.enabled ? 1 : 0,
          JSON.stringify(scope),
          scope.kind,
          scopeId,
          JSON.stringify(input.trigger),
          input.trigger.kind,
          JSON.stringify(input.conditions),
          JSON.stringify(input.actions),
          t.now,
          t.now
        );
      }

      const rule = toRule(
        this.sql
          .exec<RuleRow>(
            `SELECT id, name, enabled, scope, trigger, conditions, actions, created_at, updated_at
             FROM automation_rules WHERE id = ?`,
            ruleId
          )
          .one()
      );
      t.emit(
        isUpdate ? "update" : "create",
        "automation_rule",
        rule.id,
        rule as unknown as Record<string, unknown>
      );
      t.audit(isUpdate ? "automation.update" : "automation.create", rule.id, { name: rule.name });
      return rule;
    });
  }

  deleteAutomation(ruleId: string, actor: string | Actor): { ok: true } {
    return this.runTurn(toActor(actor), (t) => {
      const rows = this.sql
        .exec<{ name: string }>("SELECT name FROM automation_rules WHERE id = ?", ruleId)
        .toArray();
      const row = rows[0];
      if (!row) throw new Error(`Automation rule ${ruleId} not found.`);
      this.sql.exec("DELETE FROM automation_rules WHERE id = ?", ruleId);
      t.emit("delete", "automation_rule", ruleId, null);
      t.audit("automation.delete", ruleId, { name: row.name });
      return { ok: true } as const;
    });
  }

  // =========================================================================
  // Import
  // =========================================================================

  /**
   * Bulk upsert. Identity is `id` first (the ClickUp importer mints Flow ids
   * during transform and POSTs fully-formed entities), then `clickupId`.
   *
   * Import mode is deliberately unlike every other mutation path: automations
   * never run, nothing is appended to the changes log, and nothing is broadcast
   * per row — a 5k-row load would otherwise flood both. One `resync` frame goes
   * out at the end so connected clients pull a fresh snapshot.
   */
  importBatch(batch: ImportBatch, actor: string | Actor): ImportResult {
    const result: ImportResult = {
      created: emptyCounts(),
      updated: emptyCounts(),
      errors: [],
      ids: {},
    };
    const importActor = toActor(actor, "import");
    const now = Date.now();

    const bump = (bucket: "created" | "updated", key: keyof ImportCounts): void => {
      result[bucket][key] += 1;
    };
    const fail = (entity: keyof ImportBatch, ref: string, err: unknown): void => {
      result.errors.push({
        entity,
        ref,
        error: err instanceof Error ? err.message : String(err),
      });
    };
    const remember = (row: { id?: string; clickupId?: string | null }, flowId: string): void => {
      if (row.clickupId) result.ids[row.clickupId] = flowId;
      if (row.id) result.ids[row.id] = flowId;
    };

    // --- users -------------------------------------------------------------
    // A user reference from the batch may be a transform-minted id that the
    // users pass deduplicated onto an existing row (matched by email). Resolve
    // through the id map first; fall back to the raw id.
    const mapUser = (uid: string | null | undefined): string | null =>
      uid == null ? null : (result.ids[uid] ?? uid);

    for (const u of batch.users ?? []) {
      const ref = u.id ?? u.clickupId ?? u.email;
      try {
        const existing = this.findExisting("users", u.id, u.clickupId, () =>
          this.userIdByEmail(u.email)
        );
        const email = u.email.trim();
        const placeholder = email.toLowerCase().endsWith("@placeholder.flow") ? 1 : 0;
        if (existing) {
          this.sql.exec(
            `UPDATE users SET email = ?, name = ?, role = ?, deactivated = ?,
               needs_email_update = ?, clickup_id = COALESCE(?, clickup_id) WHERE id = ?`,
            email,
            u.name ?? email,
            u.role ?? "member",
            u.deactivated ? 1 : 0,
            placeholder,
            u.clickupId ?? null,
            existing
          );
          remember(u, existing);
          bump("updated", "users");
        } else {
          const userId = u.id ?? id("us_");
          this.sql.exec(
            `INSERT INTO users (id, email, name, role, deactivated, created_at, needs_email_update, clickup_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            userId,
            email,
            u.name ?? email,
            u.role ?? "member",
            u.deactivated ? 1 : 0,
            u.createdAt ?? now,
            placeholder,
            u.clickupId ?? null
          );
          remember(u, userId);
          bump("created", "users");
        }
      } catch (err) {
        fail("users", ref, err);
      }
    }

    // --- spaces ------------------------------------------------------------
    for (const s of batch.spaces ?? []) {
      const ref = s.id ?? s.clickupId ?? s.name;
      try {
        const existing = this.findExisting("spaces", s.id, s.clickupId);
        if (existing) {
          this.sql.exec(
            `UPDATE spaces SET name = ?, color = ?, archived = ?,
               visibility = COALESCE(?, visibility),
               clickup_id = COALESCE(?, clickup_id) WHERE id = ?`,
            s.name,
            s.color ?? null,
            s.archived ? 1 : 0,
            s.visibility ?? null,
            s.clickupId ?? null,
            existing
          );
          this.applyImportSpaceMembers(existing, s.memberUserIds, now);
          remember(s, existing);
          bump("updated", "spaces");
        } else {
          const spaceId = s.id ?? id("sp_");
          this.sql.exec(
            `INSERT INTO spaces (id, name, color, position, archived, visibility, created_at, clickup_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            spaceId,
            s.name,
            s.color ?? null,
            s.position ?? nextPosition(this.sql, "spaces"),
            s.archived ? 1 : 0,
            s.visibility ?? "workspace",
            s.createdAt ?? now,
            s.clickupId ?? null
          );
          this.applyImportSpaceMembers(spaceId, s.memberUserIds, now);
          remember(s, spaceId);
          bump("created", "spaces");
        }
      } catch (err) {
        fail("spaces", ref, err);
      }
    }

    // --- lists -------------------------------------------------------------
    for (const l of batch.lists ?? []) {
      const ref = l.id ?? l.clickupId ?? l.name;
      try {
        const spaceId = this.resolveParentId("spaces", l.spaceId, l.spaceClickupId, result.ids);
        const existing = this.findExisting("lists", l.id, l.clickupId);
        if (existing) {
          this.sql.exec(
            `UPDATE lists SET space_id = ?, name = ?, archived = ?,
               clickup_id = COALESCE(?, clickup_id) WHERE id = ?`,
            spaceId,
            l.name,
            l.archived ? 1 : 0,
            l.clickupId ?? null,
            existing
          );
          // Statuses are additive on re-import: add what's missing by name,
          // never delete one that tasks may still point at.
          if (l.statuses !== undefined) this.mergeImportStatuses(existing, l.statuses);
          remember(l, existing);
          bump("updated", "lists");
        } else {
          const listId = l.id ?? id("ls_");
          this.sql.exec(
            `INSERT INTO lists (id, space_id, name, position, archived, inbound_token, created_at, clickup_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            listId,
            spaceId,
            l.name,
            l.position ?? nextPosition(this.sql, "lists", spaceId),
            l.archived ? 1 : 0,
            l.inboundToken ?? null,
            l.createdAt ?? now,
            l.clickupId ?? null
          );
          insertStatuses(this.sql, listId, normalizeStatusSpecs(l.statuses));
          remember(l, listId);
          bump("created", "lists");
        }
      } catch (err) {
        fail("lists", ref, err);
      }
    }

    // --- tasks -------------------------------------------------------------
    for (const task of batch.tasks ?? []) {
      const ref = task.id ?? task.clickupId ?? task.title;
      try {
        const listId = this.resolveParentId("lists", task.listId, task.listClickupId, result.ids);
        const status = this.resolveImportStatus(listId, task.statusId, task.status);
        const assigneeId =
          mapUser(task.assigneeId) ??
          (task.assigneeEmail ? this.userIdByEmail(task.assigneeEmail) : null) ??
          null;
        const tags = normalizeTags(task.tags ?? []);
        const closedAt =
          task.closedAt !== undefined
            ? task.closedAt
            : status.type === "closed"
              ? (task.updatedAt ?? now)
              : null;
        const existing = this.findExisting("tasks", task.id, task.clickupId);

        if (existing) {
          this.sql.exec(
            `UPDATE tasks SET list_id = ?, title = ?, description = ?, status_id = ?, assignee_id = ?,
               priority = ?, due_date = ?, start_date = ?, tags = ?, tags_text = ?, updated_at = ?,
               closed_at = ?, clickup_id = COALESCE(?, clickup_id) WHERE id = ?`,
            listId,
            truncateImportTitle(task.title),
            task.description ?? "",
            status.id,
            assigneeId,
            task.priority ?? null,
            task.dueDate ?? null,
            task.startDate ?? null,
            JSON.stringify(tags),
            tagsText(tags),
            task.updatedAt ?? now,
            closedAt,
            task.clickupId ?? null,
            existing
          );
          remember(task, existing);
          bump("updated", "tasks");
        } else {
          const taskId = task.id ?? id("tk_");
          this.insertTaskRow({
            id: taskId,
            listId,
            title: truncateImportTitle(task.title),
            description: task.description ?? "",
            statusId: status.id,
            assigneeId,
            priority: task.priority ?? null,
            dueDate: task.dueDate ?? null,
            startDate: task.startDate ?? null,
            // ClickUp has no snooze, so an imported task always lands awake.
            snoozedUntil: null,
            blockedNote: null,
            tags,
            position: task.position ?? nextTaskPosition(this.sql, listId, status.id),
            createdBy: mapUser(task.createdBy) ?? importActor.userId,
            createdAt: task.createdAt ?? now,
            updatedAt: task.updatedAt ?? task.createdAt ?? now,
            closedAt,
            clickupId: task.clickupId ?? null,
          });
          remember(task, taskId);
          bump("created", "tasks");
        }
      } catch (err) {
        fail("tasks", ref, err);
      }
    }

    // --- subtasks ----------------------------------------------------------
    for (const sub of batch.subtasks ?? []) {
      const ref = sub.id ?? sub.clickupId ?? sub.title;
      try {
        const taskId = this.resolveParentId("tasks", sub.taskId, sub.taskClickupId, result.ids);
        const existing = this.findExisting("subtasks", sub.id, sub.clickupId);
        if (existing) {
          this.sql.exec(
            `UPDATE subtasks SET task_id = ?, title = ?, done = ?, assignee_id = ?, due_date = ?,
               clickup_id = COALESCE(?, clickup_id) WHERE id = ?`,
            taskId,
            truncateImportTitle(sub.title),
            sub.done ? 1 : 0,
            mapUser(sub.assigneeId),
            sub.dueDate ?? null,
            sub.clickupId ?? null,
            existing
          );
          remember(sub, existing);
          bump("updated", "subtasks");
        } else {
          const subtaskId = sub.id ?? id("sb_");
          this.sql.exec(
            `INSERT INTO subtasks (id, task_id, title, done, assignee_id, due_date, position, created_at, clickup_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            subtaskId,
            taskId,
            truncateImportTitle(sub.title),
            sub.done ? 1 : 0,
            mapUser(sub.assigneeId),
            sub.dueDate ?? null,
            sub.position ?? nextSubtaskPosition(this.sql, taskId),
            sub.createdAt ?? now,
            sub.clickupId ?? null
          );
          remember(sub, subtaskId);
          bump("created", "subtasks");
        }
      } catch (err) {
        fail("subtasks", ref, err);
      }
    }

    // --- comments ----------------------------------------------------------
    for (const c of batch.comments ?? []) {
      const ref = c.id ?? c.clickupId ?? c.body.slice(0, 40);
      try {
        const taskId = this.resolveParentId("tasks", c.taskId, c.taskClickupId, result.ids);
        const authorId =
          mapUser(c.authorId) ??
          (c.authorEmail ? this.userIdByEmail(c.authorEmail) : null) ??
          importActor.userId;
        const existing = this.findExisting("comments", c.id, c.clickupId);
        if (existing) {
          this.sql.exec(
            `UPDATE comments SET task_id = ?, author_id = ?, body = ?,
               clickup_id = COALESCE(?, clickup_id) WHERE id = ?`,
            taskId,
            authorId,
            c.body,
            c.clickupId ?? null,
            existing
          );
          remember(c, existing);
          bump("updated", "comments");
        } else {
          const commentId = c.id ?? id("cm_");
          this.sql.exec(
            `INSERT INTO comments (id, task_id, author_id, body, created_at, clickup_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            commentId,
            taskId,
            authorId,
            c.body,
            c.createdAt ?? now,
            c.clickupId ?? null
          );
          remember(c, commentId);
          bump("created", "comments");
        }
      } catch (err) {
        fail("comments", ref, err);
      }
    }

    // One audit row for the whole batch, one resync frame, zero deltas.
    this.sql.exec(
      "INSERT INTO audit (actor, action, entity, diff, at) VALUES (?, ?, ?, ?, ?)",
      JSON.stringify(importActor),
      "import.batch",
      "workspace",
      JSON.stringify({
        created: result.created,
        updated: result.updated,
        errors: result.errors.length,
      }),
      now
    );
    this.broadcast({ type: "resync" });
    return result;
  }

  /**
   * Import-mode membership: replaces the set when the row supplies one, leaves
   * it alone when it does not. Unknown user ids are skipped rather than thrown —
   * an import is lenient by design, and a missing member must not lose a space.
   */
  private applyImportSpaceMembers(
    spaceId: string,
    userIds: string[] | undefined,
    now: number
  ): void {
    if (userIds === undefined) return;
    this.sql.exec("DELETE FROM space_members WHERE space_id = ?", spaceId);
    for (const userId of userIds) {
      const known = this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE id = ?", userId)
        .one().n;
      if (known > 0) this.addSpaceMember(spaceId, userId, now);
    }
  }

  /** id first, then clickup_id, then an optional caller-supplied fallback. */
  private findExisting(
    table: "users" | "spaces" | "lists" | "tasks" | "subtasks" | "comments",
    flowId: string | undefined,
    clickupId: string | null | undefined,
    fallback?: () => string | null
  ): string | null {
    if (flowId !== undefined) {
      const row = this.sql
        .exec<{ id: string }>(`SELECT id FROM ${table} WHERE id = ?`, flowId)
        .toArray()[0];
      if (row) return row.id;
    }
    if (clickupId !== undefined && clickupId !== null) {
      const row = this.sql
        .exec<{ id: string }>(`SELECT id FROM ${table} WHERE clickup_id = ?`, clickupId)
        .toArray()[0];
      if (row) return row.id;
    }
    return fallback?.() ?? null;
  }

  /**
   * Resolve a parent reference given as a Flow id or a ClickUp id. `ids` is the
   * running map from earlier rows in the same batch, so a space and its lists
   * can arrive together.
   */
  private resolveParentId(
    table: "spaces" | "lists" | "tasks",
    flowId: string | undefined,
    clickupId: string | undefined,
    ids: Record<string, string>
  ): string {
    const noun = table === "spaces" ? "space" : table === "lists" ? "list" : "task";
    if (flowId !== undefined) {
      const row = this.sql
        .exec<{ id: string }>(`SELECT id FROM ${table} WHERE id = ?`, flowId)
        .toArray()[0];
      if (row) return row.id;
      const mapped = ids[flowId];
      if (mapped !== undefined) return mapped;
      throw new Error(`No ${noun} with id ${flowId} — import ${table} first.`);
    }
    if (clickupId === undefined) {
      throw new Error(`Row needs either a Flow ${noun} id or a ${noun} clickupId.`);
    }
    const mapped = ids[clickupId];
    if (mapped !== undefined) return mapped;
    const row = this.sql
      .exec<{ id: string }>(`SELECT id FROM ${table} WHERE clickup_id = ?`, clickupId)
      .toArray()[0];
    if (!row) throw new Error(`No ${noun} with clickupId ${clickupId} — import ${table} first.`);
    return row.id;
  }

  /** Accept a resolved statusId, a status name, or neither (list's open). */
  private resolveImportStatus(
    listId: string,
    statusId: string | undefined,
    statusName: string | undefined
  ): Status {
    if (statusId !== undefined) {
      const status = getStatus(this.sql, statusId);
      if (status) return status;
      if (statusName === undefined) {
        throw new Error(
          `Unknown statusId ${statusId} for list ${listId}. Valid statuses: ${listStatuses(
            this.sql,
            listId
          )
            .map((s) => `${s.id} "${s.name}"`)
            .join(", ")}.`
        );
      }
    }
    if (statusName !== undefined) return resolveStatusName(this.sql, listId, statusName);
    return openStatus(this.sql, listId);
  }

  /** Add statuses missing from a re-imported list; never remove one. */
  private mergeImportStatuses(
    listId: string,
    specs: ReadonlyArray<{ id?: string; name: string; color?: string; type: Status["type"] }>
  ): void {
    const existing = listStatuses(this.sql, listId);
    const byName = new Set(existing.map((s) => s.name.toLowerCase()));
    const byId = new Set(existing.map((s) => s.id));
    let position = existing.length;
    for (const spec of normalizeStatusSpecs(specs)) {
      if (byName.has(spec.name.toLowerCase())) continue;
      if (spec.id !== undefined && byId.has(spec.id)) continue;
      this.sql.exec(
        "INSERT INTO statuses (id, list_id, name, color, type, position) VALUES (?, ?, ?, ?, ?, ?)",
        spec.id ?? id("st_"),
        listId,
        spec.name,
        spec.color,
        spec.type,
        position++
      );
    }
  }

  private userIdByEmail(email: string): string | null {
    const row = this.sql
      .exec<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower(?)", email.trim())
      .toArray()[0];
    return row?.id ?? null;
  }

  // =========================================================================
  // Alarm: one alarm multiplexes every scheduled job
  // =========================================================================

  async alarm(): Promise<void> {
    const now = Date.now();
    const jobs = this.sql
      .exec<JobRow>(
        "SELECT id, run_at, kind, payload, every_ms FROM scheduled_jobs WHERE run_at <= ? ORDER BY run_at LIMIT 100",
        now
      )
      .toArray();

    for (const job of jobs) {
      try {
        this.runJob(job, now);
      } catch (err) {
        // Alarms retry; a poisoned job must not wedge the whole schedule.
        console.error("scheduled job failed", job.kind, err);
      }
      this.sql.exec("DELETE FROM scheduled_jobs WHERE id = ?", job.id);
      if (job.every_ms !== null && job.every_ms > 0) {
        // Skip missed intervals rather than firing a backlog.
        let nextRun = job.run_at + job.every_ms;
        while (nextRun <= now) nextRun += job.every_ms;
        this.sql.exec(
          "INSERT INTO scheduled_jobs (run_at, kind, payload, every_ms, created_at) VALUES (?, ?, ?, ?, ?)",
          nextRun,
          job.kind,
          job.payload,
          job.every_ms,
          now
        );
      }
    }

    this.armedAlarm = null;
    await this.armAlarm();
  }

  /** Queue a one-off job; automations can use this via ctx.sql too. */
  scheduleJob(input: { runAt: number; kind: string; payload?: unknown; everyMs?: number }): void {
    this.sql.exec(
      "INSERT INTO scheduled_jobs (run_at, kind, payload, every_ms, created_at) VALUES (?, ?, ?, ?, ?)",
      input.runAt,
      input.kind,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.everyMs ?? null,
      Date.now()
    );
    this.ctx.waitUntil(this.armAlarm());
  }

  private runJob(job: JobRow, now: number): void {
    switch (job.kind) {
      case "prune_changes":
        this.pruneChanges();
        break;
      // The hourly maintenance tick. It carries the snooze wake pass too rather
      // than seeding a second recurring job, because seedJobs only ever runs on
      // an empty scheduled_jobs table — a workspace that already exists would
      // never pick a newly-seeded job up.
      case "due_date_check":
        this.runDueDateCheck(now);
        this.runSnoozeWake(now);
        break;
      // Explicitly schedulable too, for a targeted catch-up.
      case "snooze_wake":
        this.runSnoozeWake(now);
        break;
      default:
        console.error("unknown scheduled job kind", job.kind);
    }
  }

  private pruneChanges(): void {
    const max = this.maxSeq();
    const floor = max - CHANGES_RETENTION;
    if (floor > 0) this.sql.exec("DELETE FROM changes WHERE seq <= ?", floor);
  }

  /**
   * due_date_approaching has no delta to hang off — nothing mutates when a
   * deadline gets closer — so the engine's sweep drives it. Any actions it
   * takes run inside this turn, which means their deltas broadcast normally.
   */
  private runDueDateCheck(now: number): void {
    const actor: Actor = {
      userId: this.systemUserId(),
      via: "automation",
      apiKeyId: null,
      automationRuleId: null,
    };
    this.runTurn(actor, (t) => {
      const ctx: AutomationScheduleContext = {
        ...this.automationContext(t, 0),
        listTaskIdsDueBetween: (scope, fromMs, toMs) =>
          this.listTaskIdsDueBetween(scope, fromMs, toMs),
      };
      const result = sweepDueDateAutomations(ctx, now);
      if (result.firings.length > 0) {
        t.audit("automation.due_sweep", "workspace", {
          rulesConsidered: result.rulesConsidered,
          candidatesInspected: result.candidatesInspected,
          firings: result.firings.length,
        });
      }
      pruneDueFires(ctx, now);
    });
  }

  /**
   * Time-based wake. Every task whose snooze has run out gets `snoozedUntil`
   * cleared through the ordinary update path, so each one produces a real
   * changed-fields delta and an audit row — clients un-hide the card from the
   * socket patch, exactly as if a person had pressed "Wake now".
   *
   * The actor follows the due-date sweep: the owner's user id with
   * `via: "automation"`, which is what the audit trail reads as "the system did
   * this, nobody asked for it".
   */
  private runSnoozeWake(now: number): void {
    const rows = this.sql
      .exec<SnoozedRow>(
        `SELECT id, snoozed_until FROM tasks
         WHERE snoozed_until IS NOT NULL ORDER BY snoozed_until LIMIT ?`,
        WAKE_SWEEP_LIMIT
      )
      .toArray();
    const woken = wakeCandidates(rows, now);
    if (woken.length === 0) return;

    const actor: Actor = {
      userId: this.systemUserId(),
      via: "automation",
      apiKeyId: null,
      automationRuleId: null,
    };
    this.runTurn(actor, (t) => {
      for (const taskId of woken) {
        // One bad row must not strand the rest of the sweep asleep.
        try {
          this.applyTaskUpdate(t, { taskId, snoozedUntil: null }, "task.wake");
        } catch (err) {
          console.error("snooze wake failed", taskId, err);
        }
      }
      t.audit("task.wake_sweep", "workspace", { woken: woken.length });
    });
  }

  private listTaskIdsDueBetween(
    scope: AutomationRule["scope"],
    fromMs: number,
    toMs: number
  ): string[] {
    const sql =
      scope.kind === "list"
        ? `SELECT id FROM tasks
             WHERE list_id = ? AND closed_at IS NULL
               AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ?`
        : `SELECT t.id AS id FROM tasks t JOIN lists l ON l.id = t.list_id
             WHERE l.space_id = ? AND t.closed_at IS NULL
               AND t.due_date IS NOT NULL AND t.due_date >= ? AND t.due_date <= ?`;
    return this.sql
      .exec<{ id: string }>(
        sql,
        scope.kind === "list" ? scope.listId : scope.spaceId,
        fromMs,
        toMs
      )
      .toArray()
      .map((r) => r.id);
  }

  private async armAlarm(): Promise<void> {
    const { next } = this.sql
      .exec<{ next: number | null }>("SELECT MIN(run_at) AS next FROM scheduled_jobs")
      .one();
    if (next === null) {
      this.armedAlarm = null;
      return;
    }
    if (this.armedAlarm === next) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
    this.armedAlarm = next;
  }

  private systemUserId(): string {
    const row = this.sql
      .exec<{ id: string }>("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1")
      .toArray()[0];
    return row?.id ?? "us_system";
  }

  // =========================================================================
  // Row helpers
  // =========================================================================

  private insertTaskRow(task: Task): void {
    this.sql.exec(
      `INSERT INTO tasks (id, list_id, title, description, status_id, assignee_id, priority,
         due_date, start_date, snoozed_until, blocked_note, tags, tags_text, position,
         created_by, created_at, updated_at, closed_at, clickup_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id,
      task.listId,
      task.title,
      task.description,
      task.statusId,
      task.assigneeId,
      task.priority,
      task.dueDate,
      task.startDate,
      task.snoozedUntil,
      task.blockedNote,
      JSON.stringify(task.tags),
      tagsText(task.tags),
      task.position,
      task.createdBy,
      task.createdAt,
      task.updatedAt,
      task.closedAt,
      task.clickupId
    );
  }

  private taskRow(taskId: string): TaskRowSql | null {
    const rows = this.sql
      .exec<TaskRowSql>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`, taskId)
      .toArray();
    return rows[0] ?? null;
  }

  private requireTaskRow(taskId: string): TaskRowSql {
    const row = this.taskRow(taskId);
    if (!row) throw new Error(`Task ${taskId} not found.`);
    return row;
  }

  private requireSubtask(subtaskId: string): Subtask {
    const rows = this.sql
      .exec<SubtaskRow>(
        `SELECT id, task_id, title, done, assignee_id, due_date, position, created_at
         FROM subtasks WHERE id = ?`,
        subtaskId
      )
      .toArray();
    const row = rows[0];
    if (!row) throw new Error(`Subtask ${subtaskId} not found.`);
    return toSubtask(row);
  }

  private requireListRow(listId: string): ListRow {
    const rows = this.sql
      .exec<ListRow>(
        `SELECT ${LIST_COLUMNS}
         FROM lists WHERE id = ?`,
        listId
      )
      .toArray();
    const row = rows[0];
    if (!row) {
      const known = this.sql
        .exec<{ id: string; name: string }>("SELECT id, name FROM lists ORDER BY name LIMIT 25")
        .toArray();
      throw new Error(
        `List ${listId} not found. Known lists: ${
          known.map((l) => `${l.id} ("${l.name}")`).join(", ") || "none yet"
        }.`
      );
    }
    return row;
  }

  private requireSpace(spaceId: string): Space {
    const rows = this.sql
      .exec<SpaceRow>(
        `SELECT ${SPACE_COLUMNS} FROM spaces WHERE id = ?`,
        spaceId
      )
      .toArray();
    const row = rows[0];
    if (!row) {
      const known = this.sql
        .exec<{ id: string; name: string }>("SELECT id, name FROM spaces ORDER BY name LIMIT 25")
        .toArray();
      throw new Error(
        `Space ${spaceId} not found. Known spaces: ${
          known.map((s) => `${s.id} ("${s.name}")`).join(", ") || "none yet"
        }.`
      );
    }
    return toSpace(row);
  }
}

// --- module-local helpers ---------------------------------------------------

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The pre-mutation values for exactly the keys a patch touched. */
function prevOf(
  before: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) out[key] = before[key];
  return out;
}

/**
 * A user is emailable only with a real address: non-empty and not one of the
 * `@placeholder.flow` addresses the ClickUp import mints for people whose real
 * email is unknown. Sending to those would just bounce.
 */
function hasRealEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  return e.length > 0 && !e.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
}

/** Trim, drop empties, de-duplicate case-insensitively, keep first casing. */
function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag === "") continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** Re-exported so callers can reuse the fractional-ordering maths. */
export { between as positionBetween, POSITION_STEP } from "./position.js";
