import { ChatService } from '../../src/chat/chat.service';
import { AIService } from '../../src/ai/ai.service';
import { HealthController } from '../../src/health/health.controller';
import { RagService } from '../../src/rag/rag.service';
import { MarketDataGovernor } from '../../src/stock/governance/market-data-governor';
import { createTestApp, flushBackground, resetCaches, TestApp } from '../setup/test-app';

/**
 * Failure injection through the real application. Each dependency fails in turn (and then all
 * optional ones at once); the bot must answer honestly, never crash, never leak internals, and recover
 * without a restart. Redis, queue, Telegram-delivery and Yahoo-retry failures have their own suites
 * (redis.spec, queues.spec, alert-safety.spec, stock-service.spec); this one covers the rest.
 */
const plain = (html: string) => html.replace(/<[^>]+>/g, '');
const INTERNAL = /terjadi kendala saat memproses/;
const DB_DOWN = /Layanan penyimpanan sedang bermasalah/;

describe('Resilience (integration)', () => {
  let t: TestApp;
  let chat: ChatService;
  const say = async (telegramId: number, text: string) =>
    plain(
      (
        await chat.handle({ telegramId, chatId: telegramId, chatType: 'private', text })
      ).messages.join('\n'),
    );

  beforeAll(async () => {
    // env overrides cannot reach keys the ConfigModule validated at import time: limits are set on the services
    t = await createTestApp();
    chat = t.app.get(ChatService);
    await t.app.get(RagService).ingestCorpus(); // the corpus is part of what still works when everything else is down
    // the AI timeout is fixed by the test environment; shorten it directly (as security.spec does)
    (t.app.get(AIService) as unknown as { opts: { timeoutMs: number } }).opts.timeoutMs = 1000;
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await flushBackground(t);
    resetCaches(t, { health: true });
    t.provider.failWith = null;
    t.provider.delayMs = 0;
    t.provider.fundamentalsUnavailable = false;
    t.ai.available = true;
    t.ai.hang = false;
    t.ai.delayMs = 0;
    t.ai.generated.length = 0;
    t.news.reset();
    jest.restoreAllMocks();
  });

  it('PostgreSQL failure: a safe storage message, no internal details, and recovery without restart', async () => {
    const spy = jest
      .spyOn(t.prisma.user, 'upsert')
      .mockRejectedValue(
        new Error('PrismaClientInitializationError: connection refused 127.0.0.1:5436'),
      );
    const down = await say(18001, 'TSTA');
    expect(down).toMatch(DB_DOWN);
    expect(down).not.toMatch(/prisma|5436|127\.0\.0\.1/i);
    spy.mockRestore();
    expect(await say(18001, 'TSTA')).toMatch(/TSTA/);
  });

  it('a stuck model is cut off by its timeout; the answer is deterministic and the next request is unaffected', async () => {
    t.ai.hang = true;
    const started = Date.now();
    const reply = await say(18002, 'analisis TSTA');
    // AI timeout (1 s) + backstop (2 s) + the data an analysis gathers first; never the 60 s queue wait
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(reply).toMatch(/AI/); // the notice says the model did not answer
    expect(reply).toMatch(/Support:/); // deterministic analysis still delivered
    expect(reply).not.toMatch(INTERNAL);
    t.ai.hang = false;
    expect(await say(18003, 'TSTA')).toMatch(/TSTA/);
  });

  it('a slow market-data provider is cut off by its timeout (not the user), and later requests still work', async () => {
    const gov = t.app.get(MarketDataGovernor);
    gov.reconfigure({ taskTimeoutMs: 2_000 });
    t.provider.delayMs = 4_000; // longer than the provider timeout
    const started = Date.now();
    const reply = await say(18004, 'harga TSTC'); // TSTC is not cached yet: a provider call is needed
    // bounded by the provider timeout per attempt plus the retry backoff (3 attempts), never by the upstream delay
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(reply).not.toMatch(INTERNAL);
    expect(reply).toMatch(/tidak tersedia|belum tersedia|tersimpan|coba lagi/i);
    t.provider.delayMs = 0;
    gov.reconfigure({ taskTimeoutMs: 20_000 });
    resetCaches(t);
    expect(await say(18005, 'harga TSTC')).toMatch(/TSTC/);
  }, 20_000);

  it('degraded mode: with model, market data and news all down, the bot still serves what it can and says what it cannot', async () => {
    await say(18006, 'TSTA'); // warm the stored quote so last-known data exists
    await flushBackground(t);
    resetCaches(t);
    t.ai.available = false;
    t.provider.failWith = 'ERROR';
    t.news.failWith = 'ERROR';

    expect(await say(18006, 'apa itu RSI?')).toMatch(/RSI adalah indikator momentum/);
    expect(await say(18006, 'satu lot berapa lembar?')).toMatch(/100 lembar/);
    expect(await say(18006, 'portofolio saya')).not.toMatch(INTERNAL);
    const quote = await say(18006, 'TSTA');
    expect(quote).toMatch(/TSTA/);
    expect(quote).toMatch(/tersimpan|STALE|tidak terkini|terakhir/i); // last-known data, flagged
    const analysis = await say(18006, 'analisis TSTA');
    expect(analysis).not.toMatch(INTERNAL);
    expect(await say(18006, 'berita TSTA')).toMatch(/belum tersedia|arsip/);
    expect(await say(18006, 'fundamental TSTA')).not.toMatch(INTERNAL);

    const health = await t.app.get(HealthController).check({ status: () => undefined } as never);
    expect(health.status).toBe('degraded'); // not 'error': PostgreSQL is fine
    expect(health.database).toBe('connected');
  }, 120_000); // every provider call retries with backoff before falling back: slower, by design

  it('a background write failure never surfaces to the user and the next request works', async () => {
    const spy = jest
      .spyOn(t.prisma.conversationContext, 'upsert')
      .mockRejectedValue(new Error('disk full'));
    expect(await say(18007, 'harga TSTA')).toMatch(/TSTA/);
    spy.mockRestore();
    expect(await say(18007, 'berapa RSI?')).not.toMatch(INTERNAL);
  });

  it('graceful shutdown: closing with background work pending flushes it instead of dropping or throwing', async () => {
    const t2 = await createTestApp();
    try {
      await t2.app
        .get(ChatService)
        .handle({ telegramId: 18008, chatId: 18008, chatType: 'private', text: 'TSTB' });
    } finally {
      await expect(t2.close()).resolves.not.toThrow();
    }
    expect(await t.prisma.stockQuoteSnapshot.count({ where: { stock: { symbol: 'TSTB' } } })).toBe(
      1,
    );
  });
});
