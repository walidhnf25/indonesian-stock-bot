import { Injectable } from '@nestjs/common';
import { TtlCache } from '../common/cache/ttl-cache';
import { InvalidTickerError, UserFacingError } from '../common/exceptions/app-errors';
import { referenceCloseFromCandles } from '../market/data-quality';
import { DataQualityService } from '../market/data-quality.service';
import { StockService } from '../stock/stock.service';
import { DailyCandle, DataResult, NormalizedQuote, Unavailable } from '../stock/stock.types';
import { FullTechnicalReport, TechnicalAnalysis } from './analysis.types';
import { MIN_CANDLES, computeTechnical } from './technical';

export const PROVIDER_DOWN_MESSAGE =
  'Data saham sedang tidak dapat diambil dari provider dan belum ada data tersimpan. Coba lagi beberapa saat lagi.';

export function unavailableToError(symbol: string, r: Unavailable): UserFacingError {
  if (r.code === 'NOT_FOUND') return new InvalidTickerError(symbol);
  if (r.code === 'QUOTA') {
    const wait = r.retryAfterSeconds
      ? ` Coba lagi dalam ${r.retryAfterSeconds} detik.`
      : ' Coba lagi sebentar.';
    return new UserFacingError(
      `Kamu meminta terlalu banyak data baru dalam waktu singkat.${wait}`,
      'RATE_LIMITED',
    );
  }
  if (r.code === 'BUSY') {
    return new UserFacingError(
      'Layanan data pasar sedang dibatasi agar tetap tersedia untuk semua orang, dan belum ada data tersimpan untuk ini. Coba lagi beberapa saat lagi.',
      'RATE_LIMITED',
    );
  }
  if (r.code === 'RATE_LIMITED') {
    return new UserFacingError(
      'Provider data sedang membatasi permintaan. Coba lagi dalam beberapa saat.',
      'RATE_LIMITED',
    );
  }
  return new UserFacingError(PROVIDER_DOWN_MESSAGE, 'PROVIDER_DOWN');
}

@Injectable()
export class AnalysisService {
  private readonly cache = new TtlCache<FullTechnicalReport>(60_000, 200);

  constructor(
    private readonly stocks: StockService,
    private readonly quality: DataQualityService,
  ) {}

  /** Quote + history + deterministic indicators. Throws UserFacingError on failure. */
  async getReport(symbol: string): Promise<FullTechnicalReport> {
    const hit = this.cache.get(symbol);
    if (hit) return hit.value;

    const [quoteRes, historyRes] = await Promise.all([
      this.stocks.getQuote(symbol),
      this.stocks.getHistory(symbol, '1y'),
    ]);
    const report = this.build(symbol, quoteRes, historyRes);
    this.cache.set(symbol, report);
    return report;
  }

  /** Same as getReport but returns null instead of throwing (batch/screening use). */
  async tryGetReport(symbol: string): Promise<FullTechnicalReport | null> {
    try {
      return await this.getReport(symbol);
    } catch {
      return null;
    }
  }

  async getTechnical(symbol: string): Promise<TechnicalAnalysis> {
    return (await this.getReport(symbol)).technical;
  }

  private build(
    symbol: string,
    quoteRes: DataResult<NormalizedQuote>,
    historyRes: DataResult<DailyCandle[]>,
  ): FullTechnicalReport {
    if (!quoteRes.available) throw unavailableToError(symbol, quoteRes);
    if (!historyRes.available) throw unavailableToError(symbol, historyRes);
    if (historyRes.data.length < MIN_CANDLES) {
      throw new UserFacingError(
        `Riwayat harga ${symbol} baru ${historyRes.data.length} hari — terlalu pendek untuk analisis teknikal (minimal ${MIN_CANDLES} hari).`,
        'INSUFFICIENT_HISTORY',
      );
    }
    // Previous session's close from the stored daily candles (aligned with the quote's session). It
    // is both the fallback when the provider has no previousClose and an independent cross-check of it.
    const candles = historyRes.data;
    const referenceClose = referenceCloseFromCandles(candles, quoteRes.data.timestamp);
    const plausibility = this.quality.plausibilityOf(quoteRes.data, referenceClose);
    return {
      symbol,
      quote: quoteRes.data,
      quoteSource: quoteRes.source,
      quoteStale: quoteRes.stale,
      quoteFetchedAt: quoteRes.fetchedAt,
      freshness: this.quality.freshnessOf(quoteRes.data, { stale: quoteRes.stale }),
      plausibility,
      // Classify against the live price only when the quote is trusted (see ComputeOptions.price).
      technical: computeTechnical(
        symbol,
        historyRes.data,
        plausibility.quality === 'trusted' ? { price: quoteRes.data.price } : {},
      ),
      candles: historyRes.data,
      historyStale: historyRes.stale,
    };
  }
}
