import { TechnicalSnapshot } from './analysis.types';
import {
  computeSupportResistance,
  strengthFromTouches,
} from './support-resistance/support-resistance';
import { classify, computeTechnical, MIN_CANDLES } from './technical';
import { DailyCandle } from '../stock/stock.types';

/** SYNTHETIC test fixtures — not market data. */
function candlesFromCloses(closes: number[], spread = 1, volume = 1000): DailyCandle[] {
  return closes.map((c, i) => ({
    date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
    open: c,
    high: c + spread,
    low: c - spread,
    close: c,
    volume,
  }));
}

const baseSnapshot: TechnicalSnapshot = {
  asOf: '2025-01-01',
  price: 100,
  sma5: null,
  sma20: null,
  sma50: null,
  sma100: null,
  sma200: null,
  ema12: null,
  ema26: null,
  rsi14: null,
  macd: null,
  macdSignal: null,
  macdHistogram: null,
  bollingerUpper: null,
  bollingerMiddle: null,
  bollingerLower: null,
  atr14: null,
  volumeSma20: null,
  volumeRatio: null,
};

describe('classify()', () => {
  it('BULLISH when most trend signals are positive', () => {
    const c = classify({
      ...baseSnapshot,
      price: 110,
      sma20: 105,
      sma50: 100,
      sma200: 90,
      macdHistogram: 2,
    });
    expect(c.trend).toBe('BULLISH');
    expect(c.trendSignals).toContain('Harga di atas MA20');
  });
  it('BEARISH when most trend signals are negative', () => {
    const c = classify({
      ...baseSnapshot,
      price: 80,
      sma20: 90,
      sma50: 95,
      sma200: 100,
      macdHistogram: -1,
    });
    expect(c.trend).toBe('BEARISH');
  });
  it('NEUTRAL for mixed signals', () => {
    const c = classify({
      ...baseSnapshot,
      price: 100,
      sma20: 95,
      sma50: 105,
      sma200: 90,
      macdHistogram: -1,
    });
    expect(c.trend).toBe('NEUTRAL');
  });
  it('is NEUTRAL (not an error) when no indicator is available', () => {
    expect(classify(baseSnapshot).trend).toBe('NEUTRAL');
  });
  it('derives momentum strength and bias from RSI/MACD', () => {
    expect(classify({ ...baseSnapshot, rsi14: 68, macdHistogram: 1 }).momentum).toEqual({
      strength: 'STRONG',
      bias: 'POSITIVE',
    });
    expect(classify({ ...baseSnapshot, rsi14: 33, macdHistogram: -1 }).momentum).toEqual({
      strength: 'STRONG',
      bias: 'NEGATIVE',
    });
    expect(classify({ ...baseSnapshot, rsi14: 52, macdHistogram: -1 }).momentum).toEqual({
      strength: 'WEAK',
      bias: 'NEUTRAL',
    });
    expect(classify({ ...baseSnapshot, rsi14: 58, macdHistogram: 1 }).momentum.strength).toBe(
      'MODERATE',
    );
  });
  it('flags RSI zones', () => {
    expect(classify({ ...baseSnapshot, rsi14: 75 }).rsiZone).toBe('OVERBOUGHT');
    expect(classify({ ...baseSnapshot, rsi14: 25 }).rsiZone).toBe('OVERSOLD');
    expect(classify({ ...baseSnapshot, rsi14: 50 }).rsiZone).toBe('NEUTRAL');
    expect(classify(baseSnapshot).rsiZone).toBeNull();
  });
  it('reports MACD state from macd vs signal', () => {
    expect(classify({ ...baseSnapshot, macd: 2, macdSignal: 1 }).macdState).toBe('BULLISH');
    expect(classify({ ...baseSnapshot, macd: 1, macdSignal: 2 }).macdState).toBe('BEARISH');
  });
});

describe('computeTechnical()', () => {
  it('rejects too-short history', () => {
    expect(() =>
      computeTechnical('TEST', candlesFromCloses(new Array(MIN_CANDLES - 1).fill(100))),
    ).toThrow(/Insufficient/);
  });

  it('classifies a steady synthetic uptrend as bullish with price above its MAs', () => {
    const closes = Array.from({ length: 250 }, (_, i) => 1000 + i * 4);
    const t = computeTechnical('TEST', candlesFromCloses(closes, 5));
    expect(t.classification.trend).toBe('BULLISH');
    expect(t.snapshot.price).toBe(closes[249]);
    expect(t.snapshot.sma20 as number).toBeLessThan(t.snapshot.price);
    expect(t.snapshot.sma200).not.toBeNull();
    expect(t.limitedHistory).toBe(false);
    expect(t.snapshot.rsi14).toBeCloseTo(100, 5);
  });

  it('classifies a synthetic downtrend as bearish', () => {
    const closes = Array.from({ length: 250 }, (_, i) => 2000 - i * 4);
    const t = computeTechnical('TEST', candlesFromCloses(closes, 5));
    expect(t.classification.trend).toBe('BEARISH');
  });

  it('flags limited history and leaves long-period indicators null', () => {
    const t = computeTechnical(
      'TEST',
      candlesFromCloses(Array.from({ length: 60 }, (_, i) => 100 + i)),
    );
    expect(t.limitedHistory).toBe(true);
    expect(t.snapshot.sma200).toBeNull();
    expect(t.snapshot.sma50).not.toBeNull();
  });

  it('computes volume ratio against the previous 20 days', () => {
    const candles = candlesFromCloses(new Array(60).fill(100));
    candles[candles.length - 1].volume = 3000;
    expect(computeTechnical('TEST', candles).snapshot.volumeRatio).toBeCloseTo(3, 10);
  });
});

describe('support / resistance', () => {
  /** SYNTHETIC zig-zag between ~100 (lows) and ~110 (highs). */
  function zigzag(): DailyCandle[] {
    const closes: number[] = [];
    for (let cycle = 0; cycle < 8; cycle++) {
      for (let i = 0; i < 10; i++) closes.push(i < 5 ? 100 + i * 2 : 110 - (i - 5) * 2);
    }
    return candlesFromCloses(closes, 0.5);
  }

  it('finds the repeated turning points as strong support and resistance', () => {
    const { support, resistance } = computeSupportResistance(zigzag(), 105);
    expect(support.length).toBeGreaterThan(0);
    expect(resistance.length).toBeGreaterThan(0);
    expect(support[0].price).toBeLessThan(105);
    expect(resistance[0].price).toBeGreaterThan(105);
    // raw levels are 99.5 / 110.5; levels are rounded to whole rupiah
    expect(support[0].price).toBe(100);
    expect(resistance[0].price).toBe(111);
    expect(support[0].strength).toBe('strong');
    expect(resistance[0].strength).toBe('strong');
  });

  it('returns levels on the correct side of the current price, nearest first', () => {
    const { support, resistance } = computeSupportResistance(zigzag(), 105, { maxLevels: 3 });
    expect(support.every((l) => l.price < 105)).toBe(true);
    expect(resistance.every((l) => l.price > 105)).toBe(true);
    for (let i = 1; i < support.length; i++)
      expect(support[i].price).toBeLessThan(support[i - 1].price);
  });

  it('returns empty lists for a flat market (no pivots)', () => {
    const r = computeSupportResistance(candlesFromCloses(new Array(60).fill(100), 0), 100);
    expect(r).toEqual({ support: [], resistance: [] });
  });

  it('maps touches to strength', () => {
    expect(strengthFromTouches(1)).toBe('weak');
    expect(strengthFromTouches(2)).toBe('medium');
    expect(strengthFromTouches(5)).toBe('strong');
  });
});

describe('technical analysis edge cases', () => {
  // convex (accelerating) rise: a linear one has a constant MACD, i.e. a histogram of exactly 0
  const up = (n: number) =>
    candlesFromCloses(Array.from({ length: n }, (_, i) => 100 + i * 2 + i * i * 0.15));

  it('momentum bias is NEUTRAL while the MACD histogram does not exist yet (30-33 candles)', () => {
    for (const n of [30, 31, 33]) {
      const t = computeTechnical('X', up(n));
      expect(t.snapshot.macdHistogram).toBeNull();
      expect(t.snapshot.rsi14).toBeGreaterThan(50);
      expect(t.classification.momentum.bias).toBe('NEUTRAL');
    }
    // with a histogram and RSI on the same side the bias is directional again
    expect(computeTechnical('X', up(40)).classification.momentum.bias).toBe('POSITIVE');
  });

  it('a single available signal is not a trend (very short history => NEUTRAL)', () => {
    const t = computeTechnical('X', up(30));
    expect(t.classification.trendSignals).toHaveLength(1);
    expect(t.classification.trend).toBe('NEUTRAL');
    // two signals (price vs SMA20 and the MACD histogram) are enough again
    const t2 = computeTechnical('X', up(40));
    expect(t2.classification.trendSignals.length).toBeGreaterThanOrEqual(2);
    expect(t2.classification.trend).toBe('BULLISH');
  });

  it('classification can use a live price; support/resistance distances follow it', () => {
    const candles = up(60);
    const lastClose = candles[candles.length - 1].close;
    const base = computeTechnical('X', candles);
    expect(base.snapshot.price).toBe(lastClose);
    const live = computeTechnical('X', candles, { price: lastClose * 0.6 });
    expect(live.snapshot.price).toBe(lastClose * 0.6);
    expect(live.classification.trendSignals).toContain('Harga di bawah MA20');
    expect(base.classification.trendSignals).toContain('Harga di atas MA20');
    // moving averages themselves still come from the candles
    expect(live.snapshot.sma20).toBe(base.snapshot.sma20);
    // a non-positive or missing override is ignored
    expect(computeTechnical('X', candles, { price: 0 }).snapshot.price).toBe(lastClose);
    expect(computeTechnical('X', candles, { price: Number.NaN }).snapshot.price).toBe(lastClose);
  });

  describe('corrupt input is cleaned instead of turning every average into NaN', () => {
    const clean = up(80);
    const ref = computeTechnical('X', clean);

    it('drops NaN/Infinity/non-positive rows and high < low', () => {
      const dirty: DailyCandle[] = [
        ...clean.slice(0, 40),
        { ...clean[40], close: Number.NaN },
        { ...clean[41], open: Number.POSITIVE_INFINITY },
        { ...clean[42], close: -5 },
        { ...clean[43], high: 1, low: 50 },
        ...clean.slice(44),
      ];
      const t = computeTechnical('X', dirty);
      for (const v of [t.snapshot.sma20, t.snapshot.sma50, t.snapshot.rsi14, t.snapshot.atr14]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(t.candleCount).toBe(76);
    });

    it('sorts ascending and keeps one candle per date (the last wins)', () => {
      const shuffled = [...clean].reverse();
      const withDup = [...shuffled, { ...clean[10], close: clean[10].close }];
      const t = computeTechnical('X', withDup);
      expect(t.snapshot).toEqual(ref.snapshot);
      expect(t.classification).toEqual(ref.classification);
    });

    it('a negative or NaN volume becomes 0 and does not poison the volume ratio', () => {
      const dirty = clean.map((c, i) =>
        i === 79 ? { ...c, volume: Number.NaN } : i === 70 ? { ...c, volume: -5 } : c,
      );
      const t = computeTechnical('X', dirty);
      expect(Number.isFinite(t.snapshot.volumeSma20)).toBe(true);
      expect(t.snapshot.volumeRatio === null || Number.isFinite(t.snapshot.volumeRatio)).toBe(true);
    });

    it('still refuses a history that is too short AFTER cleaning', () => {
      const dirty = [...clean.slice(0, 29), { ...clean[29], close: Number.NaN }];
      expect(() => computeTechnical('X', dirty)).toThrow(/Insufficient history/);
    });
  });
});
