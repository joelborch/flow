// The app frame: sidebar, top bar, main content, and
// the task panel with its URL binding.
//
// Exports consumed by main.tsx / the board:
//   default Shell           — <Shell>{board}</Shell>
//   openTask(taskId)        — opens the panel and pushes /t/:taskId
//   closeTask()             — closes it and restores the previous URL
//   openTaskId, activeView, activeListId, openList, showMyWork
//   openSettings/closeSettings/settingsOpen — the /settings view
//   openPalette/togglePalette/paletteOpen   — the ⌘K command palette
//
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { initTheme, isDark, toggleDark } from "../lib/theme.js";
import { Settings, SettingsTopBar } from "../settings/index.js";
import { openSettings, settingsOpen } from "../settings/route.js";
import { TaskPanel } from "../task/TaskPanel.js";
import { MyWork } from "./MyWork.js";
import { NewListDialog } from "./organize.js";
import { Onboarding } from "./onboarding.js";
import { CommandPalette, togglePalette } from "./palette.js";
import { Sidebar } from "./Sidebar.js";
import { TopBar } from "./TopBar.js";
import { cn } from "./format.js";
import { KEYFRAMES, Moon, Sun } from "./ui.js";
import { activeView, closeDrawer, closeTask, drawerOpen, openTaskId } from "./nav.js";

export {
  activeListId, activeView, closeTask, openList, openTask, openTaskId, showMyWork,
  type View,
} from "./nav.js";
export { openSettings, closeSettings, settingsOpen } from "../settings/route.js";
export { openPalette, closePalette, togglePalette, paletteOpen } from "./palette.js";
export { openOnboarding, dismissOnboarding, ONBOARDED_KEY } from "./onboarding.js";

/**
 * Light/dark toggle in the shell's own header strip, next to the sidebar. The
 * icon shows where a click takes you (moon in light mode, sun in dark), and it
 * commits an explicit choice — see lib/theme's toggleDark. Settings moved to
 * the avatar in the top bar; a gear drawn as a circle with rays read as a sun,
 * so this slot now IS the sun.
 */
function ThemeButton() {
  const dark = isDark.value;
  const label = dark ? "Switch to light mode" : "Switch to dark mode";
  return (
    <div class="flex h-[52px] shrink-0 items-center border-b border-line bg-surface pl-1 pr-3 sm:pr-4">
      <button
        type="button"
        onClick={toggleDark}
        aria-label={label}
        title={label}
        class="inline-flex h-[28px] w-[28px] items-center justify-center rounded-lg text-faint transition-colors hover:bg-bg hover:text-text"
      >
        {dark ? <Sun class="h-4 w-4" /> : <Moon class="h-4 w-4" />}
      </button>
    </div>
  );
}

/**
 * The sidebar's frame. At `sm` and up it is an ordinary flex child. Below that
 * it slides over the board, because 240px of a 375px screen leaves the board
 * unusable. One mounted copy, not two: the nav carries live state (the
 * new-space composer, collapsed spaces) that a second instance would fork.
 */
function SidebarFrame() {
  const open = drawerOpen.value;

  // Escape closes the drawer, in the capture phase and stopped, so the same
  // key does not also close the task panel underneath it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeDrawer();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  return (
    <>
      {open && (
        <div
          onClick={closeDrawer}
          aria-hidden="true"
          class="fixed inset-0 z-40 bg-black/35 animate-[flow-fade-in_120ms_ease-out] sm:hidden"
        />
      )}
      <div
        class={cn(
          "h-full shrink-0 transition-transform duration-200 ease-out",
          "max-sm:fixed max-sm:inset-y-0 max-sm:left-0 max-sm:z-50 max-sm:pl-[env(safe-area-inset-left)]",
          open ? "max-sm:translate-x-0 max-sm:shadow-2xl" : "max-sm:-translate-x-full",
          // Off-screen has to mean out of the tab order too, or Tab walks into
          // an invisible nav. `sm:visible` puts it back at desktop widths.
          !open && "max-sm:invisible sm:visible"
        )}
      >
        <Sidebar />
      </div>
    </>
  );
}

export default function Shell({ children }: { children?: ComponentChildren }) {
  // ⌘K opens the palette. The default is prevented so the browser's own
  // shortcut (Firefox focuses its search bar) never fires alongside it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        togglePalette();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  // index.html's inline script already painted the stored choice before the
  // first frame; this only re-asserts it for anything that bypassed the
  // document boot (a hot reload that swapped <html>, say).
  useEffect(initTheme, []);

  const taskId = openTaskId.value;
  const view = activeView.value;
  // Settings owns the whole main area (and its own header) rather than sitting
  // over the board, so /settings is a real, deep-linkable location.
  const settings = settingsOpen.value;

  return (
    <div class="flex h-screen w-full overflow-hidden bg-bg font-sans text-text antialiased">
      <style>{KEYFRAMES}</style>

      <SidebarFrame />

      <div class="flex min-w-0 flex-1 flex-col">
        {settings ? (
          <SettingsTopBar />
        ) : (
          <div class="flex shrink-0 items-stretch">
            <div class="min-w-0 flex-1">
              <TopBar />
            </div>
            <ThemeButton />
          </div>
        )}
        <main class="scroll-y min-h-0 flex-1 overflow-y-auto">
          {settings ? <Settings /> : view.kind === "my-work" ? <MyWork /> : children}
        </main>
      </div>

      {taskId !== null && <TaskPanel taskId={taskId} onClose={closeTask} />}

      {/* Mounted on the frame rather than inside the nav: the palette's
          "New list…" opens it, and below `sm` the nav is translated off-screen
          — a dialog parented to it would go with it. */}
      <NewListDialog />
      <CommandPalette />

      {/* Sits above everything, including the palette, and mounts unconditionally
          — it decides for itself whether this is a first sign-in. */}
      <Onboarding />
    </div>
  );
}
