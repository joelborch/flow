import { Hono } from "hono";
import { Id, type CreateTaskInput, type InboundTaskInput } from "@flow/shared";
import { resolveInboundActor } from "../auth.js";
import { findTaskByExternalIdTag, workspace } from "../do.js";
import type { AppEnv } from "../env.js";
import { badRequest, parseOrThrow, readJson, unauthorized } from "../errors.js";
import { parseBearer } from "../tokens.js";
import { mapInboundPayload } from "../gleap.js";

export const inboundRoutes = new Hono<AppEnv>();

/**
 * Per-list intake endpoint for third-party systems (Gleap today).
 *
 * Auth is the list's own `inboundToken` as a Bearer credential, not a workspace
 * api key — so a leaked Gleap token can only create tasks in that one list, and
 * rotating it is a single PATCH. This route is exempt from the global auth
 * middleware for exactly that reason.
 *
 * Idempotency: a payload carrying an `externalId` is recorded as an `ext:<id>`
 * tag, and a repeat delivery returns the existing task with 200 instead of
 * creating a duplicate. Gleap retries on non-2xx, so this matters.
 */

/** Tag prefix used as the idempotency marker. */
export const EXTERNAL_ID_TAG_PREFIX = "ext:";

export function externalIdTag(externalId: string): string {
  return `${EXTERNAL_ID_TAG_PREFIX}${externalId}`;
}

/** Fold the inbound shape into a CreateTaskInput for the target list. */
export function toCreateTaskInput(
  mapped: InboundTaskInput,
  listId: string
): CreateTaskInput {
  const tags = [...new Set(mapped.tags ?? [])];
  if (mapped.externalId) tags.push(externalIdTag(mapped.externalId));

  // CreateTaskInput has no externalUrl field, so the source link goes in the
  // description where it stays visible and clickable.
  let description = mapped.description ?? "";
  if (mapped.externalUrl && !description.includes(mapped.externalUrl)) {
    description = description === "" ? `Source: ${mapped.externalUrl}` : `${description}\n\nSource: ${mapped.externalUrl}`;
  }

  return {
    listId,
    title: mapped.title,
    description,
    tags,
    ...(mapped.status ? { status: mapped.status } : {}),
  };
}

inboundRoutes.post("/inbound/:listId", async (c) => {
  const listId = parseOrThrow(Id, c.req.param("listId"), "listId");

  // --- auth: the list's own token -----------------------------------------
  // Bearer header is the documented form. Some webhook senders (Gleap's own
  // config UI among them) only let you paste a URL with no custom headers, so a
  // `?token=` query param is accepted as an equivalent fallback.
  const presented =
    parseBearer(c.req.header("Authorization")) ?? c.req.query("token") ?? null;
  if (presented === null || presented === "") {
    throw unauthorized(
      "inbound webhook requires the list's inboundToken, either as `Authorization: Bearer <token>` or as `?token=<token>`"
    );
  }
  // Resolved token-first, so the secret is matched by an indexed equality lookup
  // in SQLite and never travels back to the Worker to be compared here.
  const list = await workspace(c.env).getListByInboundToken(presented);
  if (list === null || list.id !== listId) {
    // One message for "no such list", "intake disabled" and "wrong token": an
    // unauthenticated caller learns nothing about which lists exist.
    throw unauthorized(`inbound token is not valid for list ${listId}`);
  }

  // --- body: native shape, else best-effort Gleap mapping ------------------
  const raw = await readJson(c);
  let mapped;
  try {
    mapped = mapInboundPayload(raw);
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : "could not map inbound payload");
  }

  // --- idempotency ---------------------------------------------------------
  if (mapped.externalId) {
    const existing = await findTaskByExternalIdTag(
      c.env,
      externalIdTag(mapped.externalId)
    ).catch(() => null);
    if (existing) {
      // The tag search answers "does it exist?" with a TaskRow — a subset of
      // Task. A retrying sender must not see a different shape than it got on
      // the original delivery, so the full task is re-read before responding.
      const detail = await workspace(c.env)
        .getTaskDetail(existing.id)
        .catch(() => null);
      return c.json(
        {
          task: detail?.task ?? existing,
          created: false,
          deduplicatedBy: mapped.externalId,
        },
        200
      );
    }
  }

  // --- create as the gleap key's user (falling back to the owner) ----------
  // The actor carries the impersonated user id plus via:"webhook" and the gleap
  // key id, so the audit trail shows where the task came from.
  const { actor } = await resolveInboundActor(c.env);
  const input = toCreateTaskInput(mapped, listId);
  const task = await workspace(c.env).createTask(input, actor);

  console.log(
    JSON.stringify({
      level: "info",
      msg: "inbound task created",
      listId,
      taskId: task.id,
      externalId: mapped.externalId ?? null,
      nativeShape: mapped.native,
    })
  );

  return c.json({ task, created: true, mappedFrom: mapped.native ? "native" : "gleap" }, 201);
});
