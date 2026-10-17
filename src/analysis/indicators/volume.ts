import { Series, sma } from './sma';

export function volumeSma(volumes: number[], period = 20): Series {
  return sma(volumes, period);
}

/**
 * Volume ratio of the latest bar vs the average of the `period` bars BEFORE it.
 * The latest bar is excluded from the baseline so a spike does not dilute itself.
 * Returns null when there is not enough history or the baseline is zero.
 * Note: during trading hours the latest bar's volume is still accumulating.
 */
export function volumeRatio(volumes: number[], period = 20): number | null {
  if (volumes.length < period + 1) return null;
  const baseline = volumes.slice(-period - 1, -1);
  const avg = baseline.reduce((a, b) => a + b, 0) / period;
  if (avg <= 0) return null;
  return volumes[volumes.length - 1] / avg;
}
