// REST client. Every server call the web app makes goes through here, so the
// route contract with apps/api lives in exactly one place.
import type {
  Comment, List, Space, Subtask, Task, TaskDetail, User,
  CreateListInput, CreateSpaceInput, CreateTaskInput, UpdateTaskInput, MoveTaskInput,
  SearchTasksInput, SearchTasksResult,
  BoardSnapshot,
} from "@flow/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : "Network unreachable");
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const text = await res.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: string; message?: string };
          detail = parsed.error ?? parsed.message ?? text.slice(0, 200);
        } catch {
          detail = text.slice(0, 200);
        }
      }
    } catch {
      /* keep the status line */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // /api/me returns an envelope { user, via, apiKey } — unwrap to the User.
  me: () => request<{ user: User }>("GET", "/api/me").then((r) => r.user),
  snapshot: () => request<BoardSnapshot>("GET", "/api/snapshot"),

  createTask: (input: CreateTaskInput) => request<Task>("POST", "/api/tasks", input),
  updateTask: (input: UpdateTaskInput) =>
    request<Task>("PATCH", `/api/tasks/${encodeURIComponent(input.taskId)}`, input),
  moveTask: (input: MoveTaskInput) =>
    request<Task>("POST", `/api/tasks/${encodeURIComponent(input.taskId)}/move`, input),
  deleteTask: (taskId: string) =>
    request<void>("DELETE", `/api/tasks/${encodeURIComponent(taskId)}`),

  taskDetail: (taskId: string) =>
    request<TaskDetail>("GET", `/api/tasks/${encodeURIComponent(taskId)}`),

  createSubtask: (taskId: string, title: string, assigneeId?: string | null) =>
    request<Subtask>("POST", `/api/tasks/${encodeURIComponent(taskId)}/subtasks`, {
      taskId,
      title,
      assigneeId: assigneeId ?? null,
    }),
  toggleSubtask: (subtaskId: string, done: boolean) =>
    request<Subtask>("PATCH", `/api/subtasks/${encodeURIComponent(subtaskId)}`, {
      subtaskId,
      done,
    }),
  setSubtaskAssignee: (subtaskId: string, assigneeId: string | null) =>
    request<Subtask>("PATCH", `/api/subtasks/${encodeURIComponent(subtaskId)}`, {
      subtaskId,
      assigneeId,
    }),

  addComment: (taskId: string, body: string) =>
    request<Comment>("POST", `/api/tasks/${encodeURIComponent(taskId)}/comments`, {
      taskId,
      body,
    }),

  searchTasks: (input: SearchTasksInput) =>
    request<SearchTasksResult>("POST", "/api/tasks/search", input),

  // --- spaces & lists ------------------------------------------------------
  // POST returns the entity bare; PATCH /lists wraps it in an envelope that
  // also carries intake state, so unwrap here and keep the store on entities.
  createSpace: (input: CreateSpaceInput) => request<Space>("POST", "/api/spaces", input),
  updateSpace: (spaceId: string, patch: { name?: string; color?: string | null; archived?: boolean; position?: number }) =>
    request<Space>("PATCH", `/api/spaces/${encodeURIComponent(spaceId)}`, patch),

  createList: (input: CreateListInput) => request<List>("POST", "/api/lists", input),
  // The PATCH response strips inboundToken outright (it is a credential), so the
  // caller merges the answer onto the list it already holds.
  updateList: (listId: string, patch: { name?: string; archived?: boolean; position?: number; spaceId?: string }) =>
    request<{ list: Omit<List, "inboundToken"> }>(
      "PATCH",
      `/api/lists/${encodeURIComponent(listId)}`,
      patch
    ).then((r) => r.list),
};

// ---------------------------------------------------------------------------
// Settings surface (owner: the settings agent). Appended as its own object
// rather than folded into `api` above so this file can be extended from two
// places without collisions. Every shape mirrors what apps/api/src/routes
// actually returns; envelopes are unwrapped here so panels never see a
// wrapper key.
// ---------------------------------------------------------------------------

// Kept as its own import so the block above stays untouched by this addition.
import type { ApiKey, AutomationRule, AutomationRunLog, UpsertAutomationInput } from "@flow/shared";

/** Public origin. Inbound and MCP snippets get pasted into other systems, so
 *  they must name the deployed host — and since this SPA is served from that
 *  host, `location.origin` IS the deployed host. `VITE_APP_ORIGIN` is the
 *  override for unusual setups (e.g. the UI proxied behind a different host
 *  than the API), and the localhost fallback only exists for non-DOM tooling. */
export const APP_ORIGIN: string =
  import.meta.env.VITE_APP_ORIGIN ??
  (typeof location !== "undefined" ? location.origin : "http://localhost:8787");

/** `GET /api/api-keys` drops the hash and hands back a short fingerprint. */
export type ApiKeySummary = Omit<ApiKey, "tokenHash"> & { tokenFingerprint: string };

/** `POST /api/api-keys`. `token` exists in this response and nowhere else. */
export type CreatedApiKey = {
  apiKey: Omit<ApiKey, "tokenHash">;
  token: string;
  impersonates: { id: string; email: string; name: string };
  warning: string;
};

/** Both run-log routes page newest-first with a keyset cursor. */
export type RunsPage = { runs: AutomationRunLog[]; cursor: number | null };
export type RuleRunsPage = RunsPage & { ruleId: string; ruleName: string };

/** `GET /api/lists/:id` — `inboundToken` comes back only for owner/admin. */
export type ListDetail = {
  list: Omit<List, "inboundToken"> & { inboundToken?: string | null };
  inboundEnabled: boolean;
  tasks: Task[];
};

/** `PATCH /api/lists/:id`. The token/url pair appears only on a rotation. */
export type ListPatchResult = {
  list: Omit<List, "inboundToken">;
  inboundEnabled: boolean;
  inboundToken?: string;
  inboundUrl?: string;
  warning?: string;
};

/** The inbound route accepts the token as a query param, which makes the whole
 *  webhook configuration a single pasteable URL. */
export function inboundUrl(listId: string, token: string, base = APP_ORIGIN): string {
  return `${base}/api/inbound/${encodeURIComponent(listId)}?token=${encodeURIComponent(token)}`;
}

export const settingsApi = {
  // --- automations ---------------------------------------------------------
  automationRuns: (limit = 20) =>
    request<RunsPage>("GET", `/api/automation-runs?limit=${limit}`),

  ruleRuns: (ruleId: string, limit = 10) =>
    request<RuleRunsPage>(
      "GET",
      `/api/automations/${encodeURIComponent(ruleId)}/runs?limit=${limit}`
    ),

  /**
   * The automation route is an upsert against UpsertAutomationInput, not a
   * partial patch — a body carrying only `enabled` fails validation. So the
   * whole rule goes back with the one field flipped.
   */
  setAutomationEnabled: (rule: AutomationRule, enabled: boolean) => {
    const body: UpsertAutomationInput = {
      name: rule.name,
      enabled,
      scope: rule.scope,
      trigger: rule.trigger,
      conditions: rule.conditions,
      actions: rule.actions,
    };
    return request<AutomationRule>(
      "PATCH",
      `/api/automations/${encodeURIComponent(rule.id)}`,
      body
    );
  },

  // --- api keys (owner/admin only) -----------------------------------------
  apiKeys: () =>
    request<{ apiKeys: ApiKeySummary[] }>("GET", "/api/api-keys").then((r) => r.apiKeys),

  createApiKey: (name: string, userId?: string) =>
    request<CreatedApiKey>("POST", "/api/api-keys", {
      name,
      ...(userId ? { userId } : {}),
    }),

  revokeApiKey: (apiKeyId: string) =>
    request<{ ok: boolean; revoked: string }>(
      "DELETE",
      `/api/api-keys/${encodeURIComponent(apiKeyId)}`
    ),

  // --- inbound intake ------------------------------------------------------
  listDetail: (listId: string) =>
    request<ListDetail>("GET", `/api/lists/${encodeURIComponent(listId)}`),

  /** `"rotate"` mints a fresh token and returns it once; `null` disables. */
  setListInbound: (listId: string, mode: "rotate" | null) =>
    request<ListPatchResult>("PATCH", `/api/lists/${encodeURIComponent(listId)}`, {
      inboundToken: mode,
    }),
};
