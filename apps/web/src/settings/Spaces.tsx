// Spaces tab — owner/admin only.
//
// Every space is private or workspace-visible (SpaceVisibility). Flipping it
// is a separate, audited DO mutation from a plain rename/archive, and changing
// membership on a private space is a full-replace PUT, not a per-checkbox
// PATCH — so both actions here are deliberate, explicit steps rather than
// something that fires on every click. Owners and admins always see every
// space regardless of membership (`canSeeSpace`), so they are never shown as
// checkboxes here unless a membership row already exists for them.
import { useState } from "preact/hooks";
import type { Space } from "@flow/shared";
import { settingsApi } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { spaces, users } from "../store/index.js";
import { ChevronDown, ChevronRight } from "../shell/ui.js";
import {
  Button, Confirm, Empty, ErrorNote, Loading, Panel, Switch, Tag, errorMessage, useAsync,
} from "./ui.js";

/** Full-replace membership editor for one private space. Loads the current
 *  member list on first expand, then edits locally until Save — no per-click
 *  network round trip, matching the server's full-replace PUT semantics. */
function MembersEditor({ space }: { space: Space }) {
  const { status, data, error, reload } = useAsync(
    () => settingsApi.spaceMembers(space.id),
    [space.id]
  );
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);

  // Seed local selection from the server the first time it lands; after that,
  // the checkboxes are the source of truth until Save (or a fresh load).
  const current = selected ?? (data ? new Set(data.userIds) : null);

  const candidates = users.value
    .filter((u) => !u.deactivated)
    .filter((u) => u.role === "member" || (current?.has(u.id) ?? false))
    .sort((a, b) => a.name.localeCompare(b.name));

  const dirty = current !== null && data !== null && !setsEqual(current, new Set(data.userIds));

  async function save(): Promise<void> {
    if (!current) return;
    setSaving(true);
    try {
      const result = await settingsApi.setSpaceMembers(space.id, [...current]);
      setSelected(new Set(result.userIds));
      toast(`Saved members for ${space.name}.`, "info");
    } catch (err) {
      toast(`Couldn't save members for ${space.name} — ${errorMessage(err)}`, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="border-t border-line bg-raised/40 px-4 py-3">
      <p class="mb-2 text-[11.5px] text-faint">
        Owners and admins always have access and are not listed below. Everyone
        else needs to be checked here to see this space.
      </p>
      {status === "loading" && <Loading />}
      {status === "error" && error && <ErrorNote message={error} onRetry={reload} />}
      {status === "ok" && current && (
        <>
          {candidates.length === 0 ? (
            <p class="text-[12.5px] text-faint">No eligible members to add.</p>
          ) : (
            <ul class="space-y-1">
              {candidates.map((u) => (
                <li key={u.id}>
                  <label class="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[12.5px] text-text hover:bg-bg">
                    <input
                      type="checkbox"
                      checked={current.has(u.id)}
                      onChange={(e) => {
                        const checked = (e.currentTarget as HTMLInputElement).checked;
                        const next = new Set(current);
                        if (checked) next.add(u.id);
                        else next.delete(u.id);
                        setSelected(next);
                      }}
                    />
                    <span class="min-w-0 flex-1 truncate">{u.name}</span>
                    {u.role !== "member" && <Tag tone="accent">{u.role}</Tag>}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div class="mt-3 flex items-center gap-2">
            <Button tone="primary" size="xs" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </Button>
            {dirty && (
              <span class="text-[11.5px] text-faint">Unsaved changes.</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function SpaceRow({ space }: { space: Space }) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const isPrivate = space.visibility === "private";

  async function flip(next: "workspace" | "private"): Promise<void> {
    setConfirming(false);
    setBusy(true);
    const before = spaces.value;
    spaces.value = before.map((s) => (s.id === space.id ? { ...s, visibility: next } : s));
    try {
      const saved = await settingsApi.setSpaceVisibility(space.id, next);
      spaces.value = spaces.value.map((s) => (s.id === saved.id ? saved : s));
      if (next === "private") setExpanded(true);
    } catch (err) {
      spaces.value = before;
      toast(`Couldn't change ${space.name}'s visibility — ${errorMessage(err)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div class="border-b border-line last:border-b-0">
      <div class="flex items-center gap-3 px-4 py-2.5">
        {isPrivate ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse ${space.name}` : `Expand ${space.name}`}
            class="shrink-0 rounded p-0.5 text-faint hover:bg-bg hover:text-text"
          >
            <Chevron class="h-3.5 w-3.5" />
          </button>
        ) : (
          <span class="w-[18px] shrink-0" />
        )}

        <span class="min-w-0 flex-1 truncate text-[13px] text-text">
          {space.name}
          {space.archived && (
            <span class="ml-2 align-middle">
              <Tag>archived</Tag>
            </span>
          )}
        </span>

        <span class="flex shrink-0 items-center gap-2">
          <span class="text-[11.5px] text-muted">{isPrivate ? "Private" : "Workspace"}</span>
          <Switch
            checked={isPrivate}
            busy={busy}
            label={`Make ${space.name} ${isPrivate ? "workspace-visible" : "private"}`}
            onChange={() => setConfirming(true)}
          />
        </span>
      </div>

      {confirming && (
        <div class="px-4 pb-2.5">
          <Confirm
            message={
              isPrivate
                ? `Make "${space.name}" visible to the whole workspace? Its membership list stops mattering — everyone will see it.`
                : `Make "${space.name}" private? Only owners, admins and its members will see it — everyone else loses access immediately.`
            }
            confirmLabel={isPrivate ? "Make workspace-visible" : "Make private"}
            tone={isPrivate ? "primary" : "danger"}
            onConfirm={() => void flip(isPrivate ? "workspace" : "private")}
            onCancel={() => setConfirming(false)}
          />
        </div>
      )}

      {expanded && isPrivate && <MembersEditor space={space} />}
    </div>
  );
}

export function SpacesTab() {
  const rows = [...spaces.value].sort((a, b) => a.position - b.position);

  return (
    <Panel
      title="Spaces"
      description="Private is the default for new spaces. A private space (and everything under it) is visible only to owners, admins and the members listed here."
    >
      {rows.length === 0 && <Empty>No spaces yet.</Empty>}
      {rows.map((space) => (
        <SpaceRow key={space.id} space={space} />
      ))}
    </Panel>
  );
}
