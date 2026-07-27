// The /settings view: workspace members, then three
// tabs. Mounted by the shell in place of the board when `settingsOpen` is true.
import { setTheme, THEME_LABEL, THEME_PREFS, themePref } from "../lib/theme.js";
import { me, users } from "../store/index.js";
import { cn } from "../shell/format.js";
import { DrawerButton } from "../shell/palette.js";
import { Avatar, Moon, Sun } from "../shell/ui.js";
import { openOnboarding } from "../shell/onboarding.js";
import { AutomationsTab, } from "./Automations.js";
import { ApiKeysTab } from "./ApiKeys.js";
import { InboundTab } from "./Inbound.js";
import { activeTab, closeSettings, SETTINGS_TABS, TAB_LABEL, type SettingsTab } from "./route.js";
import { Panel, Tag, X } from "./ui.js";

export { settingsOpen, openSettings, closeSettings } from "./route.js";

/** Members, straight from the store. No API call, so it renders offline. */
function WorkspaceStrip() {
  // Deactivated accounts keep their history (assignments, comments, audit)
  // but they are not members any more, so the roster doesn't list them.
  const all = [...users.value];
  const members = all
    .filter((u) => !u.deactivated)
    .sort((a, b) => {
      const rank = { owner: 0, admin: 1, member: 2 } as const;
      return rank[a.role] - rank[b.role] || a.name.localeCompare(b.name);
    });
  const gone = all.length - members.length;
  const myId = me.value?.id ?? null;

  return (
    <Panel
      title="Workspace"
      description={`${members.length} member${members.length === 1 ? "" : "s"}.${gone > 0 ? ` ${gone} deactivated account${gone === 1 ? "" : "s"} kept for history.` : ""}`}
    >
      <ul class="divide-y divide-line">
        {members.map((u) => (
          <li key={u.id} class="flex items-center gap-2.5 px-4 py-2">
            <Avatar user={u} size="sm" />
            <span class="min-w-0 flex-1 truncate text-[12.5px] text-text">
              {u.name}
              {u.id === myId && <span class="ml-1.5 text-[11.5px] text-faint">you</span>}
            </span>
            <span class="hidden min-w-0 flex-1 truncate text-[12px] text-muted sm:block">
              {u.email}
            </span>
            <Tag tone={u.role === "member" ? "neutral" : "accent"}>{u.role}</Tag>
          </li>
        ))}
        {members.length === 0 && (
          <li class="px-4 py-6 text-center text-[12.5px] text-faint">No members loaded.</li>
        )}
      </ul>
      {/* The welcome panel is the only place the MCP command and the REST base
          appear together, and people go looking for it days later. A quiet link
          here beats making them clear localStorage to see it again. */}
      <div class="border-t border-line px-4 py-2">
        <button
          type="button"
          onClick={openOnboarding}
          class="text-[12px] font-medium text-accent underline-offset-2 hover:underline"
        >
          Connect an agent
        </button>
        <span class="ml-1.5 text-[12px] text-faint">— reopen the welcome guide.</span>
      </div>
    </Panel>
  );
}

/**
 * Appearance. Three states, not a switch: "System" is a real answer, and a
 * two-position toggle cannot express "whatever the OS is doing right now".
 * The choice is stored in localStorage and re-applied by index.html before the
 * first paint, so it survives a reload without a flash.
 */
function AppearanceStrip() {
  const current = themePref.value;
  return (
    <Panel
      title="Appearance"
      description="Applies to this browser only. System follows your OS setting."
      right={
        <span class="text-faint">
          {current === "light" ? <Sun class="h-4 w-4" /> : <Moon class="h-4 w-4" />}
        </span>
      }
    >
      <div class="flex flex-wrap gap-1.5 px-4 py-3">
        {THEME_PREFS.map((pref) => (
          <button
            key={pref}
            type="button"
            onClick={() => setTheme(pref)}
            aria-pressed={current === pref}
            class={cn(
              "rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-colors",
              current === pref
                ? "border-accent/45 bg-accent-soft text-text"
                : "border-line text-muted hover:border-line-strong hover:text-text"
            )}
          >
            {THEME_LABEL[pref]}
          </button>
        ))}
      </div>
    </Panel>
  );
}

function Tabs() {
  const current = activeTab.value;
  // API keys are self-serve now, so the tab is everyone's: a member sees their
  // own keys and can mint one for their agent. The admin-only extra — every
  // key in the workspace, with who each one impersonates — lives inside it.
  const visible: SettingsTab[] = [...SETTINGS_TABS];
  return (
    <div class="scroll-y flex items-center gap-1 overflow-x-auto border-b border-line">
      {visible.map((tab) => (
        <button
          key={tab}
          type="button"
          onClick={() => {
            activeTab.value = tab;
          }}
          aria-current={current === tab ? "page" : undefined}
          class={cn(
            "-mb-px shrink-0 whitespace-nowrap border-b-2 px-2.5 pb-2 pt-1 text-[13px] font-medium transition-colors",
            current === tab
              ? "border-accent text-text"
              : "border-transparent text-muted hover:text-text"
          )}
        >
          {TAB_LABEL[tab]}
        </button>
      ))}
    </div>
  );
}

/** Header strip. Replaces the board's TopBar while settings is up, so the
 *  breadcrumb never claims you are looking at a list you are not. */
export function SettingsTopBar() {
  return (
    <header class="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line bg-surface pl-3 pr-3 sm:gap-3 sm:px-5">
      <DrawerButton />
      <h1 class="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.01em] text-text">
        Settings
      </h1>
      <button
        type="button"
        onClick={closeSettings}
        class="inline-flex h-[28px] shrink-0 items-center gap-1.5 rounded-lg border border-line px-2 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-text sm:px-2.5"
      >
        <X class="h-3 w-3" />
        <span class="hidden sm:inline">Back to board</span>
        <span class="sm:hidden">Board</span>
      </button>
    </header>
  );
}

export function Settings() {
  const tab = activeTab.value;
  return (
    <div class="mx-auto w-full max-w-[900px] px-3 py-4 sm:px-5 sm:py-5">
      <div class="space-y-4">
        <WorkspaceStrip />
        <AppearanceStrip />
        <Tabs />
        {tab === "automations" && <AutomationsTab />}
        {tab === "api-keys" && <ApiKeysTab />}
        {tab === "inbound" && <InboundTab />}
      </div>
    </div>
  );
}

export default Settings;
