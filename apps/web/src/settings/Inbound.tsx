// Inbound webhooks tab.
//
// Intake state is not in the board snapshot: the DO nulls `inboundToken` on
// every list it hands out, so "is intake on?" comes from a per-list read of
// GET /api/lists/:id. That is one request per list, fired in parallel on mount,
// with a failed list showing "unknown" rather than taking the panel down.
import { useState } from "preact/hooks";
import { ApiError, inboundUrl, settingsApi } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { lists, spaceById, spaces } from "../store/index.js";
import {
  Button, Confirm, CopyBlock, Empty, ErrorNote, Loading, Panel, Tag, errorMessage, useAsync,
} from "./ui.js";
import { isWorkspaceAdmin } from "./ApiKeys.js";

type IntakeState = Map<string, boolean | null>;

function IntakeRow({
  listId,
  name,
  enabled,
  admin,
  onChanged,
}: {
  listId: string;
  name: string;
  enabled: boolean | null;
  admin: boolean;
  onChanged: (listId: string, enabled: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"rotate" | "disable" | null>(null);

  async function run(mode: "rotate" | null): Promise<void> {
    setConfirming(null);
    setBusy(true);
    try {
      const result = await settingsApi.setListInbound(listId, mode);
      if (mode === "rotate" && result.inboundToken) {
        // `inboundUrl` from the API names the deployed host; the token goes on
        // as a query param so the whole thing is one pasteable URL.
        const base = result.inboundUrl ? result.inboundUrl.replace(/\/api\/inbound\/.*$/, "") : undefined;
        setMinted(inboundUrl(listId, result.inboundToken, base));
      } else {
        setMinted(null);
      }
      onChanged(listId, result.inboundEnabled);
    } catch (err) {
      toast(`Intake change failed for ${name}: ${errorMessage(err)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="border-b border-line px-4 py-2.5 last:border-b-0">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span class="min-w-0 flex-1 truncate text-[13px] text-text">{name}</span>

        {enabled === null ? (
          <Tag title="Could not read this list's intake state">unknown</Tag>
        ) : enabled ? (
          <Tag tone="ok">intake on</Tag>
        ) : (
          <Tag>intake off</Tag>
        )}

        {admin && (
          <span class="flex shrink-0 items-center gap-1.5">
            <Button
              size="xs"
              disabled={busy}
              onClick={() => (enabled ? setConfirming("rotate") : void run("rotate"))}
            >
              {enabled ? "Rotate token" : "Enable"}
            </Button>
            {enabled && (
              <Button tone="danger" size="xs" disabled={busy} onClick={() => setConfirming("disable")}>
                Disable
              </Button>
            )}
          </span>
        )}
      </div>

      {confirming === "rotate" && (
        <Confirm
          message={`Rotate ${name}'s token? The current one stops working the moment the new one is minted.`}
          confirmLabel="Rotate"
          onConfirm={() => void run("rotate")}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming === "disable" && (
        <Confirm
          message={`Turn off intake for ${name}? Anything posting to it — your bug tracker included — starts getting 401s.`}
          confirmLabel="Disable"
          tone="danger"
          onConfirm={() => void run(null)}
          onCancel={() => setConfirming(null)}
        />
      )}

      {minted && (
        <div class="mt-2">
          <CopyBlock
            label={`Webhook URL for ${name}`}
            value={minted}
            warning="Shown only once. Paste it into whatever posts here now — rotating again is the only way back."
          />
        </div>
      )}
    </div>
  );
}

export function InboundTab() {
  const admin = isWorkspaceAdmin();
  const rows = lists.value.filter((l) => !l.archived);
  const key = rows.map((l) => l.id).join(",");
  const spaceMap = spaceById.value;
  const orderedSpaces = [...spaces.value].sort((a, b) => a.position - b.position);

  const { status, data, error, reload, setData } = useAsync<IntakeState>(async () => {
    const settled = await Promise.allSettled(
      rows.map(async (l) => [l.id, (await settingsApi.listDetail(l.id)).inboundEnabled] as const)
    );
    const map: IntakeState = new Map();
    for (let i = 0; i < settled.length; i++) {
      const entry = settled[i];
      const list = rows[i];
      if (!list) continue;
      map.set(list.id, entry && entry.status === "fulfilled" ? entry.value[1] : null);
    }
    // Every list failing means the API is unreachable, not that intake state is
    // genuinely unknowable — surface it as one error rather than N "unknown"s.
    if (rows.length > 0 && settled.every((s) => s.status === "rejected")) {
      const first = settled[0];
      throw first && first.status === "rejected"
        ? first.reason
        : new ApiError(0, "Can't reach the API.");
    }
    return map;
  }, [key]);

  function noteChange(listId: string, enabled: boolean): void {
    setData((prev) => {
      const next: IntakeState = new Map(prev ?? []);
      next.set(listId, enabled);
      return next;
    });
  }

  return (
    <Panel
      title="Inbound webhooks"
      description="This is how outside systems file work into Flow: bug trackers like Gleap can POST reports to a list's own intake URL, and the token in that URL is the only credential they need."
      right={
        <Button size="xs" onClick={reload}>
          Refresh
        </Button>
      }
    >
      {status === "loading" && <Loading />}
      {status === "error" && error && <ErrorNote message={error} onRetry={reload} />}
      {!admin && (
        <p class="border-b border-line px-4 py-2 text-[12px] text-muted">
          Read-only: enabling, rotating and disabling intake is owner/admin work.
        </p>
      )}
      {/* The list names come from the store, so they render even when the
          intake read failed — those rows just show "unknown" instead. */}
      {status !== "loading" && rows.length === 0 && <Empty>No lists yet.</Empty>}
      {status !== "loading" &&
        rows.length > 0 &&
        orderedSpaces.map((space) => {
          const inSpace = rows.filter((l) => l.spaceId === space.id);
          if (inSpace.length === 0) return null;
          return (
            <div key={space.id}>
              <p class="border-b border-line bg-raised/60 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">
                {spaceMap.get(space.id)?.name ?? space.name}
              </p>
              {inSpace.map((list) => (
                <IntakeRow
                  key={list.id}
                  listId={list.id}
                  name={list.name}
                  enabled={data?.get(list.id) ?? null}
                  admin={admin}
                  onChanged={noteChange}
                />
              ))}
            </div>
          );
        })}
    </Panel>
  );
}
