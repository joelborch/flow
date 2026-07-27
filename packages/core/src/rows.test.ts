import { describe, expect, it } from "vitest";
import type { Status } from "@flow/shared";
import { INBOUND_TOKEN_PREFIX, token } from "./id.js";
import { type ListRow, toList, toListWithSecrets } from "./rows.js";

const statuses: Status[] = [
  { id: "st_1", name: "To Do", color: "#8b8f9a", type: "open", position: 0 },
  { id: "st_2", name: "Done", color: "#22c55e", type: "closed", position: 1 },
];

const row = (inboundToken: string | null): ListRow => ({
  id: "ls_1",
  space_id: "sp_1",
  name: "Content Cycle",
  position: 1,
  archived: 0,
  inbound_token: inboundToken,
  created_at: 1_700_000_000_000,
  clickup_id: null,
});

describe("toList", () => {
  it("nulls the inbound token even when the row has one", () => {
    const list = toList(row("inb_supersecret"), statuses);
    expect(list.inboundToken).toBeNull();
    expect(JSON.stringify(list)).not.toContain("supersecret");
  });

  it("keeps every other field intact", () => {
    const list = toList(row("inb_supersecret"), statuses);
    expect(list).toMatchObject({
      id: "ls_1",
      spaceId: "sp_1",
      name: "Content Cycle",
      position: 1,
      archived: false,
      statuses,
      createdAt: 1_700_000_000_000,
    });
  });

  it("agrees with toListWithSecrets on everything but the token", () => {
    const safe = toList(row("inb_abc"), statuses);
    const withSecret = toListWithSecrets(row("inb_abc"), statuses);
    expect(withSecret.inboundToken).toBe("inb_abc");
    expect({ ...withSecret, inboundToken: null }).toEqual(safe);
  });

  it("is a no-op difference when intake is disabled", () => {
    expect(toList(row(null), statuses)).toEqual(toListWithSecrets(row(null), statuses));
  });
});

describe("token", () => {
  it("mints inbound tokens with the inb_ prefix", () => {
    const minted = token();
    expect(minted.startsWith(INBOUND_TOKEN_PREFIX)).toBe(true);
    expect(minted).toHaveLength(INBOUND_TOKEN_PREFIX.length + 32);
  });

  it("is unguessable enough that two mints differ", () => {
    expect(token()).not.toBe(token());
  });
});
