/**
 * Fundamentals with explicit provenance. Every metric a user sees carries one of these
 * statuses, so a number is never shown without saying where it came from:
 *
 *   reported  — the provider reported it as a historical/trailing figure
 *   estimated — a forward-looking analyst figure from the provider (forward P/E, forward EPS)
 *   derived   — computed by Indonesian Stock Bot from other reported figures (e.g. P/E = price / EPS)
 *   stale     — served from Indonesian Stock Bot's last stored snapshot because the provider is unavailable, and the
 *               snapshot is older than FUNDAMENTALS_STALE_DAYS
 *   missing   — not available from the provider and not derivable; never invented
 */
export type MetricStatus = 'reported' | 'estimated' | 'derived' | 'stale' | 'missing';

export const FUNDAMENTAL_METRICS = [
  'marketCap',
  'per',
  'forwardPer',
  'pbv',
  'eps',
  'forwardEps',
  'dividendYield',
  'revenue',
  'netIncome',
  'netMargin',
  'roe',
  'totalDebt',
  'debtToEquity',
  'revenueGrowth',
  'earningsGrowth',
] as const;

export type FundamentalMetric = (typeof FUNDAMENTAL_METRICS)[number];

export interface FundamentalField {
  value: number | null;
  status: MetricStatus;
}

export type FundamentalFields = Record<FundamentalMetric, FundamentalField>;

export interface FundamentalsReport {
  symbol: string;
  name: string | null;
  fields: FundamentalFields;
  /** Metrics with status 'missing', in display order. */
  missing: FundamentalMetric[];
  /** When the underlying figures were fetched from the provider. */
  asOf: Date;
  ageDays: number;
  /** True when served from a stored snapshot because the provider was unavailable. */
  fromSnapshot: boolean;
  /** True when fromSnapshot and the snapshot is older than FUNDAMENTALS_STALE_DAYS. */
  stale: boolean;
  source: string;
}

/** Indonesian labels and units, shared by the formatter and the comparison table. */
export const METRIC_LABEL: Record<FundamentalMetric, string> = {
  marketCap: 'Kapitalisasi pasar',
  per: 'PER',
  forwardPer: 'PER forward',
  pbv: 'PBV',
  eps: 'EPS',
  forwardEps: 'EPS forward',
  dividendYield: 'Dividend yield',
  revenue: 'Pendapatan',
  netIncome: 'Laba bersih',
  netMargin: 'Margin bersih',
  roe: 'ROE',
  totalDebt: 'Total utang',
  debtToEquity: 'DER',
  revenueGrowth: 'Pertumbuhan pendapatan',
  earningsGrowth: 'Pertumbuhan laba',
};

export type MetricUnit = 'rupiah' | 'multiple' | 'percent' | 'rupiahPerShare';

export const METRIC_UNIT: Record<FundamentalMetric, MetricUnit> = {
  marketCap: 'rupiah',
  per: 'multiple',
  forwardPer: 'multiple',
  pbv: 'multiple',
  eps: 'rupiahPerShare',
  forwardEps: 'rupiahPerShare',
  dividendYield: 'percent',
  revenue: 'rupiah',
  netIncome: 'rupiah',
  netMargin: 'percent',
  roe: 'percent',
  totalDebt: 'rupiah',
  debtToEquity: 'multiple',
  revenueGrowth: 'percent',
  earningsGrowth: 'percent',
};

export const METRIC_GROUPS: Array<{ title: string; metrics: FundamentalMetric[] }> = [
  {
    title: 'Valuasi',
    metrics: ['marketCap', 'per', 'forwardPer', 'pbv', 'eps', 'forwardEps', 'dividendYield'],
  },
  { title: 'Profitabilitas', metrics: ['revenue', 'netIncome', 'netMargin', 'roe'] },
  { title: 'Utang', metrics: ['totalDebt', 'debtToEquity'] },
  { title: 'Pertumbuhan', metrics: ['revenueGrowth', 'earningsGrowth'] },
];
