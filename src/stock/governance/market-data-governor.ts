import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { CallerContext } from '../../common/caller-context';
import { Metrics } from '../../common/metrics.service';
import { AppConfig } from '../../config/app-config.service';
import { ProviderResult } from '../stock-data-provider.interface';
import { Unavailable, unavailable } from '../stock.types';
import { CircuitBreaker } from './circuit-breaker';
import {
  ProviderBusyError,
  ProviderScheduler,
  ProviderTimeoutError,
  SchedulerStats,
} from './provider-scheduler';
import { InMemoryQuotaStore, QuotaResult, QuotaStore } from './quota-store';

export const QUOTA_STORE = Symbol('QUOTA_STORE');

export interface GovernorLimits {
  userPerMinute: number;
  /** Uncached provider calls one user may cause per hour (bounds what a handful of accounts can drain). */
  userPerHour: number;
  /** Hard ceiling for everything (users + system) per hour. */
  globalPerHour: number;
  /** Part of globalPerHour that only system jobs may spend (alert evaluation); 0 = no reserve, one shared pool. */
  systemReservePerHour: number;
  concurrency: number;
  minIntervalMs: number;
  queuePerUser: number;
  queueGlobal: number;
  /** Scheduler slots only system jobs may take (users cannot fill them). */
  queueSystem: number;
  queueWaitMs: number;
  taskTimeoutMs: number;
  breakerFailures: number;
  breakerCooldownMs: number;
}

const HOUR_MS = 3_600_000;

/**
 * A missing or non-numeric limit used to turn every comparison into `false` (NaN), which silently disabled the budget
 * (or made a test hang). The environment schema already rejects such values; this makes the governor itself refuse to
 * run with them, whoever constructs it.
 */
function assertValidLimits(l: GovernorLimits): void {
  const positive: Array<keyof GovernorLimits> = [
    'userPerMinute',
    'userPerHour',
    'globalPerHour',
    'concurrency',
    'queuePerUser',
    'queueGlobal',
    'queueSystem',
    'queueWaitMs',
    'taskTimeoutMs',
    'breakerFailures',
    'breakerCooldownMs',
  ];
  for (const key of positive) {
    if (!Number.isFinite(l[key]) || l[key] <= 0) {
      throw new Error(`invalid market-data limit ${key}: must be a positive number`);
    }
  }
  for (const key of ['systemReservePerHour', 'minIntervalMs'] as const) {
    if (!Number.isFinite(l[key]) || l[key] < 0) {
      throw new Error(`invalid market-data limit ${key}: must be zero or positive`);
    }
  }
}

const DEGRADED_MESSAGE =
  'Layanan data pasar sedang dibatasi agar tetap tersedia untuk semua orang.';

/**
 * The single door to an external market-data provider. Every uncached provider call passes through:
 *
 *   circuit breaker  →  per-user quotas (minute + hour)  →  user pool of the hourly budget  →  fair bounded
 *   scheduler  →  provider
 *   System jobs (alert evaluation) draw from their own reserve instead of the user pool and are served first by the
 *   scheduler. user pool + system reserve = MARKET_DATA_GLOBAL_PER_HOUR, so the total is still bounded.
 *
 * It never throws and never fabricates data: a refusal is an `Unavailable` result (QUOTA or BUSY) that the
 * caller turns into stored data (degraded mode) or a short, honest message. Cache hits never get here, so they
 * never consume anything. Retries come back through here and consume again, so they cannot bypass a limit.
 */
@Injectable()
export class MarketDataGovernor implements OnModuleDestroy {
  private limits: GovernorLimits;
  private scheduler: ProviderScheduler;
  private breaker: CircuitBreaker;
  private readonly quota: QuotaStore;
  private readonly logger = new Logger(MarketDataGovernor.name);
  /**
   * Process-local mirror of every grant. With a shared (Redis) store it is a floor: if Redis restarts and forgets the
   * window, this process still cannot spend more than the documented limits within the window. Null when the store
   * itself is in-process (it would only duplicate it).
   */
  private readonly floor: InMemoryQuotaStore | null;
  private readonly lastExhaustedLog = new Map<string, number>();

  constructor(
    config: AppConfig,
    private readonly metrics: Metrics,
    @Optional() @Inject(QUOTA_STORE) quota?: QuotaStore,
  ) {
    this.limits = {
      userPerMinute: config.get('MARKET_DATA_USER_UNCACHED_PER_MINUTE'),
      userPerHour: config.get('MARKET_DATA_USER_UNCACHED_PER_HOUR'),
      globalPerHour: config.get('MARKET_DATA_GLOBAL_PER_HOUR'),
      systemReservePerHour: config.get('MARKET_DATA_SYSTEM_RESERVE_PER_HOUR'),
      concurrency: config.get('STOCK_API_MAX_CONCURRENCY'),
      minIntervalMs: config.get('STOCK_API_MIN_INTERVAL_MS'),
      queuePerUser: config.get('MARKET_DATA_QUEUE_PER_USER'),
      queueGlobal: config.get('MARKET_DATA_QUEUE_GLOBAL'),
      queueSystem: config.get('MARKET_DATA_QUEUE_SYSTEM'),
      queueWaitMs: config.get('MARKET_DATA_QUEUE_WAIT_MS'),
      taskTimeoutMs: config.get('MARKET_DATA_TIMEOUT_MS'),
      breakerFailures: config.get('MARKET_DATA_BREAKER_FAILURES'),
      breakerCooldownMs: config.get('MARKET_DATA_BREAKER_COOLDOWN_SECONDS') * 1000,
    };
    assertValidLimits(this.limits);
    this.quota = quota ?? new InMemoryQuotaStore();
    this.floor = this.quota instanceof InMemoryQuotaStore ? null : new InMemoryQuotaStore();
    this.scheduler = this.buildScheduler();
    this.breaker = this.buildBreaker();
    this.publishLimits();
  }

  get currentLimits(): Readonly<GovernorLimits> {
    return this.limits;
  }

  /** Hourly provider calls system jobs may spend (never more than the total). */
  get systemReserve(): number {
    return Math.min(this.limits.systemReservePerHour, this.limits.globalPerHour);
  }

  /** Hourly provider calls ordinary users share. */
  get userPool(): number {
    return this.limits.globalPerHour - this.systemReserve;
  }

  get breakerState(): string {
    return this.breaker.state;
  }

  get schedulerStats(): SchedulerStats {
    return this.scheduler.stats;
  }

  /** Changes limits at runtime (tests); also resets the scheduler, the breaker and the quota counters. */
  reconfigure(partial: Partial<GovernorLimits>): void {
    this.scheduler.close();
    const next = { ...this.limits, ...partial };
    assertValidLimits(next);
    this.limits = next;
    this.scheduler = this.buildScheduler();
    this.breaker = this.buildBreaker();
    this.quota.reset();
    this.floor?.reset();
    this.publishLimits();
  }

  /** Clears quota counters and the breaker without changing limits (tests). */
  resetState(): void {
    this.quota.reset();
    this.floor?.reset();
    this.breaker = this.buildBreaker();
  }

  onModuleDestroy(): void {
    this.scheduler.close();
  }

  async execute<T>(
    provider: string,
    fn: () => Promise<ProviderResult<T>>,
    signal?: AbortSignal,
  ): Promise<ProviderResult<T>> {
    const effectiveSignal = signal ?? CallerContext.signal();
    const peeked = CallerContext.peek();
    if (peeked === null) this.metrics.inc('provider_unattributed_total');
    const caller = peeked ?? CallerContext.current();
    const system = CallerContext.isSystem(caller);

    if (this.breaker.blocked()) {
      return this.refuse(
        'breaker_open',
        unavailable(DEGRADED_MESSAGE, 'BUSY', this.cooldownSeconds()),
      );
    }
    const refused = system
      ? await this.chargeSystem(provider)
      : await this.chargeUser(provider, caller);
    if (refused) return refused;

    // The breaker is consulted and UPDATED inside the scheduled task, before the slot is released: work that was
    // queued while the breaker was CLOSED therefore re-checks it when it really starts, and cannot start between a
    // failure and the moment that failure is recorded.
    let abandoned = false; // set when the caller gave up (timeout/abort): a late answer must not touch the breaker
    let isProbe = false;
    try {
      return await this.scheduler.run(
        caller,
        async (): Promise<ProviderResult<T>> => {
          if (!this.breaker.allow()) {
            this.metrics.inc('provider_throttled_total', { reason: 'breaker_open' });
            return unavailable(DEGRADED_MESSAGE, 'BUSY', this.cooldownSeconds());
          }
          isProbe = this.breaker.state === 'HALF_OPEN';
          try {
            const result = await fn();
            if (!abandoned) this.record(provider, result);
            return result;
          } catch (e) {
            if (!abandoned) {
              this.breaker.onFailure();
              this.metrics.inc('provider_requests_total', { provider, outcome: 'error' });
            }
            throw e;
          }
        },
        effectiveSignal,
      );
    } catch (e) {
      abandoned = true;
      if (e instanceof ProviderBusyError) {
        if (e.reason === 'aborted' && isProbe) this.breaker.cancelProbe(); // never leave the breaker waiting for a dead probe
        const reason =
          e.reason === 'user_queue_full'
            ? 'queue_user'
            : e.reason === 'global_queue_full'
              ? 'queue_global'
              : e.reason === 'queue_timeout'
                ? 'queue_timeout'
                : 'aborted';
        return this.refuse(
          reason,
          unavailable(DEGRADED_MESSAGE, 'BUSY', reason === 'queue_user' ? 5 : 10),
        );
      }
      if (e instanceof ProviderTimeoutError) {
        this.breaker.onFailure();
        this.metrics.inc('provider_requests_total', { provider, outcome: 'timeout' });
        return unavailable('Provider tidak menjawab tepat waktu.', 'ERROR');
      }
      // the task itself threw: the wrapper already recorded the failure
      return unavailable('Provider error.', 'ERROR');
    }
  }

  /* ---------------------------------------------------------------- budget */

  /** One grant from the shared store, then from the process-local floor (stricter only if the shared store lost state). */
  private async take(
    scope: string,
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<QuotaResult> {
    const shared = await this.quota.consume(scope, key, limit, windowMs);
    if (!shared.allowed || !this.floor) return shared;
    const local = await this.floor.consume(scope, key, limit, windowMs);
    return local.allowed ? shared : local;
  }

  /** System jobs spend only their reserve (or, with no reserve configured, the one shared pool). */
  private async chargeSystem(provider: string): Promise<Unavailable | null> {
    if (this.systemReserve === 0)
      return this.chargePool(provider, 'user', this.limits.globalPerHour);
    const r = await this.take('system', provider, this.systemReserve, HOUR_MS);
    this.noteBudget('system', r);
    if (r.allowed) return null;
    return this.refuse(
      'system_reserve',
      unavailable(DEGRADED_MESSAGE, 'BUSY', Math.min(r.retryAfterSeconds, 3600)),
      'system',
    );
  }

  private async chargeUser(provider: string, caller: string): Promise<Unavailable | null> {
    const perMinute = await this.take('user', caller, this.limits.userPerMinute, 60_000);
    if (!perMinute.allowed) {
      return this.refuse(
        'user_quota',
        unavailable('Terlalu banyak data baru diminta.', 'QUOTA', perMinute.retryAfterSeconds),
      );
    }
    const perHour = await this.take('userhour', caller, this.limits.userPerHour, HOUR_MS);
    if (!perHour.allowed) {
      return this.refuse(
        'user_hourly',
        unavailable(
          'Kamu sudah meminta terlalu banyak data baru dalam satu jam terakhir.',
          'QUOTA',
          Math.min(perHour.retryAfterSeconds, 3600),
        ),
      );
    }
    return this.chargePool(provider, 'user', this.userPool);
  }

  private async chargePool(
    provider: string,
    pool: 'user' | 'system',
    limit: number,
  ): Promise<Unavailable | null> {
    const g = await this.take('global', provider, limit, HOUR_MS);
    this.noteBudget(pool, g);
    if (g.allowed) return null;
    return this.refuse(
      'global_budget',
      unavailable(DEGRADED_MESSAGE, 'BUSY', Math.min(g.retryAfterSeconds, 3600)),
      pool,
    );
  }

  /** Gauges and counters carry only the pool name, never a user id. */
  private noteBudget(pool: 'user' | 'system', r: QuotaResult): void {
    this.metrics.setGauge('provider_budget_remaining', r.allowed ? r.remaining : 0, { pool });
    this.metrics.setGauge(
      'provider_budget_limit',
      pool === 'system' ? this.systemReserve : this.userPool,
      { pool },
    );
    if (r.allowed) this.metrics.inc('provider_budget_consumed_total', { pool });
  }

  private publishLimits(): void {
    this.metrics.setGauge('provider_budget_limit', this.userPool, { pool: 'user' });
    this.metrics.setGauge('provider_budget_limit', this.systemReserve, { pool: 'system' });
    // nothing spent yet: an unset gauge would read as "0 left" for a pool that was never touched
    this.metrics.setGauge('provider_budget_remaining', this.userPool, { pool: 'user' });
    this.metrics.setGauge('provider_budget_remaining', this.systemReserve, { pool: 'system' });
  }

  /* ---------------------------------------------------------------- internals */

  private record<T>(provider: string, result: ProviderResult<T>): void {
    if (result.available) {
      this.breaker.onSuccess();
      this.metrics.inc('provider_requests_total', { provider, outcome: 'ok' });
      return;
    }
    switch (result.code) {
      case 'NOT_FOUND':
      case 'UNSUPPORTED':
        this.breaker.onSuccess(); // the provider answered: it is alive
        this.metrics.inc('provider_requests_total', { provider, outcome: 'not_found' });
        return;
      case 'ERROR':
      case 'RATE_LIMITED':
        this.breaker.onFailure();
        this.metrics.inc('provider_requests_total', { provider, outcome: 'error' });
        return;
      default:
        return; // QUOTA/BUSY produced inside (breaker probe refused): nothing reached the provider
    }
  }

  private refuse(reason: string, result: Unavailable, pool?: 'user' | 'system'): Unavailable {
    this.metrics.inc('provider_throttled_total', { reason });
    if (pool) this.warnExhausted(pool, reason);
    return result;
  }

  /** At most one log line a minute per pool, so an attack cannot flood the log. */
  private warnExhausted(pool: string, reason: string): void {
    const now = Date.now();
    if (now - (this.lastExhaustedLog.get(pool) ?? 0) < 60_000) return;
    this.lastExhaustedLog.set(pool, now);
    this.logger.warn(JSON.stringify({ evt: 'provider_budget_exhausted', pool, reason }));
  }

  private cooldownSeconds(): number {
    return Math.max(1, Math.ceil(this.limits.breakerCooldownMs / 1000));
  }

  private buildScheduler(): ProviderScheduler {
    return new ProviderScheduler({
      concurrency: this.limits.concurrency,
      minIntervalMs: this.limits.minIntervalMs,
      queuePerUser: this.limits.queuePerUser,
      queueGlobal: this.limits.queueGlobal,
      queueSystem: this.limits.queueSystem,
      queueWaitMs: this.limits.queueWaitMs,
      taskTimeoutMs: this.limits.taskTimeoutMs,
      isPrivileged: (key) => CallerContext.isSystem(key),
      onChange: (s) => {
        this.metrics.setGauge('provider_queue_depth', s.queued);
        this.metrics.setGauge('provider_active', s.active);
      },
    });
  }

  private buildBreaker(): CircuitBreaker {
    return new CircuitBreaker({
      failureThreshold: this.limits.breakerFailures,
      cooldownMs: this.limits.breakerCooldownMs,
    });
  }
}
