import { describe, expect, it } from "vitest";
import type { Status } from "@flow/shared";
import { INBOUND_TOKEN_PREFIX, token } from "./id.js";
import {
  type AttachmentRow,
  type ListRow,
  toAttachment,
  toList,
  toListWithSecrets,
} from "./rows.js";
import { MIGRATIONS } from "./schema.js";

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

describe("Drive-backed attachment rows", () => {
  const attachmentRow = (patch: Partial<AttachmentRow> = {}): AttachmentRow => ({
    id: "at_1",
    task_id: "tk_1",
    filename: "proof.pdf",
    r2_key: "at/tk_1/at_1/proof.pdf",
    storage_provider: "r2",
    drive_file_id: null,
    drive_web_view_link: null,
    drive_destination: null,
    migration_state: "r2",
    size: 123,
    mime_type: "application/pdf",
    uploaded_by: "us_1",
    created_at: 1_700_000_000_000,
    ...patch,
  });

  it("maps a verified Drive destination without discarding the R2 key", () => {
    expect(
      toAttachment(
        attachmentRow({
          storage_provider: "drive",
          drive_file_id: "drive-1",
          drive_web_view_link: "https://drive.google.com/file/d/drive-1/view",
          drive_destination: "private",
          migration_state: "cleanup_pending",
        })
      )
    ).toMatchObject({
      r2Key: "at/tk_1/at_1/proof.pdf",
      storageProvider: "drive",
      driveFileId: "drive-1",
      driveDestination: "private",
      migrationState: "cleanup_pending",
    });
  });

  it("fails open to R2 semantics for unrecognised storage values", () => {
    expect(
      toAttachment(
        attachmentRow({
          storage_provider: "unknown",
          drive_destination: "unknown",
          migration_state: "unknown",
        })
      )
    ).toMatchObject({
      storageProvider: "r2",
      driveDestination: null,
      migrationState: "r2",
    });
  });

  it("registers the additive migration once with safe defaults", () => {
    const migrations = MIGRATIONS.filter((m) => m.id === "core-0005-attachment-drive-storage");
    expect(migrations).toHaveLength(1);
    const migration = migrations[0]!;
    expect(migration.statements.some((s) => /storage_provider.+DEFAULT 'r2'/.test(s))).toBe(true);
    expect(migration.statements.some((s) => /migration_state.+DEFAULT 'r2'/.test(s))).toBe(true);
  });
});
