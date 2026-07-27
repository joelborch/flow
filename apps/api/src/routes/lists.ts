import { Hono } from "hono";
import { z } from "zod";
import { CreateListInput, Id } from "@flow/shared";
import { requireAdmin, requireAuth } from "../auth.js";
import { workspace } from "../do.js";
import type { AppEnv } from "../env.js";
import { notFound, parseOrThrow, readJson } from "../errors.js";

export const listRoutes = new Hono<AppEnv>();

const UpdateListBody = z.object({
  name: z.string().min(1).optional(),
  position: z.number().optional(),
  archived: z.boolean().optional(),
  /** Move the list to another space. */
  spaceId: Id.optional(),
  /**
   * Inbound intake control. `"rotate"` has the DO mint a fresh token, returned
   * once in this response; `null` disables intake; omitted leaves it alone.
   * The token is generated inside the DO so the plaintext exists in exactly one
   * place and is written in the same turn that records it.
   */
  inboundToken: z.union([z.literal("rotate"), z.null()]).optional(),
});

listRoutes.get("/lists", async (c) => {
  const auth = requireAuth(c);
  const spaceId = c.req.query("spaceId");
  // Filtered snapshot: lists in private spaces the caller is not a member of
  // never appear, so no extra check is needed here.
  const snapshot = await workspace(c.env).getSnapshot(auth.user.id);
  const lists = spaceId ? snapshot.lists.filter((l) => l.spaceId === spaceId) : snapshot.lists;
  // The DO already nulls inboundToken on every snapshot list; dropping the key
  // outright keeps the collection shape free of a credential-named field.
  return c.json({ lists: lists.map(({ inboundToken, ...rest }) => rest) });
});

listRoutes.get("/lists/:listId", async (c) => {
  const auth = requireAuth(c);
  const listId = parseOrThrow(Id, c.req.param("listId"), "listId");
  const ws = workspace(c.env);
  const snapshot = await ws.getSnapshot(auth.user.id);
  const list = snapshot.lists.find((l) => l.id === listId);
  if (!list) throw notFound(`no list ${listId}`);

  // The snapshot's inboundToken is always null now, so both "is intake on?" and
  // the admin-only plaintext come from the dedicated secret read.
  const isAdmin = auth.user.role === "owner" || auth.user.role === "admin";
  const secret = (await ws.getListWithSecrets(listId))?.inboundToken ?? null;
  const { inboundToken: _null, ...safe } = list;
  return c.json({
    list: isAdmin ? { ...safe, inboundToken: secret } : safe,
    inboundEnabled: secret !== null,
    tasks: snapshot.tasks.filter((t) => t.listId === listId),
  });
});

listRoutes.post("/lists", async (c) => {
  const auth = requireAdmin(c);
  const input = parseOrThrow(CreateListInput, await readJson(c));
  const list = await workspace(c.env).createList(input, auth.actor);
  // A fresh list has no intake token; say so explicitly rather than letting the
  // field's absence be read as "unknown".
  return c.json({ ...list, inboundToken: null }, 201);
});

listRoutes.patch("/lists/:listId", async (c) => {
  const auth = requireAdmin(c);
  const listId = parseOrThrow(Id, c.req.param("listId"), "listId");
  const patch = parseOrThrow(UpdateListBody, await readJson(c));

  const ws = workspace(c.env);

  // Intake is a separate DO mutation from the list's own fields, because it
  // mints a credential and audits differently.
  let minted: string | null = null;
  if (patch.inboundToken !== undefined) {
    const result = await ws.setListInboundToken(
      { listId, enabled: patch.inboundToken === "rotate" },
      auth.actor
    );
    minted = result.inboundToken;
  }

  const hasFieldUpdates =
    patch.name !== undefined ||
    patch.position !== undefined ||
    patch.archived !== undefined ||
    patch.spaceId !== undefined;

  const list = hasFieldUpdates
    ? await ws.updateList(
        {
          listId,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.position !== undefined ? { position: patch.position } : {}),
          ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
          ...(patch.spaceId !== undefined ? { spaceId: patch.spaceId } : {}),
        },
        auth.actor
      )
    : (await ws.getSnapshot(auth.user.id)).lists.find((l) => l.id === listId);
  if (!list) throw notFound(`no list ${listId}`);

  // `list` here came from a snapshot/updateList read, so its inboundToken is
  // already null. Intake state comes from what this request just did, or from
  // the dedicated secret read when it left intake alone.
  const inboundEnabled =
    patch.inboundToken !== undefined
      ? minted !== null
      : ((await ws.getListWithSecrets(listId))?.inboundToken ?? null) !== null;

  const { inboundToken: _secret, ...safeList } = list;
  return c.json({
    list: safeList,
    inboundEnabled,
    // Shown exactly once, on rotation, so it can be pasted into Gleap.
    ...(minted !== null
      ? {
          inboundToken: minted,
          inboundUrl: `https://${c.env.APP_HOSTNAME}/api/inbound/${listId}`,
          warning: "This inbound token is shown only once.",
        }
      : {}),
  });
});

listRoutes.delete("/lists/:listId", async (c) => {
  const auth = requireAdmin(c);
  const listId = parseOrThrow(Id, c.req.param("listId"), "listId");
  await workspace(c.env).deleteList(listId, auth.actor);
  return c.json({ ok: true, deleted: listId });
});
