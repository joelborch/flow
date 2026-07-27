// Primitives shared by the three settings panels.
// Deliberately small: the settings area is dense, mostly-text, and reuses the
// shell's tokens rather than inventing a second visual language.
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError } from "../lib/api.js";
import { cn } from "../shell/format.js";
import { Check, ChevronDown, ChevronRight, X } from "../shell/ui.js";

export { Check, ChevronDown, ChevronRight, X };

// --- async loading ---------------------------------------------------------

export type AsyncStatus = "loading" | "ok" | "error";

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    // A network failure in `vite dev` with no Worker is the common case; say so
    // rather than surfacing "Failed to fetch".
    return err.status === 0 ? "Can't reach the API." : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * One fetch, with a reload handle. Panels use this instead of ad-hoc effects so
 * every API-backed section fails the same way: a quiet inline notice, never a
 * thrown render.
 */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [status, setStatus] = useState<AsyncStatus>("loading");
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let alive = true;
    setStatus("loading");
    setError(null);
    loadRef.current().then(
      (value) => {
        if (!alive) return;
        setData(value);
        setStatus("ok");
      },
      (err: unknown) => {
        if (!alive) return;
        setError(errorMessage(err));
        setStatus("error");
      }
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { status, data, error, reload, setData } as const;
}

// --- layout ----------------------------------------------------------------

export function Panel({
  title,
  description,
  right,
  children,
}: {
  title: string;
  description?: string;
  right?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <section class="rounded-xl border border-line bg-surface">
      <header class="flex items-start gap-3 border-b border-line px-4 py-3">
        <div class="min-w-0 flex-1">
          <h2 class="text-[13px] font-semibold tracking-[-0.01em] text-text">{title}</h2>
          {description && <p class="mt-0.5 text-[12px] leading-relaxed text-muted">{description}</p>}
        </div>
        {right && <div class="shrink-0">{right}</div>}
      </header>
      {children}
    </section>
  );
}

export function Row({ children, class: cls }: { children: ComponentChildren; class?: string }) {
  return <div class={cn("border-b border-line px-4 py-2.5 last:border-b-0", cls)}>{children}</div>;
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <p class="px-4 py-6 text-center text-[12.5px] text-faint">{children}</p>;
}

export function Loading({ children = "Loading…" }: { children?: ComponentChildren }) {
  return <p class="px-4 py-6 text-center text-[12.5px] text-faint">{children}</p>;
}

/** The one failure surface. Never a crash: the API being unreachable is normal
 *  in `vite dev`, and the signal-backed parts of the page must stay usable. */
export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div class="m-3 flex items-start gap-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2">
      <p class="min-w-0 flex-1 text-[12.5px] leading-relaxed text-danger">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          class="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-danger underline-offset-2 hover:underline"
        >
          Retry
        </button>
      )}
    </div>
  );
}

// --- controls --------------------------------------------------------------

export function Button({
  children,
  onClick,
  tone = "default",
  size = "sm",
  disabled,
  type = "button",
}: {
  children: ComponentChildren;
  onClick?: () => void;
  tone?: "default" | "primary" | "danger" | "ghost";
  size?: "sm" | "xs";
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      class={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "xs" ? "h-[24px] px-2 text-[11.5px]" : "h-[28px] px-2.5 text-[12.5px]",
        tone === "primary" && "border-accent bg-accent text-white hover:bg-accent/90",
        tone === "danger" && "border-danger/40 bg-danger-soft text-danger hover:border-danger/70",
        tone === "default" && "border-line bg-surface text-text hover:border-line-strong hover:bg-raised",
        tone === "ghost" && "border-transparent bg-transparent text-muted hover:bg-bg hover:text-text"
      )}
    >
      {children}
    </button>
  );
}

export function TextInput({
  value,
  onInput,
  placeholder,
  ariaLabel,
  mono,
  onEnter,
}: {
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
  ariaLabel: string;
  mono?: boolean;
  onEnter?: () => void;
}) {
  return (
    <input
      type="text"
      value={value}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onEnter) {
          e.preventDefault();
          onEnter();
        }
      }}
      class={cn(
        "h-[28px] min-w-0 rounded-lg border border-line bg-surface px-2.5 text-[12.5px] text-text transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/10",
        mono && "font-mono"
      )}
    />
  );
}

/** Enabled/disabled switch. Purely presentational — the confirm step lives in
 *  the caller, because only it knows what the flip is about to do. */
export function Switch({
  checked,
  onChange,
  label,
  busy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!checked)}
      class={cn(
        "relative h-[18px] w-[30px] shrink-0 rounded-full border transition-colors disabled:opacity-50",
        checked ? "border-accent bg-accent" : "border-line-strong bg-raised"
      )}
    >
      <span
        class={cn(
          "absolute top-[2px] h-[12px] w-[12px] rounded-full bg-surface shadow-sm transition-transform",
          checked ? "translate-x-[14px]" : "translate-x-[2px]"
        )}
      />
    </button>
  );
}

/** Inline confirm strip. Used for anything that acts on real data. */
export function Confirm({
  message,
  confirmLabel,
  tone = "primary",
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmLabel: string;
  tone?: "primary" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div class="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-warn/30 bg-warn/[0.07] px-2.5 py-2">
      <p class="min-w-0 flex-1 text-[12px] text-text">{message}</p>
      <Button tone={tone} size="xs" onClick={onConfirm}>
        {confirmLabel}
      </Button>
      <Button tone="ghost" size="xs" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

// --- copyable secrets ------------------------------------------------------

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((text: string) => {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => setCopied(false));
      return;
    }
    // Older/insecure-context fallback so the value is never simply unobtainable.
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.append(el);
    el.select();
    try {
      document.execCommand("copy");
      done();
    } finally {
      el.remove();
    }
  }, []);
  return [copied, copy];
}

/** Monospace block with a copy button. `warning` is for values shown once. */
export function CopyBlock({
  value,
  label,
  warning,
}: {
  value: string;
  label: string;
  warning?: string;
}) {
  const [copied, copy] = useCopy();
  return (
    <div class="rounded-lg border border-line bg-raised">
      <div class="flex items-center gap-2 border-b border-line px-2.5 py-1.5">
        <span class="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">
          {label}
        </span>
        <Button size="xs" onClick={() => copy(value)}>
          {copied ? (
            <>
              <Check class="h-3 w-3 text-ok" /> Copied
            </>
          ) : (
            "Copy"
          )}
        </Button>
      </div>
      <pre class="scroll-y max-h-40 overflow-x-auto px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-text">
        {value}
      </pre>
      {warning && (
        <p class="border-t border-line px-2.5 py-1.5 text-[11.5px] font-medium text-warn">{warning}</p>
      )}
    </div>
  );
}

// --- chips -----------------------------------------------------------------

export function Tag({
  children,
  tone = "neutral",
  title,
}: {
  children: ComponentChildren;
  tone?: "neutral" | "accent" | "ok" | "warn" | "danger";
  title?: string;
}) {
  return (
    <span
      title={title}
      class={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium",
        tone === "neutral" && "bg-bg text-muted",
        tone === "accent" && "bg-accent/10 text-accent",
        tone === "ok" && "bg-ok/12 text-ok",
        tone === "warn" && "bg-warn/15 text-warn",
        tone === "danger" && "bg-danger-soft text-danger"
      )}
    >
      <span class="truncate">{children}</span>
    </span>
  );
}
