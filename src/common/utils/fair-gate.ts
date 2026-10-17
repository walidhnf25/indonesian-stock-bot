export class GateFullError extends Error {
  constructor() {
    super('queue is full');
    this.name = 'GateFullError';
  }
}

/** The caller already holds its fair share of the gate (running + waiting). */
export class GateUserLimitError extends Error {
  constructor() {
    super('per-user limit reached');
    this.name = 'GateUserLimitError';
  }
}

export class GateTimeoutError extends Error {
  constructor(ms: number) {
    super(`waited more than ${ms}ms for a free slot`);
    this.name = 'GateTimeoutError';
  }
}

export interface FairGateOptions {
  /** Holders allowed to run at once, across all users. */
  permits: number;
  /** Holders one user may run at once. */
  perUser: number;
  /** Callers allowed to wait, across all users. */
  maxQueue: number;
  /** Callers one user may have waiting. */
  maxQueuePerUser: number;
}

interface Waiter {
  user: string;
  grant: () => void;
}

/**
 * Process-local concurrency gate with per-user fairness (no external queue infrastructure).
 *
 *  - global limit: at most `permits` holders at any time;
 *  - per-user limit: one user can never run more than `perUser` holders, nor keep more than
 *    `maxQueuePerUser` callers waiting, so a single user cannot fill the queue;
 *  - fair scheduling: when a slot frees up, waiting users are served in round-robin order (the user
 *    served least recently goes first), not strictly first-come-first-served. A user with ten queued
 *    requests therefore does not delay another user's single request by ten turns;
 *  - every release path is idempotent, counters cannot go negative, a timed-out waiter is removed.
 */
export class FairGate {
  private active = 0;
  private waitingCount = 0;
  private readonly running = new Map<string, number>();
  private readonly queues = new Map<string, Waiter[]>();
  /** Users that currently have waiters, in arrival order (used to break ties). */
  private readonly order: string[] = [];
  /** When each busy user was last served (logical clock); the smallest stamp is served next. */
  private readonly lastServed = new Map<string, number>();
  private tick = 0;

  constructor(private readonly opts: FairGateOptions) {}

  get waiting(): number {
    return this.waitingCount;
  }

  get inUse(): number {
    return this.active;
  }

  runningFor(user: string): number {
    return this.running.get(user) ?? 0;
  }

  waitingFor(user: string): number {
    return this.queues.get(user)?.length ?? 0;
  }

  /** Takes a slot immediately or returns null (never queues). */
  tryAcquire(user: string): (() => void) | null {
    if (!this.canRunNow(user)) return null;
    return this.take(user);
  }

  async acquire(user: string, opts: { timeoutMs?: number } = {}): Promise<() => void> {
    const immediate = this.tryAcquire(user);
    if (immediate) return immediate;
    if (this.waitingFor(user) >= this.opts.maxQueuePerUser) throw new GateUserLimitError();
    if (this.waitingCount >= this.opts.maxQueue) throw new GateFullError();

    return new Promise<() => void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter: Waiter = {
        user,
        grant: () => {
          if (timer) clearTimeout(timer);
          resolve(this.take(user, true));
        },
      };
      this.enqueue(waiter);
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (this.dequeue(waiter)) reject(new GateTimeoutError(opts.timeoutMs as number));
        }, opts.timeoutMs);
      }
    });
  }

  /* ----------------------------------------------------------------- internals */

  private canRunNow(user: string): boolean {
    return this.active < this.opts.permits && this.runningFor(user) < this.opts.perUser;
  }

  /** Counts a grant for `user` and remembers when they were last served (fairness input). */
  private grant(user: string): void {
    this.active++;
    this.running.set(user, this.runningFor(user) + 1);
    this.lastServed.set(user, ++this.tick);
  }

  /** `reserved`: the slot was already counted by dispatch() when the waiter was chosen. */
  private take(user: string, reserved = false): () => void {
    if (!reserved) this.grant(user);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const left = Math.max(0, this.runningFor(user) - 1);
      if (left === 0) this.running.delete(user);
      else this.running.set(user, left);
      this.dispatch();
      // An idle user leaves no trace (the map must not grow with every user ever seen).
      if (this.runningFor(user) === 0 && this.waitingFor(user) === 0) this.lastServed.delete(user);
    };
  }

  private enqueue(w: Waiter): void {
    const q = this.queues.get(w.user) ?? [];
    q.push(w);
    this.queues.set(w.user, q);
    if (!this.order.includes(w.user)) this.order.push(w.user);
    this.waitingCount++;
  }

  private dequeue(w: Waiter): boolean {
    const q = this.queues.get(w.user);
    const i = q ? q.indexOf(w) : -1;
    if (!q || i < 0) return false;
    q.splice(i, 1);
    this.waitingCount--;
    if (q.length === 0) this.forget(w.user);
    if (this.runningFor(w.user) === 0 && this.waitingFor(w.user) === 0) {
      this.lastServed.delete(w.user);
    }
    return true;
  }

  private forget(user: string): void {
    this.queues.delete(user);
    const i = this.order.indexOf(user);
    if (i >= 0) this.order.splice(i, 1);
  }

  /**
   * Hands free slots to waiting users. The user served LEAST RECENTLY goes first (a user who has
   * never been served counts as oldest; ties keep arrival order). Serving someone updates their
   * stamp, so a user with ten queued requests does not delay another user's single request.
   */
  private dispatch(): void {
    while (this.active < this.opts.permits) {
      let chosen: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const u of this.order) {
        if (this.runningFor(u) >= this.opts.perUser) continue;
        const stamp = this.lastServed.get(u) ?? 0;
        if (stamp < oldest) {
          oldest = stamp;
          chosen = u;
        }
      }
      if (chosen === null) return;
      const q = this.queues.get(chosen) as Waiter[];
      const waiter = q.shift() as Waiter;
      this.waitingCount--;
      if (q.length === 0) this.forget(chosen);
      // Reserve the slot before waking the waiter so nobody can overtake it.
      this.grant(chosen);
      waiter.grant();
    }
  }
}
