import { Injectable } from '@nestjs/common';
import { AnalysisService } from '../analysis/analysis.service';
import { Trend } from '../analysis/analysis.types';
import { mapLimit } from '../common/utils/async';
import { AppConfig } from '../config/app-config.service';
import { IDX_UNIVERSE } from '../intent/parsers/idx-universe';
import { NumericRange, ScreenCriteria } from '../intent/intent.types';
import { Freshness } from '../market/data-quality';
import { DataQualityService } from '../market/data-quality.service';
import { StockService } from '../stock/stock.service';
import { NormalizedQuote } from '../stock/stock.types';

export const MAX_INDICATOR_SCAN = 60;
export const MAX_RESULTS = 10;

export interface ScreenRow {
  symbol: string;
  name: string | null;
  price: number;
  changePercent: number | null;
  /** Today's volume / provider 3-month average daily volume. */
  volumeRatio: number | null;
  rsi: number | null;
  trend: Trend | null;
}

export interface ScreenResult {
  rows: ScreenRow[];
  criteriaText: string[];
  universeSize: number;
  quotedCount: number;
  /** How many candidates had indicators computed (null when no indicator criteria). */
  indicatorScanned: number | null;
  indicatorCapped: boolean;
  asOf: string | null;
  anyStale: boolean;
  /** Freshness of the newest quote in the scan (feed liveness), null when nothing was quoted. */
  freshness: Freshness | null;
}

const inRange = (v: number | null, r?: NumericRange): boolean => {
  if (!r) return true;
  if (v === null || !Number.isFinite(v)) return false;
  if (r.gt !== undefined && !(v > r.gt)) return false;
  if (r.lt !== undefined && !(v < r.lt)) return false;
  return true;
};

export function describeCriteria(c: ScreenCriteria): string[] {
  const out: string[] = [];
  const range = (label: string, r: NumericRange | undefined, unit = '') => {
    if (!r) return;
    if (r.gt !== undefined) out.push(`${label} > ${r.gt}${unit}`);
    if (r.lt !== undefined) out.push(`${label} < ${r.lt}${unit}`);
  };
  range('Perubahan harian', c.changePercent, '%');
  range('Rasio volume (vs rata-rata 3 bulan)', c.volumeRatio, 'x');
  range('RSI(14)', c.rsi);
  if (c.priceAboveMa) out.push(`Harga di atas MA${c.priceAboveMa}`);
  if (c.priceBelowMa) out.push(`Harga di bawah MA${c.priceBelowMa}`);
  if (c.momentum === 'positive')
    out.push('Momentum positif (harga > MA20, histogram MACD > 0, RSI > 50)');
  if (c.momentum === 'negative')
    out.push('Momentum negatif (harga < MA20, histogram MACD < 0, RSI < 50)');
  return out;
}

export function needsIndicators(c: ScreenCriteria): boolean {
  return !!(c.rsi || c.priceAboveMa || c.priceBelowMa || c.momentum);
}

/**
 * Deterministic screener over a configurable ticker universe. The universe is a list of codes
 * (src/intent/parsers/idx-universe.ts + SCREENER_EXTRA_SYMBOLS); data comes from the provider.
 * It is NOT the full IDX and responses must say so.
 */
@Injectable()
export class ScreenerService {
  constructor(
    private readonly stocks: StockService,
    private readonly analysis: AnalysisService,
    private readonly config: AppConfig,
    private readonly quality: DataQualityService,
  ) {}

  get universe(): string[] {
    return [...new Set([...IDX_UNIVERSE, ...this.config.extraScreenerSymbols])];
  }

  async run(criteria: ScreenCriteria): Promise<ScreenResult> {
    const universe = this.universe;
    const quotes = await this.stocks.getQuotes(universe, { fallback: false });

    const entries: Array<{ quote: NormalizedQuote; stale: boolean }> = [];
    for (const symbol of universe) {
      const r = quotes.get(symbol);
      if (r?.available) entries.push({ quote: r.data, stale: r.stale });
    }

    const ratio = (q: NormalizedQuote) =>
      q.volume !== null && q.averageVolume ? q.volume / q.averageVolume : null;

    let candidates = entries.filter(
      ({ quote: q }) =>
        inRange(q.changePercent, criteria.changePercent) && inRange(ratio(q), criteria.volumeRatio),
    );

    const rows: ScreenRow[] = [];
    let indicatorScanned: number | null = null;
    let capped = false;

    if (needsIndicators(criteria)) {
      if (candidates.length > MAX_INDICATOR_SCAN) {
        candidates = candidates.slice(0, MAX_INDICATOR_SCAN);
        capped = true;
      }
      indicatorScanned = candidates.length;
      const reports = await mapLimit(candidates, 4, (c) =>
        this.analysis.tryGetReport(c.quote.symbol),
      );
      candidates.forEach((c, i) => {
        const rep = reports[i];
        if (!rep) return;
        const s = rep.technical.snapshot;
        const price = c.quote.price;
        if (!inRange(s.rsi14, criteria.rsi)) return;
        const ma = (n: 20 | 50 | 200) => (n === 20 ? s.sma20 : n === 50 ? s.sma50 : s.sma200);
        if (criteria.priceAboveMa) {
          const v = ma(criteria.priceAboveMa);
          if (v === null || !(price > v)) return;
        }
        if (criteria.priceBelowMa) {
          const v = ma(criteria.priceBelowMa);
          if (v === null || !(price < v)) return;
        }
        if (criteria.momentum === 'positive') {
          if (!(
            s.sma20 !== null &&
            price > s.sma20 &&
            (s.macdHistogram ?? -1) > 0 &&
            (s.rsi14 ?? 0) > 50
          ))
            return;
        }
        if (criteria.momentum === 'negative') {
          if (!(
            s.sma20 !== null &&
            price < s.sma20 &&
            (s.macdHistogram ?? 1) < 0 &&
            (s.rsi14 ?? 100) < 50
          ))
            return;
        }
        rows.push(this.row(c.quote, ratio(c.quote), s.rsi14, rep.technical.classification.trend));
      });
    } else {
      for (const c of candidates) rows.push(this.row(c.quote, ratio(c.quote), null, null));
    }

    this.sort(rows, criteria.sort ?? 'changePercent_desc');
    const asOf = entries.reduce<string | null>(
      (acc, e) => (!acc || e.quote.timestamp > acc ? e.quote.timestamp : acc),
      null,
    );

    const newest = entries.reduce<(typeof entries)[number] | null>(
      (acc, e) => (!acc || e.quote.timestamp > acc.quote.timestamp ? e : acc),
      null,
    );

    return {
      rows: rows.slice(0, MAX_RESULTS),
      criteriaText: describeCriteria(criteria),
      universeSize: universe.length,
      quotedCount: entries.length,
      indicatorScanned,
      indicatorCapped: capped,
      asOf,
      anyStale: entries.some((e) => e.stale),
      freshness: newest ? this.quality.freshnessOf(newest.quote, { stale: newest.stale }) : null,
    };
  }

  private row(
    q: NormalizedQuote,
    volumeRatio: number | null,
    rsi: number | null,
    trend: Trend | null,
  ): ScreenRow {
    return {
      symbol: q.symbol,
      name: q.name,
      price: q.price,
      changePercent: q.changePercent,
      volumeRatio,
      rsi,
      trend,
    };
  }

  private sort(rows: ScreenRow[], by: NonNullable<ScreenCriteria['sort']>): void {
    const n = (v: number | null, fallback: number) => (v === null ? fallback : v);
    const cmp: Record<typeof by, (a: ScreenRow, b: ScreenRow) => number> = {
      changePercent_desc: (a, b) => n(b.changePercent, -Infinity) - n(a.changePercent, -Infinity),
      changePercent_asc: (a, b) => n(a.changePercent, Infinity) - n(b.changePercent, Infinity),
      volumeRatio_desc: (a, b) => n(b.volumeRatio, -Infinity) - n(a.volumeRatio, -Infinity),
      rsi_asc: (a, b) => n(a.rsi, Infinity) - n(b.rsi, Infinity),
      rsi_desc: (a, b) => n(b.rsi, -Infinity) - n(a.rsi, -Infinity),
    };
    rows.sort(cmp[by]);
  }
}
