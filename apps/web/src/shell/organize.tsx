// Creating and reshaping the sidebar's own furniture:
// the "+ New space" composer, the per-space "+ New list" dialog with its
// status-set picker, and the inline rename used by both row menus.
//
// The pieces the Sidebar mounts once, at its root:
//   <NewListDialog />        — reads `newListFor`, so any row's + can open it
// and the pieces it renders per row:
//   <NewSpaceComposer />, <RenameRow />, <RowMenu />
//
// Cross-row UI state lives in module signals rather than lifted component
// state, because the menu that starts a rename is unmounted by the time the
// input needs focus.
import { signal, type Signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Status } from "@flow/shared";
import { createList, createSpace, lists } from "../store/index.js";
import { cn } from "./format.js";
import { openList } from "./nav.js";
import { expandSpace } from "./prefs.js";
import { Menu, MenuItem, Plus, useDialogFocus } from "./ui.js";

// --- shared row state ------------------------------------------------------

/** Space id whose "New list" dialog is open, or null. */
export const newListFor: Signal<string | null> = signal(null);
/** Space or list id currently being renamed inline, or null. */
export const renamingId: Signal<string | null> = signal(null);
/** Whether the sidebar's "+ New space" row is expanded into its input. A
 *  module signal rather than component state so the command palette can open
 *  it without reaching into the Sidebar's tree. */
export const newSpaceOpen: Signal<boolean> = signal(false);

export function startRename(id: string): void {
  renamingId.value = id;
}

// --- status sets -----------------------------------------------------------

export type StatusSpec = Pick<Status, "name" | "color" | "type">;

/** Mirrors the server's fallback, so the "Default" chips are not a guess. */
export const DEFAULT_STATUSES: StatusSpec[] = [
  { name: "To Do", color: "#8b8f9a", type: "open" },
  { name: "In Progress", color: "#3b82f6", type: "custom" },
  { name: "Done", color: "#22c55e", type: "closed" },
];

export type StatusSetOption = {
  /** "default", or the name+type signature shared by every list using this set. */
  key: string;
  label: string;
  statuses: StatusSpec[];
};

/**
 * One entry per distinct status set in the workspace, labelled by the first
 * list using it. Two lists share a set when their statuses read the same
 * names in the same order with the same types — colour is presentation and
 * deliberately not part of the identity.
 */
export function statusSetOptions(): StatusSetOption[] {
  const seen = new Map<string, StatusSetOption>();
  for (const l of [...lists.value].sort((a, b) => a.position - b.position)) {
    const ordered = [...l.statuses].sort((a, b) => a.position - b.position);
    const key = ordered.map((s) => `${s.name.toLowerCase()}\u0000${s.type}`).join("|");
    if (seen.has(key)) continue;
    seen.set(key, {
      key,
      label: l.name,
      statuses: ordered.map(({ name, color, type }) => ({ name, color, type })),
    });
  }
  return [...seen.values()];
}

function StatusChips({ statuses }: { statuses: StatusSpec[] }) {
  return (
    <div class="mt-1.5 flex flex-wrap gap-1">
      {statuses.map((s) => (
        <span
          key={s.name}
          class="inline-flex items-center gap-1 rounded border border-line px-1.5 py-[1px] text-[11px] text-muted"
        >
          <span class="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

// --- inline rename ---------------------------------------------------------

/**
 * A one-field inline editor sized to sit exactly where the row's label was.
 * Enter commits (blank or unchanged just cancels), Escape and blur abandon.
 */
export function RenameRow({
  value,
  onCommit,
  onCancel,
  class: cls,
}: {
  value: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  class?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = (): void => {
    const next = ref.current?.value.trim() ?? "";
    if (next === "" || next === value) onCancel();
    else onCommit(next);
  };

  return (
    <input
      ref={ref}
      type="text"
      defaultValue={value}
      spellcheck={false}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
      class={cn(
        // No ring of our own: styles.css draws a global :focus-visible outline
        // in the accent, and this field is always focused while it exists.
        "w-full min-w-0 rounded-md border border-line bg-bg px-1.5 py-[3px] text-[13px] text-text",
        cls
      )}
    />
  );
}

// --- row menu --------------------------------------------------------------

export type RowAction = { label: string; onSelect: () => void };

/** The ⋯ affordance. Hidden until the row is hovered, focused, or active. */
export function RowMenu({
  label,
  actions,
  show,
  class: cls,
}: {
  label: string;
  actions: RowAction[];
  show?: boolean;
  class?: string;
}) {
  return (
    <span
      class={cn(
        "shrink-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
        show ? "opacity-100" : "opacity-0",
        cls
      )}
    >
      <Menu
        label={label}
        width="w-44"
        align="right"
        trigger={() => (
          <span class="flex h-5 w-5 items-center justify-center rounded text-faint hover:bg-raised hover:text-muted">
            <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
              <circle cx="3.5" cy="8" r="1.15" />
              <circle cx="8" cy="8" r="1.15" />
              <circle cx="12.5" cy="8" r="1.15" />
            </svg>
          </span>
        )}
      >
        {(close) =>
          actions.map((a) => (
            <MenuItem
              key={a.label}
              onClick={() => {
                close();
                a.onSelect();
              }}
            >
              {a.label}
            </MenuItem>
          ))
        }
      </Menu>
    </span>
  );
}

/** The subtle + on a space header row. */
export function AddListButton({ spaceId, show }: { spaceId: string; show?: boolean }) {
  return (
    <button
      type="button"
      title="New list"
      aria-label="New list"
      onClick={(e) => {
        e.stopPropagation();
        newListFor.value = spaceId;
      }}
      class={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint transition-opacity",
        "hover:bg-raised hover:text-muted focus-visible:opacity-100 group-hover:opacity-100",
        show ? "opacity-100" : "opacity-0"
      )}
    >
      <Plus class="h-3 w-3" />
    </button>
  );
}

// --- new space composer ----------------------------------------------------

/**
 * Collapsed to a quiet "+ New space" row until clicked. Enter creates the
 * space and drops straight into naming its first list, because a space with no
 * lists has nowhere to navigate to.
 */
export function NewSpaceComposer() {
  const open = newSpaceOpen.value;
  const setOpen = (v: boolean): void => {
    newSpaceOpen.value = v;
  };
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);

  const submit = async (): Promise<void> => {
    const name = ref.current?.value.trim() ?? "";
    if (name === "" || busy) return;
    setBusy(true);
    const space = await createSpace({ name, visibility: "private" });
    setBusy(false);
    setOpen(false);
    if (space) {
      expandSpace(space.id);
      newListFor.value = space.id;
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="flex w-full items-center gap-2 rounded-lg px-2 py-[6px] text-[13px] text-muted transition-colors hover:bg-raised hover:text-text"
      >
        <Plus class="h-3.5 w-3.5 text-faint" />
        <span class="min-w-0 flex-1 truncate text-left">New space</span>
      </button>
    );
  }

  return (
    <div class="px-2 py-[3px]">
      <input
        ref={ref}
        type="text"
        placeholder="Space name"
        spellcheck={false}
        disabled={busy}
        onBlur={() => {
          if (!busy) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        class="w-full rounded-md border border-line bg-bg px-2 py-[4px] text-[13px] text-text placeholder:text-faint"
      />
    </div>
  );
}

// --- new list dialog -------------------------------------------------------

/**
 * Mounted once by the Sidebar; opens whenever `newListFor` names a space.
 * Escape closes, Enter in the name field submits, and the picker offers the
 * server default plus every status set already in use in the workspace.
 */
export function NewListDialog() {
  const spaceId = newListFor.value;
  if (spaceId === null) return null;
  return <NewListForm spaceId={spaceId} onClose={() => (newListFor.value = null)} />;
}

function NewListForm({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const options = statusSetOptions();
  const [choice, setChoice] = useState("default");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // Runs after the effect above, so it finds the name input already focused
  // and leaves it alone — it only traps Tab within the dialog and restores
  // focus to whatever had it (the "+ New list" button) once this unmounts.
  useDialogFocus(dialogRef);

  // Capture phase, and stopped, so the task panel's own Escape never also fires.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const submit = async (): Promise<void> => {
    const name = ref.current?.value.trim() ?? "";
    if (name === "" || busy) return;
    const picked = options.find((o) => o.key === choice);
    setBusy(true);
    const list = await createList({
      spaceId,
      name,
      // Omitted entirely for the default, so the server owns that definition.
      ...(picked ? { statuses: picked.statuses } : {}),
    });
    setBusy(false);
    onClose();
    // Only a server-assigned id is worth putting in the URL; a failed create
    // has already rolled the optimistic row back and toasted.
    if (list) openList(spaceId, list.id);
  };

  return (
    <div
      class="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[18vh] animate-[flow-fade-in_120ms_ease-out]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="New list"
        class="w-[400px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border border-line bg-surface shadow-xl shadow-black/[0.12] animate-[flow-pop_120ms_ease-out]"
      >
        <div class="border-b border-line px-4 py-3">
          <input
            ref={ref}
            type="text"
            placeholder="List name"
            spellcheck={false}
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            class="w-full bg-transparent text-[14px] font-medium text-text placeholder:text-faint"
          />
        </div>

        <div class="max-h-[46vh] overflow-y-auto px-2 py-2">
          <p class="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">
            Statuses
          </p>
          <StatusSetChoice
            selected={choice === "default"}
            onSelect={() => setChoice("default")}
            title="Default"
            statuses={DEFAULT_STATUSES}
          />
          {options.map((o) => (
            <StatusSetChoice
              key={o.key}
              selected={choice === o.key}
              onSelect={() => setChoice(o.key)}
              title={`Copy from ${o.label}`}
              statuses={o.statuses}
            />
          ))}
        </div>

        <div class="flex items-center justify-end gap-2 border-t border-line px-3 py-2.5">
          <button
            type="button"
            onClick={onClose}
            class="rounded-lg px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-raised hover:text-text"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            class="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Create list
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusSetChoice({
  selected,
  onSelect,
  title,
  hint,
  statuses,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  hint?: string;
  statuses: StatusSpec[];
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      class={cn(
        "mb-0.5 block w-full rounded-lg border px-2.5 py-2 text-left transition-colors",
        selected ? "border-accent/45 bg-accent-soft" : "border-transparent hover:bg-raised"
      )}
    >
      <span class="flex items-center gap-1.5">
        <span
          class={cn(
            "h-3 w-3 shrink-0 rounded-full border",
            selected ? "border-[4px] border-accent" : "border-line-strong"
          )}
        />
        <span class="min-w-0 flex-1 truncate text-[13px] text-text">{title}</span>
        {hint && <span class="shrink-0 text-[11px] text-faint">{hint}</span>}
      </span>
      <StatusChips statuses={statuses} />
    </button>
  );
}
