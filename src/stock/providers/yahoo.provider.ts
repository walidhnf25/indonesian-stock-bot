import { Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';
import { createYahooClient } from './yahoo-client';
import { fromYahooSymbol, toYahooSymbol } from '../../common/utils/ticker';
import { safeErrorMessage } from '../../common/utils/scrub';
import { cleanCompanyName } from '../../common/utils/text';
import { ProviderResult, StockDataProvider } from '../stock-data-provider.interface';
import {
  BrokerSummary,
  CompanyProfile,
  DailyCandle,
  ForeignFlow,
  Fundamentals,
  HistoryOptions,
  HistoryRange,
  NormalizedQuote,
  StockSearchResult,
  UNSUPPORTED_MESSAGE,
  unavailable,
} from '../stock.types';
import {
  normalizeYahooCandles,
  normalizeYahooFundamentals,
  normalizeYahooProfile,
  normalizeYahooQuote,
} from './yahoo-normalizer';

/* eslint-disable @typescript-eslint/no-explicit-any */

const RANGE_DAYS: Record<HistoryRange, number> = {
  '1mo': 31,
  '3mo': 93,
  '6mo': 186,
  '1y': 366,
  '2y': 732,
};

const IHSG_SYMBOL = '^JKSE';

export function classifyYahooError(error: unknown): {
  code: 'RATE_LIMITED' | 'ERROR';
  reason: string;
} {
  const msg = error instanceof Error ? error.message : String(error);
  if (/too many requests|429|rate limit/i.test(msg)) {
    return {
      code: 'RATE_LIMITED',
      reason: 'Provider data membatasi jumlah permintaan (rate limit).',
    };
  }
  return { code: 'ERROR', reason: 'Provider data sedang tidak dapat dihubungi.' };
}

/**
 * Yahoo Finance provider (via the community `yahoo-finance2` library).
 * Unofficial and free: IDX data is delayed (~10 min). Foreign flow and broker summary
 * are not offered by Yahoo and are reported as unavailable.
 */
@Injectable()
export class YahooProvider implements StockDataProvider {
  readonly name = 'yahoo-finance';
  private readonly logger = new Logger(YahooProvider.name);
  private readonly yf: any;

  constructor(@Optional() config?: AppConfig) {
    this.yf = createYahooClient(config);
  }

  async getQuote(symbol: string): Promise<ProviderResult<NormalizedQuote>> {
    try {
      const raw = await this.yf.quote(toYahooSymbol(symbol));
      const quote = normalizeYahooQuote(raw);
      if (!quote) return unavailable(`Ticker ${symbol} tidak ditemukan.`, 'NOT_FOUND');
      quote.symbol = symbol;
      return { available: true, data: quote };
    } catch (error) {
      return this.fail('quote', symbol, error);
    }
  }

  async getQuotes(symbols: string[]): Promise<Map<string, NormalizedQuote>> {
    const out = new Map<string, NormalizedQuote>();
    if (symbols.length === 0) return out;
    try {
      const raws = await this.yf.quote(symbols.map(toYahooSymbol), {}, { validateResult: false });
      for (const raw of Array.isArray(raws) ? raws : [raws]) {
        const q = normalizeYahooQuote(raw);
        if (q) out.set(q.symbol, q);
      }
    } catch (error) {
      this.logger.warn(`batch quote failed: ${safeErrorMessage(error)}`);
    }
    return out;
  }

  async getHistoricalPrices(
    symbol: string,
    options: HistoryOptions = {},
  ): Promise<ProviderResult<DailyCandle[]>> {
    const range = options.range ?? '1y';
    try {
      const period1 = new Date(Date.now() - RANGE_DAYS[range] * 86_400_000);
      const chart = await this.yf.chart(toYahooSymbol(symbol), { period1, interval: '1d' });
      const candles = normalizeYahooCandles(chart?.quotes ?? []);
      if (candles.length === 0) {
        return unavailable(`Data historis ${symbol} tidak tersedia.`, 'NOT_FOUND');
      }
      return { available: true, data: candles };
    } catch (error) {
      return this.fail('history', symbol, error);
    }
  }

  async getCompanyProfile(symbol: string): Promise<ProviderResult<CompanyProfile>> {
    try {
      const [summary, quote] = await Promise.all([
        this.yf.quoteSummary(
          toYahooSymbol(symbol),
          { modules: ['assetProfile', 'price'] },
          { validateResult: false },
        ),
        this.yf.quote(toYahooSymbol(symbol), {}, { validateResult: false }),
      ]);
      return { available: true, data: normalizeYahooProfile(symbol, summary, quote) };
    } catch (error) {
      return this.fail('profile', symbol, error);
    }
  }

  async getFundamentals(symbol: string): Promise<ProviderResult<Fundamentals>> {
    try {
      const [summary, quote] = await Promise.all([
        this.yf.quoteSummary(
          toYahooSymbol(symbol),
          { modules: ['summaryDetail', 'defaultKeyStatistics', 'financialData'] },
          { validateResult: false },
        ),
        this.yf.quote(toYahooSymbol(symbol), {}, { validateResult: false }),
      ]);
      const f = normalizeYahooFundamentals(summary, quote);
      if (Object.values(f).every((v) => v === null)) {
        return unavailable('Data fundamental tidak tersedia dari provider.', 'NOT_FOUND');
      }
      return { available: true, data: f };
    } catch (error) {
      return this.fail('fundamentals', symbol, error);
    }
  }

  getForeignFlow(): Promise<ProviderResult<ForeignFlow>> {
    return Promise.resolve(
      unavailable(
        `Data foreign flow tidak tersedia dari provider saat ini. ${UNSUPPORTED_MESSAGE}`,
        'UNSUPPORTED',
      ),
    );
  }

  getBrokerSummary(): Promise<ProviderResult<BrokerSummary>> {
    return Promise.resolve(
      unavailable(
        `Data broker summary tidak tersedia dari provider saat ini. ${UNSUPPORTED_MESSAGE}`,
        'UNSUPPORTED',
      ),
    );
  }

  async searchStocks(query: string): Promise<ProviderResult<StockSearchResult[]>> {
    try {
      const res = await this.yf.search(
        query,
        { quotesCount: 10, newsCount: 0 },
        { validateResult: false },
      );
      const results: StockSearchResult[] = (res?.quotes ?? [])
        .filter((q: any) => typeof q?.symbol === 'string' && q.symbol.endsWith('.JK'))
        .map((q: any) => ({
          symbol: fromYahooSymbol(q.symbol),
          name: cleanCompanyName(q.longname) ?? cleanCompanyName(q.shortname),
        }));
      return { available: true, data: results };
    } catch (error) {
      return this.fail('search', query, error);
    }
  }

  async getIndexQuote(): Promise<ProviderResult<NormalizedQuote>> {
    try {
      const raw = await this.yf.quote(IHSG_SYMBOL, {}, { validateResult: false });
      const q = normalizeYahooQuote(raw);
      if (!q) return unavailable('Data IHSG tidak tersedia.', 'NOT_FOUND');
      q.symbol = 'IHSG';
      return { available: true, data: q };
    } catch (error) {
      return this.fail('index', IHSG_SYMBOL, error);
    }
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const r = await this.getIndexQuote();
    return r.available ? { ok: true } : { ok: false, detail: r.reason };
  }

  private fail(op: string, subject: string, error: unknown): ProviderResult<never> {
    const { code, reason } = classifyYahooError(error);
    this.logger.warn(`yahoo ${op} ${subject} failed: ${safeErrorMessage(error)}`);
    return unavailable(reason, code);
  }
}
