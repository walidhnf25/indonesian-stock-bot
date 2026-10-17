interface Entry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
}

/** Small in-memory TTL cache with in-flight request de-duplication. */
export class TtlCache<T> {
  private readonly store = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly defaultTtlMs: number,
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): { value: T; storedAt: number } | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) return undefined;
    return { value: e.value, storedAt: e.storedAt };
  }

  set(key: string, value: T, ttlMs = this.defaultTtlMs): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    const t = this.now();
    this.store.set(key, { value, storedAt: t, expiresAt: t + ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }

  /** Returns fresh cache, or runs the loader once even if called concurrently. */
  async getOrLoad(key: string, loader: () => Promise<T>, ttlMs = this.defaultTtlMs): Promise<T> {
    const hit = this.get(key);
    if (hit) return hit.value;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = loader()
      .then((v) => {
        this.set(key, v, ttlMs);
        return v;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
