import { StockService } from '../../src/stock/stock.service';
import { createTestApp, TestApp, resetCaches } from '../setup/test-app';

describe('StockService (real PostgreSQL, fake provider)', () => {
  let t: TestApp;
  let stocks: StockService;

  beforeAll(async () => {
    t = await createTestApp();
    stocks = t.app.get(StockService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    t.provider.failWith = null;
    t.provider.calls = { quote: 0, quotes: 0, history: 0, fundamentals: 0 };
    resetCaches(t); // let the 1s test cache expire between tests
  });

  it('caches quotes: repeated requests do not hit the provider again', async () => {
    const a = await stocks.getQuote('TSTA');
    const b = await stocks.getQuote('TSTA');
    expect(a.available && b.available).toBe(true);
    expect(t.provider.calls.quote).toBe(1);
  });

  it('de-duplicates concurrent identical requests', async () => {
    await Promise.all([stocks.getQuote('TSTB'), stocks.getQuote('TSTB'), stocks.getQuote('TSTB')]);
    expect(t.provider.calls.quote).toBe(1);
  });

  it('persists quotes and daily candles to PostgreSQL', async () => {
    await stocks.getQuote('TSTC');
    await stocks.getHistory('TSTC');
    await t.moduleRef.get(StockService)['background'].flush();
    const snap = await t.prisma.stockQuoteSnapshot.findFirst({
      where: { stock: { symbol: 'TSTC' } },
    });
    expect(snap?.provider).toBe('test-fixture');
    const candles = await t.prisma.stockDailyPrice.count({ where: { stock: { symbol: 'TSTC' } } });
    expect(candles).toBeGreaterThan(200);
  });

  it('concurrent first-time writes for a NEW ticker create one row and lose nothing', async () => {
    for (const symbol of ['RACA', 'RACB', 'RACC', 'RACD', 'RACE']) {
      const ids = await Promise.all(Array.from({ length: 20 }, () => stocks.ensureStock(symbol)));
      expect(new Set(ids).size).toBe(1);
      expect(await t.prisma.stock.count({ where: { symbol } })).toBe(1);
    }
  });

  it('the first quote and the first history of a new ticker are both persisted, every time', async () => {
    for (let i = 0; i < 8; i++) {
      await t.prisma.stockDailyPrice.deleteMany({ where: { stock: { symbol: 'TSTC' } } });
      await t.prisma.stockQuoteSnapshot.deleteMany({ where: { stock: { symbol: 'TSTC' } } });
      await t.prisma.stock.deleteMany({ where: { symbol: 'TSTC' } });
      (stocks as unknown as { stockIds: Map<string, string> }).stockIds.clear();
      resetCaches(t);
      await stocks.getQuote('TSTC');
      await stocks.getHistory('TSTC');
      await t.moduleRef.get(StockService)['background'].flush();
      expect(
        await t.prisma.stockQuoteSnapshot.count({ where: { stock: { symbol: 'TSTC' } } }),
      ).toBe(1);
      expect(
        await t.prisma.stockDailyPrice.count({ where: { stock: { symbol: 'TSTC' } } }),
      ).toBeGreaterThan(200);
    }
  });

  it('returns NOT_FOUND for unknown tickers without falling back to stored data', async () => {
    const r = await stocks.getQuote('ZZZZ');
    expect(r).toMatchObject({ available: false, code: 'NOT_FOUND' });
  });

  it('retries transient provider errors with backoff, then reports unavailable', async () => {
    t.provider.failWith = 'ERROR';
    const r = await stocks.getQuote('NEWX'); // never stored before
    expect(r).toMatchObject({ available: false, code: 'ERROR' });
    expect(t.provider.calls.quote).toBe(3); // 1 try + 2 retries
  });

  it('serves last-known data flagged as stale when the provider fails', async () => {
    const fresh = await stocks.getQuote('TSTA');
    expect(fresh.available && !fresh.stale).toBe(true);
    await t.moduleRef.get(StockService)['background'].flush();
    resetCaches(t); // memory cache expired
    t.provider.failWith = 'RATE_LIMITED';
    const stale = await stocks.getQuote('TSTA');
    expect(stale.available).toBe(true);
    if (stale.available) {
      expect(stale.stale).toBe(true);
      expect(stale.source).toMatch(/tersimpan/);
      expect(stale.data.symbol).toBe('TSTA');
    }
  });

  it('serves stored history when the provider fails', async () => {
    await stocks.getHistory('TSTA');
    await t.moduleRef.get(StockService)['background'].flush();
    resetCaches(t);
    t.provider.failWith = 'ERROR';
    const h = await stocks.getHistory('TSTA');
    expect(h.available && h.stale).toBe(true);
    if (h.available) expect(h.data.length).toBeGreaterThan(200);
  });

  it('validateSymbol distinguishes invalid from provider-down', async () => {
    expect(await stocks.validateSymbol('TSTA')).toBe('valid');
    expect(await stocks.validateSymbol('ZZZZ')).toBe('invalid');
    resetCaches(t);
    t.provider.failWith = 'ERROR';
    expect(await stocks.validateSymbol('NEWX')).toBe('unknown');
  });

  it('records provider calls in DataFetchLog', async () => {
    await stocks.getQuote('TSTB');
    await t.moduleRef.get(StockService)['background'].flush();
    expect(await t.prisma.dataFetchLog.count({ where: { operation: 'quote' } })).toBeGreaterThan(0);
  });

  it('exposes unsupported optional data as structured unavailable results', async () => {
    expect(await stocks.getForeignFlow('TSTA')).toMatchObject({
      available: false,
      code: 'UNSUPPORTED',
    });
    expect(await stocks.getBrokerSummary('TSTA')).toMatchObject({
      available: false,
      code: 'UNSUPPORTED',
    });
  });
});
