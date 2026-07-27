// Hamburger, breadcrumb, palette trigger, connection.
import { connected, me } from "../store/index.js";
import { listById, spaceOfList } from "./data.js";
import { activeView } from "./nav.js";
import { openSettings } from "../settings/route.js";
import { DrawerButton, PaletteIconButton, PaletteTrigger } from "./palette.js";
import { Avatar } from "./ui.js";

function ConnectionDot() {
  const live = connected.value;
  return (
    <span
      class="flex items-center gap-1.5"
      title={live ? "Live — changes sync as they happen" : "Reconnecting to the workspace"}
    >
      <span
        class={
          live
            ? "h-[6px] w-[6px] rounded-full bg-ok"
            : "h-[6px] w-[6px] animate-pulse rounded-full bg-warn"
        }
      />
      {!live && <span class="hidden text-[11.5px] text-warn sm:inline">reconnecting</span>}
    </span>
  );
}

export function TopBar() {
  const view = activeView.value;
  const list = view.kind === "list" ? listById(view.listId) : undefined;
  const space = view.kind === "list" ? spaceOfList(view.listId) : undefined;

  return (
    <header class="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line bg-surface pl-3 pr-1 sm:gap-3 sm:pl-5 sm:pr-2">
      <DrawerButton />

      <div class="flex min-w-0 flex-1 items-center gap-1.5">
        {view.kind === "my-work" ? (
          <h1 class="truncate text-[14px] font-semibold tracking-[-0.01em] text-text">My Work</h1>
        ) : (
          <>
            {space && (
              <>
                {/* The space is the first thing to give up when the bar is
                    tight — the list name is what tells you where you are. */}
                <span class="hidden truncate text-[13px] text-muted sm:inline">{space.name}</span>
                <span class="hidden text-faint sm:inline">/</span>
              </>
            )}
            <h1 class="truncate text-[14px] font-semibold tracking-[-0.01em] text-text">
              {list?.name ?? "Select a list"}
            </h1>
          </>
        )}
      </div>

      {/* Never a text field: searching happens in the palette, so the affordance
          that looks like one opens it. */}
      <PaletteTrigger />
      <PaletteIconButton />

      <ConnectionDot />

      <button
        type="button"
        onClick={openSettings}
        aria-label="Settings"
        title="Settings"
        class="ml-0.5 inline-flex shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-80 sm:ml-1"
      >
        <Avatar user={me.value} size="md" />
      </button>
    </header>
  );
}
