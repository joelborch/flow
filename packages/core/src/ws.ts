import { ClientMsg as ClientMsgSchema, type Delta, type ServerMsg } from "@flow/shared";
import {
  WS_USER_HEADER,
  type WorkspaceHost,
  safeJson,
  spaceIdForDelta,
  spaceIdForList,
} from "./db-helpers.js";
import type { ChangeRow } from "./rows.js";
import { REPLAY_GAP_LIMIT, bumpResyncFloor, needsSnapshot, resyncFloor } from "./sync-floor.js";
import { type ScopedDelta, type Turn } from "./turn.js";
import {
  UNRESOLVED_SPACE_ID,
  deltaVisibleTo,
  isPrivilegedDeltaEntity,
  isPrivilegedRole,
  isSpaceScopedEntity,
  privateSpaceIds,
  roleOf,
  visibleSpaceIds,
} from "./visibility.js";
import { websocketCloseReplyCode } from "./websocket-close.js";

interface ConnState {
  userId: string;
}

/**
 * WebSocket upgrade at `/ws`. The api Worker authenticates the request and
 * forwards it with `?userId=us_…`; the DO does not re-authenticate.
 */
export function handleWsFetch(host: WorkspaceHost, req: Request): Response {
  const url = new URL(req.url);
  if (url.pathname !== "/ws") {
    return new Response("workspace do: unknown path", { status: 404 });
  }
  if ((req.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
    return new Response("expected websocket upgrade", { status: 426 });
  }
  const pair = new WebSocketPair();
  const server = pair[1];
  host.ctx.acceptWebSocket(server);
  const state: ConnState = {
    // The Worker sends the id as a header; the `?userId=` form is kept as a
    // fallback for direct-to-DO callers (tests, a curl against the stub).
    userId: req.headers.get(WS_USER_HEADER) ?? url.searchParams.get("userId") ?? "",
  };
  server.serializeAttachment(state);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

export async function handleWsMessage(
  host: WorkspaceHost,
  ws: WebSocket,
  message: string | ArrayBuffer
): Promise<void> {
  if (typeof message !== "string") return;
  const parsed = ClientMsgSchema.safeParse(safeJson(message));
  if (!parsed.success) return;
  const msg = parsed.data;

  if (msg.type === "ping") {
    sendWs(ws, { type: "pong" });
    return;
  }

  // hello: catch the client up, then it lives on broadcast deltas alone. The
  // snapshot and the replay are both filtered by the identity this socket was
  // accepted with, so a member never receives private-space rows either way.
  const userId = connUserId(ws);
  // upsertUser closes a deactivated user's sockets, and the Worker refuses
  // them at upgrade; this catches a socket accepted in between the two.
  if (isDeactivated(host.sql, userId)) {
    closeSocket(ws, 1008, "user deactivated");
    return;
  }
  const max = host.maxSeq();
  if (msg.sinceSeq === null) {
    sendWs(ws, { type: "snapshot", snapshot: host.getSnapshot(userId) });
    return;
  }
  const { min } = host.sql.exec<{ min: number | null }>("SELECT MIN(seq) AS min FROM changes").one();
  // The resync floor covers the delta-less mutations (import, membership,
  // visibility): they change board state without writing to `changes`, so a
  // replay from a seq at or below the floor would silently skip them — the
  // snapshot path is the only correct answer there. See ./sync-floor.ts.
  const snapshotNeeded = needsSnapshot({
    sinceSeq: msg.sinceSeq,
    maxSeq: max,
    minSeq: min,
    floor: resyncFloor(host.sql),
    gapLimit: REPLAY_GAP_LIMIT,
  });
  if (snapshotNeeded) {
    sendWs(ws, { type: "snapshot", snapshot: host.getSnapshot(userId) });
    return;
  }
  const deltas = filterReplay(host.sql, replay(host.sql, msg.sinceSeq), userId);
  if (deltas.length > 0) sendWs(ws, { type: "deltas", deltas });
}

export function handleWsClose(ws: WebSocket, code: number, reason: string): void {
  // The reply can race a close we started (a deactivated user's socket), in
  // which case the socket is already closing and close() throws.
  closeSocket(ws, websocketCloseReplyCode(code), reason);
}

export function handleWsError(error: unknown): void {
  console.error("websocket error", error);
}

export function sendWs(ws: WebSocket, msg: ServerMsg): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    console.error("websocket send failed", err);
  }
}

export function broadcastWs(ctx: DurableObjectState, msg: ServerMsg): void {
  const payload = JSON.stringify(msg);
  for (const ws of ctx.getWebSockets()) {
    try {
      ws.send(payload);
    } catch {
      // Connection is going away; close/error handlers clean up.
    }
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
export function broadcastDeltas(host: WorkspaceHost, scoped: ScopedDelta[]): void {
  if (scoped.length === 0) return;
  const restricted = privateSpaceIds(host.sql);
  // Same fail-closed rule as filterReplay: a space-scoped delta whose space
  // did not resolve at emit time gets the unresolved sentinel, so when any
  // private space exists it is withheld from members instead of defaulting
  // to visible. Space-less deltas (`user`) keep null and reach everyone.
  const effective = scoped.map((s): ScopedDelta => ({
    delta: s.delta,
    spaceId:
      s.spaceId === null && isSpaceScopedEntity(s.delta.entity) ? UNRESOLVED_SPACE_ID : s.spaceId,
  }));
  const touchesPrivate =
    restricted.size > 0 &&
    effective.some(
      (s) => s.spaceId !== null && (restricted.has(s.spaceId) || s.spaceId === UNRESOLVED_SPACE_ID)
    );
  // Automation-rule deltas are owner/admin-only, so their presence forces the
  // per-connection path exactly as a private-space delta does.
  const touchesPrivileged = effective.some((s) => isPrivilegedDeltaEntity(s.delta.entity));
  if (!touchesPrivate && !touchesPrivileged) {
    broadcastWs(host.ctx, { type: "deltas", deltas: effective.map((s) => s.delta) });
    return;
  }

  const seen = new Map<string, Set<string> | null>();
  const visibleFor = (userId: string): Set<string> | null => {
    if (!seen.has(userId)) seen.set(userId, visibleSpaceIds(host.sql, userId));
    return seen.get(userId) ?? null;
  };

  for (const ws of host.ctx.getWebSockets()) {
    // `visible === null` is visibleSpaceIds's owner/admin signal, so it is
    // also what admits the privileged-entity deltas.
    const visible = visibleFor(connUserId(ws));
    const deltas = effective
      .filter((s) => deltaVisibleTo(s.delta.entity, s.spaceId, visible))
      .map((s) => s.delta);
    if (deltas.length === 0) continue;
    sendWs(ws, { type: "deltas", deltas });
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
export function resyncFor(host: WorkspaceHost, affects: (userId: string) => boolean): void {
  for (const ws of host.ctx.getWebSockets()) {
    const userId = connUserId(ws);
    if (isPrivilegedRole(roleOf(host.sql, userId))) continue;
    if (!affects(userId)) continue;
    sendWs(ws, { type: "resync" });
  }
}

/**
 * Resync the users for whom a task or list changed space in this turn.
 *
 * A move is broadcast as an ordinary update stamped with the NEW space, which
 * is only a correct patch for someone who sees both ends: a member who sees
 * only the destination gets `{listId, statusId, …}` for a task they never
 * held, and one who sees only the source never learns it left (nor, for a
 * list, that its tasks went with it). Like a visibility flip, that cannot be
 * patched, so the floor is bumped and exactly those users resync. Same-list
 * and same-space moves stop at the first checks, so ordinary drags stay cheap.
 *
 * Runs before `flush`, so an affected client sees `resync` first and drops
 * the half-patch that follows instead of briefly rendering it.
 */
export function resyncForSpaceMoves(host: WorkspaceHost, t: Turn): void {
  const moves: Array<{ from: string | null; to: string | null }> = [];
  for (const { delta, spaceId } of t.entries) {
    if (delta.op !== "update" || delta.data === null) continue;
    let from: string | null;
    if (delta.entity === "task" && "listId" in delta.data) {
      const prevListId = delta.prev?.["listId"];
      if (typeof prevListId !== "string") continue;
      from = spaceIdForList(host.sql, prevListId);
    } else if (delta.entity === "list" && "spaceId" in delta.data) {
      const prevSpaceId = delta.prev?.["spaceId"];
      if (typeof prevSpaceId !== "string") continue;
      from = prevSpaceId;
    } else {
      continue;
    }
    if (from !== spaceId) moves.push({ from, to: spaceId });
  }
  if (moves.length === 0) return;

  // Between two workspace-visible spaces everyone sees both ends already.
  const restricted = privateSpaceIds(host.sql);
  const isRestricted = (id: string | null) => id !== null && restricted.has(id);
  if (!moves.some((m) => isRestricted(m.from) || isRestricted(m.to))) return;

  // Offline clients replaying across this seq would hit the same hole.
  bumpResyncFloor(host.sql, host.maxSeq());
  resyncFor(host, (userId) => {
    const visible = visibleSpaceIds(host.sql, userId);
    if (visible === null) return false;
    const sees = (id: string | null) => id !== null && visible.has(id);
    return moves.some((m) => sees(m.from) !== sees(m.to));
  });
}

/** Every open socket accepted for this user id (see `ConnState`). */
export function socketsFor(ctx: DurableObjectState, userId: string): WebSocket[] {
  return ctx.getWebSockets().filter((ws) => connUserId(ws) === userId);
}

export function closeSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closing; the close handler cleans up.
  }
}

/** The user id stamped on a hibernated socket at accept time. */
function connUserId(ws: WebSocket): string {
  try {
    return (ws.deserializeAttachment() as ConnState | null)?.userId ?? "";
  } catch {
    return "";
  }
}

/** Unknown ids are not "deactivated": they keep the member treatment. */
function isDeactivated(sql: SqlStorage, userId: string): boolean {
  if (userId === "") return false;
  const row = sql.exec<{ deactivated: number }>("SELECT deactivated FROM users WHERE id = ?", userId).toArray()[0];
  return row?.deactivated === 1;
}

/**
 * Replayed deltas paired with the space id STORED on each `changes` row at
 * emit time (null for pre-migration rows and genuinely space-less deltas).
 * The stored value survives row deletion, which live resolution does not.
 */
function replay(sql: SqlStorage, sinceSeq: number): ScopedDelta[] {
  return sql
    .exec<ChangeRow>(
      `SELECT seq, op, entity, entity_id, data, actor_user_id, at, space_id
       FROM changes WHERE seq > ? ORDER BY seq LIMIT ?`,
      sinceSeq,
      REPLAY_GAP_LIMIT
    )
    .toArray()
    .map(
      (r): ScopedDelta => ({
        delta: {
          seq: r.seq,
          op: r.op as Delta["op"],
          entity: r.entity as Delta["entity"],
          id: r.entity_id,
          data: r.data === null ? null : (JSON.parse(r.data) as Record<string, unknown>),
          actorUserId: r.actor_user_id,
          at: r.at,
        },
        spaceId: r.space_id,
      })
    );
}

/**
 * Apply per-space permissions to a replayed range.
 *
 * Each `changes` row carries the space id it was stamped with at emit time,
 * which is authoritative even after the underlying row is deleted. Rows
 * written before the `core-0007-changes-space-id` migration have a null
 * stored id and fall back to live resolution, memoised by entity id.
 *
 * Null-fallback semantics (fail closed): when the stored id is null AND live
 * resolution also returns null, a space-scoped entity (task, list, comment,
 * …) is mapped to UNRESOLVED_SPACE_ID — never in any member's visible set,
 * so members do not receive it, while owners/admins (visible === null) still
 * do. A deleted private-space row must not decay into "visible to everyone".
 * Workspace-scoped deltas (`user`) keep their null space and reach everyone.
 *
 * The whole pass is skipped when the workspace has no private spaces or the
 * user is an owner/admin — the normal case, keeping reconnects cheap.
 */
function filterReplay(sql: SqlStorage, scoped: ScopedDelta[], userId: string): Delta[] {
  const deltas = scoped.map((s) => s.delta);
  if (scoped.length === 0) return deltas;
  // Privileged-entity deltas (automation rules) must be filtered for members
  // even when the workspace has no private spaces, so the cheap early-out
  // only applies when neither filter has anything to do.
  const hasPrivilegedEntity = deltas.some((d) => isPrivilegedDeltaEntity(d.entity));
  if (!hasPrivilegedEntity && privateSpaceIds(sql).size === 0) return deltas;
  const visible = visibleSpaceIds(sql, userId);
  if (visible === null) return deltas;

  const memo = new Map<string, string | null>();
  const liveSpaceId = (d: Delta): string | null => {
    const key = `${d.entity}:${d.id}`;
    if (!memo.has(key)) memo.set(key, spaceIdForDelta(sql, d.entity, d.id, undefined));
    return memo.get(key) ?? null;
  };
  return scoped
    .filter((s) => {
      const stored = s.spaceId ?? liveSpaceId(s.delta);
      const spaceId =
        stored === null && isSpaceScopedEntity(s.delta.entity) ? UNRESOLVED_SPACE_ID : stored;
      return deltaVisibleTo(s.delta.entity, spaceId, visible);
    })
    .map((s) => s.delta);
}
