/**
 * Per-request plumbing for the MCP tools: the DO handle, the calling identity,
 * and a lazily-fetched index for turning ids into the names agents actually
 * reason about.
 */
import type { Workspace } from "@flow/core";
import type { Actor, Status } from "@flow/shared";
import { workspace, type WorkspaceApi } from "../do.js";
import type { AuthContext, Env } from "../env.js";

/**
 * `Workspace.getWorkspaceMap()` exists in packages/core precisely for
 * `flow_get_workspace_map` and for the id -> name resolution below (it is the
 * hierarchy plus statuses and users, with no task rows), but `WorkspaceApi` in
 * `src/do.ts` does not list it yet and that file belongs to another owner. The
 * shape is taken straight from the DO's own return type so this cannot drift,
 * and the assertion is confined to `workspaceWithMap` below.
 */
export type WorkspaceMap = ReturnType<Workspace["getWorkspaceMap"]>;
type WorkspaceMapRpc = { getWorkspaceMap(forUserId?: string): Promise<WorkspaceMap> };

function workspaceWithMap(env: Env): WorkspaceApi & WorkspaceMapRpc {
  return workspace(env) as WorkspaceApi & WorkspaceMapRpc;
}

/** Id -> human name lookups. Every miss degrades to the raw id, never to null. */
export type NameIndex = {
  statusName(statusId: string): string;
  listName(listId: string): string;
  spaceNameForList(listId: string): string;
  userName(userId: string | null): string | null;
  /** All statuses of the list a task lives in — used in error-ish contexts. */
  statusesForList(listId: string): Status[];
};

export function buildNameIndex(map: WorkspaceMap): NameIndex {
  const statuses = new Map<string, string>();
  const lists = new Map<string, { name: string; spaceName: string; statuses: Status[] }>();
  const users = new Map<string, string>();

  for (const space of map.spaces) {
    for (const list of space.lists) {
      lists.set(list.id, { name: list.name, spaceName: space.name, statuses: list.statuses });
      for (const status of list.statuses) statuses.set(status.id, status.name);
    }
  }
  for (const user of map.users) users.set(user.id, user.name);

  return {
    statusName: (id) => statuses.get(id) ?? id,
    listName: (id) => lists.get(id)?.name ?? id,
    spaceNameForList: (id) => lists.get(id)?.spaceName ?? "",
    userName: (id) => (id === null ? null : (users.get(id) ?? id)),
    statusesForList: (id) => lists.get(id)?.statuses ?? [],
  };
}

/**
 * One of these per HTTP request. The name index is memoised, so a request that
 * calls three tools costs at most one extra `getWorkspaceMap()` RPC in total.
 */
export class ToolContext {
  readonly ws: WorkspaceApi & WorkspaceMapRpc;
  private mapPromise: Promise<WorkspaceMap> | null = null;
  private indexPromise: Promise<NameIndex> | null = null;

  constructor(
    readonly env: Env,
    readonly auth: AuthContext
  ) {
    this.ws = workspaceWithMap(env);
  }

  /**
   * The actor for every mutation. `via: "mcp"` is forced here rather than
   * inherited: `auth.ts` derives `via` from the credential, so a human reaching
   * /mcp behind Cloudflare Access would otherwise be audited as "ui".
   */
  get actor(): Actor {
    return { ...this.auth.actor, via: "mcp" };
  }

  get isAdmin(): boolean {
    return this.auth.user.role === "owner" || this.auth.user.role === "admin";
  }

  /** The id every filtered read is made on behalf of: the user this key acts as. */
  get userId(): string {
    return this.auth.user.id;
  }

  workspaceMap(): Promise<WorkspaceMap> {
    // Per-space permissions apply to agents exactly as they do to the UI: a key
    // impersonating a member sees the member's spaces, not the workspace's.
    this.mapPromise ??= this.ws.getWorkspaceMap(this.userId);
    return this.mapPromise;
  }

  names(): Promise<NameIndex> {
    this.indexPromise ??= this.workspaceMap().then(buildNameIndex);
    return this.indexPromise;
  }
}
