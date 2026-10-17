import { classifyYahooError, YahooProvider } from './yahoo.provider';
import {
  normalizeYahooCandles,
  normalizeYahooFundamentals,
  normalizeYahooProfile,
  normalizeYahooQuote,
} from './yahoo-normalizer';

/**
 * SYNTHETIC provider payloads shaped like Yahoo responses. Values are invented test fixtures
 * and must never be presented as real market data.
 */
const RAW_QUOTE = {
  symbol: 'TEST.JK',
  longName: 'PT Test Fixture Tbk',
  shortName: 'Test Fixture',
  regularMarketPrice: 1000,
  regularMarketChange: 10,
  regularMarketChangePercent: 1.0101,
  regularMarketOpen: 990,
  regularMarketDayHigh: 1010,
  regularMarketDayLow: 985,
  regularMarketPreviousClose: 990,
  regularMarketVolume: 5_000_000,
  averageDailyVolume3Month: 4_000_000,
  regularMarketTime: new Date('2025-06-02T09:00:00.000Z'),
  currency: 'IDR',
  marketState: 'CLOSED',
  exchangeDataDelayedBy: 10,
  fiftyTwoWeekHigh: 1200,
  fiftyTwoWeekLow: 800,
};

describe('normalizeYahooQuote', () => {
  it('maps provider fields to the internal NormalizedQuote', () => {
    expect(normalizeYahooQuote(RAW_QUOTE)).toEqual({
      symbol: 'TEST',
      name: 'PT Test Fixture Tbk',
      price: 1000,
      change: 10,
      changePercent: 1.0101,
      open: 990,
      high: 1010,
      low: 985,
      previousClose: 990,
      volume: 5_000_000,
      averageVolume: 4_000_000,
      timestamp: '2025-06-02T09:00:00.000Z',
      currency: 'IDR',
      marketState: 'CLOSED',
      delayMinutes: 10,
      fiftyTwoWeekHigh: 1200,
      fiftyTwoWeekLow: 800,
    });
  });

  it('derives change/percent from previous close when missing', () => {
    const q = normalizeYahooQuote({
      ...RAW_QUOTE,
      regularMarketChange: undefined,
      regularMarketChangePercent: undefined,
    });
    expect(q?.change).toBe(10);
    expect(q?.changePercent).toBeCloseTo((10 / 990) * 100, 6);
  });

  it('accepts epoch-second timestamps', () => {
    const q = normalizeYahooQuote({ ...RAW_QUOTE, regularMarketTime: 1_748_854_800 });
    expect(q?.timestamp).toBe(new Date(1_748_854_800 * 1000).toISOString());
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['no price', { ...RAW_QUOTE, regularMarketPrice: undefined }],
    ['zero price', { ...RAW_QUOTE, regularMarketPrice: 0 }],
    ['NaN price', { ...RAW_QUOTE, regularMarketPrice: NaN }],
    ['no timestamp', { ...RAW_QUOTE, regularMarketTime: undefined }],
  ])('returns null for unusable payload: %s', (_n, raw) => {
    expect(normalizeYahooQuote(raw)).toBeNull();
  });

  it('never invents missing optional fields', () => {
    const q = normalizeYahooQuote({
      symbol: 'TEST.JK',
      regularMarketPrice: 500,
      regularMarketTime: new Date(),
    });
    expect(q).toMatchObject({
      open: null,
      high: null,
      low: null,
      volume: null,
      averageVolume: null,
      previousClose: null,
      name: null,
    });
  });
});

describe('normalizeYahooCandles', () => {
  const day = (iso: string, o: number, h: number, l: number, c: number, v = 100) => ({
    date: new Date(iso),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
  });

  it('sorts ascending and uses the exchange-local (WIB) calendar date', () => {
    const out = normalizeYahooCandles([
      day('2025-06-03T02:00:00.000Z', 10, 12, 9, 11),
      day('2025-06-02T02:00:00.000Z', 9, 11, 8, 10),
    ]);
    expect(out.map((c) => c.date)).toEqual(['2025-06-02', '2025-06-03']);
  });

  it('drops invalid rows: nulls, non-positive, impossible high/low', () => {
    const out = normalizeYahooCandles([
      day('2025-06-02T02:00:00.000Z', 9, 11, 8, 10),
      {
        date: new Date('2025-06-03T02:00:00.000Z'),
        open: null,
        high: 11,
        low: 8,
        close: 10,
        volume: 1,
      },
      day('2025-06-04T02:00:00.000Z', 0, 11, 8, 10),
      day('2025-06-05T02:00:00.000Z', 9, 8, 11, 10), // high < low
      day('2025-06-06T02:00:00.000Z', 9, 9.5, 8, 10), // close above high
    ]);
    expect(out).toHaveLength(1);
  });

  it('treats a missing volume as 0 and de-duplicates dates (last wins)', () => {
    const out = normalizeYahooCandles([
      { ...day('2025-06-02T02:00:00.000Z', 9, 11, 8, 10), volume: null },
      day('2025-06-02T05:00:00.000Z', 9, 12, 8, 11, 500),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ close: 11, volume: 500 });
  });

  it('handles empty/undefined input', () => {
    expect(normalizeYahooCandles([])).toEqual([]);
    expect(normalizeYahooCandles(undefined as unknown as unknown[])).toEqual([]);
  });
});

describe('fundamentals & profile normalization', () => {
  it('converts ratios to percentages and only fills what exists', () => {
    const f = normalizeYahooFundamentals(
      {
        financialData: { returnOnEquity: 0.2, totalRevenue: 1e12 },
        defaultKeyStatistics: { netIncomeToCommon: 3e11 },
      },
      {
        marketCap: 5e12,
        trailingPE: 12.5,
        priceToBook: 2,
        epsTrailingTwelveMonths: 80,
        dividendYield: 4.5,
      },
    );
    expect(f).toMatchObject({
      marketCap: 5e12,
      per: 12.5,
      pbv: 2,
      roe: 20,
      eps: 80,
      dividendYield: 4.5,
      revenue: 1e12,
      netIncome: 3e11,
    });
    const empty = normalizeYahooFundamentals({}, {});
    expect(Object.values(empty).every((v) => v === null)).toBe(true);
  });

  it('maps the extended figures: forward estimates, derivation inputs, margins, debt and growth', () => {
    const f = normalizeYahooFundamentals(
      {
        financialData: {
          profitMargins: 0.25,
          totalDebt: 4e11,
          debtToEquity: 85.3,
          revenueGrowth: 0.12,
          earningsGrowth: -0.05,
        },
        defaultKeyStatistics: { forwardEps: 90, bookValue: 1500 },
        summaryDetail: { forwardPE: 11, dividendRate: 45 },
      },
      {},
    );
    expect(f).toMatchObject({
      forwardPer: 11,
      forwardEps: 90,
      bookValuePerShare: 1500,
      dividendRate: 45,
      netMargin: 25,
      totalDebt: 4e11,
      debtToEquity: 0.853,
      revenueGrowth: 12,
      earningsGrowth: -5,
    });
    expect(normalizeYahooFundamentals({}, {}).debtToEquity).toBeNull();
  });

  it('maps the company profile', () => {
    const p = normalizeYahooProfile(
      'TEST',
      {
        assetProfile: {
          sector: 'Financial Services',
          industry: 'Banks',
          website: 'https://example.invalid',
          longBusinessSummary: 'fixture',
        },
      },
      { longName: 'PT Test' },
    );
    expect(p).toEqual({
      symbol: 'TEST',
      name: 'PT Test',
      sector: 'Financial Services',
      industry: 'Banks',
      website: 'https://example.invalid',
      summary: 'fixture',
    });
  });
});

describe('YahooProvider', () => {
  it('reports unsupported data instead of fabricating it', async () => {
    const p = new YahooProvider();
    expect(await p.getForeignFlow()).toMatchObject({ available: false, code: 'UNSUPPORTED' });
    expect(await p.getBrokerSummary()).toMatchObject({ available: false, code: 'UNSUPPORTED' });
    const ff = await p.getForeignFlow();
    if (!ff.available) expect(ff.reason).toMatch(/belum tersedia dari provider/);
  });

  it('classifies rate-limit vs generic errors', () => {
    expect(classifyYahooError(new Error('Too Many Requests'))).toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(classifyYahooError(new Error('HTTP 429'))).toMatchObject({ code: 'RATE_LIMITED' });
    expect(classifyYahooError(new Error('socket hang up'))).toMatchObject({ code: 'ERROR' });
  });

  it('maps provider failures to a structured unavailable result (never throws)', async () => {
    const p = new YahooProvider();
    (p as unknown as { yf: unknown }).yf = {
      quote: () => Promise.reject(new Error('socket hang up')),
      chart: () => Promise.reject(new Error('Too Many Requests')),
    };
    expect(await p.getQuote('BBCA')).toMatchObject({ available: false, code: 'ERROR' });
    expect(await p.getHistoricalPrices('BBCA')).toMatchObject({
      available: false,
      code: 'RATE_LIMITED',
    });
  });

  it('reports NOT_FOUND when the provider returns nothing for a ticker', async () => {
    const p = new YahooProvider();
    (p as unknown as { yf: unknown }).yf = {
      quote: () => Promise.resolve(undefined),
      chart: () => Promise.resolve({ quotes: [] }),
    };
    expect(await p.getQuote('ZZZZ')).toMatchObject({ available: false, code: 'NOT_FOUND' });
    expect(await p.getHistoricalPrices('ZZZZ')).toMatchObject({
      available: false,
      code: 'NOT_FOUND',
    });
  });
});

describe('provider data hygiene', () => {
  const row = (volume: unknown) => ({
    date: '2026-10-01T02:00:00.000Z',
    open: 100,
    high: 110,
    low: 95,
    close: 105,
    volume,
  });

  it('a negative, NaN or missing candle volume becomes 0, a valid one is kept', () => {
    const out = normalizeYahooCandles([
      { ...row(-5), date: '2026-09-28T02:00:00.000Z' },
      { ...row(Number.NaN), date: '2026-09-29T02:00:00.000Z' },
      { ...row(undefined), date: '2026-09-30T02:00:00.000Z' },
      row(1234),
    ]);
    expect(out.map((c) => c.volume)).toEqual([0, 0, 0, 1234]);
  });

  it('company names are cleaned: markup, control and invisible characters, length (prompt/markup injection)', () => {
    const q = normalizeYahooQuote({
      ...RAW_QUOTE,
      longName:
        'Bank <b>Test</b> {"summary":"beli"} ' +
        String.fromCharCode(0x200b) +
        'Tbk' +
        'x'.repeat(300),
    });
    expect(q?.name).toBeDefined();
    expect(q?.name).not.toMatch(/[<>{}"]/);
    expect(q?.name).not.toContain(String.fromCharCode(0x200b));
    expect((q?.name ?? '').length).toBeLessThanOrEqual(80);
    expect(q?.name).toMatch(/^Bank b Test \/b summary/);
  });
});
