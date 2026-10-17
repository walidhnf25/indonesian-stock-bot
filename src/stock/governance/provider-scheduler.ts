/**
 * Fair, bounded scheduler for calls to an external market-data provider.
 *
 * Replaces one shared FIFO throttle. Properties:
 *  - per-caller queues, served round-robin: a caller with a hundred queued calls takes one turn at a time,
 *    so a second caller waits for at most one turn per caller ahead of them, not for the whole backlog;
 *  - bounded: a queue per caller and one overall; beyond them a call is rejected immediately (backpressure);
 *  - a queued call that waits too long is rejected and removed (no slot is ever held for a dead waiter);
 *  - a running call that exceeds its timeout releases its slot (a hung provider cannot freeze the scheduler);
 *  - an abort signal removes a waiting call or releases a running one;
 *  - a minimum gap between call starts, like the throttle it replaces.
 * It knows nothing about quotas, budgets or providers: those are decided before a call is queued.
 */
export type SchedulerRejectReason =
  'user_queue_full' | 'global_queue_full' | 'queue_timeout' | 'aborted';

export class ProviderBusyError extends Error {
  constructor(readonly reason: SchedulerRejectReason) {
    super(`provider scheduler rejected the call: ${reason}`);
    this.name = 'ProviderBusyError';
  }
}

export class ProviderTimeoutError extends Error {
  constructor(ms: number) {
    super(`provider call exceeded ${ms} ms`);
    this.name = 'ProviderTimeoutError';
  }
}

export interface ProviderSchedulerOptions {
  /** Calls running at once. */
  concurrency: number;
  /** Minimum gap between two call starts. */
  minIntervalMs: number;
  /** Calls one caller may have waiting. */
  queuePerUser: number;
  /** Calls waiting in total. */
  queueGlobal: number;
  /** Longest a call may wait for a slot. */
  queueWaitMs: number;
  /** Longest a call may run before its slot is released. */
  taskTimeoutMs: number;
  /**
   * Callers (background jobs) that are served BEFORE ordinary callers and have their own queue bound
   * (`queueSystem`), so that users filling `queueGlobal` can neither delay nor reject them.
   */
  isPrivileged?: (callerKey: string) => boolean;
  /** Waiting slots reserved for privileged callers (on top of `queueGlobal`). Defaults to `queueGlobal`. */
  queueSystem?: number;
  /** Called after every change of the numbers below (for gauges). */
  onChange?: (stats: SchedulerStats) => void;
}

export interface SchedulerStats {
  active: number;
  queued: number;
  callersWaiting: number;
}

interface Waiter {
  callerKey: string;
  privileged: boolean;
  start: () => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
  cleanupAbort?: () => void;
  settled: boolean;
}

export class ProviderScheduler {
  private active = 0;
  private queued = 0;
  /** How many of `queued` belong to privileged callers (counted against `queueSystem`, not `queueGlobal`). */
  private queuedPrivileged = 0;
  private readonly queues = new Map<string, Waiter[]>();
  /** Ordinary callers that have waiting work, in the order they will next be served. */
  private readonly rotation: string[] = [];
  /** Privileged callers with waiting work; always served before `rotation`. */
  private readonly rotationPrivileged: string[] = [];
  private nextStartAt = 0;
  private pumpTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly opts: ProviderSchedulerOptions,
    private readonly now: () => number = Date.now,
  ) {}

  get stats(): SchedulerStats {
    return { active: this.active, queued: this.queued, callersWaiting: this.queues.size };
  }

  run<T>(callerKey: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) return reject(new ProviderBusyError('aborted'));
      if (signal?.aborted) return reject(new ProviderBusyError('aborted'));
      const mine = this.queues.get(callerKey);
      const privileged = this.opts.isPrivileged?.(callerKey) === true;
      const queueSystem = this.opts.queueSystem ?? this.opts.queueGlobal;
      const limit = privileged ? queueSystem : this.opts.queuePerUser;
      if ((mine?.length ?? 0) >= limit) return reject(new ProviderBusyError('user_queue_full'));
      // Two separate bounds: ordinary callers can fill queueGlobal but never the slots kept for system jobs.
      if (
        privileged
          ? this.queuedPrivileged >= queueSystem
          : this.queued - this.queuedPrivileged >= this.opts.queueGlobal
      ) {
        return reject(new ProviderBusyError('global_queue_full'));
      }

      const waiter: Waiter = {
        callerKey,
        privileged,
        settled: false,
        reject,
        start: () => {
          this.finishWaiting(waiter);
          this.execute(task, resolve, reject, signal);
        },
      };
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        this.remove(waiter);
        reject(new ProviderBusyError('queue_timeout'));
      }, this.opts.queueWaitMs);
      waiter.timer.unref?.();
      if (signal) {
        const onAbort = () => {
          if (waiter.settled) return;
          this.remove(waiter);
          reject(new ProviderBusyError('aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanupAbort = () => signal.removeEventListener('abort', onAbort);
      }

      if (!mine || mine.length === 0) {
        this.queues.set(callerKey, [waiter]);
        (privileged ? this.rotationPrivileged : this.rotation).push(callerKey);
      } else {
        mine.push(waiter);
      }
      this.queued++;
      if (privileged) this.queuedPrivileged++;
      this.changed();
      this.pump();
    });
  }

  /** Rejects everything waiting and stops timers (module shutdown). */
  close(): void {
    this.closed = true;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    for (const waiters of [...this.queues.values()]) {
      for (const w of [...waiters]) {
        this.remove(w);
        w.reject(new ProviderBusyError('aborted'));
      }
    }
  }

  /* ---------------------------------------------------------------- internals */

  private pump(): void {
    if (this.pumpTimer) return; // a delayed pump is already scheduled
    while (this.active < this.opts.concurrency && this.queued > 0) {
      const wait = this.nextStartAt - this.now();
      if (wait > 0) {
        this.pumpTimer = setTimeout(() => {
          this.pumpTimer = undefined;
          this.pump();
        }, wait);
        this.pumpTimer.unref?.();
        return;
      }
      const next = this.takeNext();
      if (!next) break;
      next.start();
    }
  }

  /** Next waiter: privileged callers first, then ordinary ones; round-robin over callers within each class. */
  private takeNext(): Waiter | undefined {
    return this.takeFrom(this.rotationPrivileged) ?? this.takeFrom(this.rotation);
  }

  private takeFrom(rotation: string[]): Waiter | undefined {
    while (rotation.length > 0) {
      const caller = rotation.shift() as string;
      const queue = this.queues.get(caller);
      if (!queue || queue.length === 0) {
        this.queues.delete(caller);
        continue;
      }
      const waiter = queue.shift() as Waiter;
      this.queued--;
      if (waiter.privileged) this.queuedPrivileged--;
      if (queue.length > 0) rotation.push(caller);
      else this.queues.delete(caller);
      return waiter;
    }
    return undefined;
  }

  private finishWaiting(waiter: Waiter): void {
    waiter.settled = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.cleanupAbort?.();
  }

  /** Takes a waiting call out of its queue (timeout, abort, shutdown). */
  private remove(waiter: Waiter): void {
    this.finishWaiting(waiter);
    const queue = this.queues.get(waiter.callerKey);
    if (!queue) return;
    const i = queue.indexOf(waiter);
    if (i < 0) return;
    queue.splice(i, 1);
    this.queued--;
    if (waiter.privileged) this.queuedPrivileged--;
    if (queue.length === 0) {
      this.queues.delete(waiter.callerKey);
      const rotation = waiter.privileged ? this.rotationPrivileged : this.rotation;
      const r = rotation.indexOf(waiter.callerKey);
      if (r >= 0) rotation.splice(r, 1);
    }
    this.changed();
  }

  private execute<T>(
    task: () => Promise<T>,
    resolve: (v: T) => void,
    reject: (e: Error) => void,
    signal?: AbortSignal,
  ): void {
    this.active++;
    this.nextStartAt = this.now() + this.opts.minIntervalMs;
    this.changed();
    let released = false;
    let onAbort: (() => void) | undefined;
    const release = () => {
      if (released) return;
      released = true;
      this.active--;
      if (timeout) clearTimeout(timeout);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      this.changed();
      this.pump();
    };
    const timeout = setTimeout(() => {
      release();
      reject(new ProviderTimeoutError(this.opts.taskTimeoutMs));
    }, this.opts.taskTimeoutMs);
    timeout.unref?.();
    if (signal) {
      onAbort = () => {
        release();
        reject(new ProviderBusyError('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    let running: Promise<T>;
    try {
      running = Promise.resolve(task());
    } catch (e) {
      release();
      reject(e as Error);
      return;
    }
    running.then(
      (v) => {
        release();
        resolve(v);
      },
      (e: Error) => {
        release();
        reject(e);
      },
    );
  }

  private changed(): void {
    this.opts.onChange?.(this.stats);
  }
}
