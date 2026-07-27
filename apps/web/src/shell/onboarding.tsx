// The first-login welcome overlay.
//
// It exists for one reason: a new person lands on a board they have never seen,
// and the two things they need — the keyboard, and a key for their agent — are
// both invisible until somebody points at them. So it is three short steps in a
// single panel rather than a wizard: nothing to page through, one button that
// actually does something, and Esc gets you out for good.
//
// "For good" is a localStorage flag, not server state. Getting the panel again
// after clearing a browser is a far smaller cost than a workspace-wide write on
// every first paint, and Settings keeps a link that reopens it deliberately.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { APP_ORIGIN, settingsApi, type CreatedApiKey } from "../lib/api.js";
import { Button, CopyBlock, ErrorNote, errorMessage } from "../settings/ui.js";
import { me } from "../store/index.js";
import { X } from "./ui.js";

/** Bump the suffix to show a rewritten welcome to people who saw the old one. */
export const ONBOARDED_KEY = "flow.onboarded.v1";

const onboardingOpen = signal(false);

/** localStorage throws in a locked-down browser; a welcome panel is never worth
 *  taking the app down for, so both sides fail quiet. */
function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) !== null;
  } catch {
    // Unreadable storage means we cannot prove they are new — assume they are
    // not, rather than showing the panel on every single load.
    return true;
  }
}

function markOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDED_KEY, String(Date.now()));
  } catch {
    /* the panel still closes; it may return next session */
  }
}

/** Settings' "Connect an agent" link. Reopens the panel for reference. */
export function openOnboarding(): void {
  onboardingOpen.value = true;
}

/** Esc, Skip, or the close button. Dismiss and completion are the same act:
 *  once you have seen it, you have seen it. */
export function dismissOnboarding(): void {
  markOnboarded();
  onboardingOpen.value = false;
}

/** Auto-open runs at most once per page load, whatever `me` does afterwards. */
let autoOpenChecked = false;

const MCP_COMMAND = (token: string) =>
  `claude mcp add --transport http flow ${APP_ORIGIN}/mcp \\\n  --header "Authorization: Bearer ${token}"`;

const REST_NOTE = (token: string) =>
  `Base URL: ${APP_ORIGIN}/api\nAuthorization: Bearer ${token}`;

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children?: ComponentChildren;
}) {
  return (
    <section class="flex gap-3 border-b border-line px-4 py-3.5 last:border-b-0 sm:px-5">
      <span class="mt-[1px] inline-flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11.5px] font-semibold text-accent">
        {n}
      </span>
      <div class="min-w-0 flex-1 space-y-2">
        <h3 class="text-[13px] font-semibold tracking-[-0.01em] text-text">{title}</h3>
        {children}
      </div>
    </section>
  );
}

function Key({ children }: { children: ComponentChildren }) {
  return (
    <kbd class="rounded-[5px] border border-line bg-raised px-1.5 py-0.5 font-sans text-[11.5px] font-medium text-text">
      {children}
    </kbd>
  );
}

/**
 * Step 2. The button is the whole point of the screen: one click turns "you
 * could connect an agent" into two blocks you paste into a terminal. The token
 * comes back exactly once, so the reveal says so and never re-fetches.
 */
function ConnectAgent() {
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setCreated(await settingsApi.createApiKey("my-agent"));
    } catch (err) {
      // Left retryable on purpose: the usual failure here is the Worker not
      // running yet, which fixes itself a second later.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!created) {
    return (
      <>
        <p class="text-[12.5px] leading-relaxed text-muted">
          Mint a key that acts as you, then paste the command below into your terminal. Anything the
          agent does shows up as your work, with the key recorded beside it.
        </p>
        {error && <ErrorNote message={error} />}
        <Button tone="primary" disabled={busy} onClick={() => void create()}>
          {busy ? "Creating…" : error ? "Try again" : "Create my API key"}
        </Button>
      </>
    );
  }

  return (
    <div class="space-y-2.5">
      <CopyBlock
        label="Claude Code"
        value={MCP_COMMAND(created.token)}
        warning={created.warning || "This token is shown only once and cannot be recovered."}
      />
      <CopyBlock label="Any REST client" value={REST_NOTE(created.token)} />
    </div>
  );
}

export function Onboarding() {
  const open = onboardingOpen.value;
  // The trigger: storage says they are new, and we know who they are. Waiting
  // for `me` keeps the panel from flashing over a still-blank shell, and keeps
  // step 2's create call from firing before auth has resolved.
  const identified = me.value !== null;

  useEffect(() => {
    if (autoOpenChecked || !identified) return;
    autoOpenChecked = true;
    if (!hasOnboarded()) onboardingOpen.value = true;
  }, [identified]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      dismissOnboarding();
    };
    // Capture, and stopped: Esc here must not also close the task panel or the
    // drawer sitting underneath the overlay.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Flow"
      class="fixed inset-0 z-[80] flex bg-black/40 animate-[flow-fade-in_120ms_ease-out] sm:items-center sm:justify-center sm:p-6"
    >
      <div
        class={
          // Full-screen below sm — a 375px viewport has no room for a card with
          // a margin — and a centered, scrollable panel above it.
          "scroll-y flex w-full flex-col overflow-y-auto border-line bg-surface " +
          "max-sm:h-full max-sm:pb-[env(safe-area-inset-bottom)] " +
          "sm:max-h-full sm:max-w-[560px] sm:rounded-xl sm:border sm:shadow-2xl"
        }
      >
        <header class="flex items-start gap-3 border-b border-line px-4 py-3.5 sm:px-5">
          <div class="min-w-0 flex-1">
            <h2 class="text-[15px] font-semibold tracking-[-0.01em] text-text">Welcome to Flow</h2>
            <p class="mt-0.5 text-[12.5px] leading-relaxed text-muted">
              Your workspace, minus the ceremony. Three things worth knowing before you start.
            </p>
          </div>
          <button
            type="button"
            onClick={dismissOnboarding}
            aria-label="Close"
            class="inline-flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-bg hover:text-text"
          >
            <X class="h-3 w-3" />
          </button>
        </header>

        <Step n={1} title="The keyboard is the fast path">
          <ul class="space-y-1 text-[12.5px] leading-relaxed text-muted">
            <li>
              <Key>⌘K</Key> <span class="ml-1">jump to any task, list or action.</span>
            </li>
            <li>
              <Key>?</Key> <span class="ml-1">every shortcut on the board.</span>
            </li>
            <li>
              <Key>N</Key> <span class="ml-1">new task, right where you are.</span>
            </li>
          </ul>
        </Step>

        <Step n={2} title="Connect your AI agent">
          <ConnectAgent />
        </Step>

        <Step n={3} title="Your work lives here">
          <p class="text-[12.5px] leading-relaxed text-muted">
            <span class="font-medium text-text">My Work</span> is everything assigned to you across
            every list, and the sidebar's <span class="font-medium text-text">Recent</span> tab is
            whatever you touched last.
          </p>
        </Step>

        <footer class="mt-auto flex items-center justify-end gap-2 border-t border-line px-4 py-3 sm:px-5">
          <Button tone="ghost" onClick={dismissOnboarding}>
            Skip
          </Button>
          <Button tone="primary" onClick={dismissOnboarding}>
            Start using Flow
          </Button>
        </footer>
      </div>
    </div>
  );
}
