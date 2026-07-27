// Seam with src/shell/index.tsx. It used to be a lazy `import.meta.glob` seam,
// because the board had to compile and run before the shell module existed;
// now that it does exist, the shell is a static import in main.tsx and this is
// a thin, synchronous forwarder. The exported names and signatures are
// unchanged, so shell and board code that calls through here still works — the
// calls simply no longer wait for a second chunk to arrive, which removed a
// network round trip from between the first paint and a usable board.
import { signal, type ReadonlySignal, type Signal } from "@preact/signals";
import type { ComponentChildren, ComponentType } from "preact";
import { navigate, withTask } from "./router.js";

export type ShellComponent = ComponentType<{ children?: ComponentChildren }>;

/**
 * What the board uses out of the shell module. The shell owns navigation when
 * it is present: it keeps its own view signal and its own URL binding, so we
 * defer to `openTask`/`openList`/`activeListId` rather than pushing history
 * ourselves and racing it.
 */
export type ShellModule = {
  default?: ShellComponent;
  Shell?: ShellComponent;
  openTask?: (taskId: string, opts?: { focus?: "comment" }) => void;
  closeTask?: () => void;
  openList?: (spaceId: string, listId: string) => void;
  activeListId?: ReadonlySignal<string | null>;
};

/** Known at build time: whether the shell module exists at all. Now that it is
 *  statically imported the answer is always yes, and main.tsx registers it
 *  before the first render — no fallback chrome ever flashes. */
export const shellExists = true;

const shellSignal = signal<ShellComponent | null>(null);
/** null until main.tsx registers the module — one synchronous step at startup. */
export const shell: ReadonlySignal<ShellComponent | null> = shellSignal;

/** The resolved module, for the handful of navigation signals main.tsx reads. */
export const shellModule: Signal<ShellModule | null> = signal(null);

/** Called once by main.tsx with the statically imported shell module. */
export function registerShell(mod: ShellModule): void {
  shellSignal.value = mod.default ?? mod.Shell ?? null;
  shellModule.value = mod;
}

/** Kept for callers written against the old lazy seam. Resolves immediately. */
export function loadShell(): Promise<ShellModule | null> {
  return Promise.resolve(shellModule.value);
}

/**
 * Open the task detail panel. The shell handles the URL itself; without it we
 * write the deep link so the panel appears as soon as the shell mounts.
 */
export function openTask(taskId: string, opts?: { focus?: "comment" }): void {
  const mod = shellModule.value;
  if (mod?.openTask) {
    mod.openTask(taskId, opts);
    return;
  }
  navigate(withTask(taskId));
}

export function closeTask(): void {
  const mod = shellModule.value;
  if (mod?.closeTask) {
    mod.closeTask();
    return;
  }
  navigate(withTask(null));
}
