import { ema } from './ema';
import { Series } from './sma';

export interface MacdResult {
  macd: Series;
  signal: Series;
  histogram: Series;
}

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const macdLine: Series = closes.map((_, i) =>
    fastEma[i] !== null && slowEma[i] !== null
      ? (fastEma[i] as number) - (slowEma[i] as number)
      : null,
  );

  // Signal = EMA of the defined part of the MACD line, re-aligned to the original index.
  const firstIdx = macdLine.findIndex((v) => v !== null);
  const signal: Series = new Array(closes.length).fill(null);
  if (firstIdx >= 0) {
    const defined = macdLine.slice(firstIdx) as number[];
    const sig = ema(defined, signalPeriod);
    sig.forEach((v, j) => {
      signal[firstIdx + j] = v;
    });
  }
  const histogram: Series = macdLine.map((m, i) =>
    m !== null && signal[i] !== null ? m - (signal[i] as number) : null,
  );
  return { macd: macdLine, signal, histogram };
}
