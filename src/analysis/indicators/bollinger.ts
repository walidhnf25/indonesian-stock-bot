import { Series } from './sma';

export interface BollingerResult {
  upper: Series;
  middle: Series;
  lower: Series;
}

/** Bollinger Bands using population standard deviation (the common charting convention). */
export function bollinger(closes: number[], period = 20, multiplier = 2): BollingerResult {
  const upper: Series = new Array(closes.length).fill(null);
  const middle: Series = new Array(closes.length).fill(null);
  const lower: Series = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    middle[i] = mean;
    upper[i] = mean + multiplier * sd;
    lower[i] = mean - multiplier * sd;
  }
  return { upper, middle, lower };
}
