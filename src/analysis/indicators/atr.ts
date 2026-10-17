import { Series } from './sma';

/** Wilder's Average True Range. First value appears at index `period`. */
export function atr(highs: number[], lows: number[], closes: number[], period = 14): Series {
  const n = closes.length;
  const out: Series = new Array(n).fill(null);
  if (n <= period) return out;

  const tr: number[] = new Array(n).fill(0);
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
  }
  let prev = 0;
  for (let i = 1; i <= period; i++) prev += tr[i];
  prev /= period;
  out[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}
