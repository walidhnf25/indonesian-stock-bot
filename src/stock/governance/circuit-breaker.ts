export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the breaker. */
  failureThreshold: number;
  /** How long it stays open before one probe call is allowed. */
  cooldownMs: number;
}

/**
 * Stops calling a provider that keeps failing: while OPEN nothing is sent, so a struggling or
 * rate-limiting provider is not hammered; after the cooldown one probe is allowed (HALF_OPEN) and its outcome
 * decides whether to close again.
 */
export class CircuitBreaker {
  private current: BreakerState = 'CLOSED';
  private failures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(
    private readonly opts: CircuitBreakerOptions,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): BreakerState {
    return this.current;
  }

  /** Non-mutating: true while the breaker is OPEN and its cooldown has not elapsed. */
  blocked(): boolean {
    return this.current === 'OPEN' && this.now() < this.openedAt + this.opts.cooldownMs;
  }

  /** Called right before a provider call. Returns false if the call must not be made. */
  allow(): boolean {
    if (this.current === 'CLOSED') return true;
    if (this.current === 'OPEN') {
      if (this.now() < this.openedAt + this.opts.cooldownMs) return false;
      this.current = 'HALF_OPEN';
      this.probeInFlight = true;
      return true;
    }
    // HALF_OPEN: exactly one probe at a time
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  /** The provider answered (including "no such ticker"): it is alive. */
  onSuccess(): void {
    this.current = 'CLOSED';
    this.failures = 0;
    this.probeInFlight = false;
  }

  /**
   * The call that held the HALF_OPEN probe was abandoned before it produced any outcome (the caller aborted):
   * free the probe so that another call can take it. Without this the breaker would wait forever for a dead probe.
   */
  cancelProbe(): void {
    if (this.current === 'HALF_OPEN') this.probeInFlight = false;
  }

  /** The provider failed (error, rate limit, timeout). */
  onFailure(): void {
    if (this.current === 'HALF_OPEN') {
      this.open();
      return;
    }
    this.failures++;
    if (this.failures >= this.opts.failureThreshold) this.open();
  }

  private open(): void {
    this.current = 'OPEN';
    this.openedAt = this.now();
    this.probeInFlight = false;
    this.failures = 0;
  }
}
