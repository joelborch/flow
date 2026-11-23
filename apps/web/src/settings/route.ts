// The /settings route.
//
// Settings is a full-screen view rather than an overlay, so it owns the URL:
// /settings is deep-linkable and Back returns to whatever board was underneath.
// It is kept out of lib/router's three-slot parse because it has no ids in it —
// a boolean derived from the pathname is the whole state.
import { signal, type ReadonlySignal, type Signal } from "@preact/signals";
import { navigate, route } from "../lib/router.js";

export const SETTINGS_PATH = "/settings";

function isSettingsPath(path: string): boolean {
  return path === SETTINGS_PATH || path.startsWith(`${SETTINGS_PATH}/`);
}

const open: Signal<boolean> = signal(
  typeof location !== "undefined" && isSettingsPath(location.pathname)
);

/** True while the settings view owns the main area. Read by main.tsx too, so a
 *  list-less /settings URL is not bounced to the first list on hydration. */
export const settingsOpen: ReadonlySignal<boolean> = open;

/** Where Back-to-board should land. Null on a cold deep link. */
let boardPath: string | null = null;

export function openSettings(): void {
  if (open.value) return;
  const from = route.value.path;
  boardPath = isSettingsPath(from) ? null : from;
  open.value = true;
  navigate(`${SETTINGS_PATH}/${activeTab.value}`);
}

export function closeSettings(): void {
  if (!open.value) return;
  open.value = false;
  // "/" lets main.tsx's own default-route redirect land on My Work, which is
  // the right answer when settings was opened cold from a deep link.
  navigate(boardPath ?? "/");
}

// Back/Forward move between /settings and a board URL, so the flag follows the
// history entry rather than the click that created it.
if (typeof window !== "undefined") {
  addEventListener("popstate", () => {
    open.value = isSettingsPath(location.pathname);
    const tab = tabFromPath(location.pathname);
    if (tab) activeTab.value = tab;
  });
}

// --- tabs ------------------------------------------------------------------

export const SETTINGS_TABS = ["general", "automations", "api-keys", "inbound", "spaces"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const TAB_LABEL: Record<SettingsTab, string> = {
  general: "General",
  automations: "Automations",
  "api-keys": "API keys",
  inbound: "Inbound",
  spaces: "Spaces",
};

/** The tab named by /settings/<tab>, or null for a bare /settings. */
function tabFromPath(path: string): SettingsTab | null {
  const name = path.startsWith(`${SETTINGS_PATH}/`) ? path.slice(SETTINGS_PATH.length + 1).split("/")[0] : "";
  return (SETTINGS_TABS as readonly string[]).includes(name ?? "") ? (name as SettingsTab) : null;
}

/**
 * The open tab. It lives in the address (/settings/<tab>), so a reload or a
 * shared link lands on the same section; module-level too, so it survives a
 * trip to the board and back.
 */
export const activeTab: Signal<SettingsTab> = signal(
  (typeof location !== "undefined" ? tabFromPath(location.pathname) : null) ?? "general"
);

export function setSettingsTab(tab: SettingsTab): void {
  activeTab.value = tab;
  // Replace, not push: flipping tabs shouldn't stack up Back presses.
  if (open.value) navigate(`${SETTINGS_PATH}/${tab}`, { replace: true });
}
