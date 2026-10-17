/**
 * Numeric grounding: every market number in AI text must come from the data the application
 * supplied. This is a deliberate *simple* check (tokenise numbers, compare with the allowed set),
 * not an NLP parser. It prioritises the high-risk categories: prices, percentages, RSI/MA levels,
 * volume and ratios.
 */

const MONTHS =
  'januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|jun|jul|agu|agt|sep|okt|nov|des';

/** Segments whose digits are labels, not market claims (indicator names/periods, durations, dates, times). */
const NON_CLAIM_PATTERNS: RegExp[] = [
  // Moving-average labels: "MA20", "MA 50", "EMA12", "SMA-200". Not "MA 6.340" (a price level).
  /\b(?:ema|sma|ma)\s?-?\d{1,3}(?![\d.,]*\d)/gi,
  // Period written as a parameter: "RSI(14)", "ATR(14)", "Bollinger(20, 2)", "RSI-14".
  /\b(?:rsi|atr|macd|bb|bollinger)\s?(?:\(\s?\d{1,3}(?:\s?,\s?\d{1,3}){0,2}\s?\)|-\d{1,3}(?![\d.,]*\d))/gi,
  new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS})\\s+\\d{4}\\b`, 'gi'),
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}[:.]\d{2}\s*wib\b/gi,
  // Durations ("20 hari"). The lookbehind stops "Rp3.500 hari ini" from being read as "500 hari".
  /(?<![\d.,])\d+\s*(?:hari|minggu|pekan|bulan|tahun|periode|sesi|kandel|candle|bar|menit|jam|detik)\b/gi,
];

/** Definitional constants that are not market data (RSI zones etc.). */
const DEFINITIONAL_NUMBERS = [0, 1, 2, 3, 5, 9, 12, 14, 20, 26, 30, 50, 70, 80, 100, 200];

const SUFFIX_MULTIPLIER: Record<string, number> = {
  rb: 1e3,
  ribu: 1e3,
  jt: 1e6,
  juta: 1e6,
  m: 1e9,
  miliar: 1e9,
  t: 1e12,
  triliun: 1e12,
};

export interface NumberToken {
  raw: string;
  /** Candidate interpretations (e.g. "1.250" is 1250 or 1.25). */
  values: number[];
  unit: '%' | 'x' | 'scale' | 'rp' | null;
  index: number;
}

const TOKEN_RE =
  /(?<![\w.,])(rp\.?\s?)?(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)(?:\s?(%|(?:persen|x|kali|jt|juta|rb|ribu|miliar|triliun|m|t)\b))?/gi;

function candidates(numStr: string): number[] {
  const out: number[] = [];
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(numStr)) {
    out.push(Number(numStr.replace(/\./g, '').replace(',', '.'))); // 6.100 -> 6100
    if (!numStr.includes(',') && numStr.split('.').length === 2) {
      // also the "6.1" (English decimal) reading, but never when that reading is a definitional
      // constant: "5.000" is five thousand, it must not be excused as the harmless "5"
      const decimal = Number(numStr);
      if (!DEFINITIONAL_NUMBERS.includes(decimal)) out.push(decimal);
    }
  } else if (numStr.includes(',')) {
    out.push(Number(numStr.replace(',', '.')));
  } else {
    out.push(Number(numStr));
  }
  return out.filter(Number.isFinite);
}

/** Removes label-like digits so they are not mistaken for market claims. */
export function stripNonClaims(text: string): string {
  return NON_CLAIM_PATTERNS.reduce((acc, re) => acc.replace(re, ' '), text);
}

export function extractNumberTokens(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const suffix = (m[3] ?? '').toLowerCase();
    let unit: NumberToken['unit'] = m[1] ? 'rp' : null;
    let factor = 1;
    if (suffix === '%' || suffix === 'persen') unit = '%';
    else if (suffix === 'x' || suffix === 'kali') unit = 'x';
    else if (suffix) {
      unit = 'scale';
      factor = SUFFIX_MULTIPLIER[suffix] ?? 1;
    }
    const values = candidates(m[2]).map((v) => v * factor);
    if (values.length) tokens.push({ raw: m[0].trim(), values, unit, index: m.index ?? 0 });
  }
  return tokens;
}

/** All numbers (and numbers inside strings, e.g. the pre-computed facts) found in an object tree. */
export function collectAllowedNumbers(context: unknown): number[] {
  const out: number[] = [...DEFINITIONAL_NUMBERS];
  const walk = (v: unknown): void => {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    else if (typeof v === 'string') {
      for (const t of extractNumberTokens(stripNonClaims(v))) out.push(...t.values);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(context);
  return out;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Is `n` the same number as some allowed value, allowing for display rounding (0-2 decimals) and
 * sign? `scaled` numbers ("118,04 jt") also get a small relative tolerance because the unit hides
 * the lower digits; plain prices/percentages must match exactly after rounding.
 */
export function isGrounded(
  n: number,
  allowed: readonly number[],
  opts: { scaled?: boolean } = {},
): boolean {
  const target = Math.abs(n);
  return allowed.some((raw) => {
    const a = Math.abs(raw);
    if (opts.scaled && Math.abs(a - target) <= a * 0.0006) return true;
    if (Math.abs(a - target) < 1e-9) return true;
    return [0, 1, 2].some((d) => Math.abs(round(a, d) - target) < 1e-9);
  });
}

const METRIC_CONTEXT_BEFORE =
  /(rsi|rasio|volume|harga|rp|persen|ratio|macd|support|resistance)\s*[:=(]?\s*$/i;

/**
 * Numbers in `text` that are not present in `allowed`. Small integers (<= 10) are ignored unless
 * they are attached to a metric word, a % or an x multiplier (so "RSI 5" or "7%" still count).
 */
export function findUngroundedNumbers(text: string, allowed: readonly number[]): string[] {
  const cleaned = stripNonClaims(text);
  const bad: string[] = [];
  for (const t of extractNumberTokens(cleaned)) {
    if (t.values.some((v) => isGrounded(v, allowed, { scaled: t.unit === 'scale' }))) continue;
    const small = t.values.every((v) => Number.isInteger(v) && Math.abs(v) <= 10);
    if (small && t.unit === null) {
      const before = cleaned.slice(Math.max(0, t.index - 14), t.index);
      if (!METRIC_CONTEXT_BEFORE.test(before)) continue;
    }
    bad.push(t.raw);
  }
  return [...new Set(bad)];
}
