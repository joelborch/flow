/// <reference types="@cloudflare/workers-types" />
import type { Context } from "hono";
import { resolveAuth } from "../auth.js";
import { workspaceStub } from "../do.js";
import { WS_USER_HEADER, type AppEnv } from "../env.js";
import { badRequest } from "../errors.js";

/**
 * GET /ws — authenticate, then hand the upgrade straight to the DO.
 *
 * The Worker does not terminate the socket: the DO owns the connection so it can
 * use WebSocket hibernation and broadcast deltas without a hop. All the Worker
 * contributes is identity, passed as the `X-Flow-User-Id` header, which the DO
 * reads in its fetch handler. The header is safe to trust because the Worker is
 * the only path to the DO and it strips any client-supplied copy first.
 */
export async function handleWebSocketUpgrade(c: Context<AppEnv>): Promise<Response> {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    throw badRequest("GET /ws expects an `Upgrade: websocket` request");
  }

  const auth = await resolveAuth(c);

  const headers = new Headers(c.req.raw.headers);
  // Never let a client inject its own identity.
  headers.delete(WS_USER_HEADER);
  headers.set(WS_USER_HEADER, auth.user.id);
  headers.set("X-Flow-Actor-Via", auth.actor.via);
  if (auth.apiKey) headers.set("X-Flow-Api-Key-Id", auth.apiKey.id);

  // `new Request(original, { headers })` keeps the method, the upgrade intent and
  // the webSocket handshake bits intact.
  return workspaceStub(c.env).fetch(new Request(c.req.raw, { headers }));
}
