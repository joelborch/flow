import type {
  Comment,
  List,
  Priority,
  Space,
  Status,
  StatusType,
  Subtask,
  Task,
  User,
} from "@flow/shared";
import { isClosedStatusType, parseTs } from "./clickup-types.js";
import type {
  CuAttachment,
  CuComment,
  CuFolder,
  CuList,
  CuSpace,
  CuStatus,
  CuTask,
  CuTeam,
  CuUser,
} from "./clickup-types.js";
import { IdMap } from "./idmap.js";
import { WarnTally } from "./log.js";
import { selectInScope, type ScopeConfig } from "./scope.js";

// ---------------------------------------------------------------------------
// Attachment metadata is NOT the shared Attachment entity: r2Key and the Flow
// id are assigned server-side when the bytes land in R2. Pass 2 emits the
// source URL for pass 3 to stream, so this is a load instruction, not an
// entity. Kept local on purpose rather than widening the contract.
// ---------------------------------------------------------------------------
export type AttachmentImport = {
  clickupAttachmentId: string;
  clickupTaskId: string;
  taskId: string;
  filename: string;
  mimeType: string;
  size: number;
  sourceUrl: string;
  uploadedBy: string | null;
  createdAt: number;
};

export type FlowBundle = {
  users: User[];
  spaces: Space[];
  lists: List[];
  tasks: Task[];
  subtasks: Subtask[];
  comments: Comment[];
  attachments: AttachmentImport[];
};

export type TransformInput = {
  team: CuTeam;
  spaces: CuSpace[];
  /** Every folder per space, archived ones included, so they can be skipped. */
  foldersBySpace: Record<string, CuFolder[]>;
  /** Full GET /list/{id} results — the only source of resolved statuses. */
  lists: CuList[];
  tasks: CuTask[];
  commentsByTask: Record<string, CuComment[]>;
  attachmentsByTask: Record<string, CuAttachment[]>;
};

export type TransformOptions = {
  idMap: IdMap;
  scope: ScopeConfig;
  warnings?: WarnTally;
  /** Base path old ClickUp task links are rewritten onto. */
  taskUrlPrefix?: string;
  /**
   * email (lowercased) -> Flow role. Role assignment is a deployment policy,
   * not derivable from ClickUp: guest/member there says nothing about what a
   * person should be able to do in Flow. Supplied via FLOW_ROLE_OVERRIDES or
   * --roles; when absent, the ClickUp team owner becomes Flow's owner and
   * everyone else lands as member.
   */
  roleOverrides?: RoleOverrides;
};

// --- users -----------------------------------------------------------------

export type RoleOverrides = Record<string, User["role"]>;

/** Default policy: the ClickUp team owner is Flow's owner; nobody else is promoted. */
export function defaultRoleOverrides(team: CuTeam): RoleOverrides {
  const owner = team.members.find((m) => m.user.role === 1 || m.user.role_key === "owner");
  const email = owner?.user.email?.toLowerCase();
  return email ? { [email]: "owner" } : {};
}

/** ClickUp's automation bot posts comments as user id -1. */
export const CLICKBOT_ID = -1;

export function userEmail(u: CuUser): string {
  if (u.email && u.email.includes("@")) return u.email.toLowerCase();
  // Invited-never-joined guests can lack an email; synthesize a stable local
  // address so the zod email check passes and the row stays referenceable.
  return `clickup-${u.id}@import.invalid`;
}

export function userName(u: CuUser): string {
  const name = (u.username ?? "").trim();
  if (name) return name;
  const email = u.email?.trim();
  if (email) return email.split("@")[0] ?? email;
  return `ClickUp user ${u.id}`;
}

export function resolveRole(email: string, overrides: RoleOverrides): User["role"] {
  return overrides[email.toLowerCase()] ?? "member";
}

/**
 * Members become active users; anyone who only appears as an assignee, creator
 * or comment author becomes a deactivated user so their rows stay attributable
 * (the contract explicitly allows for this).
 */
export function buildUsers(input: TransformInput, opts: TransformOptions): User[] {
  const roleOverrides = opts.roleOverrides ?? defaultRoleOverrides(input.team);
  const memberIds = new Set(input.team.members.map((m) => m.user.id));
  const byId = new Map<number, { cu: CuUser; member: boolean }>();

  for (const m of input.team.members) byId.set(m.user.id, { cu: m.user, member: true });

  const consider = (u: CuUser | null | undefined): void => {
    if (!u || u.id === undefined || u.id === null) return;
    if (byId.has(u.id)) return;
    byId.set(u.id, { cu: u, member: memberIds.has(u.id) });
  };
  for (const t of input.tasks) {
    consider(t.creator);
    for (const a of t.assignees) consider(a);
  }
  for (const list of Object.values(input.commentsByTask)) {
    for (const c of list) consider(c.user);
  }
  for (const list of Object.values(input.attachmentsByTask)) {
    for (const a of list) consider(a.user);
  }

  const users: User[] = [];
  const seenEmails = new Set<string>();
  for (const { cu, member } of byId.values()) {
    let email = userEmail(cu);
    if (seenEmails.has(email)) {
      // Two ClickUp accounts sharing an email would violate Flow's unique
      // email; disambiguate rather than drop the second one.
      opts.warnings?.add("duplicate user email", `${email} (clickup ${cu.id})`);
      email = `clickup-${cu.id}+${email}`;
    }
    seenEmails.add(email);
    users.push({
      id: opts.idMap.id("user", String(cu.id)),
      email,
      name: cu.id === CLICKBOT_ID ? "ClickBot (imported)" : userName(cu),
      role: resolveRole(email, roleOverrides),
      deactivated: !member,
      createdAt: opts.idMap.importedAt,
    });
  }
  return users.sort((a, b) => (a.email < b.email ? -1 : 1));
}

// --- statuses --------------------------------------------------------------

/**
 * ClickUp status types are open | custom | closed | done. Flow has no "done"
 * — both terminal kinds collapse to closed.
 */
export function mapStatusType(cuType: string): StatusType {
  const t = cuType.trim().toLowerCase();
  if (t === "open") return "open";
  if (isClosedStatusType(t)) return "closed";
  return "custom";
}

/**
 * Flow requires exactly one open status first and one closed status last, with
 * customs in between (entities.ts). ClickUp permits several of each, so extras
 * are demoted to custom: the FIRST open stays open, the LAST closed stays
 * closed, and missing ends are synthesized so the list satisfies min(2).
 */
export function buildStatuses(cuStatuses: CuStatus[], opts: TransformOptions, listLabel: string): Status[] {
  const ordered = [...cuStatuses].sort((a, b) => a.orderindex - b.orderindex);
  const mapped = ordered.map((s) => ({
    cu: s,
    type: mapStatusType(s.type),
  }));

  const firstOpen = mapped.findIndex((s) => s.type === "open");
  let lastClosed = -1;
  for (let i = mapped.length - 1; i >= 0; i--) {
    if (mapped[i]!.type === "closed") {
      lastClosed = i;
      break;
    }
  }

  const out: Status[] = [];
  mapped.forEach((s, i) => {
    let type: StatusType = s.type;
    if (type === "open" && i !== firstOpen) {
      opts.warnings?.add("extra open status demoted to custom", `${listLabel}/${s.cu.status}`);
      type = "custom";
    }
    if (type === "closed" && i !== lastClosed) {
      opts.warnings?.add("extra closed status demoted to custom", `${listLabel}/${s.cu.status}`);
      type = "custom";
    }
    out.push({
      // Key per-list: ClickUp reuses one status id across every list that
      // inherits a space's default set, and statuses in Flow belong to exactly
      // one list — a shared id would make lists race for the same row.
      id: opts.idMap.id("status", `${listLabel}:${s.cu.id}`),
      name: s.cu.status,
      color: s.cu.color,
      type,
      position: i,
    });
  });

  // Reorder so the open status leads and the closed status trails, then
  // renumber positions to match.
  const open = out.filter((s) => s.type === "open");
  const custom = out.filter((s) => s.type === "custom");
  const closed = out.filter((s) => s.type === "closed");

  if (open.length === 0) {
    opts.warnings?.add("list had no open status; synthesized", listLabel);
    open.push({
      id: opts.idMap.id("status", `synthetic-open:${listLabel}`),
      name: "To Do",
      color: "#87909e",
      type: "open",
      position: 0,
    });
  }
  if (closed.length === 0) {
    opts.warnings?.add("list had no closed status; synthesized", listLabel);
    closed.push({
      id: opts.idMap.id("status", `synthetic-closed:${listLabel}`),
      name: "Done",
      color: "#008844",
      type: "closed",
      position: 0,
    });
  }

  return [...open, ...custom, ...closed].map((s, i) => ({ ...s, position: i }));
}

// --- spaces & lists --------------------------------------------------------

export function buildSpaces(input: TransformInput, opts: TransformOptions): Space[] {
  return input.spaces.map((s, i) => ({
    id: opts.idMap.id("space", s.id),
    name: s.name,
    color: s.color ?? null,
    position: i,
    archived: s.archived === true,
    // ClickUp's own space privacy is not carried over: every imported space
    // lands workspace-visible, and an admin makes the ones that need it private
    // afterwards. Importing a space as private would hide it from everyone but
    // its (empty) member list the moment it loads.
    visibility: "workspace" as const,
    createdAt: opts.idMap.importedAt,
  }));
}

export type FolderInfo = {
  id: string;
  name: string;
  /** ClickUp wraps folderless lists in an implicit "hidden" folder. */
  hidden: boolean;
  archived: boolean;
  listCount: number;
};

export function folderIndex(foldersBySpace: Record<string, CuFolder[]>): Map<string, FolderInfo> {
  const idx = new Map<string, FolderInfo>();
  for (const folders of Object.values(foldersBySpace)) {
    for (const f of folders) {
      idx.set(f.id, {
        id: f.id,
        name: f.name,
        hidden: f.hidden === true,
        archived: f.archived === true,
        listCount: (f.lists ?? []).filter((l) => !l.archived).length,
      });
    }
  }
  return idx;
}

export type ListNaming =
  | { skip: true; reason: string }
  | { skip: false; name: string; folderPrefixed: boolean };

/**
 * Folders do not exist in Flow — a list carries the folder in its name. The
 * prefix is only added when the folder is a folder a human would recognize:
 *
 *  - hidden folder  -> no prefix. ClickUp invents one of these for every list
 *    that sits directly in a space — most tasks in a typical workspace live in
 *    one — always named "hidden". Prefixing would produce "hidden / Ongoing tasks".
 *  - archived folder -> skip the list entirely.
 *  - folder with no live lists -> nothing to name.
 */
export function listNaming(list: CuList, folder: FolderInfo | null | undefined): ListNaming {
  const own = list.name.trim();
  if (!folder) return { skip: false, name: own, folderPrefixed: false };
  if (folder.archived) return { skip: true, reason: `folder "${folder.name}" is archived` };
  if (folder.hidden) return { skip: false, name: own, folderPrefixed: false };
  if (folder.listCount === 0) return { skip: false, name: own, folderPrefixed: false };
  return { skip: false, name: `${folder.name.trim()} / ${own}`, folderPrefixed: true };
}

/** Resolves a list's folder from the folder index, tolerating hidden wrappers. */
function folderFor(list: CuList, folders: Map<string, FolderInfo>): FolderInfo | null {
  const ref = list.folder;
  if (!ref) return null;
  const known = folders.get(ref.id);
  if (known) return known;
  // Hidden wrappers are not returned by GET /space/{id}/folder, so they only
  // ever appear inline on the list — trust the inline flags.
  return {
    id: ref.id,
    name: ref.name,
    hidden: ref.hidden === true,
    archived: ref.archived === true,
    listCount: 1,
  };
}

export type BuiltLists = {
  lists: List[];
  /** clickup list id -> resolved statuses, for task status resolution. */
  statusesByList: Map<string, Status[]>;
  skipped: Map<string, string>;
};

export function buildLists(input: TransformInput, opts: TransformOptions): BuiltLists {
  const folders = folderIndex(input.foldersBySpace);
  const spaceIdx = new Map(input.spaces.map((s, i) => [s.id, i] as const));

  const lists: List[] = [];
  const statusesByList = new Map<string, Status[]>();
  const skipped = new Map<string, string>();

  for (const l of input.lists) {
    const naming = listNaming(l, folderFor(l, folders));
    if (naming.skip) {
      skipped.set(l.id, naming.reason);
      continue;
    }
    const spaceCuId = l.space?.id;
    if (!spaceCuId || !spaceIdx.has(spaceCuId)) {
      skipped.set(l.id, `list "${l.name}" has no known space`);
      opts.warnings?.add("list with unknown space skipped", `${l.id} ${l.name}`);
      continue;
    }
    const statuses = buildStatuses(l.statuses ?? [], opts, naming.name);
    statusesByList.set(l.id, statuses);
    lists.push({
      id: opts.idMap.id("list", l.id),
      spaceId: opts.idMap.id("space", spaceCuId),
      name: naming.name,
      position: l.orderindex ?? 0,
      archived: l.archived === true,
      statuses,
      // Inbound intake is opt-in per list post-import; never carried over.
      inboundToken: null,
      createdAt: opts.idMap.importedAt,
    });
  }
  return { lists, statusesByList, skipped };
}

// --- tasks -----------------------------------------------------------------

const PRIORITIES = new Set<string>(["urgent", "high", "normal", "low"]);

/** ClickUp priority names already match Flow's enum one-for-one. */
export function mapPriority(p: CuTask["priority"], opts?: TransformOptions): Priority | null {
  const name = p?.priority?.trim().toLowerCase();
  if (!name) return null;
  if (PRIORITIES.has(name)) return name as Priority;
  opts?.warnings?.add("unknown priority dropped", name);
  return null;
}

/** Single assignee by design: the first one wins, extras are logged. */
export function pickAssignee(
  assignees: CuUser[],
  opts: TransformOptions,
  taskId: string
): CuUser | null {
  if (assignees.length === 0) return null;
  if (assignees.length > 1) {
    opts.warnings?.add(
      "multi-assignee task truncated to first",
      `${taskId} kept ${assignees[0]?.username ?? assignees[0]?.id}, dropped ${assignees.length - 1}`
    );
  }
  return assignees[0] ?? null;
}

export const GOOGLE_DOC_FIELD = "Google Doc";

/**
 * Description body. markdown_description preserves headings, bold and links;
 * plain `description` is the same text with all formatting stripped, so it is
 * only a fallback. The "Google Doc" custom field has no home in Flow's schema,
 * so its URL is appended as a visible link line rather than lost.
 */
export function buildDescription(task: CuTask): string {
  const md = (task.markdown_description ?? "").trim();
  const plain = (task.description ?? task.text_content ?? "").trim();
  let body = md || plain;

  const doc = task.custom_fields.find(
    (f) => f.name.trim().toLowerCase() === GOOGLE_DOC_FIELD.toLowerCase()
  );
  const url = typeof doc?.value === "string" ? doc.value.trim() : "";
  if (url) {
    const line = `📄 [Google Doc](${url})`;
    if (!body.includes(url)) body = body ? `${body}\n\n${line}` : line;
  }
  return body;
}

/**
 * Resolve a task's status to one of its list's statuses. ClickUp can hand back
 * a status a list no longer defines (renamed or moved lists), so this falls
 * back by id, then by name, then by matching type, then to the list's open or
 * closed end.
 */
export function resolveStatusId(
  task: CuTask,
  statuses: Status[],
  opts: TransformOptions
): string {
  const byId = statuses.find((s) => s.id === opts.idMap.peek("status", task.status.id));
  if (byId) return byId.id;

  const wanted = task.status.status.trim().toLowerCase();
  const byName = statuses.find((s) => s.name.trim().toLowerCase() === wanted);
  if (byName) return byName.id;

  const wantType = mapStatusType(task.status.type);
  const byType = statuses.find((s) => s.type === wantType);
  opts.warnings?.add(
    "task status not in list status set",
    `${task.id} "${task.status.status}" -> ${byType?.name ?? "first status"}`
  );
  if (byType) return byType.id;
  // statuses always has >= 2 entries by construction.
  return statuses[0]!.id;
}

export type BuiltTasks = {
  tasks: Task[];
  subtasks: Subtask[];
  /** clickup task id -> flow task id, for comments/attachments/link rewrite. */
  taskIds: Map<string, string>;
};

export function buildTasks(
  input: TransformInput,
  opts: TransformOptions,
  built: BuiltLists
): BuiltTasks {
  const keep = selectInScope(input.tasks, opts.scope);
  const byCuId = new Map(input.tasks.map((t) => [t.id, t] as const));
  const userId = (u: CuUser | null | undefined): string | null =>
    u && u.id !== undefined && u.id !== null ? opts.idMap.id("user", String(u.id)) : null;

  // ASSERTION: ClickUp subtasks are themselves tasks, so nothing stops a
  // subtask from having its own subtask in principle. The workspace this was
  // built against is exactly one level deep (every subtask's parent is
  // top-level, parent always == top_level_parent). Flow's Subtask has no parent
  // pointer, so deeper nesting would be unrepresentable — fail loudly instead
  // of silently flattening.
  for (const t of input.tasks) {
    if (!t.parent) continue;
    const parent = byCuId.get(t.parent);
    if (parent?.parent) {
      throw new Error(
        `ClickUp subtask nesting deeper than one level: task ${t.id} -> ${parent.id} -> ${parent.parent}. ` +
          `Flow's Subtask cannot represent this; decide on a flattening rule before importing.`
      );
    }
    if (t.top_level_parent && t.top_level_parent !== t.parent) {
      opts.warnings?.add(
        "subtask top_level_parent != parent",
        `${t.id} parent=${t.parent} top=${t.top_level_parent}`
      );
    }
  }

  const tasks: Task[] = [];
  const taskIds = new Map<string, string>();

  for (const t of input.tasks) {
    if (t.parent) continue; // subtasks handled below
    if (!keep.has(t.id)) continue;
    const statuses = built.statusesByList.get(t.list.id);
    if (!statuses) {
      opts.warnings?.add(
        "task in skipped or unknown list dropped",
        `${t.id} list=${t.list.id} ${t.list.name ?? ""}`
      );
      continue;
    }
    const id = opts.idMap.id("task", t.id);
    taskIds.set(t.id, id);
    const createdAt = parseTs(t.date_created) ?? opts.idMap.importedAt;
    const assignee = pickAssignee(t.assignees, opts, t.id);
    tasks.push({
      id,
      listId: opts.idMap.id("list", t.list.id),
      title: t.name.trim() || "(untitled)",
      description: buildDescription(t),
      statusId: resolveStatusId(t, statuses, opts),
      assigneeId: userId(assignee),
      priority: mapPriority(t.priority, opts),
      dueDate: parseTs(t.due_date),
      startDate: parseTs(t.start_date),
      // ClickUp has no snooze, so everything arrives awake and un-annotated.
      snoozedUntil: null,
      blockedNote: null,
      tags: [...new Set(t.tags.map((g) => g.name.trim()).filter(Boolean))],
      position: Number.parseFloat(t.orderindex) || 0,
      createdBy: userId(t.creator) ?? userId(t.assignees[0]) ?? "us_unknown",
      createdAt,
      updatedAt: parseTs(t.date_updated) ?? createdAt,
      closedAt: isClosedStatusType(t.status.type)
        ? (parseTs(t.date_closed) ?? parseTs(t.date_done) ?? parseTs(t.date_updated))
        : null,
      clickupId: t.id,
    });
  }

  // Subtasks. Asana-style: a ClickUp subtask's whole status pipeline collapses
  // to a boolean, and it is done iff its own status type is closed/done.
  const subtasks: Subtask[] = [];
  const perParent = new Map<string, number>();
  for (const t of input.tasks) {
    if (!t.parent) continue;
    if (!keep.has(t.id)) continue;
    const parentFlowId = taskIds.get(t.parent);
    if (!parentFlowId) {
      opts.warnings?.add("subtask whose parent was dropped", `${t.id} parent=${t.parent}`);
      continue;
    }
    const n = perParent.get(t.parent) ?? 0;
    perParent.set(t.parent, n + 1);
    subtasks.push({
      id: opts.idMap.id("subtask", t.id),
      taskId: parentFlowId,
      title: t.name.trim() || "(untitled)",
      done: isClosedStatusType(t.status.type),
      assigneeId: userId(pickAssignee(t.assignees, opts, t.id)),
      dueDate: parseTs(t.due_date),
      position: n,
      createdAt: parseTs(t.date_created) ?? opts.idMap.importedAt,
    });
  }

  return { tasks, subtasks, taskIds };
}

// --- comments & attachments ------------------------------------------------

/**
 * ClickUp's `comment_text` is empty for attachment-only and reaction-only
 * comments (one such row in the verified sample). Flow's Comment.body is
 * min(1), so those are reassembled from the rich-text segments and, failing
 * that, skipped — an empty comment carries nothing anyway.
 */
export function commentBody(c: CuComment): string {
  const plain = (c.comment_text ?? "").trim();
  if (plain) return plain;
  return (c.comment ?? [])
    .map((seg) => seg.text ?? "")
    .join("")
    .trim();
}

export function buildComments(
  input: TransformInput,
  opts: TransformOptions,
  taskIds: Map<string, string>
): Comment[] {
  const out: Comment[] = [];
  for (const [cuTaskId, comments] of Object.entries(input.commentsByTask)) {
    const taskId = taskIds.get(cuTaskId);
    if (!taskId) continue;
    for (const c of comments) {
      const body = commentBody(c);
      if (!body) {
        opts.warnings?.add("empty comment skipped", `${cuTaskId}/${c.id}`);
        continue;
      }
      out.push({
        id: opts.idMap.id("comment", c.id),
        taskId,
        authorId: opts.idMap.id("user", String(c.user.id)),
        body,
        createdAt: parseTs(c.date) ?? opts.idMap.importedAt,
      });
    }
  }
  // Oldest first so the thread reads top-down after load.
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export function buildAttachments(
  input: TransformInput,
  opts: TransformOptions,
  taskIds: Map<string, string>
): AttachmentImport[] {
  const out: AttachmentImport[] = [];
  for (const [cuTaskId, atts] of Object.entries(input.attachmentsByTask)) {
    const taskId = taskIds.get(cuTaskId);
    if (!taskId) continue;
    for (const a of atts) {
      if (a.deleted || a.hidden) continue;
      out.push({
        clickupAttachmentId: a.id,
        clickupTaskId: cuTaskId,
        taskId,
        filename: a.title || a.id,
        mimeType: a.mimetype || "application/octet-stream",
        size: a.size ?? 0,
        sourceUrl: a.url,
        uploadedBy:
          a.user && a.user.id !== undefined && a.user.id !== null
            ? opts.idMap.id("user", String(a.user.id))
            : null,
        createdAt: parseTs(a.date) ?? opts.idMap.importedAt,
      });
    }
  }
  return out;
}

// --- link rewriting --------------------------------------------------------

// Both ClickUp task-link shapes seen in the wild:
//   https://app.clickup.com/t/9a1abcdef
//   https://app.clickup.com/t/9999999/9a1abcdef   (team-scoped)
// with an optional trailing path/query. Only the host+id portion is replaced,
// so bare URLs and markdown link targets are both handled by one pass.
const CLICKUP_LINK =
  /https?:\/\/app\.clickup\.com\/t\/(?:(\d+)\/)?([A-Za-z0-9_-]+)((?:\/[A-Za-z0-9._~-]*)*)(\?[^\s)\]]*)?/g;

export type LinkRewriteResult = { text: string; rewritten: number; unresolved: string[] };

/**
 * Second sweep: point old ClickUp deep links at the imported Flow task.
 * Unknown ids are left as-is — an out-of-scope or deleted task is still better
 * served by the original link than by a dead internal one.
 */
export function rewriteClickUpLinks(
  text: string,
  resolve: (clickupId: string) => string | null,
  taskUrlPrefix = "/t/"
): LinkRewriteResult {
  const unresolved: string[] = [];
  let rewritten = 0;
  const out = text.replace(CLICKUP_LINK, (match, _team: string | undefined, id: string) => {
    const flowId = resolve(id);
    if (!flowId) {
      unresolved.push(id);
      return match;
    }
    rewritten++;
    return `${taskUrlPrefix}${flowId}`;
  });
  return { text: out, rewritten, unresolved };
}

export type RewriteStats = { tasks: number; comments: number; links: number; unresolved: string[] };

/** Applies the link sweep in place across task descriptions and comment bodies. */
export function rewriteLinks(
  tasks: Task[],
  comments: Comment[],
  taskIds: Map<string, string>,
  taskUrlPrefix = "/t/"
): RewriteStats {
  const resolve = (cuId: string): string | null => taskIds.get(cuId) ?? null;
  const stats: RewriteStats = { tasks: 0, comments: 0, links: 0, unresolved: [] };

  for (const t of tasks) {
    if (!t.description.includes("app.clickup.com/t/")) continue;
    const r = rewriteClickUpLinks(t.description, resolve, taskUrlPrefix);
    if (r.rewritten > 0) {
      t.description = r.text;
      stats.tasks++;
      stats.links += r.rewritten;
    }
    stats.unresolved.push(...r.unresolved);
  }
  for (const c of comments) {
    if (!c.body.includes("app.clickup.com/t/")) continue;
    const r = rewriteClickUpLinks(c.body, resolve, taskUrlPrefix);
    if (r.rewritten > 0) {
      c.body = r.text;
      stats.comments++;
      stats.links += r.rewritten;
    }
    stats.unresolved.push(...r.unresolved);
  }
  stats.unresolved = [...new Set(stats.unresolved)];
  return stats;
}

// --- top level -------------------------------------------------------------

export type TransformResult = {
  bundle: FlowBundle;
  rewrite: RewriteStats;
  skippedLists: Map<string, string>;
  warnings: WarnTally;
};

export function transform(input: TransformInput, opts: TransformOptions): TransformResult {
  const warnings = opts.warnings ?? new WarnTally();
  const options: TransformOptions = { ...opts, warnings };

  const users = buildUsers(input, options);
  const spaces = buildSpaces(input, options);
  const builtLists = buildLists(input, options);
  const builtTasks = buildTasks(input, options, builtLists);
  const comments = buildComments(input, options, builtTasks.taskIds);
  const attachments = buildAttachments(input, options, builtTasks.taskIds);

  const rewrite = rewriteLinks(
    builtTasks.tasks,
    comments,
    builtTasks.taskIds,
    options.taskUrlPrefix ?? "/t/"
  );

  return {
    bundle: {
      users,
      spaces,
      lists: builtLists.lists,
      tasks: builtTasks.tasks,
      subtasks: builtTasks.subtasks,
      comments,
      attachments,
    },
    rewrite,
    skippedLists: builtLists.skipped,
    warnings,
  };
}
