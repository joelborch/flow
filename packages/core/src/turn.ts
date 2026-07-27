import type { Actor, Delta, DeltaOp, EntityKind } from "@flow/shared";
import type { AutomationDelta } from "./automation/types.js";

/**
 * One mutation turn. Everything inside a turn is a single synchronous run of
 * SQLite writes — no `await` between them — so rows, delta log entries and the
 * audit row commit atomically. Broadcasting and queue sends happen after.
 */
export interface TurnEntry {
  /**
   * Carries the two automation-only extras: `prev` (pre-mutation values, which
   * a Delta's changed-fields-only `data` can't express) and `taskId` for deltas
   * on child entities. Neither is persisted or sent to clients.
   */
  delta: AutomationDelta;
  /**
   * The space this delta belongs to, resolved at emit time, or null for deltas
   * that belong to no space (users, automation rules).
   *
   * It has to be resolved here rather than at broadcast time because a delete
   * delta is emitted after the row is gone: by the time the socket loop runs,
   * `task -> list -> space` no longer joins. Delete call sites therefore pass
   * the id they already read; everything else lets the resolver look it up.
   */
  spaceId: string | null;
  /** Automation depth that produced this delta; 0 = the caller's mutation. */
  depth: number;
  evaluated: boolean;
}

/** One broadcastable delta with the space it must be filtered against. */
export interface ScopedDelta {
  delta: Delta;
  spaceId: string | null;
}

/**
 * Resolve the space a delta belongs to. Supplied by the DO, which owns the
 * `task -> list -> space` joins; `taskId` is the parent for subtask, comment
 * and attachment deltas, whose own ids say nothing about where they live.
 */
export type SpaceResolver = (
  entity: EntityKind,
  entityId: string,
  taskId: string | undefined
) => string | null;

export class Turn {
  readonly entries: TurnEntry[] = [];
  readonly sideEffects: unknown[] = [];
  /** Depth stamped onto deltas emitted right now; applyAction bumps it. */
  depth = 0;
  /**
   * Set while an automation action is being applied, to the id of the rule that
   * fired. Audit rows written in that window are attributed to the automation
   * (see `auditActor`) instead of looking like a plain API call by the user who
   * happened to trip the trigger.
   */
  automationRuleId: string | null = null;

  constructor(
    private readonly sql: SqlStorage,
    readonly actor: Actor,
    readonly now: number,
    /**
     * Import mode: skip the changes log and per-row broadcast entirely. A
     * 5k-row import would otherwise double the delta log for no subscriber.
     */
    readonly silent = false,
    /**
     * Defaults to "belongs to no space", which is the safe direction: an
     * unresolved delta broadcasts to everyone exactly as it did before per-space
     * permissions existed. Call sites inside a private space always resolve.
     */
    private readonly resolveSpaceId: SpaceResolver = () => null
  ) {}

  /**
   * Append one Delta to `changes` and return it with its assigned seq.
   * `extra.prev` and `extra.taskId` are automation-only context: they reach the
   * engine but are never written to the log or sent to clients.
   */
  emit(
    op: DeltaOp,
    entity: EntityKind,
    entityId: string,
    data: Record<string, unknown> | null,
    extra?: {
      prev?: Record<string, unknown> | null;
      taskId?: string;
      /** Overrides the resolver — pass it when the row is already deleted. */
      spaceId?: string | null;
    }
  ): Delta {
    const base = {
      op,
      entity,
      id: entityId,
      data,
      actorUserId: this.actor.userId,
      at: this.now,
    };
    if (this.silent) return { seq: 0, ...base };

    const { seq } = this.sql
      .exec<{ seq: number }>(
        `INSERT INTO changes (op, entity, entity_id, data, actor_user_id, at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING seq`,
        op,
        entity,
        entityId,
        data === null ? null : JSON.stringify(data),
        this.actor.userId,
        this.now
      )
      .one();
    const delta: Delta = { seq, ...base };
    this.entries.push({
      delta: { ...delta, prev: extra?.prev ?? null, taskId: extra?.taskId },
      spaceId:
        extra?.spaceId !== undefined
          ? extra.spaceId
          : this.resolveSpaceId(entity, entityId, extra?.taskId),
      depth: this.depth,
      evaluated: false,
    });
    return delta;
  }

  audit(action: string, entity: string, diff: Record<string, unknown> | null): void {
    const actor = auditActor(this.actor, this.automationRuleId);
    this.sql.exec(
      `INSERT INTO audit (actor, action, entity, diff, at, actor_user_id, api_key_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      JSON.stringify(actor),
      action,
      entity,
      diff === null ? null : JSON.stringify(diff),
      this.now,
      actor.userId,
      actor.apiKeyId
    );
  }

  enqueue(payload: unknown): void {
    this.sideEffects.push(payload);
  }

  /** Deltas to push to WebSocket clients, in seq order, extras stripped. */
  broadcastable(): Delta[] {
    return this.scopedBroadcastable().map((e) => e.delta);
  }

  /**
   * The same deltas, each paired with the space it came from. The broadcast
   * path uses this so a delta from a private space only reaches the sockets
   * whose user may see that space.
   */
  scopedBroadcastable(): ScopedDelta[] {
    return this.entries.map(({ delta, spaceId }): ScopedDelta => {
      const { prev: _prev, taskId: _taskId, ...wire } = delta;
      return { delta: wire, spaceId };
    });
  }
}

/**
 * The Actor an audit row should carry.
 *
 * Outside an automation this is just the turn's actor. Inside one, the mutation
 * was decided by the rule, not the person: `via` becomes "automation" and
 * `automationRuleId` names the rule, so the audit log can answer "why did this
 * task move?" without correlating timestamps. `apiKeyId` is cleared because the
 * key did not make this particular change. `userId` is kept — the audit trail
 * must still say whose action set the chain off, and it is what the UI shows.
 */
export function auditActor(actor: Actor, automationRuleId: string | null): Actor {
  if (automationRuleId === null) return actor;
  return {
    userId: actor.userId,
    via: "automation",
    apiKeyId: null,
    automationRuleId,
  };
}

/** Coerce the RPC `actorUserId | Actor` argument into a full Actor. */
export function toActor(actor: string | Actor, defaultVia: Actor["via"] = "api"): Actor {
  if (typeof actor === "string") {
    return { userId: actor, via: defaultVia, apiKeyId: null, automationRuleId: null };
  }
  return actor;
}

/** Only the fields that actually changed, for `update` deltas and audit diffs. */
export function diffOf<T extends Record<string, unknown>>(
  before: T,
  after: T,
  keys: ReadonlyArray<keyof T & string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const a = before[k];
    const b = after[k];
    const changed = Array.isArray(a) && Array.isArray(b) ? JSON.stringify(a) !== JSON.stringify(b) : a !== b;
    if (changed) out[k] = b;
  }
  return out;
}
