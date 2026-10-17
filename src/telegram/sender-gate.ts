/**
 * Bounds how many updates of one sender may be in flight (running or waiting behind their own earlier
 * message) and, when the whole bot is busy, how many senders may queue behind themselves at all.
 *
 * Why it exists: grammY's runner processes at most 500 updates at once, and an update that is merely
 * WAITING in `sequentialize` still holds one of those slots. Without a bound, one account that sends
 * hundreds of messages behind a slow AI request fills all 500 slots and the bot stops fetching updates
 * for everybody. Dropping the excess is safe: the sender already has the allowed number of messages
 * being served, and everybody else keeps their place.
 */
export interface SenderGateOptions {
  /** Updates of one sender that may be in flight at once. */
  perSender: number;
  /** Above this many in-flight updates overall, a sender that already has one in flight is not queued further. */
  globalSoftLimit: number;
  /** A "still busy" notice is sent at most this often per sender. */
  noticeEveryMs: number;
}

export const DEFAULT_SENDER_GATE: SenderGateOptions = {
  perSender: 3,
  globalSoftLimit: 300,
  noticeEveryMs: 15_000,
};

export type GateVerdict = { admitted: true } | { admitted: false; notify: boolean };

export class SenderGate {
  private readonly pending = new Map<string, number>();
  private readonly lastNotice = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly opts: SenderGateOptions = DEFAULT_SENDER_GATE,
    private readonly now: () => number = Date.now,
  ) {}

  /** Number of updates in flight (running or queued) across all senders. */
  get inFlight(): number {
    return this.total;
  }

  enter(key: string): GateVerdict {
    const mine = this.pending.get(key) ?? 0;
    const overloaded = this.total >= this.opts.globalSoftLimit && mine >= 1;
    if (mine >= this.opts.perSender || overloaded)
      return { admitted: false, notify: this.shouldNotify(key) };
    this.pending.set(key, mine + 1);
    this.total++;
    return { admitted: true };
  }

  leave(key: string): void {
    const mine = this.pending.get(key);
    if (mine === undefined) return;
    this.total--;
    if (mine <= 1) this.pending.delete(key);
    else this.pending.set(key, mine - 1);
  }

  private shouldNotify(key: string): boolean {
    const t = this.now();
    const last = this.lastNotice.get(key);
    if (last !== undefined && t - last < this.opts.noticeEveryMs) return false;
    if (this.lastNotice.size > 5000) this.lastNotice.clear(); // bounded: only a throttle, never a record
    this.lastNotice.set(key, t);
    return true;
  }
}
