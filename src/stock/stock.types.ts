/** Provider-independent normalized market data. */

export interface NormalizedQuote {
  symbol: string;
  name: string | null;
  price: number;
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  volume: number | null;
  averageVolume: number | null;
  /** ISO timestamp of the provider's last trade/market time. */
  timestamp: string;
  currency: string;
  marketState: string | null;
  /** Minutes the provider says the data is delayed, if known. */
  delayMinutes: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
}

export interface DailyCandle {
  /** ISO date (YYYY-MM-DD) in exchange local time. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CompanyProfile {
  symbol: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  website: string | null;
  summary: string | null;
}

/**
 * Raw provider fundamentals. The first eight fields are what every provider must answer (null when
 * unknown); the rest are optional inputs and figures a richer provider can add. Percent-type values
 * (roe, dividendYield, netMargin, growth) are percentages, not fractions. Provenance (reported /
 * estimated / derived / stale / missing) is attached later by the fundamentals service.
 */
export interface Fundamentals {
  marketCap: number | null;
  per: number | null;
  pbv: number | null;
  roe: number | null;
  eps: number | null;
  dividendYield: number | null;
  revenue: number | null;
  netIncome: number | null;
  /** Analyst forward figures (estimates by definition). */
  forwardPer?: number | null;
  forwardEps?: number | null;
  /** Inputs for derivations. */
  bookValuePerShare?: number | null;
  dividendRate?: number | null;
  totalEquity?: number | null;
  /** Further reported figures. */
  netMargin?: number | null;
  totalDebt?: number | null;
  debtToEquity?: number | null;
  revenueGrowth?: number | null;
  earningsGrowth?: number | null;
}

export interface ForeignFlow {
  foreignBuy: number;
  foreignSell: number;
  netForeign: number;
  asOf: string;
}

export interface BrokerSummary {
  asOf: string;
  topBuyers: Array<{ broker: string; value: number }>;
  topSellers: Array<{ broker: string; value: number }>;
}

export interface StockSearchResult {
  symbol: string;
  name: string | null;
}

/**
 * NOT_FOUND / UNSUPPORTED / RATE_LIMITED / ERROR come from the provider. QUOTA and BUSY come from our own
 * governance: QUOTA = this user asked for too much new data; BUSY = the shared provider capacity,
 * hourly budget or circuit breaker says "not now". Neither is retried and neither reached the provider.
 */
export type UnavailableCode =
  'NOT_FOUND' | 'UNSUPPORTED' | 'RATE_LIMITED' | 'ERROR' | 'QUOTA' | 'BUSY';

export interface Unavailable {
  available: false;
  reason: string;
  code: UnavailableCode;
  /** For QUOTA/BUSY: when it is worth trying again. */
  retryAfterSeconds?: number;
}

export interface Available<T> {
  available: true;
  data: T;
  source: string;
  /** When we fetched/stored this payload. */
  fetchedAt: string;
  /** True when served from last-known stored data because the provider failed. */
  stale: boolean;
}

export type DataResult<T> = Available<T> | Unavailable;

export type HistoryRange = '1mo' | '3mo' | '6mo' | '1y' | '2y';

export interface HistoryOptions {
  range?: HistoryRange;
}

export const UNSUPPORTED_MESSAGE = 'Data ini belum tersedia dari provider saat ini.';

export function unavailable(
  reason: string,
  code: UnavailableCode = 'ERROR',
  retryAfterSeconds?: number,
): Unavailable {
  return retryAfterSeconds === undefined
    ? { available: false, reason, code }
    : { available: false, reason, code, retryAfterSeconds };
}

export function available<T>(
  data: T,
  source: string,
  stale = false,
  fetchedAt = new Date(),
): Available<T> {
  return { available: true, data, source, fetchedAt: fetchedAt.toISOString(), stale };
}
