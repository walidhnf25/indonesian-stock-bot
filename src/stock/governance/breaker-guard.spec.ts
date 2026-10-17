import { CallerContext } from '../../common/caller-context';
import { Metrics } from '../../common/metrics.service';
import { AppConfig } from '../../config/app-config.service';
import { ProviderResult } from '../stock-data-provider.interface';
import { unavailable } from '../stock.types';
import { MarketDataGovernor } from './market-data-governor';

/**
 * The circuit breaker is consulted TWICE: at the door (cheap refusal while OPEN) and again
 * inside the scheduled task, when the call really starts. The second check is what stops work that was queued while
 * the breaker was still CLOSED, and what limits HALF_OPEN to a single probe. Removing it left the whole suite green.
 * These tests go through the real governor + scheduler, so they fail if either guard disappears.
 */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function config(over: Record<string, unknown> = {}): AppConfig {
  const values: Record<string, unknown> = {
    MARKET_DATA_USER_UNCACHED_PER_MINUTE: 1000,
    MARKET_DATA_USER_UNCACHED_PER_HOUR: 100_000,
    MARKET_DATA_GLOBAL_PER_HOUR: 100_000,
    MARKET_DATA_SYSTEM_RESERVE_PER_HOUR: 1000,
    STOCK_API_MAX_CONCURRENCY: 1,
    STOCK_API_MIN_INTERVAL_MS: 0,
    MARKET_DATA_QUEUE_PER_USER: 50,
    MARKET_DATA_QUEUE_GLOBAL: 500,
    MARKET_DATA_QUEUE_SYSTEM: 50,
    MARKET_DATA_QUEUE_WAIT_MS: 5000,
    MARKET_DATA_TIMEOUT_MS: 2000,
    MARKET_DATA_BREAKER_FAILURES: 1,
    MARKET_DATA_BREAKER_COOLDOWN_SECONDS: 1,
    ...over,
  };
  return { get: (k: string) => values[k] } as unknown as AppConfig;
}

const good = (): ProviderResult<number> => ({ available: true, data: 1 });
const bad = (): ProviderResult<number> => unavailable('upstream down', 'ERROR');
const as = <T>(key: string, fn: () => Promise<T>, signal?: AbortSignal) =>
  CallerContext.run(key, fn, signal);

describe('circuit breaker: execution-time guard and half-open single probe', () => {
  let gov: MarketDataGovernor;
  let metrics: Metrics;
  let providerCalls: number;
  /** A provider call that takes `ms` and then returns `result`. */
  const call = (caller: string, ms: number, result: () => ProviderResult<number>) =>
    CallerContext.run(caller, () =>
      gov.execute('yahoo', async () => {
        providerCalls++;
        await delay(ms);
        return result();
      }),
    );

  beforeEach(() => {
    providerCalls = 0;
    metrics = new Metrics();
    gov = new MarketDataGovernor(config(), metrics);
    gov.reconfigure({ breakerFailures: 1, breakerCooldownMs: 250 });
  });
  afterEach(() => gov.onModuleDestroy());

  it('work queued while the breaker was CLOSED is refused when it finally runs, after the breaker opened', async () => {
    // one worker: A runs (and fails) while B, C, D wait in the queue behind it
    const all = await Promise.all([
      call('tg:a', 40, bad),
      call('tg:b', 40, good),
      call('tg:c', 40, good),
      call('tg:d', 40, good),
    ]);
    expect(providerCalls).toBe(1); // only A ever reached the provider
    expect(all[0]).toMatchObject({ available: false, code: 'ERROR' });
    for (const r of all.slice(1)) expect(r).toMatchObject({ available: false, code: 'BUSY' });
    expect(gov.breakerState).toBe('OPEN');
    expect(metrics.counter('provider_throttled_total', { reason: 'breaker_open' })).toBe(3);
  });

  it('the same holds with several workers: a failure recorded while others are still queued stops the queue', async () => {
    gov.reconfigure({ concurrency: 2, breakerFailures: 1, breakerCooldownMs: 250 });
    const all = await Promise.all(
      Array.from({ length: 8 }, (_, i) => call(`tg:${i}`, 40, i === 0 ? bad : good)),
    );
    // at most the two calls that were already running when the breaker opened may have reached the provider
    expect(providerCalls).toBeLessThanOrEqual(2);
    expect(all.filter((r) => r.available).length).toBeLessThanOrEqual(1);
  });

  it('HALF_OPEN lets exactly one probe through a burst of concurrent requests', async () => {
    gov.reconfigure({ concurrency: 6, breakerFailures: 1, breakerCooldownMs: 250 });
    await call('tg:opener', 5, bad);
    expect(gov.breakerState).toBe('OPEN');
    const opened = providerCalls;
    // while OPEN nothing is sent
    expect(await call('tg:early', 5, good)).toMatchObject({ available: false, code: 'BUSY' });
    expect(providerCalls).toBe(opened);
    await delay(300); // cooldown elapsed

    const burst = await Promise.all(
      Array.from({ length: 12 }, (_, i) => call(`tg:burst${i}`, 60, bad)),
    );
    expect(providerCalls - opened).toBe(1); // one probe, not twelve
    expect(burst.filter((r) => r.available === false && r.code === 'ERROR')).toHaveLength(1);
    expect(burst.filter((r) => r.available === false && r.code === 'BUSY')).toHaveLength(11);
    expect(gov.breakerState).toBe('OPEN'); // the probe failed: back to OPEN with a fresh cooldown
  });

  it('a successful probe closes the breaker and normal traffic resumes without a stampede or a stuck state', async () => {
    gov.reconfigure({ concurrency: 6, breakerFailures: 1, breakerCooldownMs: 250 });
    await call('tg:opener', 5, bad);
    await delay(300);
    const burst = await Promise.all(
      Array.from({ length: 10 }, (_, i) => call(`tg:burst${i}`, 40, good)),
    );
    expect(burst.filter((r) => r.available)).toHaveLength(1); // only the probe ran
    expect(gov.breakerState).toBe('CLOSED');
    const after = providerCalls;
    const next = await Promise.all(
      Array.from({ length: 10 }, (_, i) => call(`tg:next${i}`, 5, good)),
    );
    expect(next.every((r) => r.available)).toBe(true);
    expect(providerCalls - after).toBe(10);
  });

  it('a probe abandoned by its caller frees the probe slot, so the breaker is not stuck waiting for it', async () => {
    await call('tg:opener', 5, bad);
    await delay(300);
    const ac = new AbortController();
    const abandoned = as(
      'tg:impatient',
      () =>
        gov.execute('yahoo', async () => {
          providerCalls++;
          await delay(400);
          return good();
        }),
      ac.signal,
    );
    await delay(30); // the probe is running
    ac.abort();
    await abandoned;
    const before = providerCalls;
    const next = await call('tg:next', 5, good); // must be allowed to probe again right away
    expect(providerCalls - before).toBe(1);
    expect(next).toMatchObject({ available: true });
    expect(gov.breakerState).toBe('CLOSED');
  });

  it('system callers obey the breaker as well (the reserve is a budget, not a way around an open circuit)', async () => {
    await call('tg:opener', 5, bad);
    const before = providerCalls;
    const r = await CallerContext.run('system:alerts', () =>
      gov.execute('yahoo', async () => {
        providerCalls++;
        return good();
      }),
    );
    expect(r).toMatchObject({ available: false, code: 'BUSY' });
    expect(providerCalls).toBe(before);
  });
});
