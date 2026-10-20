// Email intake section of the Inbound tab — owner/admin only.
//
// A list with an intake has its own address, <alias>@<domain>: mail from an
// allowed sender opens a task there, and a reply on that thread lands as a
// comment. None of it is in the board snapshot, so the panel reads
// GET /api/email-intakes on mount and then patches its own copy from each PUT
// or DELETE answer. Every route here 403s for a member, so the Inbound tab only
// mounts this for owner/admin and a member never fires the read at all.
import { useId, useState } from "preact/hooks";
import type { EmailIntake, List, SetEmailIntakeInput, Space } from "@flow/shared";
import { settingsApi } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { listById, lists, spaceById, spaces } from "../store/index.js";
import {
  Button, Check, Confirm, Empty, ErrorNote, Loading, Panel, Tag, TextInput,
  errorMessage, useAsync, useCopy,
} from "./ui.js";

type SpaceChoices = { space: Space; lists: List[] };

/** Textarea to payload: one entry per line, trimmed, blank lines dropped. */
export function parseSenders(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function intakeAddress(alias: string, domain: string | null): string | null {
  return domain ? `${alias}@${domain}` : null;
}

/** "Space / List" from the store. An intake can outlive the list's presence in
 *  this client, so a miss falls back to the id rather than a blank row. */
function listLabel(listId: string): string {
  const list = listById.value.get(listId);
  if (!list) return listId;
  const space = spaceById.value.get(list.spaceId);
  return space ? `${space.name} / ${list.name}` : list.name;
}

/** Board order: space position, then list position; unknown lists sink. */
function boardRank(listId: string): [number, number] {
  const list = listById.value.get(listId);
  if (!list) return [Infinity, Infinity];
  return [spaceById.value.get(list.spaceId)?.position ?? Infinity, list.position];
}

function byBoardOrder(a: EmailIntake, b: EmailIntake): number {
  const [sa, la] = boardRank(a.listId);
  const [sb, lb] = boardRank(b.listId);
  return sa - sb || la - lb || a.alias.localeCompare(b.alias);
}

/** Lists an intake can be added to: live lists in live spaces, minus the ones
 *  that already have an address (the PUT would silently replace theirs). */
function addChoices(taken: ReadonlySet<string>): SpaceChoices[] {
  return [...spaces.value]
    .filter((s) => !s.archived)
    .sort((a, b) => a.position - b.position)
    .map((space) => ({
      space,
      lists: lists.value
        .filter((l) => l.spaceId === space.id && !l.archived && !taken.has(l.id))
        .sort((a, b) => a.position - b.position),
    }))
    .filter((group) => group.lists.length > 0);
}

const FIELD_LABEL = "mb-1 block text-[11.5px] font-medium text-muted";

/**
 * Alias + senders, shared by add and edit. Add passes `choices` and gets a list
 * picker; edit passes the fixed `listId`. Validation is the server's job — its
 * 422 sentence is shown here verbatim, next to the fields that caused it.
 */
function IntakeForm({
  listId: fixedListId,
  choices,
  domain,
  initialAlias = "",
  initialSenders = [],
  onSave,
  onCancel,
}: {
  listId?: string;
  choices?: SpaceChoices[];
  domain: string | null;
  initialAlias?: string;
  initialSenders?: string[];
  onSave: (listId: string, input: SetEmailIntakeInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [listId, setListId] = useState(fixedListId ?? "");
  const [alias, setAlias] = useState(initialAlias);
  const [senders, setSenders] = useState(initialSenders.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  const ready = listId !== "" && alias.trim() !== "" && !busy;
  // The server lowercases aliases, so compare the way it will store them.
  const renaming = initialAlias !== "" && alias.trim().toLowerCase() !== initialAlias;

  async function submit(): Promise<void> {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(listId, { alias: alias.trim(), allowedSenders: parseSenders(senders) });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (choices && choices.length === 0) {
    return (
      <div class="flex flex-wrap items-center gap-2">
        <p class="min-w-0 flex-1 text-[12.5px] text-faint">Every active list already has an address.</p>
        <Button tone="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <form
      class="space-y-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {choices && (
        <label class="block">
          <span class={FIELD_LABEL}>List</span>
          <select
            value={listId}
            onChange={(e) => setListId((e.currentTarget as HTMLSelectElement).value)}
            class="h-[28px] w-full max-w-[360px] rounded-lg border border-line bg-surface px-2 text-[12.5px] text-text hover:border-line-strong focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/10"
          >
            <option value="">Choose a list…</option>
            {choices.map(({ space, lists: inSpace }) => (
              <optgroup key={space.id} label={space.name}>
                {inSpace.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}

      <label class="block">
        <span class={FIELD_LABEL}>Alias</span>
        <span class="flex min-w-0 items-center gap-1.5">
          <TextInput ariaLabel="Alias" mono placeholder="acme" value={alias} onInput={setAlias} />
          {domain && <span class="min-w-0 truncate font-mono text-[12px] text-muted">@{domain}</span>}
        </span>
      </label>
      {renaming && (
        <p class="text-[11.5px] text-warn">
          Mail to the old address, {intakeAddress(initialAlias, domain) ?? initialAlias}, stops
          opening tasks once you save.
        </p>
      )}

      <label class="block">
        <span class={FIELD_LABEL}>Allowed senders</span>
        <textarea
          rows={4}
          value={senders}
          spellcheck={false}
          aria-describedby={hintId}
          placeholder={"name@example.com\n@example.com"}
          onInput={(e) => setSenders((e.currentTarget as HTMLTextAreaElement).value)}
          class="block w-full max-w-[480px] resize-y rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-[12.5px] leading-relaxed text-text transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/10"
        />
      </label>
      <p id={hintId} class="text-[11.5px] text-faint">
        One per line: an address, or @example.com to admit everyone at that domain.
      </p>

      {error && (
        <p
          role="alert"
          class="rounded-lg border border-danger/30 bg-danger-soft px-2.5 py-1.5 text-[12px] leading-relaxed text-danger"
        >
          {error}
        </p>
      )}

      <div class="flex items-center gap-2">
        <Button tone="primary" size="xs" type="submit" disabled={!ready}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button tone="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function IntakeRow({
  intake,
  domain,
  onSaved,
  onRemoved,
}: {
  intake: EmailIntake;
  domain: string | null;
  onSaved: (intake: EmailIntake) => void;
  onRemoved: (listId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, copy] = useCopy();
  const label = listLabel(intake.listId);
  const address = intakeAddress(intake.alias, domain);
  const archived = listById.value.get(intake.listId)?.archived ?? false;

  async function save(listId: string, input: SetEmailIntakeInput): Promise<void> {
    const saved = await settingsApi.setEmailIntake(listId, input);
    onSaved(saved);
    setEditing(false);
    toast(`Saved the email intake for ${label}.`);
  }

  async function remove(): Promise<void> {
    setConfirming(false);
    setBusy(true);
    try {
      await settingsApi.removeEmailIntake(intake.listId);
      toast(`Removed ${address ?? intake.alias}.`);
      onRemoved(intake.listId);
    } catch (err) {
      toast(`Couldn't remove the email intake for ${label}: ${errorMessage(err)}`, "error");
      setBusy(false);
    }
  }

  return (
    <div class="border-b border-line px-4 py-2.5 last:border-b-0">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span class="min-w-0 flex-1 truncate text-[13px] text-text">
          {label}
          {archived && (
            <span class="ml-2 align-middle">
              <Tag>archived</Tag>
            </span>
          )}
        </span>
        <span class="flex shrink-0 items-center gap-1.5">
          <Button
            size="xs"
            disabled={busy}
            ariaLabel={`${editing ? "Close the editor for" : "Edit"} the email intake for ${label}`}
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Close" : "Edit"}
          </Button>
          <Button
            tone="danger"
            size="xs"
            disabled={busy}
            ariaLabel={`Remove the email intake for ${label}`}
            onClick={() => setConfirming(true)}
          >
            Remove
          </Button>
        </span>
      </div>

      <div class="mt-1 flex min-w-0 items-center gap-2">
        <span class="min-w-0 truncate font-mono text-[12px] text-muted">{address ?? intake.alias}</span>
        {address ? (
          <Button size="xs" ariaLabel={`Copy ${address}`} onClick={() => copy(address)}>
            {copied ? (
              <>
                <Check class="h-3 w-3 text-ok" /> Copied
              </>
            ) : (
              "Copy"
            )}
          </Button>
        ) : (
          <span class="shrink-0 text-[11.5px] text-faint">no intake domain set</span>
        )}
      </div>

      <div class="mt-1.5 flex flex-wrap items-center gap-1">
        <span class="mr-0.5 text-[11.5px] text-faint">From</span>
        {intake.allowedSenders.map((sender) => (
          <Tag key={sender}>{sender}</Tag>
        ))}
      </div>

      {confirming && (
        <Confirm
          message={`Remove ${address ?? intake.alias}? Mail sent to it stops opening tasks in ${label}. Tasks it already opened stay.`}
          confirmLabel="Remove"
          tone="danger"
          onConfirm={() => void remove()}
          onCancel={() => setConfirming(false)}
        />
      )}

      {editing && (
        <div class="mt-2 rounded-lg border border-line bg-raised/40 p-3">
          <IntakeForm
            listId={intake.listId}
            domain={domain}
            initialAlias={intake.alias}
            initialSenders={intake.allowedSenders}
            onSave={save}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}
    </div>
  );
}

export function EmailIntakePanel() {
  const { status, data, error, reload, setData } = useAsync(() => settingsApi.emailIntakes(), []);
  const [adding, setAdding] = useState(false);
  const domain = data?.domain ?? null;
  const intakes = [...(data?.intakes ?? [])].sort(byBoardOrder);

  function upsert(intake: EmailIntake): void {
    setData((prev) =>
      prev && {
        ...prev,
        intakes: [...prev.intakes.filter((i) => i.listId !== intake.listId), intake],
      }
    );
  }

  function drop(listId: string): void {
    setData((prev) => prev && { ...prev, intakes: prev.intakes.filter((i) => i.listId !== listId) });
  }

  async function add(listId: string, input: SetEmailIntakeInput): Promise<void> {
    const saved = await settingsApi.setEmailIntake(listId, input);
    upsert(saved);
    setAdding(false);
    toast(`${listLabel(listId)} now takes mail at ${intakeAddress(saved.alias, domain) ?? saved.alias}.`);
  }

  return (
    <Panel
      title="Email intake"
      description="Mail from a list's allowed senders to its address opens a task in that list, and replies on that email thread land as comments. Mail from anyone else is bounced."
      right={
        <div class="flex items-center gap-2">
          <Button size="xs" disabled={status !== "ok"} onClick={() => setAdding((v) => !v)}>
            Add address
          </Button>
          <Button size="xs" onClick={reload}>
            Refresh
          </Button>
        </div>
      }
    >
      {status === "loading" && <Loading />}
      {status === "error" && error && <ErrorNote message={error} onRetry={reload} />}
      {status === "ok" && data && (
        <>
          {domain === null && (
            <p class="border-b border-line bg-warn/[0.07] px-4 py-2 text-[12px] text-warn">
              The intake domain isn't configured on the server, so these aliases can't receive mail yet.
            </p>
          )}
          {adding && (
            <div class="border-b border-line bg-raised/40 px-4 py-3">
              <IntakeForm
                choices={addChoices(new Set(data.intakes.map((i) => i.listId)))}
                domain={domain}
                onSave={add}
                onCancel={() => setAdding(false)}
              />
            </div>
          )}
          {intakes.length === 0 && !adding && <Empty>No list has an email address yet.</Empty>}
          {intakes.map((intake) => (
            <IntakeRow
              key={intake.listId}
              intake={intake}
              domain={domain}
              onSaved={upsert}
              onRemoved={drop}
            />
          ))}
        </>
      )}
    </Panel>
  );
}
