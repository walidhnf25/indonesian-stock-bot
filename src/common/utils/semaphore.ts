export class SemaphoreFullError extends Error {
  constructor() {
    super('queue is full');
    this.name = 'SemaphoreFullError';
  }
}

export class SemaphoreTimeoutError extends Error {
  constructor(ms: number) {
    super(`waited more than ${ms}ms for a free slot`);
    this.name = 'SemaphoreTimeoutError';
  }
}

export interface AcquireOptions {
  /** Reject with SemaphoreTimeoutError if no slot frees up within this time. */
  timeoutMs?: number;
}

/**
 * Async semaphore with a bounded wait queue. Process-local: it protects a single Node process
 * (e.g. one local Ollama instance), it is not a distributed lock.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  /**
   * @param permits  how many holders may run at once
   * @param maxQueue how many callers may wait; the next one is rejected with SemaphoreFullError
   */
  constructor(
    permits: number,
    private readonly maxQueue: number = Number.POSITIVE_INFINITY,
  ) {
    this.available = permits;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  get hasFreeSlot(): boolean {
    return this.available > 0;
  }

  /** Takes a slot immediately or returns null (never queues). */
  tryAcquire(): (() => void) | null {
    if (this.available <= 0) return null;
    this.available--;
    return this.makeRelease();
  }

  async acquire(opts: AcquireOptions = {}): Promise<() => void> {
    const immediate = this.tryAcquire();
    if (immediate) return immediate;
    if (this.waiters.length >= this.maxQueue) throw new SemaphoreFullError();

    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onSlot = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      this.waiters.push(onSlot);
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const i = this.waiters.indexOf(onSlot);
          if (i >= 0) {
            this.waiters.splice(i, 1);
            reject(new SemaphoreTimeoutError(opts.timeoutMs as number));
          }
        }, opts.timeoutMs);
      }
    });
    // The releasing holder handed its slot straight to us (available was not incremented).
    return this.makeRelease();
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.available++;
    };
  }
}
