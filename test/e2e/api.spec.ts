import request from 'supertest';
import { AIService } from '../../src/ai/ai.service';
import { sleep, createTestApp, TestApp, resetCaches } from '../setup/test-app';

describe('REST API (e2e, fake provider + fake AI, real PostgreSQL)', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    t.provider.failWith = null;
    t.ai.available = true;
    await t.app.get(AIService).checkHealth(true); // reset the 30s AI health cache
  });

  describe('GET /health', () => {
    it('reports every dependency and stays 200 + "degraded" when optional ones fail', async () => {
      const ok = await http().get('/health').expect(200);
      expect(ok.body).toMatchObject({
        status: 'ok', // Telegram being intentionally disabled (no token) is not a failure
        database: 'connected',
        telegram: 'disabled',
        stockProvider: 'available',
        ai: 'available',
      });
      expect(ok.body.details.telegram).toMatch(/TELEGRAM_BOT_TOKEN/);
      expect(typeof ok.body.timestamp).toBe('string');

      resetCaches(t, { health: true }); // the 15 s /health probe cache
      t.provider.failWith = 'ERROR';
      t.ai.available = false;
      const degraded = await http().get('/health').expect(200);
      expect(degraded.body).toMatchObject({
        status: 'degraded',
        database: 'connected',
        stockProvider: 'unavailable',
        ai: 'unavailable',
      });
    }, 40000);

    it('never leaks secrets or connection strings', async () => {
      const res = await http().get('/health').expect(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/postgres:\/\//);
      expect(body).not.toMatch(/password|api[_-]?key|token":/i);
    });
  });

  describe('GET /stocks/:symbol', () => {
    it('returns a normalized quote', async () => {
      const res = await http().get('/stocks/tsta').expect(200); // lower-case is normalised
      expect(res.body).toMatchObject({ symbol: 'TSTA', stale: false, source: 'test-fixture' });
      expect(res.body.quote).toMatchObject({ symbol: 'TSTA', currency: 'IDR' });
      expect(typeof res.body.quote.timestamp).toBe('string');
    });

    it('404 for an unknown ticker, 400 for a malformed one', async () => {
      const nf = await http().get('/stocks/ZZZZ').expect(404);
      expect(nf.body).toMatchObject({ statusCode: 404, code: 'INVALID_TICKER' });
      await http().get('/stocks/BBCAX').expect(400);
      await http().get('/stocks/12').expect(400);
    });

    it('503 with a safe message when the provider is down and nothing is stored', async () => {
      t.provider.failWith = 'ERROR';
      resetCaches(t);
      const res = await http().get('/stocks/NEWX').expect(503);
      expect(res.body.code).toBe('PROVIDER_DOWN');
      expect(JSON.stringify(res.body)).not.toMatch(/prisma|stack|at \w+\.\w+ \(/i);
    });
  });

  describe('GET /stocks/:symbol/technical', () => {
    it('returns indicators, classification and levels', async () => {
      const res = await http().get('/stocks/TSTA/technical').expect(200);
      expect(res.body.indicators).toEqual(
        expect.objectContaining({
          rsi14: expect.any(Number),
          sma20: expect.any(Number),
          sma200: expect.any(Number),
        }),
      );
      expect(res.body.classification.trend).toMatch(/BULLISH|NEUTRAL|BEARISH/);
      expect(Array.isArray(res.body.support)).toBe(true);
      expect(Array.isArray(res.body.resistance)).toBe(true);
    });

    it('422 when the listing is too new for indicators', async () => {
      const res = await http().get('/stocks/NEWX/technical').expect(422);
      expect(res.body.code).toBe('INSUFFICIENT_HISTORY');
    });
  });

  describe('GET /stocks/:symbol/history', () => {
    it('returns candles and validates the range query', async () => {
      const res = await http().get('/stocks/TSTA/history?range=3mo').expect(200);
      expect(res.body.candles.length).toBeGreaterThan(30);
      expect(res.body.candles[0]).toEqual(
        expect.objectContaining({ date: expect.any(String), close: expect.any(Number) }),
      );
      await http().get('/stocks/TSTA/history?range=forever').expect(400);
      await http().get('/stocks/TSTA/history?range=3mo&evil=1').expect(400); // unknown params rejected
    });
  });

  describe('POST /analysis/:symbol', () => {
    it('returns deterministic analysis plus validated AI output', async () => {
      const res = await http().post('/analysis/TSTA').expect(201);
      expect(res.body.technical.classification).toBeDefined();
      expect(res.body.ai).toMatchObject({ available: true, provider: 'fake-ai' });
      // application-written catalogue sentence chosen by the (fake) model, never model prose
      expect(res.body.ai.output.summary).toMatch(/^Harga terakhir Rp1\.777, naik 2,50%/);
      expect(res.body.ai.output.trend).toBe('Bullish');
      expect(res.body.disclaimer).toMatch(/bukan rekomendasi investasi/);
    });

    it('still returns the technical part when AI is down', async () => {
      t.ai.available = false;
      await sleep(100);
      const res = await http().post('/analysis/TSTA').expect(201);
      expect(res.body.technical.indicators.rsi14).toEqual(expect.any(Number));
      expect(res.body.ai.available).toBe(false);
    });
  });

  it('unknown routes are plain 404s', async () => {
    await http().get('/nope').expect(404);
  });

  it('rate limits abusive clients (per IP)', async () => {
    let limited = false;
    for (let i = 0; i < 70; i++) {
      const r = await http().get('/stocks/TSTA');
      if (r.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  }, 60000);
});
