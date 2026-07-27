const started = Date.now();

function stamp(): string {
  const secs = ((Date.now() - started) / 1000).toFixed(1).padStart(6, " ");
  return `[${secs}s]`;
}

export function info(msg: string): void {
  console.log(`${stamp()} ${msg}`);
}

export function warn(msg: string): void {
  console.warn(`${stamp()} WARN ${msg}`);
}

export function fail(msg: string): void {
  console.error(`${stamp()} ERROR ${msg}`);
}

/**
 * Single-line progress that stays quiet on non-TTY (log files) by only
 * emitting every `every` items.
 */
export function progress(label: string, done: number, total: number | null, every = 25): void {
  if (done % every !== 0 && done !== total) return;
  const pct = total ? ` (${((done / total) * 100).toFixed(0)}%)` : "";
  info(`${label}: ${done}${total ? `/${total}` : ""}${pct}`);
}

/** Collects duplicate warnings so a systemic data quirk logs once, not 4,000x. */
export class WarnTally {
  private counts = new Map<string, number>();
  private samples = new Map<string, string>();

  add(kind: string, detail: string): void {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    if (!this.samples.has(kind)) this.samples.set(kind, detail);
  }

  get entries(): { kind: string; count: number; sample: string }[] {
    return [...this.counts.entries()].map(([kind, count]) => ({
      kind,
      count,
      sample: this.samples.get(kind) ?? "",
    }));
  }

  flush(): void {
    for (const e of this.entries) {
      warn(`${e.kind} x${e.count} (e.g. ${e.sample})`);
    }
  }
}
