import { info, warn } from "./log.js";

// ClickUp's personal-token plan reports X-RateLimit-Limit: 100 per minute
// (verified live). We run a token bucket sized from that header and steer by
// X-RateLimit-Remaining, so the crawl self-tunes if the plan limit changes.

export type RateLimitState = {
  limit: number;
  remaining: number;
  /** Epoch SECONDS (ClickUp sends seconds, not millis, in this header). */
  resetAt: number;
};

export type LimiterOptions = {
  /** Requests per window we aim to use. Defaults to the reported limit. */
  limit?: number;
  windowMs?: number;
  /** Stop and wait for the window to roll when remaining dips below this. */
  floor?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)));

export class RateLimiter {
  private windowMs: number;
  private floor: number;
  private tokens: number;
  private limit: number;
  private windowStart: number;
  private state: RateLimitState | null = null;
  private readonly doSleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(opts: LimiterOptions = {}) {
    this.limit = opts.limit ?? 100;
    this.windowMs = opts.windowMs ?? 60_000;
    this.floor = opts.floor ?? 5;
    this.doSleep = opts.sleep ?? sleep;
    this.now = opts.now ?? (() => Date.now());
    this.tokens = this.limit;
    this.windowStart = this.now();
  }

  get snapshot(): RateLimitState | null {
    return this.state;
  }

  /** Blocks until it is safe to issue one request. */
  async acquire(): Promise<void> {
    for (;;) {
      const t = this.now();
      if (t - this.windowStart >= this.windowMs) {
        this.windowStart = t;
        this.tokens = this.limit;
      }
      // Server-reported headroom wins over our local count.
      if (this.state && this.state.remaining <= this.floor) {
        const waitMs = this.state.resetAt * 1000 - t + 500;
        if (waitMs > 0) {
          info(`rate limit headroom ${this.state.remaining}; sleeping ${Math.ceil(waitMs / 1000)}s`);
          await this.doSleep(waitMs);
          this.state = null;
          this.windowStart = this.now();
          this.tokens = this.limit;
          continue;
        }
        this.state = null;
      }
      if (this.tokens > 0) {
        this.tokens -= 1;
        return;
      }
      await this.doSleep(this.windowStart + this.windowMs - t + 50);
    }
  }

  /** Feed the response headers back so the bucket tracks the server's view. */
  observe(headers: Headers): void {
    const limit = Number(headers.get("x-ratelimit-limit"));
    const remaining = Number(headers.get("x-ratelimit-remaining"));
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (!Number.isFinite(remaining) || !Number.isFinite(reset)) return;
    if (Number.isFinite(limit) && limit > 0) {
      this.limit = limit;
      if (this.tokens > limit) this.tokens = limit;
    }
    this.state = { limit: this.limit, remaining, resetAt: reset };
  }

  /**
   * Wait out a 429. ClickUp's X-RateLimit-Reset is epoch seconds; fall back to
   * exponential backoff when the header is missing or already in the past.
   */
  async backoff(headers: Headers, attempt: number): Promise<void> {
    const reset = Number(headers.get("x-ratelimit-reset"));
    const nowSec = this.now() / 1000;
    let waitMs = Number.isFinite(reset) && reset > nowSec ? (reset - nowSec) * 1000 + 750 : 0;
    if (waitMs <= 0) waitMs = Math.min(60_000, 1_000 * 2 ** attempt);
    warn(`429 from ClickUp; backing off ${Math.ceil(waitMs / 1000)}s (attempt ${attempt + 1})`);
    await this.doSleep(waitMs);
    this.state = null;
    this.windowStart = this.now();
    this.tokens = this.limit;
  }
}
