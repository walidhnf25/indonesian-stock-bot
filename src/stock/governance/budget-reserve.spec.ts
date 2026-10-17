import { CallerContext } from '../../common/caller-context';
import { Metrics } from '../../common/metrics.service';
import { AppConfig } from '../../config/app-config.service';
import { ProviderResult } from '../stock-data-provider.interface';
import { MarketDataGovernor } from './market-data-governor';
import { InMemoryQuotaStore, QuotaResult, QuotaStore } from './quota-store';

/**
 * The hourly provider budget used to be one pool shared by every user AND by the alert checker, so a few
 * ordinary accounts (each inside its own quota) could drain it and silently stop alert evaluation for everyone.
 * Now: total = user pool + system reserve; users can never touch the reserve and system jobs can never exceed it.
 */
const TOTAL = 100;
const RESERVE = 20;
const USER_POOL = TOTAL - RESERVE;

function config(over: Record<string, unknown> = {}): AppConfig {
  const values: Record<string, unknown> = {
    MARKET_DATA_USER_UNCACHED_PER_MINUTE: 1000,
    MARKET_DATA_USER_UNCACHED_PER_HOUR: 1000,
    MARKET_DATA_GLOBAL_PER_HOUR: TOTAL,
    MARKET_DATA_SYSTEM_RESERVE_PER_HOUR: RESERVE,
    STOCK_API_MAX_CONCURRENCY: 4,
    STOCK_API_MIN_INTERVAL_MS: 0,
    MARKET_DATA_QUEUE_PER_USER: 50,
    MARKET_DATA_QUEUE_GLOBAL: 500,
    MARKET_DATA_QUEUE_SYSTEM: 50,
    MARKET_DATA_QUEUE_WAIT_MS: 5000,
    MARKET_DATA_TIMEOUT_MS: 2000,
    MARKET_DATA_BREAKER_FAILURES: 50,
    MARKET_DATA_BREAKER_COOLDOWN_SECONDS: 1,
    ...over,
  };
  return { get: (k: string) => values[k] } as unknown as AppConfig;
}

const ok = (): ProviderResult<number> => ({ available: true, data: 1 });
const as = <T>(key: string, fn: () => Promise<T>) => CallerContext.run(key, fn);

describe('market-data budget: system reserve', () => {
  let metrics: Metrics;
  let gov: MarketDataGovernor;
  let providerCalls: number;
  const call = (caller: string) =>
    as(caller, () =>
      gov.execute('yahoo', async () => {
        providerCalls++;
        return ok();
      }),
    );
  /** Many ordinary accounts, each far inside its own quota, spend until the user pool refuses. */
  const drainUserPool = async (accounts = 10) => {
    let granted = 0;
    for (let i = 0; granted < USER_POOL + 5 && i < 500; i++) {
      const r = await call(`tg:${i % accounts}`);
      if (r.available) granted++;
      else break;
    }
    return granted;
  };

  beforeEach(() => {
    providerCalls = 0;
    metrics = new Metrics();
    gov = new MarketDataGovernor(config(), metrics);
  });
  afterEach(() => gov.onModuleDestroy());

  it('exposes the split: user pool + system reserve == the hard total', () => {
    expect(gov.userPool).toBe(USER_POOL);
    expect(gov.systemReserve).toBe(RESERVE);
    expect(gov.userPool + gov.systemReserve).toBe(TOTAL);
  });

  it('many accounts together can spend exactly the user pool, never the reserve (the historical attack)', async () => {
    const granted = await drainUserPool();
    expect(granted).toBe(USER_POOL);
    expect(providerCalls).toBe(USER_POOL);
    // a brand-new account (fresh quota) is refused too: the pool is shared, the reserve is not theirs
    const fresh = await call('tg:brand-new');
    expect(fresh).toMatchObject({ available: false, code: 'BUSY' });
    expect(providerCalls).toBe(USER_POOL);
    expect(
      metrics.counter('provider_throttled_total', { reason: 'global_budget' }),
    ).toBeGreaterThan(0);
  });

  it('system callers (alert evaluation) still get their reserve after the user pool is exhausted', async () => {
    await drainUserPool();
    for (let i = 0; i < RESERVE; i++) {
      const r = await call('system:alerts');
      expect(r.available).toBe(true);
    }
    expect(providerCalls).toBe(USER_POOL + RESERVE);
  });

  it('system callers can NOT bypass the total: beyond the reserve they are refused too', async () => {
    let granted = 0;
    for (let i = 0; i < 3 * RESERVE; i++) if ((await call('system:alerts')).available) granted++;
    expect(granted).toBe(RESERVE);
    expect(providerCalls).toBe(RESERVE);
    expect(metrics.counter('provider_throttled_total', { reason: 'system_reserve' })).toBe(
      2 * RESERVE,
    );
  });

  it('users + system together never exceed the global ceiling, whatever the interleaving', async () => {
    const results = await Promise.all(
      Array.from({ length: 400 }, (_, i) => call(i % 4 === 0 ? 'system:alerts' : `tg:${i % 37}`)),
    );
    expect(results.filter((r) => r.available).length).toBe(providerCalls);
    expect(providerCalls).toBeLessThanOrEqual(TOTAL);
    expect(providerCalls).toBe(TOTAL); // 100 system attempts > reserve, 300 user attempts > pool: both pools fill
  });

  it('concurrent calls cannot overspend the user pool (atomic accounting)', async () => {
    const results = await Promise.all(Array.from({ length: 300 }, (_, i) => call(`tg:${i % 60}`)));
    expect(results.filter((r) => r.available).length).toBe(USER_POOL);
    expect(providerCalls).toBe(USER_POOL);
  });

  it('reserve 0 keeps the legacy behaviour: system draws from the one shared pool, still bounded by the total', async () => {
    gov.reconfigure({ systemReservePerHour: 0, globalPerHour: 10 });
    let granted = 0;
    for (let i = 0; i < 30; i++) if ((await call('system:alerts')).available) granted++;
    expect(granted).toBe(10);
  });

  describe('per-user limits are preserved', () => {
    it('per-minute quota still applies to one account', async () => {
      gov.reconfigure({ userPerMinute: 5 });
      let granted = 0;
      for (let i = 0; i < 20; i++) if ((await call('tg:1')).available) granted++;
      expect(granted).toBe(5);
      expect(await call('tg:1')).toMatchObject({ available: false, code: 'QUOTA' });
    });

    it('hourly per-user cap bounds what one account can take from the pool', async () => {
      gov.reconfigure({ userPerHour: 7 });
      let granted = 0;
      for (let i = 0; i < 20; i++) if ((await call('tg:1')).available) granted++;
      expect(granted).toBe(7);
      const denied = await call('tg:1');
      expect(denied).toMatchObject({ available: false, code: 'QUOTA' });
      expect((denied as { retryAfterSeconds?: number }).retryAfterSeconds).toBeLessThanOrEqual(
        3600,
      );
      expect(
        metrics.counter('provider_throttled_total', { reason: 'user_hourly' }),
      ).toBeGreaterThan(0);
      // another account is unaffected
      expect((await call('tg:2')).available).toBe(true);
    });

    it('with the default-like ratio a handful of accounts can no longer drain the pool in an hour', async () => {
      // production shape: pool 8000/h, 300/h per user => at least 27 accounts are needed to drain it
      gov.reconfigure({ globalPerHour: 10_000, systemReservePerHour: 2_000, userPerHour: 300 });
      let granted = 0;
      for (let account = 0; account < 6; account++) {
        for (let i = 0; i < 400; i++) if ((await call(`tg:att${account}`)).available) granted++;
      }
      expect(granted).toBe(6 * 300);
      expect(granted).toBeLessThan(gov.userPool);
    });

    it('system callers are exempt from per-user quotas (they have their own reserve)', async () => {
      gov.reconfigure({ userPerMinute: 1, userPerHour: 1 });
      expect((await call('system:alerts')).available).toBe(true);
      expect((await call('system:alerts')).available).toBe(true);
    });
  });

  describe('a shared store that loses its state (Redis restart)', () => {
    /** Behaves like Redis: shared, and able to forget everything (FLUSHALL / restart without persistence). */
    class ForgetfulStore implements QuotaStore {
      private inner = new InMemoryQuotaStore();
      consume(
        scope: string,
        key: string,
        limit: number,
        windowMs: number,
        cost?: number,
      ): Promise<QuotaResult> {
        return this.inner.consume(scope, key, limit, windowMs, cost);
      }
      reset(): void {
        this.inner = new InMemoryQuotaStore();
      }
      forget(): void {
        this.inner = new InMemoryQuotaStore();
      }
    }

    it('does not silently grant a second budget: the process-local floor still enforces the documented limits', async () => {
      const store = new ForgetfulStore();
      const g = new MarketDataGovernor(config(), new Metrics(), store);
      let calls = 0;
      const run = (caller: string) =>
        as(caller, () => g.execute('yahoo', async () => (calls++, ok())));
      for (let i = 0; i < 300; i++) await run(`tg:${i % 50}`);
      expect(calls).toBe(USER_POOL);
      store.forget(); // Redis restarted: the shared window is gone
      for (let i = 0; i < 300; i++) await run(`tg:${i % 50}`);
      expect(calls).toBe(USER_POOL); // the pool did not refill
      // and the system reserve is protected the same way
      let sys = 0;
      for (let i = 0; i < 3 * RESERVE; i++) {
        if ((await as('system:alerts', () => g.execute('yahoo', async () => ok()))).available)
          sys++;
      }
      store.forget();
      for (let i = 0; i < 3 * RESERVE; i++) {
        if ((await as('system:alerts', () => g.execute('yahoo', async () => ok()))).available)
          sys++;
      }
      expect(sys).toBe(RESERVE);
      g.onModuleDestroy();
    });
  });

  describe('observability', () => {
    it('reports consumption and remaining capacity per pool, never per user', async () => {
      for (let i = 0; i < 5; i++) await call(`tg:secret-user-${i}`);
      for (let i = 0; i < 3; i++) await call('system:alerts');
      expect(metrics.gauge('provider_budget_limit', { pool: 'user' })).toBe(USER_POOL);
      expect(metrics.gauge('provider_budget_limit', { pool: 'system' })).toBe(RESERVE);
      expect(metrics.counter('provider_budget_consumed_total', { pool: 'user' })).toBe(5);
      expect(metrics.counter('provider_budget_consumed_total', { pool: 'system' })).toBe(3);
      expect(metrics.gauge('provider_budget_remaining', { pool: 'user' })).toBe(USER_POOL - 5);
      expect(metrics.gauge('provider_budget_remaining', { pool: 'system' })).toBe(RESERVE - 3);
      const text = metrics.toPrometheus();
      expect(text).toContain('provider_budget_remaining{pool="user"}');
      expect(text).not.toMatch(/secret-user|tg:/);
    });

    it('shows exhaustion: remaining drops to 0 and the throttle counter names the pool', async () => {
      await drainUserPool();
      await call('tg:one-more');
      expect(metrics.gauge('provider_budget_remaining', { pool: 'user' })).toBe(0);
      expect(metrics.gauge('provider_budget_remaining', { pool: 'system' })).toBe(RESERVE);
    });
  });

  describe('invalid limits are refused, never silently ignored', () => {
    it.each([
      ['a missing number', { MARKET_DATA_USER_UNCACHED_PER_HOUR: undefined }],
      ['NaN', { MARKET_DATA_GLOBAL_PER_HOUR: Number.NaN }],
      ['zero total', { MARKET_DATA_GLOBAL_PER_HOUR: 0 }],
      ['a negative reserve', { MARKET_DATA_SYSTEM_RESERVE_PER_HOUR: -1 }],
      ['a text value', { STOCK_API_MAX_CONCURRENCY: 'many' }],
    ])('the constructor throws for %s', (_name, over) => {
      expect(() => new MarketDataGovernor(config(over), new Metrics())).toThrow(
        /invalid market-data limit/,
      );
    });

    it('reconfigure() refuses them too', () => {
      expect(() => gov.reconfigure({ globalPerHour: Number.NaN })).toThrow(
        /invalid market-data limit/,
      );
      expect(gov.userPool).toBe(USER_POOL); // the previous, valid limits are kept
    });
  });

  describe('honest degraded mode for users', () => {
    it('answers BUSY with a retry hint (not an error, not fabricated data) and does not call the provider', async () => {
      await drainUserPool();
      const before = providerCalls;
      const r = await call('tg:late');
      expect(r).toMatchObject({ available: false, code: 'BUSY' });
      expect((r as { retryAfterSeconds?: number }).retryAfterSeconds).toBeGreaterThan(0);
      expect((r as { retryAfterSeconds?: number }).retryAfterSeconds).toBeLessThanOrEqual(3600);
      expect(providerCalls).toBe(before);
    });
  });
});
