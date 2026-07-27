import { z } from "zod";
import {
  Attachment, Comment, Id, List, Space, Subtask, Task, Ts, User,
} from "./entities.js";
import { AutomationRule } from "./automations.js";

// ---------------------------------------------------------------------------
// Delta events. Every committed mutation appends one event with a monotonic
// seq to the changes log. The same envelope is:
//   - broadcast to WebSocket clients (live board updates)
//   - replayed on reconnect (client sends last-seen seq)
//   - delivered to outbound webhooks (with HMAC signature)
// Clients apply patches; they never re-fetch the board after a mutation.
// ---------------------------------------------------------------------------

export const EntityKind = z.enum([
  "space", "list", "task", "subtask", "comment", "attachment", "user",
  "automation_rule",
]);
export type EntityKind = z.infer<typeof EntityKind>;

export const DeltaOp = z.enum(["create", "update", "delete"]);
export type DeltaOp = z.infer<typeof DeltaOp>;

export const Delta = z.object({
  seq: z.number().int(),
  op: DeltaOp,
  entity: EntityKind,
  id: Id,
  // create: full object. update: changed fields only. delete: null.
  data: z.record(z.string(), z.unknown()).nullable(),
  actorUserId: Id,
  at: Ts,
});
export type Delta = z.infer<typeof Delta>;

// --- WebSocket protocol ----------------------------------------------------

export const ClientMsg = z.discriminatedUnion("type", [
  // First message after connect. sinceSeq = last applied seq, or null for
  // a fresh client (server replies with snapshot).
  z.object({ type: z.literal("hello"), sinceSeq: z.number().int().nullable() }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

/**
 * A task as it travels inside a BoardSnapshot: the fields the board actually
 * draws, and nothing else. `description` is by far the biggest column in the
 * table and no card renders it, so the snapshot ships a single `hasDescription`
 * bit instead and the detail panel's own `GET /api/tasks/:id` fills in the real
 * text; `clickupId`, `startDate`, `createdBy` and `closedAt` are detail/audit
 * fields with no board consumer (closed-ness is read off the task's status, not
 * off `closedAt`).
 *
 * Only the SNAPSHOT is slimmed. Deltas keep carrying full `Task` objects on
 * create and the changed subset on update, so a client that has fetched a
 * task's detail keeps an entry that upgrades to a complete Task in place.
 */
export const SnapshotTask = Task.omit({
  description: true,
  clickupId: true,
  startDate: true,
  createdBy: true,
  closedAt: true,
}).extend({
  /** `description != ''` on the server. Lets the panel choose placeholder vs
   *  loading without waiting for the detail fetch. */
  hasDescription: z.boolean(),
});
export type SnapshotTask = z.infer<typeof SnapshotTask>;

export const BoardSnapshot = z.object({
  seq: z.number().int(),
  spaces: z.array(Space),
  lists: z.array(List),
  tasks: z.array(SnapshotTask),
  subtasks: z.array(Subtask),
  users: z.array(User),
  automationRules: z.array(AutomationRule),
  // Comments and attachments load lazily per task, not in the snapshot.
});
export type BoardSnapshot = z.infer<typeof BoardSnapshot>;

export const ServerMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), snapshot: BoardSnapshot }),
  z.object({ type: z.literal("deltas"), deltas: z.array(Delta) }),
  // Gap too large to replay — client must reconnect fresh.
  z.object({ type: z.literal("resync") }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerMsg = z.infer<typeof ServerMsg>;

// --- Outbound webhook envelope --------------------------------------------

export const WebhookPayload = z.object({
  event: z.string(), // "task.status_changed", "task.created", ...
  delta: Delta,
  task: Task.nullable(), // full snapshot when the entity is a task
  workspace: z.string(), // hostname, for multi-consumer routing
});
export type WebhookPayload = z.infer<typeof WebhookPayload>;

export const TaskDetail = z.object({
  task: Task,
  subtasks: z.array(Subtask),
  comments: z.array(Comment),
  attachments: z.array(Attachment),
});
export type TaskDetail = z.infer<typeof TaskDetail>;
