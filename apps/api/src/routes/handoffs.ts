import { Hono } from "hono";
import { Id, ListHandoffsInput, ReplyHandoffInput, RequestHandoffInput } from "@flow/shared";
import { requireAuth } from "../auth.js";
import { workspace } from "../do.js";
import type { AppEnv } from "../env.js";
import { parseOrThrow, readJson } from "../errors.js";

/**
 * Agent handoffs: one person's agent files a request for a teammate's agent.
 * A handoff is an ordinary task (assigned to the recipient, tagged "handoff")
 * plus a `handoff` object, and replies are ordinary comments.
 *
 * Open to every member. Who may move a handoff to which state is the DO's call,
 * not this file's: the recipient may set any state, the requester may only
 * decline (or hand a needs_input handoff back by replying), owners and admins
 * may do anything. The DO's refusal reaches the caller as its own sentence.
 */
export const handoffRoutes = new Hono<AppEnv>();

const csv = (values: string[]): string[] =>
  values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => v !== "");

/**
 * `?direction=incoming|outgoing&states=a,b&limit=n` -> `ListHandoffsInput`.
 * `states` may be repeated or comma-separated, and `state` is accepted for it,
 * since an unknown param is silently ignored and would otherwise quietly fall
 * back to the open states. Only supplied keys are set, so Zod defaults apply.
 */
export function listHandoffsInputFromQuery(url: URL): unknown {
  const q = url.searchParams;
  const out: Record<string, unknown> = {};
  const direction = q.get("direction");
  if (direction !== null && direction.trim() !== "") out["direction"] = direction.trim();
  const states = csv([...q.getAll("states"), ...q.getAll("state")]);
  if (states.length > 0) out["states"] = states;
  const limit = q.get("limit");
  if (limit !== null && limit.trim() !== "") {
    const parsed = Number(limit);
    out["limit"] = Number.isFinite(parsed) ? parsed : Number.NaN; // NaN -> Zod reports it
  }
  return out;
}

handoffRoutes.post("/handoffs", async (c) => {
  const auth = requireAuth(c);
  const input = parseOrThrow(RequestHandoffInput, await readJson(c));
  const task = await workspace(c.env).requestHandoff(input, auth.actor);
  return c.json({ task }, 201);
});

handoffRoutes.get("/handoffs", async (c) => {
  const auth = requireAuth(c);
  const input = parseOrThrow(
    ListHandoffsInput,
    listHandoffsInputFromQuery(new URL(c.req.url)),
    "handoff query params"
  );
  return c.json({ tasks: await workspace(c.env).listHandoffs(input, auth.actor) });
});

handoffRoutes.post("/tasks/:taskId/handoff", async (c) => {
  const auth = requireAuth(c);
  const taskId = parseOrThrow(Id, c.req.param("taskId"), "taskId");
  const body = await readJson(c);
  // taskId comes from the path, which always wins over a body copy.
  const input = parseOrThrow(ReplyHandoffInput, {
    ...(typeof body === "object" && body !== null ? body : {}),
    taskId,
  });
  return c.json(await workspace(c.env).replyHandoff(input, auth.actor));
});
