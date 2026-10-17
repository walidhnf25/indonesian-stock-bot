import { atr } from './atr';
import { bollinger } from './bollinger';
import { ema } from './ema';
import { macd } from './macd';
import { rsi } from './rsi';
import { last, sma } from './sma';
import { volumeRatio, volumeSma } from './volume';

describe('SMA', () => {
  it('computes a simple moving average with null warm-up', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it('returns all null when history is shorter than the period', () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
  });
  it('rejects non-positive periods', () => {
    expect(() => sma([1], 0)).toThrow();
  });
  it('last() returns the latest non-null value', () => {
    expect(last([null, 1, 2, null])).toBe(2);
    expect(last([null, null])).toBeNull();
  });
});

describe('EMA', () => {
  it('is seeded with the SMA of the first period and then smoothed (k = 2/(n+1))', () => {
    // seed = (1+2+3)/3 = 2, k = 0.5 -> 3 -> 4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it('converges to a constant series value', () => {
    const out = ema(new Array(50).fill(7), 12);
    expect(out[49]).toBeCloseTo(7, 10);
  });
  it('returns nulls when too short', () => {
    expect(ema([1, 2], 5)).toEqual([null, null]);
  });
});

describe('RSI (Wilder)', () => {
  // Sample closes (a well-known textbook series). Expected values are derived independently below.
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
    46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
  ];

  /** Straightforward reference implementation, written separately from rsi.ts. */
  function referenceRsi(values: number[], period: number): number[] {
    const out: number[] = [];
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i < values.length; i++) {
      const change = values[i] - values[i - 1];
      const gain = Math.max(change, 0);
      const loss = Math.max(-change, 0);
      if (i <= period) {
        avgGain += gain / period;
        avgLoss += loss / period;
        if (i === period) out.push(100 - 100 / (1 + avgGain / avgLoss));
      } else {
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        out.push(100 - 100 / (1 + avgGain / avgLoss));
      }
    }
    return out;
  }

  it('first value matches the hand calculation (gains 3.34 / losses 1.40 over 14 changes)', () => {
    // avgGain = 3.34/14, avgLoss = 1.40/14  =>  RSI = 100 - 100/(1 + 3.34/1.40)
    const expected = 100 - 100 / (1 + 3.34 / 1.4);
    expect(expected).toBeCloseTo(70.464, 3);
    expect(rsi(closes, 14)[14]).toBeCloseTo(expected, 6);
  });
  it('matches the reference implementation on every bar', () => {
    const r = rsi(closes, 14);
    expect(r[13]).toBeNull();
    const ref = referenceRsi(closes, 14);
    ref.forEach((v, i) => expect(r[14 + i]).toBeCloseTo(v, 9));
  });
  it('is 100 for a strictly rising series, 0 for a falling one, 50 for flat', () => {
    const up = Array.from({ length: 30 }, (_, i) => i + 1);
    const down = [...up].reverse();
    expect(last(rsi(up))).toBe(100);
    expect(last(rsi(down))).toBeCloseTo(0, 10);
    expect(last(rsi(new Array(30).fill(10)))).toBe(50);
  });
  it('stays within 0..100', () => {
    const noisy = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 10 + (i % 7));
    for (const v of rsi(noisy)) {
      if (v === null) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe('MACD', () => {
  const closes = Array.from({ length: 120 }, (_, i) => 100 + i * 0.5 + Math.sin(i / 4) * 3);
  it('macd = EMA12 - EMA26, histogram = macd - signal', () => {
    const m = macd(closes);
    const e12 = ema(closes, 12);
    const e26 = ema(closes, 26);
    const i = closes.length - 1;
    expect(m.macd[i]).toBeCloseTo((e12[i] as number) - (e26[i] as number), 10);
    expect(m.histogram[i]).toBeCloseTo((m.macd[i] as number) - (m.signal[i] as number), 10);
  });
  it('has the expected warm-up: macd from index 25, signal from index 33', () => {
    const m = macd(closes);
    expect(m.macd[24]).toBeNull();
    expect(m.macd[25]).not.toBeNull();
    expect(m.signal[32]).toBeNull();
    expect(m.signal[33]).not.toBeNull();
  });
  it('is zero for a constant series', () => {
    const m = macd(new Array(60).fill(50));
    expect(last(m.macd)).toBeCloseTo(0, 10);
    expect(last(m.histogram)).toBeCloseTo(0, 10);
  });
  it('is positive in a steady uptrend', () => {
    const up = Array.from({ length: 80 }, (_, i) => 100 + i);
    expect(last(macd(up).macd) as number).toBeGreaterThan(0);
  });
});

describe('Bollinger Bands', () => {
  it('uses population standard deviation', () => {
    const closes = Array.from({ length: 20 }, (_, i) => i + 1);
    const b = bollinger(closes, 20, 2);
    const sd = Math.sqrt((20 * 20 - 1) / 12); // population sd of 1..20
    expect(b.middle[19]).toBeCloseTo(10.5, 10);
    expect(b.upper[19]).toBeCloseTo(10.5 + 2 * sd, 10);
    expect(b.lower[19]).toBeCloseTo(10.5 - 2 * sd, 10);
  });
  it('collapses to the price when volatility is zero', () => {
    const b = bollinger(new Array(25).fill(8), 20, 2);
    expect(b.upper[24]).toBe(8);
    expect(b.lower[24]).toBe(8);
  });
});

describe('ATR (Wilder)', () => {
  it('equals the constant true range for a constant-range series', () => {
    const n = 40;
    const closes = new Array(n).fill(100);
    const highs = closes.map((c) => c + 1);
    const lows = closes.map((c) => c - 1);
    expect(last(atr(highs, lows, closes, 14))).toBeCloseTo(2, 10);
  });
  it('accounts for gaps via previous close', () => {
    const highs = [10, 10, 20, 20];
    const lows = [9, 9, 19, 19];
    const closes = [9.5, 9.5, 19.5, 19.5];
    // TR[2] = max(1, |20-9.5|, |19-9.5|) = 10.5
    const out = atr(highs, lows, closes, 2);
    expect(out[2]).toBeCloseTo((1 + 10.5) / 2, 10);
  });
  it('returns nulls when there is not enough data', () => {
    expect(atr([1, 2], [0, 1], [1, 1.5], 14)).toEqual([null, null]);
  });
});

describe('Volume indicators', () => {
  it('volumeSma is a simple average', () => {
    expect(last(volumeSma([10, 20, 30, 40], 2))).toBe(35);
  });
  it('volumeRatio compares the latest bar to the previous N bars (excluding itself)', () => {
    const vols = [...new Array(20).fill(100), 300];
    expect(volumeRatio(vols, 20)).toBeCloseTo(3, 10);
  });
  it('returns null without enough history or with zero baseline', () => {
    expect(volumeRatio([1, 2, 3], 20)).toBeNull();
    expect(volumeRatio([...new Array(20).fill(0), 5], 20)).toBeNull();
  });
});
