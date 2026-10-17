import { formatNumber, formatPercent, formatRatio, formatRupiah } from '../common/utils/format';

/**
 * Claim catalogue.
 *
 * The model never writes the text a user reads. The application computes a numbered catalogue of
 * short, factual sentences from the data ("claims"); the model only answers with the ids it finds
 * most relevant, and the application renders those sentences. Unsafe wording therefore has no path
 * to Telegram: whatever else a model emits (advice, predictions, disguised letters, injected
 * instructions) is dropped because it is not a known id.
 *
 * Every sentence in a catalogue is application-authored, descriptive and covered by a test that runs
 * it through the output policy.
 */

export type ClaimKind = 'observation' | 'risk' | 'difference' | 'consideration';

export interface Claim {
  id: string;
  kind: ClaimKind;
  text: string;
}

export interface AnalysisClaims {
  observations: Claim[];
  risks: Claim[];
}

export interface ComparisonClaims {
  differences: Claim[];
  considerations: Claim[];
}

/** Application-written label for a classification, shared with the renderers. */
export const TREND_LABEL: Record<string, string> = {
  BULLISH: 'Bullish',
  NEUTRAL: 'Netral',
  BEARISH: 'Bearish',
};
export const STRENGTH_LABEL: Record<string, string> = {
  STRONG: 'Kuat',
  MODERATE: 'Moderat',
  WEAK: 'Lemah',
};
export const BIAS_LABEL: Record<string, string> = {
  POSITIVE: 'bias positif',
  NEGATIVE: 'bias negatif',
  NEUTRAL: 'bias campuran',
};
const MACD_LABEL: Record<string, string> = {
  BULLISH: 'bullish',
  BEARISH: 'bearish',
  NEUTRAL: 'netral',
};

const numbered = (kind: ClaimKind, prefix: string, texts: readonly string[]): Claim[] =>
  texts.map((text, i) => ({ id: `${prefix}${i + 1}`, kind, text }));

export const observationClaims = (texts: readonly string[]): Claim[] =>
  numbered('observation', 'O', texts);
export const riskClaims = (texts: readonly string[]): Claim[] => numbered('risk', 'R', texts);

/** Fixed risk sentences used when a context carries none (also the always-present ones). */
export const GENERIC_RISK = 'Pergerakan harga dapat berubah sewaktu-waktu.';
export const NO_NEWS_RISK =
  'Analisis hanya memakai harga dan volume; berita dan fundamental tidak termasuk.';
/** Risk sentences that are always in the catalogue; every OTHER risk is derived from the data. */
/** Replaces NO_NEWS_RISK when fundamental or news claims are in the catalogue. */
export const SOURCES_RISK =
  'Analisis memakai harga, volume, fundamental yang dilaporkan, dan kejadian berita; semuanya menggambarkan masa lalu, bukan prediksi.';
export const FIXED_RISKS: readonly string[] = [GENERIC_RISK, NO_NEWS_RISK, SOURCES_RISK];

const isClaim = (v: unknown): v is Claim => {
  const c = v as Claim;
  return (
    !!c &&
    typeof c.id === 'string' &&
    /^[ORDC]\d{1,3}$/.test(c.id) &&
    typeof c.text === 'string' &&
    c.text.length > 0
  );
};

/**
 * The analysis catalogue of a context. Contexts built by `buildAnalysisContext` carry `claims`;
 * any other context (tests, tools) falls back to its `facts` sentences plus the generic risk.
 */
export function analysisClaimsOf(context: unknown): AnalysisClaims {
  const c = (context ?? {}) as {
    claims?: { observations?: unknown[]; risks?: unknown[] };
    facts?: unknown;
  };
  const obs = (c.claims?.observations ?? []).filter(isClaim);
  const risks = (c.claims?.risks ?? []).filter(isClaim);
  if (obs.length > 0) return { observations: obs, risks };
  const facts = Array.isArray(c.facts)
    ? c.facts.filter((f): f is string => typeof f === 'string' && f.length > 0)
    : [];
  return { observations: observationClaims(facts), risks: riskClaims([GENERIC_RISK]) };
}

/** Application-written limitation sentences of a context (shown as-is, never chosen by the model). */
export function limitationsOf(context: unknown): string[] {
  const l = (context as { knownDataLimitations?: unknown } | null)?.knownDataLimitations;
  return Array.isArray(l) ? l.filter((x): x is string => typeof x === 'string').slice(0, 5) : [];
}

/** What the model is shown: the data without its prose duplicate, plus the catalogue to choose from. */
export function promptContext(context: unknown, claims: AnalysisClaims): string {
  const base = context && typeof context === 'object' ? { ...(context as object) } : {};
  delete (base as { facts?: unknown }).facts;
  return JSON.stringify({ ...base, claims });
}

/* ---------------------------------------------------------------- comparison */

interface ComparisonEntry {
  symbol?: unknown;
  price?: unknown;
  changePercent?: unknown;
  trend?: unknown;
  momentum?: { strength?: unknown; bias?: unknown } | null;
  rsi14?: unknown;
  macdState?: unknown;
  ma20?: unknown;
  ma50?: unknown;
  volumeRatio?: unknown;
  changePercent20d?: unknown;
  nearestSupport?: unknown;
  nearestResistance?: unknown;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const COMPARISON_CONSIDERATIONS = [
  'Perbandingan ini hanya memakai harga dan volume; berita dan fundamental tidak termasuk.',
  'Perbandingan ini tidak memberi peringkat dan bukan rekomendasi.',
  'Kondisi teknikal dapat berubah sewaktu-waktu.',
];

/**
 * Factual comparison rows computed from the per-stock entries. Each row only restates values that
 * are in the entries (no derived numbers), so the output policy's number checks hold by construction.
 */
export function comparisonClaimsOf(entries: unknown): ComparisonClaims {
  const list = (Array.isArray(entries) ? entries : []).filter(
    (e): e is ComparisonEntry =>
      !!e && typeof e === 'object' && typeof (e as ComparisonEntry).symbol === 'string',
  );
  const rows: string[] = [];
  const row = (label: string, cell: (e: ComparisonEntry) => string | null, end = '.') => {
    const cells = list.map((e) => ({ sym: e.symbol as string, v: cell(e) }));
    if (cells.filter((c) => c.v !== null).length < 2) return;
    rows.push(`${label}: ${cells.map((c) => `${c.sym} ${c.v ?? '-'}`).join(', ')}${end}`);
  };
  const vsMa = (e: ComparisonEntry, ma: unknown) =>
    finite(e.price) && finite(ma)
      ? `${e.price > ma ? 'di atas' : e.price < ma ? 'di bawah' : 'sama dengan'} (${formatRupiah(ma)})`
      : null;

  row('Perubahan harga terakhir', (e) =>
    finite(e.changePercent) ? formatPercent(e.changePercent) : null,
  );
  row('Kondisi teknikal', (e) =>
    typeof e.trend === 'string' ? (TREND_LABEL[e.trend] ?? null) : null,
  );
  row('Momentum', (e) => {
    const m = e.momentum;
    if (!m || typeof m.strength !== 'string' || typeof m.bias !== 'string') return null;
    const s = STRENGTH_LABEL[m.strength];
    const b = BIAS_LABEL[m.bias];
    return s && b ? `${s} (${b})` : null;
  });
  row('RSI(14)', (e) => (finite(e.rsi14) ? formatNumber(e.rsi14, 1) : null));
  row('MACD', (e) => (typeof e.macdState === 'string' ? (MACD_LABEL[e.macdState] ?? null) : null));
  row('Harga terhadap MA20', (e) => vsMa(e, e.ma20));
  row('Harga terhadap MA50', (e) => vsMa(e, e.ma50));
  row('Rasio volume terhadap rata-rata 20 hari', (e) =>
    finite(e.volumeRatio) ? formatRatio(e.volumeRatio) : null,
  );
  row('Perubahan harga 20 hari terakhir', (e) =>
    finite(e.changePercent20d) ? formatPercent(e.changePercent20d) : null,
  );
  row('Harga terakhir', (e) => (finite(e.price) ? formatRupiah(e.price) : null));
  row('Support terdekat', (e) =>
    finite(e.nearestSupport) ? formatRupiah(e.nearestSupport) : null,
  );
  row('Resistance terdekat', (e) =>
    finite(e.nearestResistance) ? formatRupiah(e.nearestResistance) : null,
  );

  return {
    differences: numbered('difference', 'D', rows),
    considerations: numbered('consideration', 'C', COMPARISON_CONSIDERATIONS),
  };
}
