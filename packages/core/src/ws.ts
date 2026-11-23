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

  const userId = connUserId(ws);
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

export function broadcastDeltas(host: WorkspaceHost, scoped: ScopedDelta[]): void {
  if (scoped.length === 0) return;
  const restricted = privateSpaceIds(host.sql);
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
    const visible = visibleFor(connUserId(ws));
    const deltas = effective
      .filter((s) => deltaVisibleTo(s.delta.entity, s.spaceId, visible))
      .map((s) => s.delta);
    if (deltas.length === 0) continue;
    sendWs(ws, { type: "deltas", deltas });
  }
}

export function resyncFor(host: WorkspaceHost, affects: (userId: string) => boolean): void {
  for (const ws of host.ctx.getWebSockets()) {
    const userId = connUserId(ws);
    if (isPrivilegedRole(roleOf(host.sql, userId))) continue;
    if (!affects(userId)) continue;
    sendWs(ws, { type: "resync" });
  }
}

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

  const restricted = privateSpaceIds(host.sql);
  const isRestricted = (id: string | null) => id !== null && restricted.has(id);
  if (!moves.some((m) => isRestricted(m.from) || isRestricted(m.to))) return;

  bumpResyncFloor(host.sql, host.maxSeq());
  resyncFor(host, (userId) => {
    const visible = visibleSpaceIds(host.sql, userId);
    if (visible === null) return false;
    const sees = (id: string | null) => id !== null && visible.has(id);
    return moves.some((m) => sees(m.from) !== sees(m.to));
  });
}

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

function connUserId(ws: WebSocket): string {
  try {
    return (ws.deserializeAttachment() as ConnState | null)?.userId ?? "";
  } catch {
    return "";
  }
}

function isDeactivated(sql: SqlStorage, userId: string): boolean {
  if (userId === "") return false;
  const row = sql.exec<{ deactivated: number }>("SELECT deactivated FROM users WHERE id = ?", userId).toArray()[0];
  return row?.deactivated === 1;
}

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

function filterReplay(sql: SqlStorage, scoped: ScopedDelta[], userId: string): Delta[] {
  const deltas = scoped.map((s) => s.delta);
  if (scoped.length === 0) return deltas;
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
