// Raw ClickUp v2 API shapes, transcribed from live responses. Only the fields
// the importer reads are declared; everything else is dropped on extract. All
// ClickUp timestamps arrive as epoch-millisecond STRINGS, never numbers — see
// parseTs().

export type CuUser = {
  id: number; // ClickBot is -1
  username: string | null; // null for invited-but-never-active guests
  email: string | null;
  color?: string | null;
  initials?: string | null;
  profilePicture?: string | null;
};

export type CuMember = {
  user: CuUser & {
    // 1 = owner, 2 = admin, 3 = member, 4 = guest
    role?: number | null;
    role_key?: string | null;
    date_joined?: string | null;
    date_invited?: string | null;
    last_active?: string | null;
  };
};

export type CuTeam = {
  id: string;
  name: string;
  color?: string | null;
  members: CuMember[];
};

// ClickUp status "type" is one of open | custom | closed | done. This
// workspace only uses the first three, but "done" is part of the API
// vocabulary so the mapper handles it.
export type CuStatus = {
  id: string;
  status: string;
  orderindex: number;
  color: string;
  type: string;
  status_group?: string;
};

export type CuSpace = {
  id: string;
  name: string;
  color: string | null;
  private?: boolean;
  archived?: boolean;
  statuses?: CuStatus[];
};

export type CuListRef = {
  id: string;
  name?: string;
  access?: boolean;
};

export type CuList = {
  id: string;
  name: string;
  orderindex: number;
  archived: boolean;
  override_statuses?: boolean;
  task_count?: number | null;
  statuses?: CuStatus[];
  // Present on GET /list/{id}. `hidden: true` means the list sits directly in
  // the space and ClickUp wrapped it in an implicit folder — NOT a real folder.
  folder?: { id: string; name: string; hidden?: boolean; archived?: boolean };
  space?: { id: string; name?: string; archived?: boolean };
};

export type CuFolder = {
  id: string;
  name: string;
  orderindex: number;
  hidden?: boolean;
  archived: boolean;
  task_count?: string | number | null;
  space?: { id: string; name?: string };
  lists: CuList[];
};

export type CuTag = {
  name: string;
  tag_fg?: string;
  tag_bg?: string;
};

export type CuPriority = {
  id: string;
  priority: string; // urgent | high | normal | low
  color?: string;
  orderindex?: string;
};

export type CuCustomField = {
  id: string;
  name: string;
  type: string;
  value?: unknown;
  value_richtext?: unknown;
};

export type CuTask = {
  id: string;
  custom_id: string | null;
  custom_item_id: number | null;
  name: string;
  text_content: string | null;
  description: string | null;
  // Only returned when include_markdown_description=true is requested.
  markdown_description?: string | null;
  status: CuStatus;
  orderindex: string;
  date_created: string;
  date_updated: string;
  date_closed: string | null;
  date_done: string | null;
  archived: boolean;
  creator: CuUser;
  assignees: CuUser[];
  watchers?: CuUser[];
  tags: CuTag[];
  // Non-null on subtasks; equals top_level_parent in this workspace because
  // ClickUp subtask nesting here is exactly one level deep.
  parent: string | null;
  top_level_parent: string | null;
  priority: CuPriority | null;
  due_date: string | null;
  start_date: string | null;
  custom_fields: CuCustomField[];
  team_id?: string;
  url?: string;
  list: CuListRef;
  folder?: { id: string; name: string; hidden?: boolean; access?: boolean };
  space?: { id: string };
  // Only present on GET /task/{id}, never on the team task list.
  attachments?: CuAttachment[];
};

export type CuAttachment = {
  id: string;
  date: string;
  title: string;
  extension?: string | null;
  mimetype?: string | null;
  size?: number | null;
  hidden?: boolean;
  deleted?: boolean;
  url: string;
  url_w_query?: string;
  user?: CuUser | null;
};

export type CuCommentSegment = { text?: string };

export type CuComment = {
  id: string;
  // Plain-text rendering of the comment. Can be "" for attachment-only or
  // reaction-only comments — those carry no importable body.
  comment_text: string;
  comment?: CuCommentSegment[];
  user: CuUser;
  date: string;
  reply_count?: number;
};

// --- helpers ---------------------------------------------------------------

/** ClickUp sends epoch millis as strings. Returns null for absent/garbage. */
export function parseTs(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

export function isClosedStatusType(type: string): boolean {
  const t = type.toLowerCase();
  return t === "closed" || t === "done";
}
