import type { Actor, ApiKey, List, Space, SpaceVisibility, User } from "@flow/shared";
import {
  API_KEY_COLUMNS,
  type CreateApiKeyInput,
  type ParsedListInput,
  type ParsedSpaceInput,
  USER_COLUMNS,
  type UpsertUserInput,
  type WorkspaceHost,
  addSpaceMember,
  assertSpaceWritable,
  emailIntakeForList,
  requireListRow,
  requirePrivileged,
  requireSpace,
  sqlPatch,
} from "./db-helpers.js";
import { id, token } from "./id.js";
import { nextPosition } from "./position.js";
import { getUserByEmail } from "./reads.js";
import { type ApiKeyRow, type ListRow, type UserRow, toApiKey, toList, toUser } from "./rows.js";
import { seedSandboxWorkspace } from "./sandbox-seed.js";
import { PLACEHOLDER_EMAIL_DOMAIN } from "./schema.js";
import { insertStatuses, listStatuses, normalizeStatusSpecs } from "./statuses.js";
import { bumpResyncFloor } from "./sync-floor.js";
import { type Turn, toActor } from "./turn.js";
import { isPrivilegedRole, listSpaceMemberIds, roleOf } from "./visibility.js";
import { broadcastWs, closeSocket, resyncFor, sendWs, socketsFor } from "./ws.js";

export function createSpace(host: WorkspaceHost, input: ParsedSpaceInput, actor: string | Actor): Space {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    const space: Space = {
      id: id("sp_"),
      name: input.name,
      color: input.color ?? null,
      position: nextPosition(sql, "spaces"),
      archived: false,
      visibility: input.visibility,
      createdAt: t.now,
    };
    sql.exec(
      `INSERT INTO spaces (id, name, color, position, archived, visibility, created_at, created_by)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      space.id,
      space.name,
      space.color,
      space.position,
      space.visibility,
      space.createdAt,
      t.actor.userId
    );
    if (space.visibility === "private") {
      addSpaceMember(sql, space.id, t.actor.userId, t.now);
    }
    t.emit("create", "space", space.id, space as unknown as Record<string, unknown>);
    t.audit("space.create", space.id, { name: space.name, visibility: space.visibility });
    return space;
  });
}

export function updateSpace(
  host: WorkspaceHost,
  input: { spaceId: string; name?: string; color?: string | null; archived?: boolean; position?: number },
  actor: string | Actor
): Space {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    const before = requireSpace(sql, input.spaceId);
    const p = sqlPatch();
    p.setIf(input.name, before.name, "name");
    p.setNullable(input.color, before.color, "color");
    p.setIf(input.archived === undefined ? undefined : input.archived ? 1 : 0, before.archived ? 1 : 0, "archived");
    p.setIf(input.position, before.position, "position");
    if (p.sets.length === 0) return before;
    sql.exec(`UPDATE spaces SET ${p.sets.join(", ")} WHERE id = ?`, ...p.params, before.id);
    const after = requireSpace(sql, before.id);
    const patch: Record<string, unknown> = {};
    for (const key of ["name", "color", "archived", "position"] as const) {
      if (before[key] !== after[key]) patch[key] = after[key];
    }
    t.emit("update", "space", after.id, patch);
    t.audit("space.update", after.id, patch);
    return after;
  });
}

export function setSpaceVisibility(
  host: WorkspaceHost,
  input: { spaceId: string; visibility: SpaceVisibility },
  actor: string | Actor
): Space {
  const result = host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    requirePrivileged(sql, t.actor, "Changing a space's visibility");
    const before = requireSpace(sql, input.spaceId);
    if (before.visibility === input.visibility) return { space: before, changed: false };

    sql.exec("UPDATE spaces SET visibility = ? WHERE id = ?", input.visibility, input.spaceId);

    if (input.visibility === "private") {
      const createdBy =
        sql
          .exec<{ created_by: string | null }>("SELECT created_by FROM spaces WHERE id = ?", input.spaceId)
          .toArray()[0]?.created_by ?? null;
      addSpaceMember(sql, input.spaceId, createdBy ?? t.actor.userId, t.now);
    }

    const after = requireSpace(sql, input.spaceId);
    t.emit("update", "space", after.id, { visibility: after.visibility });
    t.audit("space.visibility", after.id, { from: before.visibility, to: after.visibility });
    return { space: after, changed: true };
  });

  if (result.changed) {
    bumpResyncFloor(host.sql, host.maxSeq());
    const spaceId = result.space.id;
    const members = new Set(listSpaceMemberIds(host.sql, spaceId));
    resyncFor(host, (userId) => !members.has(userId));
  }
  return result.space;
}

export function setSpaceMembers(
  host: WorkspaceHost,
  input: { spaceId: string; userIds: string[] },
  actor: string | Actor
): { spaceId: string; userIds: string[] } {
  const result = host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    requirePrivileged(sql, t.actor, "Setting a space's members");
    const space = requireSpace(sql, input.spaceId);

    const seen = new Set<string>();
    const wanted: string[] = [];
    for (const userId of input.userIds) {
      if (seen.has(userId)) continue;
      seen.add(userId);
      const exists = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE id = ?", userId).one().n;
      if (exists === 0) throw new Error(`Cannot add unknown user ${userId} to space ${space.id}.`);
      wanted.push(userId);
    }

    const before = new Set(listSpaceMemberIds(sql, space.id));
    sql.exec("DELETE FROM space_members WHERE space_id = ?", space.id);
    for (const userId of wanted) addSpaceMember(sql, space.id, userId, t.now);

    const changedUsers = new Set<string>();
    for (const userId of before) if (!seen.has(userId)) changedUsers.add(userId);
    for (const userId of wanted) if (!before.has(userId)) changedUsers.add(userId);

    t.audit("space.set_members", space.id, { userIds: wanted });
    return { spaceId: space.id, userIds: wanted, changedUsers, private: space.visibility === "private" };
  });

  if (result.private && result.changedUsers.size > 0) {
    bumpResyncFloor(host.sql, host.maxSeq());
    resyncFor(host, (userId) => result.changedUsers.has(userId));
  }
  return { spaceId: result.spaceId, userIds: result.userIds };
}

export function deleteSpace(host: WorkspaceHost, spaceId: string, actor: string | Actor): { ok: true } {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    const before = requireSpace(sql, spaceId);
    const { n } = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM lists WHERE space_id = ?", spaceId).one();
    if (n > 0) {
      throw new Error(
        `Space ${spaceId} ("${before.name}") still has ${n} list(s). ` +
          `Delete or move them first, or archive the space instead (updateSpace with archived: true).`
      );
    }
    sql.exec("DELETE FROM space_members WHERE space_id = ?", spaceId);
    sql.exec("DELETE FROM spaces WHERE id = ?", spaceId);
    t.emit("delete", "space", spaceId, null, { spaceId });
    t.audit("space.delete", spaceId, { name: before.name });
    return { ok: true } as const;
  });
}

export function createList(host: WorkspaceHost, input: ParsedListInput, actor: string | Actor): List {
  return host.runTurn(toActor(actor), (t) => {
    assertSpaceWritable(host.sql, t.actor, input.spaceId);
    return applyListCreate(host.sql, t, input);
  });
}

function applyListCreate(
  sql: SqlStorage,
  t: Turn,
  input: ParsedListInput,
  clickupId: string | null = null
): List {
  requireSpace(sql, input.spaceId);
  const specs = normalizeStatusSpecs(input.statuses);
  const listId = id("ls_");
  const row: ListRow = {
    id: listId,
    space_id: input.spaceId,
    name: input.name,
    position: nextPosition(sql, "lists", input.spaceId),
    archived: 0,
    inbound_token: null,
    created_at: t.now,
    clickup_id: clickupId,
  };
  sql.exec(
    `INSERT INTO lists (id, space_id, name, position, archived, inbound_token, created_at, clickup_id)
     VALUES (?, ?, ?, ?, 0, NULL, ?, ?)`,
    row.id,
    row.space_id,
    row.name,
    row.position,
    row.created_at,
    row.clickup_id
  );
  const statuses = insertStatuses(sql, listId, specs);
  const list = toList(row, statuses);
  t.emit("create", "list", listId, list as unknown as Record<string, unknown>);
  t.audit("list.create", listId, { spaceId: list.spaceId, name: list.name });
  return list;
}

export function updateList(
  host: WorkspaceHost,
  input: { listId: string; name?: string; archived?: boolean; position?: number; spaceId?: string },
  actor: string | Actor
): List {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    const row = requireListRow(sql, input.listId);
    assertSpaceWritable(sql, t.actor, row.space_id);
    if (input.spaceId !== undefined) assertSpaceWritable(sql, t.actor, input.spaceId);
    const before = toList(row, listStatuses(sql, row.id));
    const p = sqlPatch();
    p.setIf(input.name, before.name, "name");
    p.setIf(input.archived === undefined ? undefined : input.archived ? 1 : 0, before.archived ? 1 : 0, "archived");
    p.setIf(input.position, before.position, "position");
    if (input.spaceId !== undefined && input.spaceId !== before.spaceId) {
      requireSpace(sql, input.spaceId);
      p.set("space_id", input.spaceId);
    }
    if (p.sets.length === 0) return before;
    sql.exec(`UPDATE lists SET ${p.sets.join(", ")} WHERE id = ?`, ...p.params, before.id);
    const after = toList(requireListRow(sql, before.id), listStatuses(sql, before.id));
    const patch: Record<string, unknown> = {};
    const prev: Record<string, unknown> = {};
    for (const key of ["name", "archived", "position", "spaceId"] as const) {
      if (before[key] !== after[key]) {
        patch[key] = after[key];
        prev[key] = before[key];
      }
    }
    t.emit("update", "list", after.id, patch, { prev });
    t.audit("list.update", after.id, patch);
    return after;
  });
}

export function setListInboundToken(
  host: WorkspaceHost,
  input: { listId: string; enabled: boolean },
  actor: string | Actor
): { listId: string; inboundToken: string | null } {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    const row = requireListRow(sql, input.listId);
    assertSpaceWritable(sql, t.actor, row.space_id);
    const inboundToken = input.enabled ? token() : null;
    sql.exec("UPDATE lists SET inbound_token = ? WHERE id = ?", inboundToken, row.id);
    t.emit("update", "list", row.id, { inboundToken: null });
    t.audit("list.set_inbound_token", row.id, { enabled: input.enabled });
    return { listId: row.id, inboundToken };
  });
}

export function deleteList(host: WorkspaceHost, listId: string, actor: string | Actor): { ok: true } {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    const row = requireListRow(sql, listId);
    assertSpaceWritable(sql, t.actor, row.space_id);
    const { n } = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE list_id = ?", listId).one();
    if (n > 0) {
      throw new Error(
        `List ${listId} ("${row.name}") still has ${n} task(s). Move or delete them first, ` +
          `or archive the list instead (updateList with archived: true).`
      );
    }
    const intake = emailIntakeForList(sql, listId);
    sql.exec("DELETE FROM email_intakes WHERE list_id = ?", listId);
    sql.exec("DELETE FROM statuses WHERE list_id = ?", listId);
    sql.exec("DELETE FROM lists WHERE id = ?", listId);
    t.emit("delete", "list", listId, null, { spaceId: row.space_id });
    t.audit("list.delete", listId, {
      name: row.name,
      ...(intake === null ? {} : { emailIntakeAlias: intake.alias }),
    });
    return { ok: true } as const;
  });
}

export function claimOwner(host: WorkspaceHost, email: string): User | null {
  const trimmed = email.trim();
  if (trimmed === "") return null;
  const existing = getUserByEmail(host.sql, trimmed);
  if (existing) return existing;
  const placeholder = getUserByEmail(host.sql, `owner@${PLACEHOLDER_EMAIL_DOMAIN}`);
  if (!placeholder || placeholder.role !== "owner" || placeholder.deactivated) return null;
  return upsertUser(host, { id: placeholder.id, email: trimmed }, placeholder.id);
}

export function upsertUser(host: WorkspaceHost, input: UpsertUserInput, actor: string | Actor): User {
  const { before, after } = host.runTurn(toActor(actor), (t) => applyUserUpsert(host.sql, t, input));
  if (before === null) return after;
  if (isPrivilegedRole(before.role) !== isPrivilegedRole(after.role)) {
    bumpResyncFloor(host.sql, host.maxSeq());
    if (!after.deactivated) {
      for (const ws of socketsFor(host.ctx, after.id)) sendWs(ws, { type: "resync" });
    }
  }
  if (after.deactivated) {
    for (const ws of socketsFor(host.ctx, after.id)) closeSocket(ws, 1008, "user deactivated");
  }
  return after;
}

function applyUserUpsert(
  sql: SqlStorage,
  t: Turn,
  input: UpsertUserInput
): { before: User | null; after: User } {
  const email = input.email.trim();
  const existing = sql
    .exec<UserRow>(
      `SELECT ${USER_COLUMNS}
       FROM users WHERE ${input.id !== undefined ? "id = ?" : "lower(email) = lower(?)"}`,
      input.id ?? email
    )
    .toArray()[0];

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
    sql.exec(
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
    return { before: null, after: user };
  }

  const before = toUser(existing);
  const p = sqlPatch();
  if (email !== "" && email.toLowerCase() !== before.email.toLowerCase()) {
    p.set("email", email);
    p.set("needs_email_update", email.endsWith("@placeholder.flow") ? 1 : 0);
  }
  p.setIf(input.name, before.name, "name");
  p.setIf(input.role, before.role, "role");
  p.setIf(
    input.deactivated === undefined ? undefined : input.deactivated ? 1 : 0,
    before.deactivated ? 1 : 0,
    "deactivated"
  );
  p.setIf(input.clickupId, existing.clickup_id, "clickup_id");
  if (p.sets.length === 0) return { before, after: before };
  sql.exec(`UPDATE users SET ${p.sets.join(", ")} WHERE id = ?`, ...p.params, before.id);
  const after = toUser(sql.exec<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, before.id).one());
  const patch: Record<string, unknown> = {};
  for (const key of ["email", "name", "role", "deactivated"] as const) {
    if (before[key] !== after[key]) patch[key] = after[key];
  }
  t.emit("update", "user", after.id, patch);
  t.audit("user.update", after.id, patch);
  return { before, after };
}

export function createApiKey(
  host: WorkspaceHost,
  input: CreateApiKeyInput,
  actor: string | Actor
): ApiKey {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    const users = sql.exec<{ id: string }>("SELECT id FROM users WHERE id = ?", input.userId).toArray();
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
      canEmailRequesters: false,
    };
    sql.exec(
      `INSERT INTO api_keys (id, user_id, name, token_hash, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      key.id,
      key.userId,
      key.name,
      key.tokenHash,
      key.createdAt
    );
    t.audit("api_key.create", key.id, { userId: key.userId, name: key.name });
    return key;
  });
}

export function revokeApiKey(host: WorkspaceHost, keyId: string, actor: string | Actor): { ok: true } {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    const rows = sql.exec<{ id: string }>("SELECT id FROM api_keys WHERE id = ?", keyId).toArray();
    if (rows.length === 0) throw new Error(`API key ${keyId} not found.`);
    sql.exec("UPDATE api_keys SET revoked_at = ? WHERE id = ?", t.now, keyId);
    t.audit("api_key.revoke", keyId, null);
    return { ok: true } as const;
  });
}

export function setApiKeyEmailRequesters(
  host: WorkspaceHost,
  keyId: string,
  allowed: boolean,
  actor: string | Actor
): ApiKey {
  return host.runTurn(toActor(actor), (t) => {
    const { sql } = host;
    if (t.actor.via !== "ui" && t.actor.via !== "api") {
      throw new Error("Whether a key may email requesters can't be changed over MCP.");
    }
    if (!isPrivilegedRole(roleOf(sql, t.actor.userId))) {
      throw new Error("Only a workspace owner or admin can change whether a key may email requesters.");
    }
    const row = sql.exec<ApiKeyRow>(`SELECT ${API_KEY_COLUMNS} FROM api_keys WHERE id = ?`, keyId).toArray()[0];
    if (!row) throw new Error(`API key ${keyId} not found.`);
    if (row.revoked_at !== null) throw new Error(`API key ${keyId} is revoked.`);
    sql.exec("UPDATE api_keys SET can_email_requesters = ? WHERE id = ?", allowed ? 1 : 0, keyId);
    t.audit("api_key.email_requesters", keyId, { allowed });
    return toApiKey({ ...row, can_email_requesters: allowed ? 1 : 0 });
  });
}

export async function wipeSandbox(host: WorkspaceHost): Promise<{ ok: true }> {
  if (host.env.SANDBOX !== "true") {
    throw new Error('wipeSandbox only runs on the sandbox Worker (SANDBOX="true").');
  }
  await host.ctx.storage.deleteAlarm();
  await host.ctx.storage.deleteAll();
  return { ok: true };
}

export function seedSandbox(host: WorkspaceHost, now: number = Date.now()): { ok: true } {
  if (host.env.SANDBOX !== "true") {
    throw new Error('seedSandbox only runs on the sandbox Worker (SANDBOX="true").');
  }
  const owner = host.sql
    .exec<{ id: string }>("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1")
    .toArray()[0];
  if (!owner) throw new Error("sandbox workspace has no owner to seed as");
  seedSandboxWorkspace(host.sql, owner.id, now);
  bumpResyncFloor(host.sql, host.maxSeq());
  broadcastWs(host.ctx, { type: "resync" });
  return { ok: true };
}
