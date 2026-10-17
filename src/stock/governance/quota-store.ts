/**
 * Quota accounting behind a small interface, so that the in-process implementation can later be replaced by a
 * Redis-backed one (shared across processes) without touching callers. The interface is async on purpose.
 */
export interface QuotaResult {
  allowed: boolean;
  /** When denied: seconds until enough of the window frees up (at least 1). */
  retryAfterSeconds: number;
  /** Units left in the current window after this call (0 when denied). */
  remaining: number;
}

export interface QuotaStore {
  /** Atomically takes `cost` units of `key` in `scope` if the sliding window still has room. */
  consume(
    scope: string,
    key: string,
    limit: number,
    windowMs: number,
    cost?: number,
  ): Promise<QuotaResult>;
  /** Drops all state (tests). */
  reset(): void;
}

interface Bucket {
  t: number;
  cost: number;
}

/** Hits closer together than this are merged, so a busy key keeps O(window / granularity) entries. */
const GRANULARITY_MS = 1000;

export class InMemoryQuotaStore implements QuotaStore {
  private readonly hits = new Map<string, Bucket[]>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  async consume(
    scope: string,
    key: string,
    limit: number,
    windowMs: number,
    cost = 1,
  ): Promise<QuotaResult> {
    const k = `${scope}:${key}`;
    const t = this.now();
    const live = (this.hits.get(k) ?? []).filter((b) => t - b.t < windowMs);
    const used = live.reduce((sum, b) => sum + b.cost, 0);
    if (used + cost > limit) {
      this.set(k, live);
      const oldest = live[0]?.t ?? t;
      const retry = Math.max(1, Math.ceil((oldest + windowMs - t) / 1000));
      return { allowed: false, retryAfterSeconds: retry, remaining: 0 };
    }
    const last = live[live.length - 1];
    if (last && t - last.t < GRANULARITY_MS) last.cost += cost;
    else live.push({ t, cost });
    this.set(k, live);
    return { allowed: true, retryAfterSeconds: 0, remaining: limit - used - cost };
  }

  reset(): void {
    this.hits.clear();
  }

  private set(key: string, buckets: Bucket[]): void {
    // re-insert so that the most recently used keys are last (cheap LRU for the size cap)
    this.hits.delete(key);
    this.hits.set(key, buckets);
    if (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
  }
}
