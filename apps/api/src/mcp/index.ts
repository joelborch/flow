/// <reference types="@cloudflare/workers-types" />
/**
 * Streamable-HTTP MCP endpoint, mounted at `/mcp` (and `/mcp/*`) by src/index.ts.
 *
 * Shape of the thing:
 *
 *  - A **new `McpServer` and a new transport per request.** The MCP SDK requires
 *    this from 1.26 onward: a stateless transport reused across requests
 *    cross-wires JSON-RPC ids between clients, and here it would also mean one
 *    caller's tools closing over another caller's identity. Construction is a
 *    handful of object allocations, so per-request costs nothing worth saving.
 *  - **Stateless.** No session id, no event store, so there is no MCP state to
 *    keep anywhere — which is what lets any isolate serve any request without a
 *    Durable Object of its own. `Mcp-Session-Id` is neither issued nor checked.
 *  - **Auth is already done.** `authMiddleware` runs before this handler and
 *    resolves the `flow_` bearer (or Access JWT) to a workspace user; the
 *    resolved `AuthContext` arrives as the third argument and every tool acts as
 *    that user, with the api key id in the audit trail.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type {
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import type { AuthContext, Env } from "../env.js";
import { ToolContext } from "./context.js";
import { registerFlowTools } from "./tools.js";

const SERVER_NAME = "flow";
const SERVER_VERSION = "0.1.0";

/**
 * Read by the client before it has called anything, and often truncated — some
 * clients keep only the first few hundred characters. So the first paragraph
 * block is written to stand alone: within the opening 512 characters an agent
 * has been told to call the map tool first and that statuses are names. The
 * budget is asserted in server.test.ts so an edit cannot quietly break it.
 */
const INSTRUCTIONS = `Flow is this team's task manager: spaces hold lists, lists hold tasks, and each list defines its own ordered statuses.

Call flow_get_workspace_map first — it returns every list id, the valid status NAMES per list, and the members you can assign.

Statuses are always human-readable NAMES ("In Progress"), never status ids, matched case-insensitively within the task's own list. Timestamps are epoch milliseconds.

Paging and budgets, once for every tool: anything pageable takes a cursor and returns a cursor, null when there is nothing left — pass the value straight back to get the next page. Reads take format: "concise" (the default, trimmed rows) or "detailed" (every field), and say in their description what concise leaves out.

What this server will not do:
- Nothing here deletes. There is no delete tool for tasks, subtasks, comments or automation rules; if something must go, a person removes it in the UI.
- Closing a task means moving it to its list's closed status BY NAME, with flow_update_task or flow_move_task. There is no done flag on a task.
- Subtasks are done/not-done checklist steps and carry no status of their own, so never send one for a subtask.
- Prefer flow_bulk_create_tasks and flow_bulk_update_tasks over looping the single-task tools: a loop is slower and throws away the per-item ok/error reporting the bulk tools give you.
- Automations evaluate inline inside every mutation, exactly as they do for the web app, so do not hand-apply what a rule already does — make the change, then re-read the task to see where the rules left it. flow_list_automations shows what is wired up.

Errors come back as a plain sentence naming the problem and the valid values; read it and fix the call rather than retrying it unchanged.`;

/**
 * The SDK builds an Ajv validator by default, purely to check user input coming
 * back from `elicitation/create`. This server never elicits, and Ajv compiles
 * schemas with `new Function`, which Workers forbids — so supply a validator
 * that cannot silently pass anything instead of shipping that landmine.
 */
const elicitationUnsupported: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return () => ({
      valid: false,
      data: undefined,
      errorMessage: "the Flow MCP server does not use elicitation",
    });
  },
};

function jsonRpcError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * `req` and `env` are the original signature; `auth` is what src/index.ts hands
 * over from `c.get("auth")`. It stays optional so the handler is still callable
 * as `mcpHandler(req, env)` — that path just refuses the request, because a tool
 * with no identity has no user to act as and nothing to write to the audit trail.
 */
export async function mcpHandler(
  req: Request,
  env: Env,
  auth?: AuthContext
): Promise<Response> {
  if (!auth) {
    return jsonRpcError(
      401,
      "unauthenticated: send Authorization: Bearer flow_<token> to https://<host>/mcp"
    );
  }

  // POST carries every JSON-RPC message. A GET would open the spec's optional
  // standalone SSE stream for server-initiated messages, which a stateless
  // server has none of and which would sit open until the Worker's request
  // timeout; DELETE only terminates a session, and there are none.
  if (req.method !== "POST") {
    return jsonRpcError(
      405,
      `${req.method} is not supported: this MCP endpoint is stateless streamable HTTP, so POST your JSON-RPC messages to /mcp (no SSE stream, no session id)`
    );
  }

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: INSTRUCTIONS,
      capabilities: { tools: {} },
      jsonSchemaValidator: elicitationUnsupported,
    }
  );
  registerFlowTools(server, new ToolContext(env, auth));

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session id issued, none validated.
    sessionIdGenerator: undefined,
    // One complete JSON response per POST instead of an SSE frame. Simpler for
    // clients, and it means the Response body is finished when we return it.
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(req);
}
