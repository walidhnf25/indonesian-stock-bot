/** Sliding-window limiter keyed by an arbitrary id (e.g. Telegram user id). */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit if allowed. Returns retry-after seconds when blocked. */
  tryConsume(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const retryAfterMs = this.windowMs - (t - recent[0]);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.prune(t);
    return { allowed: true };
  }

  private prune(t: number): void {
    for (const [k, v] of this.hits) {
      if (v.every((x) => t - x >= this.windowMs)) this.hits.delete(k);
    }
  }
}

/** Limits concurrency and enforces a minimum gap between task starts. */
export class Throttle {
  private active = 0;
  private lastStart = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly maxConcurrency: number,
    private readonly minIntervalMs: number,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  private acquire(): Promise<void> {
    return new Promise((resolve) => {
      const attempt = () => {
        if (this.active >= this.maxConcurrency) {
          this.queue.push(attempt);
          return;
        }
        const wait = Math.max(0, this.lastStart + this.minIntervalMs - Date.now());
        this.active++;
        this.lastStart = Date.now() + wait;
        if (wait > 0) setTimeout(resolve, wait);
        else resolve();
      };
      attempt();
    });
  }
}
