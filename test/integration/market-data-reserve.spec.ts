import { AlertService } from '../../src/alert/alert.service';
import { ChatService } from '../../src/chat/chat.service';
import { CallerContext } from '../../src/common/caller-context';
import { Metrics } from '../../src/common/metrics.service';
import { MarketDataGovernor } from '../../src/stock/governance/market-data-governor';
import { UserService } from '../../src/user/user.service';
import { createTestApp, flushBackground, resetCaches, TestApp } from '../setup/test-app';

/**
 * End to end (real ChatService + AlertService + PostgreSQL, fixture provider): the historical attack —
 * several ordinary accounts, each inside its own quota, drain the shared hourly budget — used to leave the alert
 * checker with nothing, so a satisfied alert was never delivered. With the system reserve it is delivered, the
 * total provider usage stays bounded, and ordinary users get an honest degraded answer.
 */
const randTicker = () =>
  Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );
const plain = (h: string) => h.replace(/<[^>]+>/g, '');

describe('alert evaluation survives user-pool exhaustion (real PostgreSQL)', () => {
  let t: TestApp;
  let chat: ChatService;
  let alerts: AlertService;
  let users: UserService;
  let gov: MarketDataGovernor;
  let metrics: Metrics;
  const DAY = 86_400_000;
  const POOL = 40;
  const RESERVE = 20;

  /** Production-shaped limits, scaled down so the test can exhaust them. */
  const limits = (over: Record<string, number> = {}) =>
    gov.reconfigure({
      userPerMinute: 1000,
      userPerHour: 1000,
      globalPerHour: POOL + RESERVE,
      systemReservePerHour: RESERVE,
      concurrency: 3,
      minIntervalMs: 0,
      queuePerUser: 100,
      queueGlobal: 1000,
      queueSystem: 100,
      breakerFailures: 1000,
      ...over,
    });
  const say = async (id: number, text: string) =>
    plain((await chat.handle({ telegramId: id, chatId: id, text })).messages.join('\n'));
  /** `accounts` ordinary accounts, each asking for unknown tickers, until the user pool refuses. */
  const drainUserPool = async (accounts = 6) => {
    for (let round = 0; round < 40; round++) {
      await Promise.all(
        Array.from({ length: accounts }, (_, a) =>
          say(73_100 + a, 'harga ' + Array.from({ length: 4 }, randTicker).join(' ')),
        ),
      );
      if (metrics.counter('provider_throttled_total', { reason: 'global_budget' }) > 0) return;
    }
    throw new Error('the user pool was never exhausted');
  };
  const live = () => t.sent.filter((m) => /ALERT/.test(m.text)).length;

  beforeAll(async () => {
    t = await createTestApp();
    chat = t.app.get(ChatService);
    alerts = t.app.get(AlertService);
    users = t.app.get(UserService);
    gov = t.app.get(MarketDataGovernor);
    metrics = t.app.get(Metrics);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await flushBackground(t);
    await t.prisma.$executeRawUnsafe(
      'TRUNCATE "User","Alert","StockQuoteSnapshot","StockDailyPrice" RESTART IDENTITY CASCADE',
    );
    resetCaches(t, { governance: true });
    limits();
    t.sent.length = 0;
    t.provider.clearOverrides();
    t.provider.failWith = null;
  });

  it('REGRESSION: a satisfied alert is delivered although ordinary accounts have exhausted the user pool', async () => {
    const owner = (await users.upsertFromTelegram({ telegramId: 73_001, chatId: 73_001 })).id;
    await alerts.create(owner, 'TSTA', 'price', 'above', 1500); // TSTA is quoted at 1 777
    await drainUserPool();
    resetCaches(t); // the alert's quote must come from the provider path, as after the cache TTL
    const r = await alerts.checkAll();
    expect(r).toMatchObject({ checked: 1, triggered: 1, errors: 0 });
    expect(live()).toBe(1);
    expect((await t.prisma.alert.findFirstOrThrow()).status).toBe('TRIGGERED');
  });

  it('ordinary users meanwhile get an honest degraded answer for new data, never invented data', async () => {
    await drainUserPool();
    resetCaches(t);
    const reply = await say(73_200, 'harga TSTB');
    expect(reply).toMatch(/dibatasi|belum ada data tersimpan/i);
    expect(reply).not.toMatch(/Rp1\.003/); // no fabricated price
  });

  it('total provider usage stays bounded by the global ceiling, flood and alert checks together', async () => {
    const owner = (await users.upsertFromTelegram({ telegramId: 73_002, chatId: 73_002 })).id;
    await alerts.create(owner, 'TSTA', 'price', 'above', 99_999); // never satisfied: it is re-evaluated every cycle
    const before = t.provider.calls.quote + t.provider.calls.quotes + t.provider.calls.history;
    const flood = (async () => {
      for (let r = 0; r < 10; r++) {
        await Promise.all(
          Array.from({ length: 6 }, (_, a) =>
            say(73_300 + a, 'harga ' + Array.from({ length: 4 }, randTicker).join(' ')),
          ),
        );
      }
    })();
    const checker = (async () => {
      for (let i = 0; i < 40; i++) {
        resetCaches(t);
        await alerts.checkAll();
      }
    })();
    await Promise.all([flood, checker]);
    const used =
      t.provider.calls.quote + t.provider.calls.quotes + t.provider.calls.history - before;
    expect(used).toBeLessThanOrEqual(POOL + RESERVE);
  });

  it('the reserve is finite: once system jobs spent it, alert evaluation is skipped (not fired), and users are unaffected', async () => {
    const owner = (await users.upsertFromTelegram({ telegramId: 73_003, chatId: 73_003 })).id;
    await alerts.create(owner, 'TSTA', 'price', 'above', 1500);
    // system jobs spend the whole reserve (any system caller draws from it)
    let spent = 0;
    while (
      (
        await CallerContext.run('system:other-job', () =>
          gov.execute(t.provider.name, async () => ({ available: true as const, data: 1 })),
        )
      ).available
    ) {
      spent++;
      if (spent > 10 * RESERVE) throw new Error('the reserve is not finite');
    }
    expect(spent).toBe(RESERVE);
    resetCaches(t);
    const r = await alerts.checkAll();
    expect(r.triggered).toBe(0); // no capacity: nothing fires on missing data
    expect(r.errors).toBeGreaterThan(0);
    expect(live()).toBe(0);
    expect((await t.prisma.alert.findFirstOrThrow()).status).toBe('ACTIVE'); // not consumed
    // users still have their own pool
    expect(await say(73_400, 'harga TSTB')).toMatch(/TSTB/);
  });

  it('the reserve does not make the alert system fire on stale data', async () => {
    const owner = (await users.upsertFromTelegram({ telegramId: 73_004, chatId: 73_004 })).id;
    await alerts.create(owner, 'TSTA', 'price', 'above', 1000);
    await drainUserPool();
    t.provider.patchQuote('TSTA', { timestamp: new Date(Date.now() - 6 * DAY).toISOString() });
    resetCaches(t);
    const r = await alerts.checkAll();
    expect(r).toMatchObject({ triggered: 0, skippedStale: 1 });
    expect(live()).toBe(0);
    expect((await t.prisma.alert.findFirstOrThrow()).status).toBe('ACTIVE'); // not consumed
  });

  it('the reserve does not make the alert system fire on an implausible price', async () => {
    const owner = (await users.upsertFromTelegram({ telegramId: 73_005, chatId: 73_005 })).id;
    await alerts.create(owner, 'TSTA', 'price', 'below', 1000);
    await drainUserPool();
    t.provider.patchQuote('TSTA', { price: 1 });
    resetCaches(t);
    const r = await alerts.checkAll();
    expect(r).toMatchObject({ triggered: 0, skippedAnomaly: 1 });
    expect(live()).toBe(0);
  });

  it('an open circuit breaker stops alert evaluation too: no provider call, no alert, no crash', async () => {
    const owner = (await users.upsertFromTelegram({ telegramId: 73_006, chatId: 73_006 })).id;
    await alerts.create(owner, 'TSTA', 'price', 'above', 1500);
    limits({ breakerFailures: 1, breakerCooldownMs: 60_000 });
    t.provider.failWith = 'ERROR';
    await say(73_500, 'harga TSTB'); // one failure opens the breaker
    t.provider.failWith = null;
    resetCaches(t);
    const calls = t.provider.calls.quote + t.provider.calls.quotes;
    const r = await alerts.checkAll();
    expect(r.triggered).toBe(0);
    expect(t.provider.calls.quote + t.provider.calls.quotes).toBe(calls);
    expect(live()).toBe(0);
  });

  it('exposes the budget on /metrics without user ids', async () => {
    await drainUserPool();
    const text = metrics.toPrometheus();
    expect(text).toMatch(/provider_budget_remaining\{pool="user"\} 0/);
    expect(text).toMatch(/provider_budget_remaining\{pool="system"\}/);
    expect(text).toMatch(/provider_budget_consumed_total\{pool="user"\}/);
    expect(text).not.toMatch(/73100|73101|tg:/);
  });
});
