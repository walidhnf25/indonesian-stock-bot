import { DailyCandle } from '../../stock/stock.types';
import { LevelStrength, PriceLevel } from '../analysis.types';

export interface SupportResistanceOptions {
  /** Candles on each side that must be lower/higher for a pivot. */
  pivotWindow?: number;
  /** Only the most recent N candles are considered. */
  lookback?: number;
  /** Pivots within this fraction of price are merged into one level. */
  clusterTolerance?: number;
  maxLevels?: number;
}

export interface SupportResistanceResult {
  support: PriceLevel[];
  resistance: PriceLevel[];
}

export function strengthFromTouches(touches: number): LevelStrength {
  if (touches >= 3) return 'strong';
  if (touches === 2) return 'medium';
  return 'weak';
}

/**
 * Deterministic swing-pivot support/resistance:
 *  1. find swing highs/lows (local extrema over a +-window),
 *  2. cluster nearby pivots (they represent the same price zone),
 *  3. strength = number of pivots in the zone,
 *  4. levels below the current price are support, above are resistance.
 */
export function computeSupportResistance(
  candles: DailyCandle[],
  currentPrice: number,
  opts: SupportResistanceOptions = {},
): SupportResistanceResult {
  const w = opts.pivotWindow ?? 3;
  const lookback = opts.lookback ?? 180;
  const tol = opts.clusterTolerance ?? 0.015;
  const maxLevels = opts.maxLevels ?? 3;

  const data = candles.slice(-lookback);
  const pivots: number[] = [];
  for (let i = w; i < data.length - w; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      if (data[j].high >= data[i].high) isHigh = false;
      if (data[j].low <= data[i].low) isLow = false;
    }
    if (isHigh) pivots.push(data[i].high);
    if (isLow) pivots.push(data[i].low);
  }
  if (pivots.length === 0) return { support: [], resistance: [] };

  pivots.sort((a, b) => a - b);
  const clusters: Array<{ sum: number; count: number }> = [];
  for (const p of pivots) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(p - c.sum / c.count) / (c.sum / c.count) <= tol) {
      c.sum += p;
      c.count++;
    } else {
      clusters.push({ sum: p, count: 1 });
    }
  }

  const levels: PriceLevel[] = clusters.map((c) => ({
    price: Math.round(c.sum / c.count),
    touches: c.count,
    strength: strengthFromTouches(c.count),
  }));

  const support = levels
    .filter((l) => l.price < currentPrice * 0.999)
    .sort((a, b) => b.price - a.price)
    .slice(0, maxLevels);
  const resistance = levels
    .filter((l) => l.price > currentPrice * 1.001)
    .sort((a, b) => a.price - b.price)
    .slice(0, maxLevels);

  return { support, resistance };
}
