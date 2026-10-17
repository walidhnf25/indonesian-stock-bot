import { CallerContext } from '../../common/caller-context';
import { Metrics } from '../../common/metrics.service';
import { AppConfig } from '../../config/app-config.service';
import { ProviderResult } from '../stock-data-provider.interface';
import { unavailable } from '../stock.types';
import { MarketDataGovernor } from './market-data-governor';
import { TickerRegistry } from './ticker-registry';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function config(over: Record<string, unknown> = {}): AppConfig {
  const values: Record<string, unknown> = {
    MARKET_DATA_USER_UNCACHED_PER_MINUTE: 5,
    MARKET_DATA_USER_UNCACHED_PER_HOUR: 1000,
    MARKET_DATA_GLOBAL_PER_HOUR: 100,
    // 0 = no reserve: the legacy tests below describe one shared pool; the reserve has its own describe block
    MARKET_DATA_SYSTEM_RESERVE_PER_HOUR: 0,
    STOCK_API_MAX_CONCURRENCY: 2,
    STOCK_API_MIN_INTERVAL_MS: 0,
    MARKET_DATA_QUEUE_PER_USER: 3,
    MARKET_DATA_QUEUE_GLOBAL: 20,
    MARKET_DATA_QUEUE_SYSTEM: 10,
    MARKET_DATA_QUEUE_WAIT_MS: 2000,
    MARKET_DATA_TIMEOUT_MS: 1000,
    MARKET_DATA_BREAKER_FAILURES: 3,
    MARKET_DATA_BREAKER_COOLDOWN_SECONDS: 1,
    TICKER_EXISTS_TTL_SECONDS: 86_400,
    TICKER_MISSING_TTL_SECONDS: 120,
    ...over,
  };
  return { get: (k: string) => values[k] } as unknown as AppConfig;
}

const ok = (data = 1): ProviderResult<number> => ({ available: true, data });
const as = <T>(key: string, fn: () => Promise<T>) => CallerContext.run(key, fn);

describe('MarketDataGovernor', () => {
  let metrics: Metrics;
  let gov: MarketDataGovernor;
  beforeEach(() => {
    metrics = new Metrics();
    gov = new MarketDataGovernor(config(), metrics);
  });
  afterEach(() => gov.onModuleDestroy());

  describe('per-user quota', () => {
    it('lets a user cause up to the limit, then answers QUOTA with a retry hint and does not call the provider', async () => {
      let calls = 0;
      const call = () => as('tg:1', () => gov.execute('yahoo', async () => (calls++, ok())));
      for (let i = 0; i < 5; i++) expect((await call()).available).toBe(true);
      const denied = await call();
      expect(denied).toMatchObject({ available: false, code: 'QUOTA' });
      expect((denied as { retryAfterSeconds?: number }).retryAfterSeconds).toBeGreaterThan(0);
      expect(calls).toBe(5);
      expect(metrics.counter('provider_throttled_total', { reason: 'user_quota' })).toBe(1);
    });

    it('is per user: another user is unaffected by a user who used up the quota', async () => {
      for (let i = 0; i < 6; i++) await as('tg:1', () => gov.execute('yahoo', async () => ok()));
      const other = await as('tg:2', () => gov.execute('yahoo', async () => ok()));
      expect(other.available).toBe(true);
    });

    it('a denied call does not take a global unit', async () => {
      gov.reconfigure({ globalPerHour: 6, userPerMinute: 5 });
      for (let i = 0; i < 20; i++) await as('tg:1', () => gov.execute('yahoo', async () => ok()));
      // 5 allowed for tg:1, 15 refused by the user quota: one global unit is still left
      const other = await as('tg:2', () => gov.execute('yahoo', async () => ok()));
      expect(other.available).toBe(true);
    });

    it('background jobs (system:*) are exempt from the per-user quota', async () => {
      for (let i = 0; i < 20; i++) {
        const r = await as('system:alerts', () => gov.execute('yahoo', async () => ok()));
        expect(r.available).toBe(true);
      }
    });

    it('a caller without any context is still limited (and counted)', async () => {
      for (let i = 0; i < 5; i++) await gov.execute('yahoo', async () => ok());
      const denied = await gov.execute('yahoo', async () => ok());
      expect(denied).toMatchObject({ available: false, code: 'QUOTA' });
      expect(metrics.counter('provider_unattributed_total')).toBe(6);
    });
  });

  describe('global hourly budget', () => {
    it('spent budget puts the provider into degraded mode for everybody, system included', async () => {
      gov.reconfigure({ globalPerHour: 3, userPerMinute: 100 });
      for (let i = 0; i < 3; i++) {
        expect((await as(`tg:${i}`, () => gov.execute('yahoo', async () => ok()))).available).toBe(
          true,
        );
      }
      const user = await as('tg:9', () => gov.execute('yahoo', async () => ok()));
      const system = await as('system:alerts', () => gov.execute('yahoo', async () => ok()));
      expect(user).toMatchObject({ available: false, code: 'BUSY' });
      expect(system).toMatchObject({ available: false, code: 'BUSY' });
      expect(metrics.counter('provider_throttled_total', { reason: 'global_budget' })).toBe(2);
    });

    it('is per provider: another provider keeps its own budget', async () => {
      gov.reconfigure({ globalPerHour: 1, userPerMinute: 100 });
      await as('tg:1', () => gov.execute('yahoo', async () => ok()));
      expect((await as('tg:1', () => gov.execute('yahoo', async () => ok()))).available).toBe(
        false,
      );
      expect((await as('tg:1', () => gov.execute('providerB', async () => ok()))).available).toBe(
        true,
      );
    });
  });

  describe('fair, bounded scheduling', () => {
    it('answers BUSY at once when a user queue is full, without calling the provider', async () => {
      gov.reconfigure({ concurrency: 1, queuePerUser: 1, userPerMinute: 100, queueWaitMs: 2000 });
      let calls = 0;
      const slow = () =>
        as('tg:1', () =>
          gov.execute('yahoo', async () => {
            calls++;
            await delay(60);
            return ok();
          }),
        );
      const results = await Promise.all([slow(), slow(), slow(), slow()]);
      expect(results.filter((r) => r.available)).toHaveLength(2); // one running + one queued
      expect(results.filter((r) => !r.available && r.code === 'BUSY')).toHaveLength(2);
      expect(calls).toBe(2);
      expect(metrics.counter('provider_throttled_total', { reason: 'queue_user' })).toBe(2);
    });

    it('a second user is served promptly while another user floods', async () => {
      gov.reconfigure({ concurrency: 1, queuePerUser: 5, userPerMinute: 1000 });
      const started: string[] = [];
      const call = (user: string, label: string) =>
        as(user, () =>
          gov.execute('yahoo', async () => {
            started.push(label);
            await delay(100); // long enough that the victim queues while the first call still runs
            return ok();
          }),
        );
      const flood = Array.from({ length: 6 }, (_, i) => call('tg:flooder', `F${i}`));
      while (started.length < 1) await delay(1); // the first flooding call is running
      const victim = call('tg:victim', 'V0');
      await victim;
      expect(started.indexOf('V0')).toBeLessThanOrEqual(2);
      await Promise.all(flood);
    });

    it('releases the slot when the provider throws, times out, or the caller is refused', async () => {
      gov.reconfigure({ concurrency: 1, taskTimeoutMs: 40, userPerMinute: 1000 });
      const thrown = await as('tg:1', () =>
        gov.execute('yahoo', async () => {
          throw new Error('socket hang up');
        }),
      );
      expect(thrown).toMatchObject({ available: false, code: 'ERROR' });
      const hung = await as('tg:1', () =>
        gov.execute('yahoo', () => new Promise<never>(() => undefined)),
      );
      expect(hung).toMatchObject({ available: false, code: 'ERROR' });
      const next = await as('tg:2', () => gov.execute('yahoo', async () => ok(7)));
      expect(next).toMatchObject({ available: true, data: 7 });
      expect(gov.schedulerStats.active).toBe(0);
    });

    it('an aborted call releases the slot', async () => {
      gov.reconfigure({ concurrency: 1, userPerMinute: 1000 });
      const controller = new AbortController();
      const p = as('tg:1', () =>
        gov.execute('yahoo', () => new Promise<never>(() => undefined), controller.signal),
      );
      await delay(10);
      controller.abort();
      expect(await p).toMatchObject({ available: false, code: 'BUSY' });
      expect((await as('tg:2', () => gov.execute('yahoo', async () => ok()))).available).toBe(true);
    });
  });

  describe('circuit breaker', () => {
    const fail = (): Promise<ProviderResult<number>> =>
      Promise.resolve(unavailable('down', 'ERROR'));

    it('opens after consecutive provider failures, then stops calling the provider (degraded mode)', async () => {
      gov.reconfigure({ breakerFailures: 3, breakerCooldownMs: 5000, userPerMinute: 1000 });
      let calls = 0;
      const call = () => as('tg:1', () => gov.execute('yahoo', async () => (calls++, fail())));
      for (let i = 0; i < 3; i++) await call();
      expect(gov.breakerState).toBe('OPEN');
      const refused = await call();
      expect(refused).toMatchObject({ available: false, code: 'BUSY' });
      expect(calls).toBe(3);
      expect(metrics.counter('provider_throttled_total', { reason: 'breaker_open' })).toBe(1);
    });

    it('NOT_FOUND answers do not count as failures', async () => {
      gov.reconfigure({ breakerFailures: 2, userPerMinute: 1000 });
      for (let i = 0; i < 10; i++) {
        await as('tg:1', () => gov.execute('yahoo', async () => unavailable('no', 'NOT_FOUND')));
      }
      expect(gov.breakerState).toBe('CLOSED');
    });

    it('lets one probe through after the cooldown and closes again on success', async () => {
      gov.reconfigure({ breakerFailures: 2, breakerCooldownMs: 60, userPerMinute: 1000 });
      for (let i = 0; i < 2; i++) await as('tg:1', () => gov.execute('yahoo', async () => fail()));
      expect(gov.breakerState).toBe('OPEN');
      await delay(80);
      const probe = await as('tg:1', () => gov.execute('yahoo', async () => ok(3)));
      expect(probe).toMatchObject({ available: true, data: 3 });
      expect(gov.breakerState).toBe('CLOSED');
    });

    it('an open breaker consumes no quota: after the cooldown the user still has what was left', async () => {
      gov.reconfigure({
        breakerFailures: 1,
        breakerCooldownMs: 80,
        userPerMinute: 3,
        globalPerHour: 100,
      });
      await as('tg:1', () => gov.execute('yahoo', async () => fail())); // opens the breaker; 1 of 3 units used
      for (let i = 0; i < 10; i++) {
        const refused = await as('tg:1', () => gov.execute('yahoo', async () => ok()));
        expect(refused).toMatchObject({ available: false, code: 'BUSY' }); // refused by the breaker, not by the quota
      }
      await delay(100);
      const probe = await as('tg:1', () => gov.execute('yahoo', async () => ok(9)));
      expect(probe).toMatchObject({ available: true, data: 9 }); // would be QUOTA if the refusals had been charged
      expect(metrics.counter('provider_throttled_total', { reason: 'user_quota' })).toBe(0);
    });
  });

  describe('metrics', () => {
    it('count requests by outcome and expose the queue gauges', async () => {
      await as('tg:1', () => gov.execute('yahoo', async () => ok()));
      await as('tg:1', () => gov.execute('yahoo', async () => unavailable('x', 'NOT_FOUND')));
      await as('tg:1', () => gov.execute('yahoo', async () => unavailable('x', 'ERROR')));
      expect(metrics.counter('provider_requests_total', { provider: 'yahoo', outcome: 'ok' })).toBe(
        1,
      );
      expect(
        metrics.counter('provider_requests_total', { provider: 'yahoo', outcome: 'not_found' }),
      ).toBe(1);
      expect(
        metrics.counter('provider_requests_total', { provider: 'yahoo', outcome: 'error' }),
      ).toBe(1);
      expect(metrics.gauge('provider_queue_depth')).toBe(0);
      expect(metrics.gauge('provider_active')).toBe(0);
    });

    it('never put a caller identity into a label', async () => {
      for (let i = 0; i < 8; i++)
        await as('tg:123456789', () => gov.execute('yahoo', async () => ok()));
      expect(metrics.toPrometheus()).not.toContain('123456789');
    });
  });
});

describe('TickerRegistry', () => {
  const make = (over: Record<string, unknown> = {}) => new TickerRegistry(config(over));

  it('listed tickers are always known to exist and never become missing', () => {
    const r = make();
    expect(r.status('BBCA')).toBe('listed');
    expect(r.noteMissing('BBCA')).toBe(false);
    expect(r.noteMissing('BBCA')).toBe(false);
    expect(r.status('BBCA')).toBe('listed');
  });

  it('an unknown ticker is "unverified" until the provider proves it exists', () => {
    const r = make();
    expect(r.status('ZZQX')).toBe('unverified');
    expect(r.isKnownToExist('ZZQX')).toBe(false);
    r.markVerified('ZZQX');
    expect(r.status('ZZQX')).toBe('verified');
    expect(r.isKnownToExist('ZZQX')).toBe(true);
  });

  it('"missing" needs two misses; a verified ticker can never become missing', () => {
    const r = make();
    expect(r.noteMissing('ZZQX')).toBe(false);
    expect(r.status('ZZQX')).toBe('unverified');
    expect(r.noteMissing('ZZQX')).toBe(true);
    expect(r.status('ZZQX')).toBe('missing');
    r.markVerified('ZZQX'); // it turned out to exist after all
    expect(r.status('ZZQX')).toBe('verified');
    expect(r.noteMissing('ZZQX')).toBe(false);
    expect(r.status('ZZQX')).toBe('verified');
  });

  it('remembered answers expire (positive and negative)', async () => {
    const r = make({ TICKER_EXISTS_TTL_SECONDS: 0.05, TICKER_MISSING_TTL_SECONDS: 0.05 });
    r.markVerified('AAAA');
    r.noteMissing('BBBZ');
    r.noteMissing('BBBZ');
    expect(r.status('AAAA')).toBe('verified');
    expect(r.status('BBBZ')).toBe('missing');
    await delay(80);
    expect(r.status('AAAA')).toBe('unverified');
    expect(r.status('BBBZ')).toBe('unverified');
  });

  it('reset() forgets what was learned but keeps the built-in list', () => {
    const r = make();
    r.markVerified('ZZQX');
    r.reset();
    expect(r.status('ZZQX')).toBe('unverified');
    expect(r.status('BBCA')).toBe('listed');
  });
});

describe('request deadline: the abort signal of the caller context cancels provider calls', () => {
  it('a queued call is cancelled when the request is abandoned, without an explicit signal argument', async () => {
    const metrics = new Metrics();
    const gov = new MarketDataGovernor(config({ STOCK_API_MAX_CONCURRENCY: 1 }), metrics);
    try {
      const controller = new AbortController();
      const blocker = CallerContext.run('tg:1', () =>
        gov.execute('yahoo', () => delay(200).then(() => ok(1))),
      );
      const queued = CallerContext.run(
        'tg:2',
        () => gov.execute('yahoo', async () => ok(2)),
        controller.signal,
      );
      controller.abort();
      expect(await queued).toMatchObject({ available: false, code: 'BUSY' });
      expect(metrics.counter('provider_throttled_total', { reason: 'aborted' })).toBe(1);
      await blocker;
    } finally {
      gov.onModuleDestroy();
    }
  });

  it('TickerRegistry treats word-tickers as listed', () => {
    const r = new TickerRegistry(config());
    expect(r.status('GOOD')).toBe('listed');
    expect(r.noteMissing('GOOD')).toBe(false);
  });
});
