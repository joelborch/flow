// Appearance preference: System / Light / Dark.
//
// The palette itself lives in styles.css. The contract between the two is one
// attribute on <html>:
//
//   data-theme absent      — follow the OS (`prefers-color-scheme`)
//   data-theme="dark"      — dark, whatever the OS says
//   data-theme="light"     — light, whatever the OS says
//
// index.html sets the attribute from localStorage before the first paint, so a
// dark-mode reload never flashes white. This module is the same logic in the
// app, plus a signal so the toggle and the settings strip stay in sync.
import { computed, signal, type ReadonlySignal, type Signal } from "@preact/signals";

export type ThemePref = "system" | "light" | "dark";

export const THEME_KEY = "flow.theme";
export const THEME_PREFS: ThemePref[] = ["system", "light", "dark"];

export const THEME_LABEL: Record<ThemePref, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function isPref(v: unknown): v is ThemePref {
  return v === "system" || v === "light" || v === "dark";
}

function stored(): ThemePref {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return isPref(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

/** The OS preference, kept live so "System" relabels when the OS flips. */
const osDark: Signal<boolean> = signal(
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
);

if (typeof matchMedia === "function") {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const sync = (): void => {
    osDark.value = mq.matches;
  };
  // Safari <14 only has the deprecated form; both are cheap to try.
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", sync);
  else mq.addListener(sync);
}

export const themePref: Signal<ThemePref> = signal(stored());

/** What is actually on screen right now. */
export const isDark: ReadonlySignal<boolean> = computed(() =>
  themePref.value === "system" ? osDark.value : themePref.value === "dark"
);

function paint(pref: ThemePref): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

export function setTheme(pref: ThemePref): void {
  themePref.value = pref;
  paint(pref);
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* private mode — the choice still holds for this page */
  }
}

/**
 * The palette's one-key affordance. It commits an explicit choice rather than
 * bouncing back to "system", because a toggle that sometimes lands on "follow
 * the OS" flips to the wrong colour half the time.
 */
export function toggleDark(): void {
  setTheme(isDark.value ? "light" : "dark");
}

/** Re-assert the stored preference in case the inline script was skipped. */
export function initTheme(): void {
  paint(themePref.value);
}
