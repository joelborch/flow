// API keys tab — everyone's, not just admins'.
//
// Keys are self-serve: a member mints one that acts as themselves, which is how
// they connect an agent without filing a ticket. Owner/admin get the same panel
// plus the workspace-wide view, where "who does this key act as" is a real
// column because it can differ from the person reading it.
//
// The plaintext token exists for the duration of one create response and is
// never recoverable, which is why the reveal block is loud about it.
import { useState } from "preact/hooks";
import { APP_ORIGIN, settingsApi, type ApiKeySummary, type CreatedApiKey } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { formatDateTime, relativeTime } from "../shell/format.js";
import { me, users } from "../store/index.js";
import {
  Button, Confirm, CopyBlock, Empty, ErrorNote, Loading, Panel, TextInput, Tag,
  errorMessage, useAsync,
} from "./ui.js";

export function isWorkspaceAdmin(): boolean {
  const role = me.value?.role;
  return role === "owner" || role === "admin";
}

function mcpSnippet(token: string): string {
  return `claude mcp add --transport http flow ${APP_ORIGIN}/mcp \\\n  --header "Authorization: Bearer ${token}"`;
}

/** Shown once, immediately after a create. */
function RevealedKey({ created, onDone }: { created: CreatedApiKey; onDone: () => void }) {
  return (
    <div class="space-y-2.5 border-b border-line bg-accent-soft/60 px-4 py-3">
      <p class="text-[12.5px] text-text">
        <span class="font-semibold">{created.apiKey.name}</span> created, acting as{" "}
        {created.impersonates.name} ({created.impersonates.email}).
      </p>
      <CopyBlock
        label="Token"
        value={created.token}
        warning={created.warning || "This token is shown only once and cannot be recovered."}
      />
      <CopyBlock label="Connect Claude to Flow over MCP" value={mcpSnippet(created.token)} />
      <Button onClick={onDone}>I've stored it</Button>
    </div>
  );
}

function KeyRow({
  apiKey,
  showImpersonates,
  onRevoked,
}: {
  apiKey: ApiKeySummary;
  /** Owner/admin only: a member's list is all their own keys, so the line would
   *  repeat their own name on every row and say nothing. */
  showImpersonates: boolean;
  onRevoked: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const impersonates = users.value.find((u) => u.id === apiKey.userId);
  const revoked = apiKey.revokedAt !== null;

  async function revoke(): Promise<void> {
    setConfirming(false);
    setBusy(true);
    try {
      await settingsApi.revokeApiKey(apiKey.id);
      toast(`Revoked "${apiKey.name}".`);
      onRevoked();
    } catch (err) {
      toast(`Could not revoke "${apiKey.name}": ${errorMessage(err)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="border-b border-line px-4 py-2.5 last:border-b-0">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span class="min-w-0 flex-1">
          <span class="truncate text-[13px] font-medium text-text">{apiKey.name}</span>
          <span class="ml-2 font-mono text-[11px] text-faint">{apiKey.tokenFingerprint}…</span>
          {revoked && (
            <span class="ml-2">
              <Tag tone="danger">revoked</Tag>
            </span>
          )}
          {showImpersonates && (
            <span class="block truncate text-[12px] text-muted">
              acts as {impersonates ? `${impersonates.name} (${impersonates.email})` : apiKey.userId}
            </span>
          )}
        </span>

        <span class="shrink-0 text-[11.5px] text-faint" title={formatDateTime(apiKey.createdAt)}>
          created {relativeTime(apiKey.createdAt)}
        </span>
        <span class="w-[110px] shrink-0 text-[11.5px] text-faint">
          {apiKey.lastUsedAt === null ? "never used" : `used ${relativeTime(apiKey.lastUsedAt)}`}
        </span>

        {!revoked && (
          <Button tone="danger" size="xs" disabled={busy} onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        )}
      </div>

      {confirming && (
        <Confirm
          message={`Revoke "${apiKey.name}"? Anything using it — MCP clients, scripts — stops working immediately.`}
          confirmLabel="Revoke"
          tone="danger"
          onConfirm={() => void revoke()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function CreateKey({
  admin,
  onCreated,
}: {
  /** Only owner/admin may mint a key for somebody else, so only they get the
   *  picker. For everyone else the impersonation is implicitly themselves and
   *  the form is one field. */
  admin: boolean;
  onCreated: (created: CreatedApiKey) => void;
}) {
  const [name, setName] = useState("");
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    try {
      const created = await settingsApi.createApiKey(trimmed, userId || undefined);
      setName("");
      onCreated(created);
    } catch (err) {
      toast(`Could not create the key: ${errorMessage(err)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
      <TextInput
        ariaLabel="New key name"
        placeholder="Key name, e.g. claude-mcp"
        value={name}
        onInput={setName}
        onEnter={() => void create()}
      />
      {admin && (
        <select
          aria-label="Impersonate"
          value={userId}
          onChange={(e) => setUserId((e.currentTarget as HTMLSelectElement).value)}
          class="h-[28px] rounded-lg border border-line bg-surface px-2 text-[12.5px] text-text hover:border-line-strong focus:border-accent/50 focus:outline-none"
        >
          <option value="">Acts as me</option>
          {users.value
            .filter((u) => !u.deactivated)
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
        </select>
      )}
      <Button tone="primary" disabled={busy || name.trim() === ""} onClick={() => void create()}>
        Create key
      </Button>
    </div>
  );
}

export function ApiKeysTab() {
  const { status, data, error, reload } = useAsync(() => settingsApi.apiKeys(), []);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const admin = isWorkspaceAdmin();

  return (
    <div class="space-y-4">
      <Panel
        title={admin ? "API keys" : "My API keys"}
        description={
          admin
            ? "A key impersonates a real user: its actions show up as that person's work, with the key id recorded beside them in the audit trail. You see every key in the workspace."
            : "A key acts as you: anything it does shows up as your work, with the key id recorded beside it in the audit trail. You see and manage only your own keys."
        }
        right={
          <Button size="xs" onClick={reload}>
            Refresh
          </Button>
        }
      >
        <CreateKey
          admin={admin}
          onCreated={(c) => {
            setCreated(c);
            reload();
          }}
        />
        {created && <RevealedKey created={created} onDone={() => setCreated(null)} />}

        {status === "loading" && <Loading />}
        {status === "error" && error && <ErrorNote message={error} onRetry={reload} />}
        {status === "ok" && data && data.length === 0 && (
          <Empty>{admin ? "No API keys yet." : "You have no API keys yet."}</Empty>
        )}
        {status === "ok" &&
          data?.map((k) => (
            <KeyRow key={k.id} apiKey={k} showImpersonates={admin} onRevoked={reload} />
          ))}
      </Panel>

      <Panel
        title="Connect an MCP client"
        description="Mint a key above, then point Claude at Flow's MCP endpoint. The key is the whole credential — there is no separate MCP auth."
      >
        <div class="p-3">
          <CopyBlock label="Terminal" value={mcpSnippet("<token>")} />
        </div>
      </Panel>
    </div>
  );
}
