import { ChatService } from '../../src/chat/chat.service';
import { AIService } from '../../src/ai/ai.service';
import { Metrics } from '../../src/common/metrics.service';
import { MarketDataGovernor } from '../../src/stock/governance/market-data-governor';
import { createTestApp, flushBackground, resetCaches, TestApp } from '../setup/test-app';

/**
 * Load test (not part of the gate; `npm run test:load`). Many distinct public users send a
 * realistic mix of messages at once through the real ChatService on real PostgreSQL, with the fixture
 * market-data provider and the fake model (so the numbers measure Indonesian Stock Bot, not Yahoo or Ollama).
 *
 * What is asserted is what must hold under load, not raw speed: no internal errors leak to users, the
 * fairness controls engage instead of the process falling over, latency stays bounded, and the process is
 * still responsive afterwards. Set LOAD_USERS / LOAD_MESSAGES to scale.
 */
const USERS = Number(process.env.LOAD_USERS ?? 150);
const MESSAGES = Number(process.env.LOAD_MESSAGES ?? 6);
const MIX = [
  'TSTA',
  'teknikal TSTB',
  'analisis TSTA',
  'bandingkan TSTA TSTB',
  'ingatkan saya kalau TSTA di atas 5000',
  'portofolio saya',
  'apa itu RSI?',
  'satu lot berapa lembar?',
  'kenapa TSTA naik?',
  'jam berapa market buka?',
];
const INTERNAL_ERROR = /terjadi kendala saat memproses|Layanan penyimpanan sedang bermasalah/;

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

describe('load: many public users at once', () => {
  let t: TestApp;
  let chat: ChatService;
  beforeAll(async () => {
    t = await createTestApp();
    chat = t.app.get(ChatService);
    // production-like limits, set on the services (env overrides do not reach validated config keys)
    t.app.get(MarketDataGovernor).reconfigure({ userPerMinute: 30 });
    const ai = t.app.get(AIService) as unknown as {
      opts: { maxConcurrent: number; maxQueue: number };
    };
    ai.opts.maxConcurrent = 2;
    ai.opts.maxQueue = 4;
    t.ai.delayMs = 50;
    await t.prisma.$executeRawUnsafe('TRUNCATE "User","Alert" RESTART IDENTITY CASCADE');
    resetCaches(t, { governance: true });
  });
  afterAll(async () => {
    await flushBackground(t);
    await t.close();
  });

  it(`${USERS} users x ${MESSAGES} messages: no internal errors, bounded latency, controls engage, still responsive`, async () => {
    const latencies: number[] = [];
    let internalErrors = 0;
    let rateLimited = 0;
    let aiBusy = 0;
    let throttled = 0;
    const started = Date.now();

    await Promise.all(
      Array.from({ length: USERS }, async (_, u) => {
        const telegramId = 900_000 + u;
        for (let m = 0; m < MESSAGES; m++) {
          const text = MIX[(u + m) % MIX.length];
          const t0 = Date.now();
          const r = await chat.handle({
            telegramId,
            chatId: telegramId,
            chatType: 'private',
            text,
          });
          latencies.push(Date.now() - t0);
          const joined = r.messages.join('\n');
          if (INTERNAL_ERROR.test(joined)) internalErrors++;
          if (/Terlalu banyak pesan/.test(joined)) rateLimited++;
          if (/AI sedang sibuk/.test(joined)) aiBusy++;
          if (/terlalu banyak permintaan data|kuota/i.test(joined)) throttled++;
        }
      }),
    );

    const total = Date.now() - started;
    const sorted = [...latencies].sort((a, b) => a - b);
    const metrics = t.app.get(Metrics);
    const summary = {
      users: USERS,
      messages: latencies.length,
      totalMs: total,
      throughputPerSec: Math.round((latencies.length / total) * 1000 * 10) / 10,
      p50: pct(sorted, 0.5),
      p95: pct(sorted, 0.95),
      p99: pct(sorted, 0.99),
      max: sorted[sorted.length - 1],
      internalErrors,
      rateLimited,
      aiBusy,
      throttled,
      providerRequests: metrics.total('provider_requests_total'),
      providerThrottled: metrics.total('provider_throttled_total'),
      aiGenerateCalls: t.ai.generated.length,
    };
    console.log(`LOAD ${JSON.stringify(summary)}`);

    expect(internalErrors).toBe(0);
    expect(latencies).toHaveLength(USERS * MESSAGES);
    // the model is a shared, bounded resource: with this many analyses some users must be told it is busy
    expect(aiBusy).toBeGreaterThan(0);
    expect(t.ai.generated.length).toBeLessThan(USERS * MESSAGES);
    // bounded tail: nothing waits forever (the AI queue and request deadline cap it)
    expect(summary.p99).toBeLessThan(30_000);

    const t0 = Date.now();
    const after = await chat.handle({
      telegramId: 1,
      chatId: 1,
      chatType: 'private',
      text: 'TSTA',
    });
    expect(after.messages.join('\n')).toMatch(/TSTA/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
