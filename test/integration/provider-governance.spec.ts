import request from 'supertest';
import { ChatService } from '../../src/chat/chat.service';
import { CallerContext } from '../../src/common/caller-context';
import { Metrics } from '../../src/common/metrics.service';
import {
  GovernorLimits,
  MarketDataGovernor,
} from '../../src/stock/governance/market-data-governor';
import { TickerRegistry } from '../../src/stock/governance/ticker-registry';
import { StockService } from '../../src/stock/stock.service';
import { createTestApp, flushBackground, resetCaches, sleep, TestApp } from '../setup/test-app';

/**
 * one public account must not be able to drive the provider (Yahoo) without bound, and must not make
 * other users wait. Fixture provider + real PostgreSQL. TSTA/TSTB/TSTC are real to the fixture provider but not
 * on the built-in IDX list, so they behave like the "real but unlisted tickers" of the review's attack.
 */
const plain = (html: string) => html.replace(/<[^>]+>/g, '');

describe('provider governance (integration)', () => {
  let t: TestApp;
  let stocks: StockService;
  let gov: MarketDataGovernor;
  let metrics: Metrics;
  let defaults: GovernorLimits;

  const as = <T>(user: string, fn: () => Promise<T>) => CallerContext.run(user, fn);
  const providerCalls = () =>
    t.provider.calls.quote + t.provider.calls.history + t.provider.calls.fundamentals;
  /** What an analysis of one ticker asks the provider for. */
  const analysisCalls = (symbol: string) =>
    Promise.all([
      stocks.getQuote(symbol),
      stocks.getHistory(symbol, '1y'),
      stocks.getFundamentals(symbol),
    ]);

  beforeAll(async () => {
    t = await createTestApp();
    stocks = t.app.get(StockService);
    gov = t.app.get(MarketDataGovernor);
    metrics = t.app.get(Metrics);
    defaults = { ...gov.currentLimits };
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    // stored data is the degraded-mode fallback: it must not leak from one test into the next
    await flushBackground(t); // writes started by the previous test must land before the clean-up
    await t.prisma.stockQuoteSnapshot.deleteMany({});
    await t.prisma.stockDailyPrice.deleteMany({});
    gov.reconfigure(defaults);
    resetCaches(t, { governance: true });
    t.provider.failWith = null;
    t.provider.calls = { quote: 0, quotes: 0, history: 0, fundamentals: 0 };
  });
  afterEach(() => {
    gov.reconfigure(defaults);
  });

  describe('the attack from the review: one account, many uncached tickers', () => {
    it('an account cannot cause more provider calls per minute than its quota, however often it asks', async () => {
      gov.reconfigure({ userPerMinute: 12 });
      for (let round = 0; round < 20; round++) {
        resetCaches(t); // caches expire / the attacker rotates tickers: every round is uncached
        for (const symbol of ['TSTA', 'TSTB', 'TSTC'])
          await as('tg:attacker', () => analysisCalls(symbol));
      }
      expect(providerCalls()).toBeLessThanOrEqual(12);
      expect(providerCalls()).toBeGreaterThan(0);
      expect(metrics.counter('provider_throttled_total', { reason: 'user_quota' })).toBeGreaterThan(
        0,
      );
    });

    it('while the attacker is throttled another user is still served normally', async () => {
      gov.reconfigure({ userPerMinute: 6 });
      for (let round = 0; round < 10; round++) {
        resetCaches(t);
        await as('tg:attacker', () => analysisCalls('TSTA'));
      }
      resetCaches(t);
      const victim = await as('tg:victim', () => stocks.getQuote('TSTB'));
      expect(victim.available).toBe(true);
      const attacker = await as('tg:attacker', () => stocks.getQuote('TSTC'));
      expect(attacker).toMatchObject({ available: false, code: 'QUOTA' });
    });

    it('cache hits are free: repeated requests inside the cache window use no quota', async () => {
      gov.reconfigure({ userPerMinute: 3 });
      for (let i = 0; i < 25; i++) await as('tg:1', () => stocks.getQuote('TSTA'));
      expect(t.provider.calls.quote).toBe(1);
      // only one unit of three was used: two more uncached calls are still allowed
      resetCaches(t);
      expect((await as('tg:1', () => stocks.getQuote('TSTB'))).available).toBe(true);
      resetCaches(t);
      expect((await as('tg:1', () => stocks.getQuote('TSTC'))).available).toBe(true);
      resetCaches(t);
      // the fourth uncached request must not reach the provider: it is refused (QUOTA) or, when the earlier
      // background persistence has already stored TSTA, answered from stored data like any outage
      const fourth = await as('tg:1', () => stocks.getQuote('TSTA'));
      expect(t.provider.calls.quote).toBe(3);
      if (fourth.available) expect(fourth.data.symbol).toBe('TSTA');
      else expect(fourth.code).toBe('QUOTA');
    });

    it('a retry does not bypass the quota: every attempt is charged', async () => {
      gov.reconfigure({ userPerMinute: 2 });
      t.provider.failWith = 'ERROR';
      const r = await as('tg:1', () => stocks.getQuote('TSTA')); // 1 try + 2 retries would be 3 calls
      expect(r.available).toBe(false);
      expect(t.provider.calls.quote).toBe(2);
    });
  });

  describe('unknown tickers fail cheaply', () => {
    it('history and fundamentals of an unknown ticker never reach the provider', async () => {
      for (let i = 0; i < 4; i++) {
        await as('tg:1', () => stocks.getHistory('ZZQX', '1y'));
        await as('tg:1', () => stocks.getFundamentals('ZZQX'));
        await as('tg:1', () => stocks.getForeignFlow('ZZQX'));
      }
      expect(t.provider.calls.history).toBe(0);
      expect(t.provider.calls.fundamentals).toBe(0);
      // the probe is asked twice (the second miss confirms the ticker is missing), then nothing at all
      expect(t.provider.calls.quote).toBe(2);
    });

    it('an unlisted but real ticker costs one probe, then history and fundamentals follow', async () => {
      await as('tg:1', () => analysisCalls('TSTA'));
      expect(t.provider.calls.quote).toBe(1); // the probe and the analysis quote are the same call
      expect(t.provider.calls.history).toBe(1);
      expect(t.provider.calls.fundamentals).toBe(1);
      expect(t.app.get(TickerRegistry).status('TSTA')).toBe('verified');
    });

    it('a listed ticker needs no probe: its calls start at once', async () => {
      await as('tg:1', () => stocks.getHistory('BBCA', '1y'));
      expect(t.provider.calls.quote).toBe(0); // the fixture provider does not know BBCA, but no probe was made
      expect(t.provider.calls.history).toBe(1);
    });

    it('a confirmed-missing ticker is answered without any provider call', async () => {
      await as('tg:1', () => stocks.getQuote('ZZQX'));
      await as('tg:1', () => stocks.getQuote('ZZQX')); // second miss: now remembered
      const before = providerCalls();
      for (let i = 0; i < 20; i++) await as('tg:1', () => stocks.getQuote('ZZQX'));
      expect(providerCalls()).toBe(before);
    });
  });

  describe('global budget, degraded mode and the breaker', () => {
    it('when the hourly budget is spent, stored data is served (marked stale) instead of calling the provider', async () => {
      await as('tg:1', () => stocks.getQuote('TSTA'));
      await flushBackground(t); // the quote is now stored in PostgreSQL
      gov.reconfigure({ globalPerHour: 1, userPerMinute: 100 });
      await as('tg:1', () => stocks.getQuote('TSTB')); // takes the only unit
      resetCaches(t);
      const before = providerCalls();
      const r = await as('tg:2', () => stocks.getQuote('TSTA'));
      expect(r.available && r.stale).toBe(true);
      expect(providerCalls()).toBe(before);
      expect(
        metrics.counter('provider_throttled_total', { reason: 'global_budget' }),
      ).toBeGreaterThan(0);
    });

    it('with no stored data the user gets an honest short message, not a crash or a guess', async () => {
      gov.reconfigure({ globalPerHour: 1, userPerMinute: 100 });
      await as('tg:1', () => stocks.getQuote('TSTA'));
      resetCaches(t);
      await t.prisma.stockQuoteSnapshot.deleteMany({});
      const r = await as('tg:2', () => stocks.getQuote('TSTB'));
      expect(r).toMatchObject({ available: false, code: 'BUSY' });
    });

    it('a provider that keeps failing opens the breaker; calls then stop until the cooldown', async () => {
      gov.reconfigure({ breakerFailures: 2, breakerCooldownMs: 60_000, userPerMinute: 1000 });
      t.provider.failWith = 'ERROR';
      await as('tg:1', () => stocks.getQuote('TSTA'));
      const callsWhenOpen = t.provider.calls.quote;
      for (let i = 0; i < 10; i++) {
        resetCaches(t);
        await as('tg:1', () => stocks.getQuote('TSTA'));
      }
      expect(gov.breakerState).toBe('OPEN');
      expect(t.provider.calls.quote).toBe(callsWhenOpen);
    });

    it('a provider call that never answers is cut off, frees its slot and the next user is served', async () => {
      gov.reconfigure({
        concurrency: 1,
        taskTimeoutMs: 80,
        userPerMinute: 1000,
        breakerFailures: 50,
      });
      const original = t.provider.getQuote.bind(t.provider);
      t.provider.getQuote = (s: string) =>
        s === 'TSTA' ? new Promise(() => undefined) : original(s);
      try {
        const hung = await as('tg:1', () => stocks.getQuote('TSTA'));
        expect(hung.available).toBe(false);
        const next = await as('tg:2', () => stocks.getQuote('TSTB'));
        expect(next.available).toBe(true);
        expect(gov.schedulerStats.active).toBe(0);
      } finally {
        t.provider.getQuote = original;
      }
    });
  });

  describe('fair scheduling at the service level', () => {
    it('a user flooding with distinct tickers cannot make another user wait for the backlog', async () => {
      gov.reconfigure({ concurrency: 1, minIntervalMs: 0, queuePerUser: 6, userPerMinute: 1000 });
      const started: string[] = [];
      const original = t.provider.getQuote.bind(t.provider);
      t.provider.getQuote = async (s: string) => {
        started.push(s);
        await sleep(40);
        return original(s);
      };
      try {
        const flood = ['BBCA', 'BBRI', 'BMRI', 'TLKM', 'ASII', 'UNVR'].map((s) =>
          as('tg:flooder', () => stocks.getQuote(s)),
        );
        await sleep(10);
        const victim = as('tg:victim', () => stocks.getQuote('TSTA'));
        await victim;
        expect(started.indexOf('TSTA')).toBeLessThanOrEqual(2);
        await Promise.all(flood);
      } finally {
        t.provider.getQuote = original;
      }
    });

    it('the queue stays bounded: surplus calls of one user are refused at once', async () => {
      gov.reconfigure({ concurrency: 1, minIntervalMs: 0, queuePerUser: 2, userPerMinute: 1000 });
      const original = t.provider.getQuote.bind(t.provider);
      t.provider.getQuote = async (s: string) => {
        await sleep(50);
        return original(s);
      };
      try {
        const symbols = ['BBCA', 'BBRI', 'BMRI', 'TLKM', 'ASII', 'UNVR', 'ANTM', 'GOTO'];
        const results = await Promise.all(
          symbols.map((s) => as('tg:flooder', () => stocks.getQuote(s))),
        );
        const refused = results.filter((r) => !r.available && r.code === 'BUSY');
        expect(refused.length).toBeGreaterThanOrEqual(4);
        expect(t.provider.calls.quote).toBeLessThanOrEqual(4);
        expect(
          metrics.counter('provider_throttled_total', { reason: 'queue_user' }),
        ).toBeGreaterThan(0);
      } finally {
        t.provider.getQuote = original;
      }
    });

    it('background alert evaluation (system) is not limited by the per-user quota', async () => {
      gov.reconfigure({ userPerMinute: 1 });
      for (let i = 0; i < 5; i++) {
        resetCaches(t);
        expect((await as('system:alerts', () => stocks.getQuote('TSTA'))).available).toBe(true);
      }
    });
  });

  describe('through the chat, as a user sees it', () => {
    it('a user who asks for too much new data gets a short Indonesian message with a wait time', async () => {
      gov.reconfigure({ userPerMinute: 1 });
      const chat = t.app.get(ChatService);
      const say = (text: string) =>
        chat.handle({
          telegramId: 4001,
          chatId: 4001,
          chatType: 'private',
          username: 'u4001',
          text,
        });
      const first = await say('harga TSTA');
      expect(plain(first.messages.join('\n'))).toContain('FIXTURE A Tbk');
      resetCaches(t);
      const second = plain((await say('harga TSTB')).messages.join('\n'));
      expect(second).toMatch(/terlalu banyak data baru/i);
      expect(second).toMatch(/detik/);
    });
  });

  describe('isolation and housekeeping', () => {
    it('the quota is charged to the sender of the chat message: one user using theirs up does not affect another', async () => {
      gov.reconfigure({ userPerMinute: 1 });
      const chat = t.app.get(ChatService);
      const say = (id: number, text: string) =>
        chat.handle({ telegramId: id, chatId: id, chatType: 'private', username: 'u' + id, text });
      expect(plain((await say(4101, 'harga TSTA')).messages.join('\n'))).toContain('FIXTURE A Tbk');
      resetCaches(t);
      expect(plain((await say(4101, 'harga TSTB')).messages.join('\n'))).toMatch(
        /terlalu banyak data baru/i,
      );
      resetCaches(t);
      expect(plain((await say(4102, 'harga TSTC')).messages.join('\n'))).toContain('FIXTURE C Tbk');
    });

    it('refused calls leave no database rows: a flood of refusals cannot become a flood of log rows', async () => {
      gov.reconfigure({ userPerMinute: 1 });
      await t.prisma.dataFetchLog.deleteMany({});
      for (let i = 0; i < 30; i++) {
        resetCaches(t);
        await as('tg:1', () => stocks.getQuote('TSTA'));
      }
      await flushBackground(t);
      expect(await t.prisma.dataFetchLog.count()).toBe(1); // only the one call that reached the provider
    });
  });

  describe('observability', () => {
    it('GET /metrics exposes the throttling counters and no caller identity', async () => {
      gov.reconfigure({ userPerMinute: 1 });
      await as('tg:777000111', () => stocks.getQuote('TSTA'));
      resetCaches(t);
      await as('tg:777000111', () => stocks.getQuote('TSTB'));
      const res = await request(t.app.getHttpServer()).get('/metrics').expect(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toMatch(/provider_throttled_total\{reason="user_quota"\} 1/);
      expect(res.text).toMatch(/provider_requests_total\{outcome="ok",provider="[^"]+"\} 1/);
      expect(res.text).not.toContain('777000111');
    });

    it('the metrics endpoint is not reachable from a foreign Host', async () => {
      await request(t.app.getHttpServer()).get('/metrics').set('Host', 'example.com').expect(403);
    });
  });
});
