import { Hono } from "hono";
import { z } from "zod";
import { CreateSpaceInput, Id, SpaceVisibility, UpdateSpaceMembersInput } from "@flow/shared";
import { requireAdmin, requireAuth } from "../auth.js";
import { workspace } from "../do.js";
import type { AppEnv } from "../env.js";
import { notFound, parseOrThrow, readJson } from "../errors.js";

export const spaceRoutes = new Hono<AppEnv>();

const UpdateSpaceBody = z.object({
  name: z.string().min(1).optional(),
  color: z.string().nullable().optional(),
  position: z.number().optional(),
  archived: z.boolean().optional(),
  /**
   * "private" hides the space (and everything under it) from members who are
   * not in its member list; "workspace" gives it back to everyone. Applied as
   * its own DO mutation because it is audited separately and makes connected
   * clients resync.
   */
  visibility: SpaceVisibility.optional(),
});

spaceRoutes.get("/spaces", async (c) => {
  const auth = requireAuth(c);
  const snapshot = await workspace(c.env).getSnapshot(auth.user.id);
  return c.json({ spaces: snapshot.spaces });
});

spaceRoutes.get("/spaces/:spaceId", async (c) => {
  const auth = requireAuth(c);
  const spaceId = parseOrThrow(Id, c.req.param("spaceId"), "spaceId");
  // A private space the caller cannot see is absent from their snapshot, so it
  // falls through to the same 404 a genuinely missing id gets.
  const snapshot = await workspace(c.env).getSnapshot(auth.user.id);
  const space = snapshot.spaces.find((s) => s.id === spaceId);
  if (!space) throw notFound(`no space ${spaceId}`);
  return c.json({
    space,
    // Belt and braces: the DO already nulls inboundToken on snapshot lists, and
    // this drops the field so a regression there cannot leak through here.
    lists: snapshot.lists
      .filter((l) => l.spaceId === spaceId)
      .map(({ inboundToken: _secret, ...rest }) => rest),
  });
});

spaceRoutes.post("/spaces", async (c) => {
  const auth = requireAdmin(c);
  const input = parseOrThrow(CreateSpaceInput, await readJson(c));
  return c.json(await workspace(c.env).createSpace(input, auth.actor), 201);
});

spaceRoutes.patch("/spaces/:spaceId", async (c) => {
  const auth = requireAdmin(c);
  const spaceId = parseOrThrow(Id, c.req.param("spaceId"), "spaceId");
  const { visibility, ...patch } = parseOrThrow(UpdateSpaceBody, await readJson(c));
  const ws = workspace(c.env);

  // Visibility first, so a body that both renames and privatises a space cannot
  // broadcast the new name to people who are about to lose access to it.
  let space =
    visibility !== undefined
      ? await ws.setSpaceVisibility({ spaceId, visibility }, auth.actor)
      : null;

  if (Object.keys(patch).length > 0) {
    space = await ws.updateSpace({ spaceId, ...patch }, auth.actor);
  }
  if (space === null) {
    const snapshot = await ws.getSnapshot(auth.user.id);
    space = snapshot.spaces.find((s) => s.id === spaceId) ?? null;
    if (space === null) throw notFound(`no space ${spaceId}`);
  }
  return c.json(space);
});

/**
 * Membership for a private space. Owner/admin only, on both sides: the DO
 * re-checks the actor's role because these decide who can see what.
 */
spaceRoutes.get("/spaces/:spaceId/members", async (c) => {
  requireAdmin(c);
  const spaceId = parseOrThrow(Id, c.req.param("spaceId"), "spaceId");
  return c.json({ spaceId, userIds: await workspace(c.env).listSpaceMembers(spaceId) });
});

/** PUT, not PATCH: `userIds` is the complete membership afterwards. */
spaceRoutes.put("/spaces/:spaceId/members", async (c) => {
  const auth = requireAdmin(c);
  const spaceId = parseOrThrow(Id, c.req.param("spaceId"), "spaceId");
  const body = await readJson(c);
  const input = parseOrThrow(UpdateSpaceMembersInput, {
    ...(typeof body === "object" && body !== null ? body : {}),
    spaceId,
  });
  return c.json(await workspace(c.env).setSpaceMembers(input, auth.actor));
});

spaceRoutes.delete("/spaces/:spaceId", async (c) => {
  const auth = requireAdmin(c);
  const spaceId = parseOrThrow(Id, c.req.param("spaceId"), "spaceId");
  await workspace(c.env).deleteSpace(spaceId, auth.actor);
  return c.json({ ok: true, deleted: spaceId });
});
