import { jakartaParts } from '../../common/utils/format';
import { cleanCompanyName } from '../../common/utils/text';
import { fromYahooSymbol } from '../../common/utils/ticker';
import { CompanyProfile, DailyCandle, Fundamentals, NormalizedQuote } from '../stock.types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function toIso(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  if (typeof v === 'number') return new Date(v > 1e11 ? v : v * 1000).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

/** Converts a Yahoo `quote()` payload into the internal NormalizedQuote. Returns null if unusable. */
export function normalizeYahooQuote(raw: any): NormalizedQuote | null {
  if (!raw || typeof raw !== 'object') return null;
  const price = num(raw.regularMarketPrice);
  const timestamp = toIso(raw.regularMarketTime);
  if (price === null || price <= 0 || !timestamp) return null;

  const previousClose = num(raw.regularMarketPreviousClose);
  let change = num(raw.regularMarketChange);
  let changePercent = num(raw.regularMarketChangePercent);
  if (change === null && previousClose) change = price - previousClose;
  if (changePercent === null && previousClose)
    changePercent = ((price - previousClose) / previousClose) * 100;

  return {
    symbol: fromYahooSymbol(String(raw.symbol ?? '')),
    name: cleanCompanyName(raw.longName) ?? cleanCompanyName(raw.shortName),
    price,
    change,
    changePercent,
    open: num(raw.regularMarketOpen),
    high: num(raw.regularMarketDayHigh),
    low: num(raw.regularMarketDayLow),
    previousClose,
    volume: num(raw.regularMarketVolume),
    averageVolume: num(raw.averageDailyVolume3Month) ?? num(raw.averageDailyVolume10Day),
    timestamp,
    currency: str(raw.currency) ?? 'IDR',
    marketState: str(raw.marketState),
    delayMinutes: num(raw.exchangeDataDelayedBy),
    fiftyTwoWeekHigh: num(raw.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: num(raw.fiftyTwoWeekLow),
  };
}

/**
 * Converts Yahoo chart quotes into validated daily candles (ascending by date).
 * Rows with null/NaN/non-positive OHLC or impossible high/low are dropped.
 */
export function normalizeYahooCandles(rawQuotes: any[]): DailyCandle[] {
  const byDate = new Map<string, DailyCandle>();
  for (const q of rawQuotes ?? []) {
    const open = num(q?.open);
    const high = num(q?.high);
    const low = num(q?.low);
    const close = num(q?.close);
    // missing or negative volume cannot be trusted; 0 (not a negative number) keeps the averages sane
    const rawVolume = num(q?.volume);
    const volume = rawVolume !== null && rawVolume >= 0 ? rawVolume : 0;
    const when = q?.date instanceof Date ? q.date : new Date(q?.date);
    if (open === null || high === null || low === null || close === null) continue;
    if (Number.isNaN(when.getTime())) continue;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
    if (high < low || high < Math.max(open, close) - 1e-9 || low > Math.min(open, close) + 1e-9)
      continue;
    const date = jakartaParts(when).isoDate;
    byDate.set(date, { date, open, high, low, close, volume });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function normalizeYahooFundamentals(summary: any, quote: any): Fundamentals {
  const pct = (v: unknown) => (num(v) === null ? null : (v as number) * 100);
  return {
    marketCap: num(quote?.marketCap) ?? num(summary?.summaryDetail?.marketCap),
    per: num(quote?.trailingPE) ?? num(summary?.summaryDetail?.trailingPE),
    pbv: num(quote?.priceToBook) ?? num(summary?.defaultKeyStatistics?.priceToBook),
    roe: pct(summary?.financialData?.returnOnEquity),
    eps: num(quote?.epsTrailingTwelveMonths) ?? num(summary?.defaultKeyStatistics?.trailingEps),
    // quote().dividendYield is already a percentage; summaryDetail.dividendYield is a fraction.
    dividendYield: num(quote?.dividendYield) ?? pct(summary?.summaryDetail?.dividendYield),
    revenue: num(summary?.financialData?.totalRevenue),
    netIncome: num(summary?.defaultKeyStatistics?.netIncomeToCommon),
    // Estimates, derivation inputs and further reported figures (all optional)
    forwardPer: num(quote?.forwardPE) ?? num(summary?.summaryDetail?.forwardPE),
    forwardEps: num(quote?.epsForward) ?? num(summary?.defaultKeyStatistics?.forwardEps),
    bookValuePerShare: num(quote?.bookValue) ?? num(summary?.defaultKeyStatistics?.bookValue),
    dividendRate: num(quote?.dividendRate) ?? num(summary?.summaryDetail?.dividendRate),
    totalEquity: null, // not in these modules; D/E and ROE come reported from financialData instead
    netMargin: pct(summary?.financialData?.profitMargins),
    totalDebt: num(summary?.financialData?.totalDebt),
    // Yahoo reports debtToEquity as a percentage (e.g. 85.3); Indonesian Stock Bot shows it as a multiple
    debtToEquity:
      num(summary?.financialData?.debtToEquity) === null
        ? null
        : (summary.financialData.debtToEquity as number) / 100,
    revenueGrowth: pct(summary?.financialData?.revenueGrowth),
    earningsGrowth: pct(summary?.financialData?.earningsGrowth),
  };
}

export function normalizeYahooProfile(symbol: string, summary: any, quote: any): CompanyProfile {
  return {
    symbol,
    name:
      cleanCompanyName(quote?.longName) ??
      cleanCompanyName(quote?.shortName) ??
      cleanCompanyName(summary?.price?.longName),
    sector: str(summary?.assetProfile?.sector),
    industry: str(summary?.assetProfile?.industry),
    website: str(summary?.assetProfile?.website),
    summary: str(summary?.assetProfile?.longBusinessSummary),
  };
}
