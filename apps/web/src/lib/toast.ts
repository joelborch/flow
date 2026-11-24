// Transient notices. Optimistic mutations that fail roll back and post one; a
// change that can be reversed posts one carrying an Undo.
import { signal } from "@preact/signals";

export type ToastKind = "error" | "info";
export type ToastAction = { label: string; run: () => void };
export type Toast = { id: number; kind: ToastKind; message: string; action?: ToastAction };

export const toasts = signal<Toast[]>([]);

let nextId = 1;

export function toast(message: string, kind: ToastKind = "info", ttlMs = 5000, action?: ToastAction): number {
  const id = nextId++;
  toasts.value = [...toasts.value, { id, kind, message, ...(action ? { action } : {}) }];
  setTimeout(() => dismissToast(id), ttlMs);
  return id;
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

// --- undo --------------------------------------------------------------------
// One undo is live at a time: the newest reversible change. Changes made in the
// same tick (a bulk edit applies one update per task) share a single toast.

const UNDO_TTL_MS = 7000;
type UndoItem = { label: string; run: () => void };
let pending: UndoItem[] = [];
let scheduled = false;
let live: { id: number; items: UndoItem[] } | null = null;

/**
 * Offer to reverse a change that was just made. Returns a function that
 * withdraws the offer, for a change the server then refused: it was rolled
 * back already, so there is nothing left to undo.
 */
export function offerUndo(label: string, run: () => void): () => void {
  const item: UndoItem = { label, run };
  pending.push(item);
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const items = pending;
      pending = [];
      if (items.length === 0) return;
      if (live) dismissToast(live.id);
      const entry = { id: 0, items };
      entry.id = toast(items.length === 1 ? items[0]!.label : `${items.length} tasks changed`, "info", UNDO_TTL_MS, {
        label: "Undo",
        run: () => {
          undoLast();
        },
      });
      live = entry;
      setTimeout(() => {
        if (live === entry) live = null;
      }, UNDO_TTL_MS);
    });
  }
  return () => {
    pending = pending.filter((p) => p !== item);
    if (!live || !live.items.includes(item)) return;
    live.items = live.items.filter((p) => p !== item);
    if (live.items.length === 0) {
      dismissToast(live.id);
      live = null;
    }
  };
}

/** Reverse the newest change while its toast is still up. Returns whether it did. */
export function undoLast(): boolean {
  const entry = live;
  if (!entry) return false;
  live = null;
  dismissToast(entry.id);
  for (const item of entry.items) item.run();
  return true;
}
