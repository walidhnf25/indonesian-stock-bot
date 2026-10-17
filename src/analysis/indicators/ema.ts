import { Series } from './sma';

/** EMA seeded with the SMA of the first `period` values (standard convention). */
export function ema(values: number[], period: number): Series {
  if (period <= 0) throw new Error('period must be > 0');
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
