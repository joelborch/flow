/**
 * End-to-end over the JSON-RPC wire, with the DO stubbed.
 *
 * This is what catches the failures unit tests on the schemas cannot: a tool
 * whose Zod shape will not convert to JSON Schema, a name that drifts from
 * `MCP_TOOLS`, a transport handshake the SDK rejects, and an error that reaches
 * the caller as a stack instead of the DO's own sentence.
 */
import { describe, expect, it, vi, type Mock } from "vitest";
import { MCP_TOOLS } from "@flow/shared";
import type { AuthContext, Env } from "../env.js";
import { mcpHandler } from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const workspaceMap = {
  seq: 7,
  spaces: [
    {
      id: "sp_eng",
      name: "Engineering",
      color: null,
      position: 1,
      archived: false,
      createdAt: 0,
      lists: [
        {
          id: "ls_bugs",
          name: "Bugs",
          archived: false,
          openTasks: 1,
          statuses: [
            { id: "st_todo", name: "Triage", color: "#888", type: "open", position: 1 },
            { id: "st_done", name: "Shipped", color: "#0a0", type: "closed", position: 2 },
          ],
        },
        {
          id: "ls_old",
          name: "Retired",
          archived: true,
          openTasks: 0,
          statuses: [
            { id: "st_a", name: "Open", color: "#888", type: "open", position: 1 },
            { id: "st_b", name: "Closed", color: "#0a0", type: "closed", position: 2 },
          ],
        },
      ],
    },
  ],
  users: [
    {
      id: "us_alice",
      email: "alice@example.com",
      name: "Alice",
      role: "owner",
      deactivated: false,
      createdAt: 0,
    },
  ],
};

const taskRow = {
  id: "tk_1",
  listId: "ls_bugs",
  title: "Checkout fails on Safari",
  statusId: "st_todo",
  assigneeId: "us_alice",
  priority: "urgent",
  dueDate: 1_780_000_000_000,
  tags: ["bug", "safari"],
  position: 1,
  updatedAt: 1_780_000_000_000,
};

/** Every RPC the tools under test reach for, mockable one at a time. */
type RpcMock = Mock<(...args: never[]) => unknown>;

function fakeWorkspace(overrides: Record<string, RpcMock> = {}) {
  const base = {
    getWorkspaceMap: vi.fn(async () => workspaceMap),
    getSnapshot: vi.fn(async () => ({ ...workspaceMap, tasks: [taskRow], subtasks: [] })),
    searchTasks: vi.fn(async (_input: unknown, _actor: unknown) => ({
      tasks: [taskRow],
      cursor: null,
      total: 1,
    })),
    createTask: vi.fn(async (_input: unknown, _actor: unknown) => ({
      ...taskRow,
      description: "",
      startDate: null,
    })),
    getTaskDetail: vi.fn(async (_taskId: string): Promise<unknown> => null),
    upsertAutomation: vi.fn(async (_input: unknown, _actor: unknown): Promise<unknown> => {
      throw new Error("upsertAutomation is not stubbed in this test");
    }),
  };
  return Object.assign(base, overrides);
}

function fakeEnv(stub: unknown): Env {
  return {
    WORKSPACE: { idFromName: () => "id", get: () => stub },
  } as unknown as Env;
}

const auth: AuthContext = {
  user: {
    id: "us_alice",
    email: "alice@example.com",
    name: "Alice",
    role: "owner",
    deactivated: false,
    createdAt: 0,
  },
  apiKey: {
    id: "ak_1",
    userId: "us_alice",
    name: "claude-mcp",
    tokenHash: "x",
    createdAt: 0,
    lastUsedAt: null,
    revokedAt: null,
  },
  actor: { userId: "us_alice", via: "api", apiKeyId: "ak_1", automationRuleId: null },
};

const memberAuth: AuthContext = {
  ...auth,
  user: { ...auth.user, id: "us_sam", role: "member", email: "sam@example.com" },
};

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

type RpcBody = { result?: Record<string, unknown>; error?: { message: string } };

async function rpc(
  stub: unknown,
  method: string,
  params?: unknown,
  identity: AuthContext | undefined = auth
): Promise<{ status: number; body: RpcBody }> {
  const req = new Request("https://flow.example.com/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const res = await mcpHandler(req, fakeEnv(stub), identity);
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as RpcBody) };
}

/**
 * Tool results carry the same document twice: `structuredContent` for clients
 * that read the declared `outputSchema`, and a serialized text block for those
 * that do not. Asserting they agree here means every other test in this file
 * covers both at once.
 */
function toolPayload(body: RpcBody): Record<string, unknown> {
  const content = body.result?.["content"] as Array<{ type: string; text: string }>;
  const text = JSON.parse(content[0]!.text) as Record<string, unknown>;
  expect(body.result?.["structuredContent"]).toEqual(text);
  return text;
}

function toolError(body: RpcBody): string {
  expect(body.result?.["isError"]).toBe(true);
  const content = body.result?.["content"] as Array<{ type: string; text: string }>;
  return content[0]!.text;
}

async function callTool(stub: unknown, name: string, args: unknown, identity = auth) {
  return rpc(stub, "tools/call", { name, arguments: args }, identity);
}

// ---------------------------------------------------------------------------

describe("mcpHandler transport", () => {
  it("refuses a request with no resolved identity", async () => {
    const res = await mcpHandler(
      new Request("https://flow.example.com/mcp", { method: "POST" }),
      fakeEnv(fakeWorkspace())
    );
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("Bearer flow_") },
    });
  });

  it("refuses GET and DELETE, since a stateless server has no SSE stream or session", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await mcpHandler(
        new Request("https://flow.example.com/mcp", { method }),
        fakeEnv(fakeWorkspace()),
        auth
      );
      expect(res.status).toBe(405);
    }
  });

  it("completes the initialize handshake without issuing a session id", async () => {
    const { status, body } = await rpc(fakeWorkspace(), "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0" },
    });
    expect(status).toBe(200);
    expect(body.result).toMatchObject({ serverInfo: { name: "flow" } });
    expect(body.result?.["instructions"]).toContain("flow_get_workspace_map");
  });

  it("front-loads the two rules that matter into the first 512 characters", async () => {
    const { body } = await rpc(fakeWorkspace(), "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0" },
    });
    // Clients truncate instructions. Whatever else gets cut, an agent that reads
    // only the opening must still know to call the map first and to send names.
    const head = (body.result?.["instructions"] as string).slice(0, 512);
    expect(head).toContain("Call flow_get_workspace_map first");
    expect(head).toMatch(/status NAMES/);
    expect(head).toContain("never status ids");
  });

  it("tells the agent what the server will not do", async () => {
    const { body } = await rpc(fakeWorkspace(), "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0" },
    });
    const text = body.result?.["instructions"] as string;
    expect(text).toContain("Nothing here deletes");
    expect(text).toContain("closed status BY NAME");
    expect(text).toContain("carry no status of their own");
    expect(text).toContain("flow_bulk_create_tasks");
    expect(text).toContain("Automations evaluate inline");
    // The paging convention is stated centrally, exactly once.
    expect(text.match(/takes a cursor and returns a cursor/g)).toHaveLength(1);
  });
});

describe("tools/list", () => {
  it("exposes exactly the tools named in the contract", async () => {
    const { body } = await rpc(fakeWorkspace(), "tools/list");
    const tools = body.result?.["tools"] as Array<{ name: string; description: string }>;
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOLS].sort());
  });

  it("gives every tool a description and a converted JSON Schema", async () => {
    const { body } = await rpc(fakeWorkspace(), "tools/list");
    const tools = body.result?.["tools"] as Array<{
      name: string;
      description: string;
      inputSchema: { type: string };
    }>;
    for (const tool of tools) {
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      expect(tool.inputSchema.type, tool.name).toBe("object");
    }
  });

  it("annotates every tool explicitly — a missing hint reads as unknown, not as false", async () => {
    const { body } = await rpc(fakeWorkspace(), "tools/list");
    const tools = body.result?.["tools"] as Array<{
      name: string;
      annotations?: Record<string, boolean>;
    }>;

    const READS = [
      "flow_get_workspace_map",
      "flow_search_tasks",
      "flow_get_task",
      "flow_list_my_work",
      "flow_list_automations",
      "flow_get_audit_log",
    ];
    const IDEMPOTENT = [
      "flow_update_task",
      "flow_move_task",
      "flow_toggle_subtask",
      "flow_upsert_automation",
    ];

    expect(tools).toHaveLength(MCP_TOOLS.length);
    for (const tool of tools) {
      const a = tool.annotations;
      expect(a, tool.name).toBeDefined();
      // Every tool talks to this one workspace DO and nothing else.
      expect(a!["openWorldHint"], tool.name).toBe(false);
      expect(a!["readOnlyHint"], tool.name).toBe(READS.includes(tool.name));
      if (READS.includes(tool.name)) {
        expect(a, tool.name).not.toHaveProperty("destructiveHint");
        continue;
      }
      // Only the upsert replaces something that already existed.
      expect(a!["destructiveHint"], tool.name).toBe(tool.name === "flow_upsert_automation");
      expect(a!["idempotentHint"], tool.name).toBe(
        IDEMPOTENT.includes(tool.name) ? true : undefined
      );
    }
  });

  it("declares an object outputSchema on every tool, so results are structured", async () => {
    const { body } = await rpc(fakeWorkspace(), "tools/list");
    const tools = body.result?.["tools"] as Array<{
      name: string;
      outputSchema?: { type: string; properties?: Record<string, unknown> };
    }>;
    for (const tool of tools) {
      expect(tool.outputSchema?.type, tool.name).toBe("object");
      expect(Object.keys(tool.outputSchema?.properties ?? {}).length, tool.name).toBeGreaterThan(0);
    }
  });

  it("says statuses are names, not ids, on every tool that takes one", async () => {
    const { body } = await rpc(fakeWorkspace(), "tools/list");
    const tools = body.result?.["tools"] as Array<{ name: string; description: string }>;
    const takesStatus = [
      "flow_create_task",
      "flow_update_task",
      "flow_move_task",
      "flow_search_tasks",
      "flow_bulk_create_tasks",
      "flow_bulk_update_tasks",
      "flow_upsert_automation",
    ];
    for (const name of takesStatus) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.description, name).toMatch(/NAME/);
    }
  });
});

describe("flow_get_workspace_map", () => {
  it("returns the hierarchy with status names, members and tags in use", async () => {
    const { body } = await callTool(fakeWorkspace(), "flow_get_workspace_map", {
      includeTags: true,
    });
    const payload = toolPayload(body) as {
      spaces: Array<{ lists: Array<{ name: string; statuses: Array<{ name: string }> }> }>;
      users: Array<{ name: string }>;
      tags: string[];
    };
    expect(payload.spaces[0]!.lists.map((l) => l.name)).toEqual(["Bugs"]); // archived dropped
    expect(payload.spaces[0]!.lists[0]!.statuses.map((s) => s.name)).toEqual(["Triage", "Shipped"]);
    expect(payload.users.map((u) => u.name)).toEqual(["Alice"]);
    expect(payload.tags).toEqual(["bug", "safari"]);
  });

  it("never leaks a list's inbound token", async () => {
    const stub = fakeWorkspace();
    const { body } = await callTool(stub, "flow_get_workspace_map", {});
    const content = body.result?.["content"] as Array<{ text: string }>;
    expect(content[0]!.text).not.toContain("inboundToken");
  });

  it("skips the task scan by default, since the tag scan is the expensive part", async () => {
    const stub = fakeWorkspace();
    const { body } = await callTool(stub, "flow_get_workspace_map", {});
    expect(stub.getSnapshot).not.toHaveBeenCalled();
    expect(toolPayload(body)).not.toHaveProperty("tags");
  });

  it("includes archived lists on request", async () => {
    const { body } = await callTool(fakeWorkspace(), "flow_get_workspace_map", {
      includeArchived: true,
    });
    const payload = toolPayload(body) as { spaces: Array<{ lists: Array<{ name: string }> }> };
    expect(payload.spaces[0]!.lists.map((l) => l.name)).toEqual(["Bugs", "Retired"]);
  });

  it("keeps concise to ids, names and status names; detailed adds counts and member records", async () => {
    type Map = {
      spaces: Array<{ lists: Array<Record<string, unknown>> }>;
      users: Array<Record<string, unknown>>;
    };

    const concise = toolPayload(
      (await callTool(fakeWorkspace(), "flow_get_workspace_map", {})).body
    ) as Map;
    expect(concise.spaces[0]!.lists[0]).not.toHaveProperty("openTasks");
    expect(concise.users[0]).toEqual({ id: "us_alice", name: "Alice" });
    // The values other tools take as arguments survive the budget.
    expect(concise.spaces[0]!.lists[0]).toMatchObject({ id: "ls_bugs", name: "Bugs" });

    const detailed = toolPayload(
      (await callTool(fakeWorkspace(), "flow_get_workspace_map", { format: "detailed" })).body
    ) as Map;
    expect(detailed.spaces[0]!.lists[0]).toMatchObject({ openTasks: 1 });
    expect(detailed.users[0]).toMatchObject({ email: "alice@example.com", role: "owner" });
  });
});

describe("flow_search_tasks", () => {
  it("resolves ids to names in every row", async () => {
    const { body } = await callTool(fakeWorkspace(), "flow_search_tasks", { query: "safari" });
    expect(toolPayload(body)).toMatchObject({
      total: 1,
      cursor: null,
      tasks: [{ id: "tk_1", status: "Triage", list: "Bugs", assignee: "Alice" }],
    });
  });

  it("rejects a status passed as a bare string rather than an array", async () => {
    const { body } = await callTool(fakeWorkspace(), "flow_search_tasks", { status: "Triage" });
    expect(body.result?.["isError"] ?? body.error).toBeTruthy();
  });

  it("returns the concise row by default and the full one on request", async () => {
    const concise = toolPayload(
      (await callTool(fakeWorkspace(), "flow_search_tasks", {})).body
    ) as { tasks: Array<Record<string, unknown>> };
    expect(Object.keys(concise.tasks[0]!).sort()).toEqual([
      "assignee",
      "dueDate",
      "id",
      "list",
      "priority",
      "status",
      "title",
    ]);

    const detailed = toolPayload(
      (await callTool(fakeWorkspace(), "flow_search_tasks", { format: "detailed" })).body
    ) as { tasks: Array<Record<string, unknown>> };
    expect(detailed.tasks[0]).toMatchObject({
      listId: "ls_bugs",
      space: "Engineering",
      assigneeId: "us_alice",
      tags: ["bug", "safari"],
    });
  });

  it("does not pass format through to the DO as a search filter", async () => {
    const stub = fakeWorkspace();
    await callTool(stub, "flow_search_tasks", { format: "detailed" });
    expect(stub.searchTasks.mock.calls[0]![0]).not.toHaveProperty("format");
  });
});

describe("flow_list_my_work", () => {
  it("defaults to the calling user and groups by due bucket", async () => {
    const stub = fakeWorkspace();
    const { body } = await callTool(stub, "flow_list_my_work", {});
    expect(stub.searchTasks.mock.calls[0]![0]).toMatchObject({ assigneeId: "us_alice" });
    const payload = toolPayload(body) as {
      assignee: { id: string; name: string };
      counts: Record<string, number>;
      buckets: Record<string, unknown[]>;
    };
    expect(payload.assignee).toEqual({ id: "us_alice", name: "Alice" });
    expect(Object.keys(payload.buckets)).toEqual([
      "overdue",
      "today",
      "thisWeek",
      "later",
      "noDate",
    ]);
    // The fixture's due date is in the past relative to any real clock.
    expect(payload.counts["overdue"]).toBe(1);
  });

  it("can look at someone else's plate", async () => {
    const stub = fakeWorkspace();
    await callTool(stub, "flow_list_my_work", { assigneeId: "us_sam" });
    expect(stub.searchTasks.mock.calls[0]![0]).toMatchObject({ assigneeId: "us_sam" });
  });

  it("asks for one page of 50 rather than the whole plate", async () => {
    const stub = fakeWorkspace();
    await callTool(stub, "flow_list_my_work", {});
    expect(stub.searchTasks.mock.calls[0]![0]).toMatchObject({ limit: 50 });
  });

  it("round-trips a cursor: what comes out goes straight back in", async () => {
    const stub = fakeWorkspace({
      searchTasks: vi
        .fn()
        .mockResolvedValueOnce({ tasks: [taskRow], cursor: "tk_1|1780000000000", total: 2 })
        .mockResolvedValueOnce({ tasks: [taskRow], cursor: null, total: 2 }),
    });

    const first = toolPayload((await callTool(stub, "flow_list_my_work", {})).body) as {
      cursor: string | null;
    };
    expect(first.cursor).toBe("tk_1|1780000000000");
    expect(stub.searchTasks.mock.calls[0]![0]).not.toHaveProperty("cursor");

    const second = toolPayload(
      (await callTool(stub, "flow_list_my_work", { cursor: first.cursor })).body
    ) as { cursor: string | null };
    expect(stub.searchTasks.mock.calls[1]![0]).toMatchObject({ cursor: "tk_1|1780000000000" });
    // Null is how the convention says "that was the last page".
    expect(second.cursor).toBeNull();
  });

  it("buckets concise rows by default and full rows on request", async () => {
    const concise = toolPayload((await callTool(fakeWorkspace(), "flow_list_my_work", {})).body) as {
      buckets: Record<string, Array<Record<string, unknown>>>;
    };
    expect(concise.buckets["overdue"]![0]).not.toHaveProperty("tags");

    const detailed = toolPayload(
      (await callTool(fakeWorkspace(), "flow_list_my_work", { format: "detailed" })).body
    ) as { buckets: Record<string, Array<Record<string, unknown>>> };
    expect(detailed.buckets["overdue"]![0]).toHaveProperty("tags");
  });
});

describe("flow_get_task", () => {
  const detail = (commentCount: number) => ({
    task: { ...taskRow, description: "long", startDate: null, closedAt: null },
    subtasks: [],
    attachments: [],
    comments: Array.from({ length: commentCount }, (_, i) => ({
      id: `cm_${i}`,
      taskId: "tk_1",
      authorId: "us_alice",
      body: `comment ${i}`,
      createdAt: i,
    })),
  });

  it("keeps only the 15 newest comments in concise, and says how many it dropped", async () => {
    const stub = fakeWorkspace({ getTaskDetail: vi.fn(async () => detail(40)) });
    const payload = toolPayload((await callTool(stub, "flow_get_task", { taskId: "tk_1" })).body) as {
      comments: Array<{ body: string }>;
      commentsOmitted: number;
      note: string;
    };
    expect(payload.comments).toHaveLength(15);
    expect(payload.comments[0]!.body).toBe("comment 25"); // newest 15, oldest first
    expect(payload.commentsOmitted).toBe(25);
    expect(payload.note).toContain("detailed");
  });

  it("returns the whole thread and no note in detailed", async () => {
    const stub = fakeWorkspace({ getTaskDetail: vi.fn(async () => detail(40)) });
    const payload = toolPayload(
      (await callTool(stub, "flow_get_task", { taskId: "tk_1", format: "detailed" })).body
    ) as { comments: unknown[]; commentsOmitted: number };
    expect(payload.comments).toHaveLength(40);
    expect(payload.commentsOmitted).toBe(0);
  });

  it("adds no note when the thread fits the budget", async () => {
    const stub = fakeWorkspace({ getTaskDetail: vi.fn(async () => detail(3)) });
    const payload = toolPayload((await callTool(stub, "flow_get_task", { taskId: "tk_1" })).body);
    expect(payload["commentsOmitted"]).toBe(0);
    expect(payload).not.toHaveProperty("note");
  });
});

describe("flow_get_audit_log", () => {
  const entry = {
    id: 41823,
    at: 1_780_000_000_000,
    action: "task.update",
    entity: "tk_1",
    actor: { userId: "us_alice", via: "mcp", apiKeyId: "ak_1", automationRuleId: null },
    diff: { title: "x" },
  };

  it("pages on cursor and still honours the legacy before", async () => {
    const getAuditLog = vi.fn(async (_filter: unknown) => ({
      entries: [entry],
      nextBefore: 41823,
    }));
    const stub = fakeWorkspace({ getAuditLog: getAuditLog as unknown as RpcMock });

    // A cursor comes back only when the page came back full, so ask for one row.
    const first = toolPayload((await callTool(stub, "flow_get_audit_log", { limit: 1 })).body) as {
      cursor: number | null;
    };
    expect(first.cursor).toBe(41823);

    await callTool(stub, "flow_get_audit_log", { cursor: first.cursor, limit: 1 });
    expect(getAuditLog.mock.calls[1]![0]).toMatchObject({ before: 41823 });

    await callTool(stub, "flow_get_audit_log", { before: 999 });
    expect(getAuditLog.mock.calls[2]![0]).toMatchObject({ before: 999 });
  });
});

describe("mutations", () => {
  it("records the caller as the actor, with via: mcp regardless of credential", async () => {
    const stub = fakeWorkspace();
    await callTool(stub, "flow_create_task", { listId: "ls_bugs", title: "New" });
    expect(stub.createTask.mock.calls[0]![1]).toEqual({
      userId: "us_alice",
      via: "mcp",
      apiKeyId: "ak_1",
      automationRuleId: null,
    });
  });

  it("reports per-item outcomes on a bulk create instead of failing the batch", async () => {
    const stub = fakeWorkspace({
      createTask: vi
        .fn()
        .mockResolvedValueOnce(taskRow)
        .mockRejectedValueOnce(new Error("unknown status 'Blocked' for list ls_bugs")),
    });
    const { body } = await callTool(stub, "flow_bulk_create_tasks", {
      tasks: [
        { listId: "ls_bugs", title: "ok" },
        { listId: "ls_bugs", title: "bad", status: "Blocked" },
      ],
    });
    expect(toolPayload(body)).toMatchObject({
      created: 1,
      failed: 1,
      results: [
        { taskId: "tk_1", ok: true, error: null },
        { taskId: null, ok: false, error: "unknown status 'Blocked' for list ls_bugs" },
      ],
    });
  });

  it("keeps automation writes to owners and admins", async () => {
    const rule = {
      name: "Tag on triage",
      scope: { kind: "list", listId: "ls_bugs" },
      trigger: { kind: "task_created" },
      actions: [{ kind: "add_tags", tags: ["new"] }],
    };
    // A whole `AutomationRule`, because the declared outputSchema is the
    // contract's own and the SDK validates what we hand back against it.
    const stored = { id: "ar_1", enabled: false, conditions: [], createdAt: 0, updatedAt: 0, ...rule };
    const stub = fakeWorkspace({ upsertAutomation: vi.fn(async () => stored) });

    const denied = await callTool(stub, "flow_upsert_automation", rule, memberAuth);
    expect(toolError(denied.body)).toContain("owner or admin");
    expect(stub.upsertAutomation).not.toHaveBeenCalled();

    const allowed = await callTool(stub, "flow_upsert_automation", rule);
    expect(toolPayload(allowed.body)).toMatchObject({ automation: { id: "ar_1" } });
  });
});

describe("errors", () => {
  it("passes the DO's descriptive message through as a tool error, with no stack", async () => {
    const message = "unknown status 'Blocked' for list ls_bugs; valid statuses are Triage, Shipped";
    const stub = fakeWorkspace({
      createTask: vi.fn(() => {
        throw new Error(message);
      }),
    });
    const { body } = await callTool(stub, "flow_create_task", {
      listId: "ls_bugs",
      title: "x",
      status: "Blocked",
    });
    const text = toolError(body);
    expect(text).toBe(message);
    expect(text).not.toContain("at ");
  });

  it("reports a missing task as a tool error rather than an empty result", async () => {
    const stub = fakeWorkspace({ getTaskDetail: vi.fn(async () => null) });
    const { body } = await callTool(stub, "flow_get_task", { taskId: "tk_nope" });
    expect(toolError(body)).toBe("no task tk_nope");
  });

  it("reports an invalid argument without reaching the DO", async () => {
    const stub = fakeWorkspace();
    const { body } = await callTool(stub, "flow_create_task", { listId: "ls_bugs" });
    expect(body.result?.["isError"] ?? body.error).toBeTruthy();
    expect(stub.createTask).not.toHaveBeenCalled();
  });
});
