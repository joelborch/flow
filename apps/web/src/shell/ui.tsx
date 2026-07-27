// Shared visual primitives: icons, avatars, menus,
// chips. One accent (#5b5bd6) is used across the whole app; everything else is
// restrained neutrals.
import type { ComponentChildren, VNode } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Priority, User } from "@flow/shared";
import { avatarHue, initials, PRIORITY_COLOR, PRIORITY_LABEL } from "../lib/fmt.js";
import { cn } from "./format.js";

// Priority colour/label and the avatar hue come from lib/fmt so a chip in the
// panel and the same chip on a board card are identical.
export { PRIORITY_COLOR, PRIORITY_LABEL };

// --- icons -----------------------------------------------------------------
// 16px grid, 1.6 stroke, currentColor. Deliberately spare.

type IconProps = { class?: string };

function svg(path: VNode | VNode[]) {
  return function Icon({ class: cls }: IconProps) {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        class={cn("h-4 w-4 shrink-0", cls)}
      >
        {path}
      </svg>
    );
  };
}

export const ChevronRight = svg(<path d="M6 3.5 10.5 8 6 12.5" />);
export const ChevronDown = svg(<path d="M3.5 6 8 10.5 12.5 6" />);
export const Check = svg(<path d="M3 8.5 6.25 11.75 13 5" />);
export const X = svg(<path d="M4 4l8 8M12 4l-8 8" />);
export const Plus = svg(<path d="M8 3.5v9M3.5 8h9" />);
export const Search = svg([
  <circle cx="7" cy="7" r="3.75" />,
  <path d="M10 10l3 3" />,
]);
export const Inbox = svg([
  <path d="M2 8.5h3l1 2h4l1-2h3" />,
  <path d="M3.5 3.5h9l1.5 5v4.5h-12V8.5l1.5-5Z" />,
]);
export const CalendarIcon = svg([
  <rect x="2.5" y="3.5" width="11" height="10" rx="2" />,
  <path d="M2.5 6.5h11M5.5 2v2M10.5 2v2" />,
]);
export const FlagIcon = svg(<path d="M4 14V2.5h8l-1.5 3 1.5 3H4" />);
export const TagIcon = svg([
  <path d="M8.5 2.5H13V7l-6 6-4.5-4.5 6-6Z" />,
  <circle cx="10.75" cy="5.25" r=".9" fill="currentColor" stroke="none" />,
]);
export const Paperclip = svg(
  <path d="M11 6 6.5 10.5a2.12 2.12 0 0 0 3 3l4-4a3.5 3.5 0 0 0-5-5l-4.5 4.5a4.5 4.5 0 0 0 6.5 6.5" />
);
export const Upload = svg([
  <path d="M8 11V3.5" />,
  <path d="M5 6.5 8 3.5l3 3" />,
  <path d="M3 11v1.5h10V11" />,
]);
export const Archive = svg([
  <rect x="2.5" y="3" width="11" height="3" rx="1" />,
  <path d="M3.5 6v6.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6M6.5 9h3" />,
]);
export const Bars = svg(<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />);
export const ListIcon = svg([
  <path d="M3 4.5h10M3 8h10M3 11.5h6" />,
]);
export const SpaceIcon = svg([
  <path d="M8 2 14 5.25 8 8.5 2 5.25 8 2Z" />,
  <path d="M2.5 8.5 8 11.5l5.5-3M2.5 11.5 8 14.5l5.5-3" />,
]);
export const Moon = svg(<path d="M13 9.6A5.6 5.6 0 0 1 6.4 3a5.6 5.6 0 1 0 6.6 6.6Z" />);
export const Sun = svg([
  <circle cx="8" cy="8" r="2.8" />,
  <path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />,
]);
export const PersonIcon = svg([
  <circle cx="8" cy="5.2" r="2.6" fill="none" />,
  <path d="M2.9 13.4a5.3 5.3 0 0 1 10.2 0" />,
]);
export const GearSmall = svg([
  <circle cx="8" cy="8" r="2.1" />,
  <path d="M8 1.8v1.6M8 12.6v1.6M2.2 8h1.6M12.2 8h1.6M3.9 3.9l1.1 1.1M11 11l1.1 1.1M12.1 3.9 11 5M5 11l-1.1 1.1" />,
]);

// --- avatar ----------------------------------------------------------------

export function Avatar({
  user,
  size = "md",
  title,
}: {
  user: User | null | undefined;
  size?: "xs" | "sm" | "md";
  title?: string;
}) {
  const dims =
    size === "xs" ? "h-4 w-4 text-[8px]"
    : size === "sm" ? "h-5 w-5 text-[9px]"
    : "h-6 w-6 text-[10px]";

  if (!user) {
    return (
      <span
        title={title ?? "Unassigned"}
        class={cn(
          "inline-flex items-center justify-center rounded-full border border-dashed border-line-strong text-faint",
          dims
        )}
      >
        <svg viewBox="0 0 16 16" class="h-2.5 w-2.5" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="6" r="2.4" />
          <path d="M3.2 14c.4-2.6 2.4-4 4.8-4s4.4 1.4 4.8 4Z" />
        </svg>
      </span>
    );
  }

  return (
    <span
      title={title ?? user.name}
      style={{ backgroundColor: `hsl(${avatarHue(user)} 42% 48%)` }}
      class={cn(
        "inline-flex select-none items-center justify-center rounded-full font-semibold uppercase tracking-tight text-white",
        user.deactivated && "opacity-45 saturate-50",
        dims
      )}
    >
      {initials(user.name)}
    </span>
  );
}

// --- priority --------------------------------------------------------------

export const PRIORITIES: Priority[] = ["urgent", "high", "normal", "low"];

export function PriorityFlag({ priority, class: cls }: { priority: Priority; class?: string }) {
  return (
    <span style={{ color: PRIORITY_COLOR[priority] }} class={cn("inline-flex", cls)}>
      <FlagIcon class="h-3.5 w-3.5" />
    </span>
  );
}

// --- status dot ------------------------------------------------------------

export function StatusDot({ color, class: cls }: { color: string; class?: string }) {
  return (
    <span
      style={{ borderColor: color, backgroundColor: `${color}26` }}
      class={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px]", cls)}
    />
  );
}

// --- menu (popover) -------------------------------------------------------
// Escape is handled in the capture phase and stopped, so a nested menu closes
// before the task panel's own Escape handler sees the key.

export function Menu({
  trigger,
  children,
  width = "w-60",
  align = "left",
  label,
}: {
  trigger: (state: { open: boolean }) => ComponentChildren;
  children: (close: () => void) => ComponentChildren;
  width?: string;
  align?: "left" | "right";
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div class="relative" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        class="block max-w-full rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {trigger({ open })}
      </button>
      {open && (
        <div
          role="menu"
          class={cn(
            "absolute z-40 mt-1.5 origin-top overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-xl shadow-black/[0.08]",
            "animate-[flow-pop_120ms_ease-out]",
            width,
            align === "right" ? "right-0" : "left-0"
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  selected,
  danger,
}: {
  children: ComponentChildren;
  onClick: () => void;
  selected?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      class={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] outline-none",
        danger ? "text-danger hover:bg-danger-soft" : "text-text hover:bg-bg",
        selected && !danger && "font-medium text-text"
      )}
    >
      <span class="min-w-0 flex-1 truncate">{children}</span>
      {selected && <Check class="h-3.5 w-3.5 text-accent" />}
    </button>
  );
}

// --- misc ------------------------------------------------------------------

export function SectionLabel({ children, right }: { children: ComponentChildren; right?: ComponentChildren }) {
  return (
    <div class="mb-2.5 flex items-center justify-between">
      <h3 class="text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">{children}</h3>
      {right}
    </div>
  );
}

export function Chip({
  children,
  onRemove,
  tone = "neutral",
  title,
}: {
  children: ComponentChildren;
  onRemove?: () => void;
  tone?: "neutral" | "accent" | "warn";
  title?: string;
}) {
  return (
    <span
      title={title}
      class={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium",
        tone === "accent" && "bg-accent/10 text-accent",
        tone === "warn" && "bg-danger-soft text-danger",
        tone === "neutral" && "bg-bg text-muted"
      )}
    >
      <span class="truncate">{children}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove"
          class="-mr-0.5 rounded p-0.5 opacity-55 transition-opacity hover:opacity-100"
        >
          <X class="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}

/** Global keyframes. Rendered once by the Shell; styles.css is not ours. */
export const KEYFRAMES = `
@keyframes flow-pop { from { opacity: 0; transform: translateY(-2px) scale(.985) } to { opacity: 1; transform: none } }
@keyframes flow-slide-in { from { transform: translateX(16px); opacity: .4 } to { transform: none; opacity: 1 } }
@keyframes flow-fade-in { from { opacity: 0 } to { opacity: 1 } }
`;
