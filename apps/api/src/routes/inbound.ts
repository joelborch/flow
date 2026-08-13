import { Hono } from "hono";
import { Id, type CreateTaskInput, type InboundTaskInput, type Task } from "@flow/shared";
import { resolveInboundActor } from "../auth.js";
import { findTaskByExternalIdTag, workspace } from "../do.js";
import type { AppEnv } from "../env.js";
import { badRequest, parseOrThrow, readJson, unauthorized } from "../errors.js";
import { parseBearer } from "../tokens.js";
import { mapInboundPayload, type GleapMapping } from "../gleap.js";
import { gleapProjectToken, type GleapScreenshotJob } from "../gleap-screenshot.js";

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

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function generatedPayloadDescription(description: string): boolean {
  return description.includes("**Reported payload**") && description.includes("```json");
}

export function gleapEnrichmentUpdate(
  existing: Pick<Task, "id" | "title" | "description" | "tags">,
  mapped: GleapMapping
): { taskId: string; title?: string; description?: string; tags?: string[] } | null {
  const update: {
    taskId: string;
    title?: string;
    description?: string;
    tags?: string[];
  } = { taskId: existing.id };

  // Repair only Flow's known malformed output. Human-edited task content is
  // never replaced by a later Gleap delivery.
  if (
    existing.title === "Untitled Gleap report" &&
    generatedPayloadDescription(existing.description)
  ) {
    update.title = mapped.title;
    update.description = mapped.description ?? "";
  }

  // Replace the legacy ext:<shareToken> marker with the stable ticket id while
  // retaining every human tag. The ext marker stays internal to idempotency.
  if (mapped.externalId) {
    const humanTags = existing.tags.filter((tag) => !tag.startsWith(EXTERNAL_ID_TAG_PREFIX));
    const nextTags = [...new Set([...humanTags, ...(mapped.tags ?? []), externalIdTag(mapped.externalId)])];
    if (!sameStrings(existing.tags, nextTags)) update.tags = nextTags;
  }

  return Object.keys(update).length === 1 ? null : update;
}

async function findExistingTask(
  env: AppEnv["Bindings"],
  mapped: GleapMapping,
  listId: string
): Promise<Task | null> {
  const ids = [mapped.externalId, ...(mapped.gleap?.legacyExternalIds ?? [])].filter(
    (value): value is string => typeof value === "string" && value !== ""
  );
  for (const externalId of ids) {
    const row = await findTaskByExternalIdTag(env, externalIdTag(externalId)).catch(() => null);
    if (!row || row.listId !== listId) continue;
    const detail = await workspace(env).getTaskDetail(row.id).catch(() => null);
    if (detail) return detail.task;
  }
  return null;
}

async function enrichGeneratedTask(
  env: AppEnv["Bindings"],
  existing: Task,
  mapped: GleapMapping,
  actor: Awaited<ReturnType<typeof resolveInboundActor>>["actor"]
): Promise<Task> {
  const update = gleapEnrichmentUpdate(existing, mapped);
  if (update === null) return existing;
  return workspace(env).updateTask(update, actor);
}

async function enqueueGleapScreenshot(
  env: AppEnv["Bindings"],
  taskId: string,
  mapped: GleapMapping
): Promise<boolean> {
  const source = mapped.gleap;
  if (!source || source.screenshotFailed || source.ticketId === "") return false;
  if (source.screenshotUrl === null && !source.screenshotPending) return false;
  const projectToken = source.projectId
    ? gleapProjectToken(source.projectId, env.GLEAP_PROJECT_TOKENS_JSON)
    : null;
  if (source.screenshotUrl === null && projectToken === null) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "Gleap screenshot polling is not configured",
        taskId,
        hasProjectId: Boolean(source.projectId),
        hasProjectToken: false,
      })
    );
    return false;
  }

  const job: GleapScreenshotJob = {
    kind: "gleap-screenshot",
    taskId,
    ticketId: source.ticketId,
    projectId: source.projectId ?? "",
    screenshotUrl: source.screenshotUrl,
  };
  await env.SIDE_EFFECTS.send(job, {
    delaySeconds: source.screenshotUrl === null ? 5 : 0,
  });
  return true;
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

  // --- create/update as the gleap key's user (falling back to the owner) ----
  // The actor carries the impersonated user id plus via:"webhook" and the gleap
  // key id, so the audit trail shows where the task came from.
  const { actor } = await resolveInboundActor(c.env);
  const existing = await findExistingTask(c.env, mapped, listId);
  if (existing) {
    const task = await enrichGeneratedTask(c.env, existing, mapped, actor);
    const screenshotQueued = await enqueueGleapScreenshot(c.env, task.id, mapped);
    return c.json(
      {
        task,
        created: false,
        deduplicatedBy: mapped.externalId,
        screenshotQueued,
      },
      200
    );
  }

  const input = toCreateTaskInput(mapped, listId);
  const task = await workspace(c.env).createTask(input, actor);
  const screenshotQueued = await enqueueGleapScreenshot(c.env, task.id, mapped);

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

  return c.json(
    {
      task,
      created: true,
      mappedFrom: mapped.native ? "native" : "gleap",
      screenshotQueued,
    },
    201
  );
});
