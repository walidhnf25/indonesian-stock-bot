/** Series helpers return arrays aligned with the input; warm-up positions are null. */
export type Series = Array<number | null>;

export function sma(values: number[], period: number): Series {
  if (period <= 0) throw new Error('period must be > 0');
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function last<T>(arr: Array<T | null>): T | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}
