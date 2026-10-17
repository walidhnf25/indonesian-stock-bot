import { AppConfig } from '../config/app-config.service';
import { NormalizedQuote } from '../stock/stock.types';
import {
  Freshness,
  FreshnessInput,
  assessPlausibility,
  classifyFreshness,
  referenceCloseFromCandles,
  worstFreshness,
} from './data-quality';
import { MarketService } from './market.service';

const wib = (isoLocal: string) => new Date(`${isoLocal}+07:00`);
const market = (holidays: string[] = []) => new MarketService({ holidays } as unknown as AppConfig);

/** Builds the freshness input the same way DataQualityService does, from a wall-clock "now". */
function input(
  over: Partial<Omit<FreshnessInput, 'quoteTimestamp' | 'now'>> & {
    now: Date;
    ts: string | null;
    holidays?: string[];
  },
): FreshnessInput {
  const { now, ts, holidays, ...rest } = over;
  const m = market(holidays);
  return {
    quoteTimestamp: ts,
    delayMinutes: 10,
    servedFromFallback: false,
    now,
    marketIsTrading: m.getStatus(now).isTrading,
    lastTradingDate: m.lastTradingDate(now),
    staleAfterMinutes: 30,
    ...rest,
  };
}

describe('MarketService.lastTradingDate', () => {
  it('is today once the session has started on a trading day', () => {
    expect(market().lastTradingDate(wib('2026-10-01T10:00:00'))).toBe('2026-10-01'); // Thursday open
    expect(market().lastTradingDate(wib('2026-10-01T20:00:00'))).toBe('2026-10-01'); // after close
  });
  it('is the previous trading day before the open, at weekends and on holidays', () => {
    expect(market().lastTradingDate(wib('2026-10-01T08:00:00'))).toBe('2026-09-30');
    expect(market().lastTradingDate(wib('2026-10-03T12:00:00'))).toBe('2026-10-02'); // Saturday -> Friday
    expect(market().lastTradingDate(wib('2026-10-05T07:00:00'))).toBe('2026-10-02'); // Monday pre-open
    expect(market(['2026-10-02']).lastTradingDate(wib('2026-10-03T12:00:00'))).toBe('2026-10-01'); // Friday holiday
    expect(market(['2026-10-01', '2026-10-02']).lastTradingDate(wib('2026-10-05T08:00:00'))).toBe(
      '2026-09-30',
    );
  });
  it('isTradingDay respects weekends and configured holidays', () => {
    const m = market(['2026-10-02']);
    expect(m.isTradingDay('2026-10-01')).toBe(true);
    expect(m.isTradingDay('2026-10-02')).toBe(false);
    expect(m.isTradingDay('2026-10-03')).toBe(false);
    expect(m.isTradingDay('2026-10-04')).toBe(false);
  });
});

describe('classifyFreshness', () => {
  const now = wib('2026-10-01T10:30:00'); // Thursday, market open
  const iso = (d: Date) => d.toISOString();
  const ago = (min: number) => iso(new Date(now.getTime() - min * 60_000));

  describe('while the market is open', () => {
    it('LIVE: provider declares no delay and the data is fresh', () => {
      const f = classifyFreshness(input({ now, ts: ago(2), delayMinutes: 0 }));
      expect(f.state).toBe('LIVE');
    });
    it('DELAYED: provider feed is delayed (Yahoo/IDX ~10 min) but not old', () => {
      const f = classifyFreshness(input({ now, ts: ago(12) }));
      expect(f.state).toBe('DELAYED');
      expect(f.reason).toMatch(/tertunda/);
    });
    it('DELAYED: no declared delay but 10 minutes old', () => {
      expect(classifyFreshness(input({ now, ts: ago(10), delayMinutes: 0 })).state).toBe('DELAYED');
    });
    it('STALE: older than the threshold plus the declared delay (30 + 10 minutes)', () => {
      expect(classifyFreshness(input({ now, ts: ago(39) })).state).toBe('DELAYED');
      const f = classifyFreshness(input({ now, ts: ago(45) }));
      expect(f.state).toBe('STALE');
      expect(f.reason).toMatch(/jarang diperdagangkan/);
    });
    it('the threshold is configurable', () => {
      expect(classifyFreshness(input({ now, ts: ago(45), staleAfterMinutes: 60 })).state).toBe(
        'DELAYED',
      );
      expect(
        classifyFreshness(input({ now, ts: ago(15), staleAfterMinutes: 1, delayMinutes: 0 })).state,
      ).toBe('STALE');
    });
  });

  describe('while the market is closed (old timestamps are normal)', () => {
    it("after the close: today's closing data is NOT stale, even hours old", () => {
      const evening = wib('2026-10-01T20:00:00');
      const f = classifyFreshness(
        input({ now: evening, ts: wib('2026-10-01T16:14:00').toISOString() }),
      );
      expect(f.state).toBe('DELAYED');
      expect(f.marketClosed).toBe(true);
      expect(f.reason).toMatch(/penutupan/);
    });
    it("weekend: Friday's close is current; Thursday's data is STALE", () => {
      const sat = wib('2026-10-03T12:00:00');
      expect(
        classifyFreshness(input({ now: sat, ts: wib('2026-10-02T16:10:00').toISOString() })).state,
      ).toBe('DELAYED');
      const stale = classifyFreshness(
        input({ now: sat, ts: wib('2026-10-01T16:10:00').toISOString() }),
      );
      expect(stale.state).toBe('STALE');
      expect(stale.reason).toMatch(/lebih lama dari sesi bursa terakhir/);
    });
    it('before the open on Monday: Friday data is fine, Thursday data is STALE', () => {
      const mon = wib('2026-10-05T07:30:00');
      expect(
        classifyFreshness(input({ now: mon, ts: wib('2026-10-02T16:10:00').toISOString() })).state,
      ).toBe('DELAYED');
      expect(
        classifyFreshness(input({ now: mon, ts: wib('2026-10-01T16:10:00').toISOString() })).state,
      ).toBe('STALE');
    });
    it('lunch break and pre-closing use the closed-market rule (date based)', () => {
      const lunch = wib('2026-10-01T12:30:00');
      expect(
        classifyFreshness(input({ now: lunch, ts: wib('2026-10-01T11:59:00').toISOString() }))
          .state,
      ).toBe('DELAYED');
    });
    it('a configured holiday moves the expected last session back', () => {
      const sat = wib('2026-10-03T12:00:00');
      const holidays = ['2026-10-02'];
      expect(
        classifyFreshness(
          input({ now: sat, holidays, ts: wib('2026-10-01T16:10:00').toISOString() }),
        ).state,
      ).toBe('DELAYED');
    });
    it('LIVE tag only when the provider declares no delay', () => {
      const sat = wib('2026-10-03T12:00:00');
      expect(
        classifyFreshness(
          input({ now: sat, delayMinutes: 0, ts: wib('2026-10-02T16:10:00').toISOString() }),
        ).state,
      ).toBe('LIVE');
    });
  });

  describe('STALE / UNKNOWN regardless of market state', () => {
    it('data served from our stored copy is always STALE', () => {
      const f = classifyFreshness(input({ now, ts: ago(1), servedFromFallback: true }));
      expect(f.state).toBe('STALE');
      expect(f.fromFallback).toBe(true);
    });
    it('missing / invalid / future timestamps are UNKNOWN', () => {
      expect(classifyFreshness(input({ now, ts: null })).state).toBe('UNKNOWN');
      expect(classifyFreshness(input({ now, ts: 'not-a-date' })).state).toBe('UNKNOWN');
      expect(
        classifyFreshness(input({ now, ts: iso(new Date(now.getTime() + 30 * 60_000)) })).state,
      ).toBe('UNKNOWN');
    });
    it('worstFreshness ranks STALE > UNKNOWN > DELAYED > LIVE', () => {
      const f = (state: Freshness['state']): Freshness => ({
        state,
        ageMinutes: 0,
        reason: '',
        marketClosed: false,
        fromFallback: false,
      });
      expect(worstFreshness([f('LIVE'), f('DELAYED')])?.state).toBe('DELAYED');
      expect(worstFreshness([f('DELAYED'), f('UNKNOWN'), f('LIVE')])?.state).toBe('UNKNOWN');
      expect(worstFreshness([f('UNKNOWN'), f('STALE')])?.state).toBe('STALE');
      expect(worstFreshness([])).toBeNull();
    });
  });
});

describe('assessPlausibility', () => {
  const quote = (over: Partial<NormalizedQuote> = {}): NormalizedQuote => ({
    symbol: 'TEST',
    name: 'TEST',
    price: 8000,
    change: 0,
    changePercent: 0,
    open: 8000,
    high: 8050,
    low: 7950,
    previousClose: 8000,
    volume: 1_000_000,
    averageVolume: 1_000_000,
    timestamp: '2026-10-01T09:00:00.000Z',
    currency: 'IDR',
    marketState: 'REGULAR',
    delayMinutes: 10,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    ...over,
  });
  const opts = { maxChangePercent: 50 };

  it('accepts an ordinary quote', () => {
    expect(assessPlausibility(quote(), opts)).toEqual({
      ok: true,
      quality: 'trusted',
      reasons: [],
    });
  });

  it("flags the review's case: price 1 against a previous close of 8000", () => {
    const r = assessPlausibility(quote({ price: 1, changePercent: -99.99 }), opts);
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(expect.arrayContaining(['ohlc_inconsistent', 'extreme_change']));
  });

  it('flags zero, negative and non-finite prices', () => {
    for (const price of [0, -5, NaN, Infinity]) {
      expect(assessPlausibility(quote({ price }), opts)).toEqual({
        ok: false,
        quality: 'invalid',
        reasons: ['price_invalid'],
      });
    }
  });

  it("flags a price outside the day's range and an impossible range (high < low)", () => {
    expect(assessPlausibility(quote({ price: 9000 }), opts).reasons).toContain('ohlc_inconsistent');
    expect(assessPlausibility(quote({ high: 7900, low: 8100 }), opts).reasons).toContain(
      'ohlc_inconsistent',
    );
  });

  it('a move beyond the threshold is SUSPECT even when every field of the quote agrees with itself', () => {
    // A -62,5 % day whose open/high/low/change% all match: consistent, but nothing independent backs
    // it (it could be a corrupt quote or a split). It may be shown with a warning, never trigger an alert.
    const crash = quote({
      price: 3000,
      previousClose: 8000,
      open: 3050,
      high: 3200,
      low: 2900,
      changePercent: -62.5,
    });
    expect(assessPlausibility(crash, opts)).toEqual({
      ok: false,
      quality: 'suspect',
      reasons: ['extreme_change'],
    });
    // the extreme case from the review: price = open = high = low = 1 with a consistent -99,9 %
    const glitch = quote({
      price: 1,
      open: 1,
      high: 1,
      low: 1,
      previousClose: 2354,
      changePercent: -99.96,
    });
    expect(assessPlausibility(glitch, opts).quality).toBe('suspect');
    expect(
      assessPlausibility(
        {
          ...glitch,
          price: 10_000,
          open: 10_000,
          high: 10_000,
          low: 10_000,
          previousClose: 1000,
          changePercent: 900,
        },
        opts,
      ).quality,
    ).toBe('suspect');
  });

  it('legitimate large moves inside the threshold stay trusted (ARA/ARB about 35 %, new-listing days)', () => {
    const ara = quote({
      price: 10_800,
      previousClose: 8000,
      open: 9000,
      high: 10_800,
      low: 8900,
      changePercent: 35,
    });
    const arb = quote({
      price: 5200,
      previousClose: 8000,
      open: 7000,
      high: 7100,
      low: 5200,
      changePercent: -35,
    });
    expect(assessPlausibility(ara, opts).quality).toBe('trusted');
    expect(assessPlausibility(arb, opts).quality).toBe('trusted');
  });

  it('the threshold is configurable', () => {
    const q = quote({
      price: 10_800,
      previousClose: 8000,
      open: 9000,
      high: 10_800,
      low: 8900,
      changePercent: 35,
    });
    expect(assessPlausibility(q, { maxChangePercent: 20 }).quality).toBe('suspect');
    expect(assessPlausibility(q, { maxChangePercent: 50 }).quality).toBe('trusted');
  });

  it.each([
    ['NaN price', { price: NaN }],
    ['Infinity price', { price: Infinity }],
    ['negative price', { price: -1 }],
    ['zero price', { price: 0 }],
    ['negative low', { low: -5 }],
    ['non-finite high', { high: Infinity }],
    ['NaN open', { open: NaN }],
    ['high below low', { high: 7900, low: 8100 }],
    ['price above the day high', { price: 9000 }],
    ['price below the day low', { price: 6000 }],
  ] as const)('%s is INVALID', (_label, over) => {
    expect(assessPlausibility(quote(over), opts).quality).toBe('invalid');
  });

  it('an open outside the day range, or a previous close that disagrees with the stored daily close, is SUSPECT', () => {
    expect(assessPlausibility(quote({ open: 5000 }), opts)).toMatchObject({
      quality: 'suspect',
      reasons: ['open_outside_range'],
    });
    // quote says previous close 8000 but the stored daily candles say 6000 (a 33 % disagreement)
    expect(assessPlausibility(quote(), { ...opts, referenceClose: 6000 })).toMatchObject({
      quality: 'suspect',
      reasons: ['reference_mismatch'],
    });
    expect(assessPlausibility(quote(), { ...opts, referenceClose: 8100 }).quality).toBe('trusted');
    expect(
      assessPlausibility(quote(), { ...opts, referenceClose: 8300, referenceTolerancePercent: 2 })
        .quality,
    ).toBe('suspect');
  });

  it('does NOT use a fixed price floor: legitimate low-priced stocks pass', () => {
    expect(
      assessPlausibility(
        quote({ price: 28, previousClose: 32, open: 30, high: 32, low: 28, changePercent: -12.5 }),
        opts,
      ).ok,
    ).toBe(true);
    expect(
      assessPlausibility(
        quote({ price: 3, previousClose: 3, open: 3, high: 3, low: 3, changePercent: 0 }),
        opts,
      ).ok,
    ).toBe(true);
  });

  it('flags a provider change% that disagrees with price/previousClose', () => {
    const r = assessPlausibility(
      quote({
        price: 8080,
        previousClose: 8000,
        changePercent: 12,
        open: 8000,
        high: 8100,
        low: 8000,
      }),
      opts,
    );
    expect(r.reasons).toContain('change_mismatch');
  });

  it('falls back to a reference close when the provider sends no previousClose', () => {
    const q = quote({
      price: 1,
      previousClose: null,
      changePercent: null,
      open: null,
      high: null,
      low: null,
    });
    expect(assessPlausibility(q, { ...opts, referenceClose: 8000 }).reasons).toContain(
      'extreme_change',
    );
    // nothing to compare with: not accused of being wrong, but not trusted enough for an alert either
    expect(assessPlausibility(q, opts)).toMatchObject({
      quality: 'suspect',
      reasons: ['no_reference'],
    });
  });

  it('works with missing optional fields and a configurable threshold', () => {
    const sparse = quote({ open: null, high: null, low: null, volume: null, averageVolume: null });
    expect(assessPlausibility(sparse, opts).ok).toBe(true);
    const moved = quote({
      price: 6000,
      previousClose: 8000,
      open: 8000,
      high: 8000,
      low: 5900,
      changePercent: -25,
    });
    expect(assessPlausibility(moved, { maxChangePercent: 20 }).reasons).toContain('extreme_change');
    expect(assessPlausibility(moved, { maxChangePercent: 50 }).ok).toBe(true);
  });
});

describe('referenceCloseFromCandles (independent previous-session close)', () => {
  const candles = [
    { date: '2026-09-29', close: 100 },
    { date: '2026-09-30', close: 110 },
    { date: '2026-10-01', close: 120 },
  ];
  it('uses the candle before the newest one when the newest candle is the same session as the quote', () => {
    expect(referenceCloseFromCandles(candles, '2026-10-01T08:00:00.000Z')).toBe(110);
  });
  it('uses the newest candle when the quote belongs to a later session (e.g. today is not in the history yet)', () => {
    expect(referenceCloseFromCandles(candles, '2026-10-02T03:00:00.000Z')).toBe(120);
  });
  it('has no reference when the session of the quote is unknown (missing or invalid timestamp), and handles tiny histories', () => {
    // guessing "the newest candle is the quote's session" produced a wrong reference
    expect(referenceCloseFromCandles(candles, null)).toBeNull();
    expect(referenceCloseFromCandles(candles, 'not-a-date')).toBeNull();
    expect(referenceCloseFromCandles(candles, '')).toBeNull();
    expect(referenceCloseFromCandles([], '2026-10-01T08:00:00.000Z')).toBeNull();
    expect(referenceCloseFromCandles([candles[0]], '2026-09-29T08:00:00.000Z')).toBeNull(); // nothing before it
    expect(referenceCloseFromCandles([candles[0]], '2026-09-30T08:00:00.000Z')).toBe(100);
  });
  it('for an OLDER stored quote the reference is the close before THAT session, not before the newest candle', () => {
    expect(referenceCloseFromCandles(candles, '2026-09-30T08:00:00.000Z')).toBe(100);
    expect(referenceCloseFromCandles(candles, '2026-09-29T08:00:00.000Z')).toBeNull();
  });
  it('uses the Asia/Jakarta calendar day of the quote (17:00 UTC is already the next day in WIB)', () => {
    expect(referenceCloseFromCandles(candles, '2026-10-01T17:30:00.000Z')).toBe(120);
  });
});

describe('volume validity', () => {
  const q = (volume: number | null): NormalizedQuote => ({
    symbol: 'TEST',
    name: 'TEST',
    price: 1777,
    change: 3,
    changePercent: 0.17,
    open: 1777,
    high: 1787,
    low: 1767,
    previousClose: 1774,
    volume,
    averageVolume: 1_000_000,
    timestamp: '2026-10-01T09:00:00.000Z',
    currency: 'IDR',
    marketState: 'REGULAR',
    delayMinutes: 10,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
  });
  const opts = { maxChangePercent: 50, referenceClose: 1774, referenceTolerancePercent: 5 };

  it.each([-5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'volume %s makes the quote suspect (warning, never an alert), not trusted',
    (v) => {
      const r = assessPlausibility(q(v), opts);
      expect(r.quality).toBe('suspect');
      expect(r.reasons).toContain('volume_invalid');
      expect(r.ok).toBe(false);
    },
  );

  it.each([0, 1, 1_000_000, null])('volume %s is fine', (v) => {
    expect(assessPlausibility(q(v), opts)).toMatchObject({ quality: 'trusted', reasons: [] });
  });

  it('an invalid price still wins (invalid), and volume does not change that', () => {
    expect(assessPlausibility({ ...q(-5), price: 0 }, opts).quality).toBe('invalid');
  });
});
