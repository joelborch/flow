// Transient notices. Optimistic mutations that fail roll back and post one.
import { signal } from "@preact/signals";

export type ToastKind = "error" | "info";
export type Toast = { id: number; kind: ToastKind; message: string };

export const toasts = signal<Toast[]>([]);

let nextId = 1;

export function toast(message: string, kind: ToastKind = "info", ttlMs = 5000): void {
  const id = nextId++;
  toasts.value = [...toasts.value, { id, kind, message }];
  setTimeout(() => dismissToast(id), ttlMs);
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}
