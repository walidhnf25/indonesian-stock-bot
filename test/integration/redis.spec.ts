import Redis from 'ioredis';
import { Metrics } from '../../src/common/metrics.service';
import { AppConfig } from '../../src/config/app-config.service';
import { RedisQuotaStore } from '../../src/redis/redis-quota-store';
import { RedisService } from '../../src/redis/redis.service';
import { MarketDataGovernor } from '../../src/stock/governance/market-data-governor';
import { CallerContext } from '../../src/common/caller-context';

/**
 * Redis-backed shared state. Needs the compose Redis (`docker compose up -d redis`, 127.0.0.1:6380).
 * Database 1 is used so that nothing of a running bot (database 0) is touched. When Redis is not reachable the
 * suite is skipped with a visible message instead of failing silently green.
 */
const URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/1';

async function reachable(): Promise<boolean> {
  const probe = new Redis(URL, {
    lazyConnect: true,
    connectTimeout: 1500,
    maxRetriesPerRequest: 0,
  });
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

function config(over: Record<string, unknown> = {}): AppConfig {
  const values: Record<string, unknown> = {
    REDIS_URL: URL,
    REDIS_CONNECT_TIMEOUT_MS: 1500,
    REDIS_KEY_PREFIX: 'stockbottest:',
    MARKET_DATA_USER_UNCACHED_PER_MINUTE: 5,
    MARKET_DATA_USER_UNCACHED_PER_HOUR: 1000,
    MARKET_DATA_GLOBAL_PER_HOUR: 1000,
    // 0 = one shared pool (the tests below are about the shared store, not about the reserve)
    MARKET_DATA_SYSTEM_RESERVE_PER_HOUR: 0,
    STOCK_API_MAX_CONCURRENCY: 2,
    STOCK_API_MIN_INTERVAL_MS: 0,
    MARKET_DATA_QUEUE_PER_USER: 5,
    MARKET_DATA_QUEUE_GLOBAL: 50,
    MARKET_DATA_QUEUE_SYSTEM: 10,
    MARKET_DATA_QUEUE_WAIT_MS: 2000,
    MARKET_DATA_TIMEOUT_MS: 2000,
    MARKET_DATA_BREAKER_FAILURES: 100,
    MARKET_DATA_BREAKER_COOLDOWN_SECONDS: 1,
    ...over,
  };
  return { get: (k: string) => values[k] } as unknown as AppConfig;
}

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('Redis-backed quota store', () => {
  let up = false;
  let raw: Redis;
  beforeAll(async () => {
    up = await reachable();
    if (!up) {
      console.warn(`[redis.spec] Redis not reachable at ${URL}: integration tests SKIPPED`);
      return;
    }
    raw = new Redis(URL);
    const keys = await raw.keys('stockbottest:*');
    if (keys.length) await raw.del(...keys);
  });
  afterAll(async () => {
    if (raw) {
      const keys = await raw.keys('stockbottest:*');
      if (keys.length) await raw.del(...keys);
      raw.disconnect();
    }
  });

  const it_ = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(name, async () => (up ? fn() : undefined), timeout);

  const connected = async () => {
    const svc = new RedisService(config(), new Metrics());
    await waitFor(() => svc.status === 'connected');
    return svc;
  };

  it_('connects, reports status and answers ping', async () => {
    const svc = await connected();
    expect(svc.enabled).toBe(true);
    expect(await svc.ping()).toBe(true);
    expect(svc.key('a', 1)).toBe('stockbottest:a:1');
    await svc.onModuleDestroy();
    expect(svc.status).toBe('disabled');
  });

  it_(
    'enforces a sliding window atomically: 100 concurrent consumes with limit 10 allow exactly 10',
    async () => {
      const svc = await connected();
      const store = new RedisQuotaStore(svc);
      const results = await Promise.all(
        Array.from({ length: 100 }, () => store.consume('t', 'atomic', 10, 60_000)),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(10);
      const denied = results.find((r) => !r.allowed);
      expect(denied?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(denied?.retryAfterSeconds).toBeLessThanOrEqual(60);
      const ttl = await raw.pttl('stockbottest:quota:t:atomic');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
      await svc.onModuleDestroy();
    },
  );

  it_('is shared between processes: two services see one budget', async () => {
    const a = await connected();
    const b = await connected();
    const sa = new RedisQuotaStore(a);
    const sb = new RedisQuotaStore(b);
    expect((await sa.consume('t', 'shared', 2, 60_000)).allowed).toBe(true);
    expect((await sb.consume('t', 'shared', 2, 60_000)).allowed).toBe(true);
    expect((await sa.consume('t', 'shared', 2, 60_000)).allowed).toBe(false);
    expect((await sb.consume('t', 'shared', 2, 60_000)).allowed).toBe(false);
    await a.onModuleDestroy();
    await b.onModuleDestroy();
  });

  it_('the window slides: units free up after windowMs', async () => {
    const svc = await connected();
    const store = new RedisQuotaStore(svc);
    expect((await store.consume('t', 'slide', 1, 300)).allowed).toBe(true);
    expect((await store.consume('t', 'slide', 1, 300)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 350));
    expect((await store.consume('t', 'slide', 1, 300)).allowed).toBe(true);
    await svc.onModuleDestroy();
  });

  it_('two governors (two processes) share the per-user quota', async () => {
    const m = new Metrics();
    const a = await connected();
    const b = await connected();
    const govA = new MarketDataGovernor(config(), m, new RedisQuotaStore(a));
    const govB = new MarketDataGovernor(config(), m, new RedisQuotaStore(b));
    const call = (g: MarketDataGovernor) =>
      CallerContext.run('tg:shared-user', () =>
        g.execute('yahoo', async () => ({ available: true, data: 1 })),
      );
    let ok = 0;
    for (let i = 0; i < 4; i++) if ((await call(i % 2 ? govA : govB)).available) ok++;
    expect(ok).toBe(4);
    expect(await call(govA)).toMatchObject({ available: true }); // the 5th and last unit
    expect(await call(govB)).toMatchObject({ available: false, code: 'QUOTA' });
    govA.onModuleDestroy();
    govB.onModuleDestroy();
    await a.onModuleDestroy();
    await b.onModuleDestroy();
  });

  it_('two governors share ONE user pool and ONE system reserve through Redis', async () => {
    const over = {
      MARKET_DATA_GLOBAL_PER_HOUR: 30,
      MARKET_DATA_SYSTEM_RESERVE_PER_HOUR: 10,
      MARKET_DATA_USER_UNCACHED_PER_MINUTE: 1000,
    };
    const a = await connected();
    const b = await connected();
    const govA = new MarketDataGovernor(config(over), new Metrics(), new RedisQuotaStore(a));
    const govB = new MarketDataGovernor(config(over), new Metrics(), new RedisQuotaStore(b));
    const callAs = (g: MarketDataGovernor, caller: string) =>
      CallerContext.run(caller, () =>
        g.execute('aud01', async () => ({ available: true, data: 1 })),
      );
    let users = 0;
    let system = 0;
    for (let i = 0; i < 60; i++) {
      if ((await callAs(i % 2 ? govA : govB, `tg:acct${i % 17}`)).available) users++;
      if ((await callAs(i % 2 ? govB : govA, 'system:alerts')).available) system++;
    }
    expect(users).toBe(20); // 30 total - 10 reserve, across both processes
    expect(system).toBe(10); // the reserve, across both processes
    govA.onModuleDestroy();
    govB.onModuleDestroy();
    await a.onModuleDestroy();
    await b.onModuleDestroy();
  });

  it_(
    'a Redis that forgets its keys (restart without persistence) does not refill the budget of this process',
    async () => {
      const over = {
        MARKET_DATA_GLOBAL_PER_HOUR: 30,
        MARKET_DATA_SYSTEM_RESERVE_PER_HOUR: 10,
        MARKET_DATA_USER_UNCACHED_PER_MINUTE: 1000,
      };
      const svc = await connected();
      const gov = new MarketDataGovernor(config(over), new Metrics(), new RedisQuotaStore(svc));
      let granted = 0;
      const burst = async () => {
        for (let i = 0; i < 60; i++) {
          const r = await CallerContext.run(`tg:acct${i % 17}`, () =>
            gov.execute('aud01-flush', async () => ({ available: true, data: 1 })),
          );
          if (r.available) granted++;
        }
      };
      await burst();
      expect(granted).toBe(20);
      const keys = await raw.keys('stockbottest:*');
      if (keys.length) await raw.del(...keys); // what a restart without persistence does
      await burst();
      expect(granted).toBe(20); // the local floor still holds the documented limit
      gov.onModuleDestroy();
      await svc.onModuleDestroy();
    },
  );

  it('when Redis is configured but unreachable, quotas fall back to the process and the fallback is counted', async () => {
    const metrics = new Metrics();
    const svc = new RedisService(config({ REDIS_URL: 'redis://127.0.0.1:1/0' }), metrics);
    const store = new RedisQuotaStore(svc);
    await waitFor(() => svc.status === 'unavailable', 8000);
    expect((await store.consume('t', 'fb', 1, 60_000)).allowed).toBe(true);
    expect((await store.consume('t', 'fb', 1, 60_000)).allowed).toBe(false); // still enforced locally
    expect(metrics.counter('redis_fallback_total', { what: 'quota' })).toBeGreaterThanOrEqual(2);
    expect(await svc.ping()).toBe(false);
    await svc.onModuleDestroy();
  }, 15_000);

  it('without REDIS_URL the service is disabled and the store is purely local', async () => {
    const metrics = new Metrics();
    const svc = new RedisService(config({ REDIS_URL: undefined }), metrics);
    const store = new RedisQuotaStore(svc);
    expect(svc.enabled).toBe(false);
    expect(svc.status).toBe('disabled');
    expect((await store.consume('t', 'local', 1, 60_000)).allowed).toBe(true);
    expect((await store.consume('t', 'local', 1, 60_000)).allowed).toBe(false);
    expect(metrics.counter('redis_fallback_total', { what: 'quota' })).toBe(0); // not a fallback: by design
    await svc.onModuleDestroy();
  });
});
