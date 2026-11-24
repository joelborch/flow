import { SetEmailIntakeInput as SetEmailIntakeSchema, type Actor, type EmailIntake, type SetEmailIntakeInput } from "@flow/shared";
import {
  EMAIL_INTAKE_COLUMNS,
  EMAIL_RATE_WINDOW_MS,
  EMAIL_THREAD_REFERENCE_LIMIT,
  type WorkspaceHost,
  emailIntakeForList,
  requireListRow,
  requirePrivileged,
  spaceIdForList,
  spaceIdForTask,
  spaceWriteRefusal,
  taskRow,
} from "./db-helpers.js";
import {
  EMAIL_INGEST_PERMANENT_ERROR,
  EMAIL_INTAKE_HOURLY_LIMIT,
  EMAIL_INTAKE_LIST_HOURLY_LIMIT,
  EMAIL_INTAKE_TAG,
  EMAIL_INTAKE_UNVERIFIED_TAG,
  type EmailIngestAttachment,
  type EmailIntakeCheck,
  type IngestEmailInput,
  type IngestEmailResult,
  normalizeMessageId,
  senderAllowed,
} from "./email-intake.js";
import { type EmailIntakeRow, type TaskRowSql, toEmailIntake } from "./rows.js";
import { applyAttachmentCreate, applyCommentCreate, applyTaskCreate } from "./task-mutations.js";
import { type Turn, toActor } from "./turn.js";

const permanentEmailError = (detail: string): Error =>
  new Error(`${EMAIL_INGEST_PERMANENT_ERROR}: ${detail}`);

// =========================================================================
// Email intake (see ./email-intake.ts)
//
// The api Worker's email() handler runs checkEmailIntake before it parses or
// uploads anything, then hands the formatted message to ingestEmail. The
// pre-check is advisory: ingestEmail repeats every check inside its own turn
// and writes the task or comment together with the email_messages row that
// turns a redelivery into a no-op.
// =========================================================================

/** Every list's intake, by alias. Holds sender allowlists: the Worker admin-gates it. */
export function listEmailIntakes(sql: SqlStorage): EmailIntake[] {
  return sql
    .exec<EmailIntakeRow>(`SELECT ${EMAIL_INTAKE_COLUMNS} FROM email_intakes ORDER BY alias`)
    .toArray()
    .map(toEmailIntake);
}

/**
 * Create or replace (`input`) or remove (`null`) one list's intake.
 *
 * Owner/admin only, checked here as well as on the route: an intake lets
 * people outside the workspace write into it, so the sole writer does not
 * take the caller's word for it. Intakes are not in the snapshot, so this
 * writes an audit row and no delta.
 */
export function setEmailIntake(
  host: WorkspaceHost,
  listId: string,
  input: SetEmailIntakeInput | null,
  actor: string | Actor
): EmailIntake | null {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    requirePrivileged(sql, t.actor, "Configuring a list's email intake");
    const list = requireListRow(sql, listId);
    const before = emailIntakeForList(sql, list.id);
    if (input === null) {
      if (before === null) return null;
      sql.exec("DELETE FROM email_intakes WHERE list_id = ?", list.id);
      t.audit("list.email_intake.remove", list.id, { alias: before.alias });
      return null;
    }

    // The route has already parsed this; parsing again here normalizes
    // (trim, lowercase) for any other caller with the contract's own rules.
    const parsed = SetEmailIntakeSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message ?? "Invalid email intake.");
    }
    const alias = parsed.data.alias;
    const allowedSenders = [...new Set(parsed.data.allowedSenders)];

    // Checked in code so the caller gets the holder's name, not a constraint
    // code; the UNIQUE on email_intakes.alias is the backstop.
    const holder = sql
      .exec<{ list_id: string; name: string | null }>(
        `SELECT e.list_id AS list_id, l.name AS name
         FROM email_intakes e LEFT JOIN lists l ON l.id = e.list_id
         WHERE e.alias = ? AND e.list_id != ?`,
        alias,
        list.id
      )
      .toArray()[0];
    if (holder) {
      throw new Error(
        `Email alias "${alias}" is already used by list ${holder.list_id}` +
          `${holder.name === null ? "" : ` ("${holder.name}")`}. ` +
          `Remove it from that list first, or pick another alias.`
      );
    }

    const after: EmailIntake = {
      listId: list.id,
      alias,
      allowedSenders,
      createdAt: before?.createdAt ?? t.now,
      updatedAt: t.now,
    };
    sql.exec(
      `INSERT INTO email_intakes (list_id, alias, allowed_senders, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (list_id) DO UPDATE SET
         alias = excluded.alias,
         allowed_senders = excluded.allowed_senders,
         updated_at = excluded.updated_at`,
      after.listId,
      after.alias,
      JSON.stringify(after.allowedSenders),
      after.createdAt,
      after.updatedAt
    );
    t.audit("list.email_intake.set", list.id, { alias, allowedSenders });
    return after;
  });
}

/** Read-only and cheap: the Worker's pre-check before it parses or uploads. */
export function checkEmailIntake(
  sql: SqlStorage,
  input: { alias: string; sender: string; messageId: string }
): EmailIntakeCheck {
  return runEmailIntakeCheck(
    sql,
    input.alias.trim().toLowerCase(),
    input.sender.trim().toLowerCase(),
    normalizeMessageId(input.messageId) ?? "",
    Date.now()
  );
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
export function ingestEmail(
  host: WorkspaceHost,
  input: IngestEmailInput,
  actor: string | Actor
): IngestEmailResult {
  const result = host.runTurn(toActor(actor), (t): IngestEmailResult => {
    const { sql } = host;
    const alias = input.alias.trim().toLowerCase();
    const sender = input.sender.trim().toLowerCase();
    // Only an explicit true vouches for the sender; a caller that leaves the
    // flag out gets the unverified treatment, never the trusted one.
    const authenticated = input.authenticated === true;
    const messageId = normalizeMessageId(input.messageId);
    if (messageId === null) {
      throw permanentEmailError("no Message-ID, and it is the dedupe key.");
    }
    const check = runEmailIntakeCheck(sql, alias, sender, messageId, t.now);
    if (check.status !== "ok") return check;
    const listId = check.listId;
    const message = { messageId, listId, alias, sender, authenticated };

    // Everything that can refuse is checked before the first write: a throw
    // after it would leave a ticket with no dedupe row, and the redelivery
    // would open a second one.
    requireFreshAttachmentIds(sql, input.attachments);
    const thread = emailThreadTask(sql, listId, input.referenceIds);
    if (thread !== null) {
      // An unauthenticated reply still threads: the Worker marks the comment
      // text itself, and the ticket was opened by someone this list admits.
      requireEmailWritable(sql, t.actor, "task", thread.id);
      // A reply is only ever a comment: it never reopens, moves or retags
      // the ticket, even a closed one.
      const comment = applyCommentCreate(host, t, { taskId: thread.id, body: input.commentBody });
      for (const a of input.attachments) applyAttachmentCreate(host, t, { ...a, taskId: thread.id });
      recordEmailMessage(sql, t, { ...message, taskId: thread.id, commentId: comment.id });
      return { status: "commented", taskId: thread.id, commentId: comment.id, listId: thread.list_id };
    }

    requireEmailWritable(sql, t.actor, "list", listId);
    const task = applyTaskCreate(host, t, {
      listId,
      title: input.task.title,
      description: input.task.description,
      tags: authenticated ? [EMAIL_INTAKE_TAG] : [EMAIL_INTAKE_TAG, EMAIL_INTAKE_UNVERIFIED_TAG],
    });
    for (const a of input.attachments) applyAttachmentCreate(host, t, { ...a, taskId: task.id });
    recordEmailMessage(sql, t, { ...message, taskId: task.id, commentId: null });
    return { status: "created", taskId: task.id, listId: task.listId };
  });
  // As in runTaskTurn: an automation in the same turn may have moved the
  // task, and the caller should hear where it actually landed.
  if (result.status === "created" || result.status === "commented") {
    const row = taskRow(host.sql, result.taskId);
    if (row !== null) return { ...result, listId: row.list_id };
  }
  return result;
}

/**
 * The contract's refusals in its fixed order, then ok. Reads only.
 *
 * Dedupe is per (Message-ID, intake list), so one email addressed to two
 * intakes files once in each. It runs before the rate limits so a
 * redelivery is always recognized as one. Then two hourly budgets: the
 * sender's own, and the list's across every sender, since an "@domain"
 * entry admits any number of local parts each with a fresh sender budget.
 */
function runEmailIntakeCheck(
  sql: SqlStorage,
  alias: string,
  sender: string,
  messageId: string,
  now: number
): EmailIntakeCheck {
  const intake = sql
    .exec<EmailIntakeRow & { list_archived: number | null }>(
      `SELECT e.list_id AS list_id, e.alias AS alias, e.allowed_senders AS allowed_senders,
              e.created_at AS created_at, e.updated_at AS updated_at, l.archived AS list_archived
       FROM email_intakes e LEFT JOIN lists l ON l.id = e.list_id
       WHERE e.alias = ?`,
      alias
    )
    .toArray()[0];
  // `list_archived` is null when the list row is gone. Either way the
  // sender hears the same thing as for an alias that never existed.
  if (!intake || intake.list_archived !== 0) return { status: "unknown_alias" };
  if (!senderAllowed(sender, toEmailIntake(intake).allowedSenders)) {
    return { status: "sender_not_allowed" };
  }
  const listId = intake.list_id;
  const prior = sql
    .exec<{ task_id: string }>(
      "SELECT task_id FROM email_messages WHERE message_id = ? AND list_id = ?",
      messageId,
      listId
    )
    .toArray()[0];
  if (prior) return { status: "duplicate", taskId: prior.task_id };
  const since = now - EMAIL_RATE_WINDOW_MS;
  const fromSender = sql
    .exec<{ n: number }>("SELECT COUNT(*) AS n FROM email_messages WHERE sender = ? AND received_at > ?", sender, since)
    .one().n;
  if (fromSender >= EMAIL_INTAKE_HOURLY_LIMIT) return { status: "rate_limited" };
  const toList = sql
    .exec<{ n: number }>("SELECT COUNT(*) AS n FROM email_messages WHERE list_id = ? AND received_at > ?", listId, since)
    .one().n;
  if (toList >= EMAIL_INTAKE_LIST_HOURLY_LIMIT) return { status: "rate_limited" };
  return { status: "ok", listId };
}

/**
 * The ticket a reply belongs to: the first of its first
 * EMAIL_THREAD_REFERENCE_LIMIT referenced messages that this same list filed
 * and whose task still exists. Matching on the list rather than the alias
 * means one intake can't append to another's tickets, and an alias that is
 * removed and later given to another list can't carry that list's mail onto
 * the tickets the alias opened before.
 */
function emailThreadTask(
  sql: SqlStorage,
  listId: string,
  referenceIds: readonly string[]
): TaskRowSql | null {
  for (const raw of referenceIds.slice(0, EMAIL_THREAD_REFERENCE_LIMIT)) {
    const ref = normalizeMessageId(raw);
    if (ref === null) continue;
    const prior = sql
      .exec<{ task_id: string }>(
        "SELECT task_id FROM email_messages WHERE message_id = ? AND list_id = ?",
        ref,
        listId
      )
      .toArray()[0];
    const row = prior ? taskRow(sql, prior.task_id) : null;
    if (row !== null) return row;
  }
  return null;
}

/** The space write guard for ingestEmail: a refusal there is permanent, so it says so. */
function requireEmailWritable(
  sql: SqlStorage,
  actor: Actor,
  kind: "list" | "task",
  targetId: string
): void {
  const spaceId = kind === "task" ? spaceIdForTask(sql, targetId) : spaceIdForList(sql, targetId);
  const refusal = spaceWriteRefusal(sql, actor, spaceId);
  if (refusal !== null) {
    throw permanentEmailError(`the inbound actor may not write to ${kind} ${targetId}. ${refusal}`);
  }
}

/** The Worker mints attachment ids; a reused one would fail mid-turn, so refuse it up front. */
function requireFreshAttachmentIds(
  sql: SqlStorage,
  attachments: readonly EmailIngestAttachment[]
): void {
  const seen = new Set<string>();
  for (const a of attachments) {
    const taken =
      seen.has(a.id) ||
      sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM attachments WHERE id = ?", a.id).one().n > 0;
    if (taken) throw permanentEmailError(`attachment id ${a.id} is already in use.`);
    seen.add(a.id);
  }
}

/** The dedupe row, written last in the turn that filed the message. */
function recordEmailMessage(
  sql: SqlStorage,
  t: Turn,
  m: {
    messageId: string;
    listId: string;
    alias: string;
    sender: string;
    authenticated: boolean;
    taskId: string;
    commentId: string | null;
  }
): void {
  sql.exec(
    `INSERT INTO email_messages (message_id, list_id, alias, task_id, comment_id, sender, received_at, authenticated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    m.messageId,
    m.listId,
    m.alias,
    m.taskId,
    m.commentId,
    m.sender,
    t.now,
    m.authenticated ? 1 : 0
  );
  // The task/comment audit rows name the actor the Worker passed; this one
  // records who actually wrote in, and whether Cloudflare vouched for them.
  t.audit("email.ingest", m.taskId, {
    listId: m.listId,
    alias: m.alias,
    sender: m.sender,
    authenticated: m.authenticated,
    messageId: m.messageId,
    commentId: m.commentId,
  });
}
