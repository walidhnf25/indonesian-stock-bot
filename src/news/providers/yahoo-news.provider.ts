import { Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';
import { createYahooClient } from '../../stock/providers/yahoo-client';
import { safeErrorMessage } from '../../common/utils/scrub';
import { toYahooSymbol } from '../../common/utils/ticker';
import { ProviderResult } from '../../stock/stock-data-provider.interface';
import { unavailable } from '../../stock/stock.types';
import { classifyYahooError } from '../../stock/providers/yahoo.provider';
import { mapRelatedTickers } from '../news-events';
import { NewsProvider } from '../news-provider.interface';
import { RawNewsItem } from '../news.types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Yahoo's search endpoint returns recent headlines for a ticker; Indonesian Stock Bot uses nothing else from it here. */
export function normalizeYahooNews(raw: unknown): RawNewsItem[] {
  const items = (raw as { news?: unknown[] } | null)?.news;
  if (!Array.isArray(items)) return [];
  const out: RawNewsItem[] = [];
  for (const n of items as any[]) {
    if (typeof n?.uuid !== 'string' || typeof n?.title !== 'string') continue;
    const t = n.providerPublishTime;
    const publishedAt =
      t instanceof Date
        ? t
        : typeof t === 'number'
          ? new Date(t * (t < 1e12 ? 1000 : 1))
          : new Date(NaN);
    out.push({
      id: `yahoo:${n.uuid}`,
      title: n.title,
      publisher: typeof n.publisher === 'string' ? n.publisher : '',
      url: typeof n.link === 'string' ? n.link : null,
      publishedAt,
      relatedTickers: mapRelatedTickers(n.relatedTickers),
    });
  }
  return out;
}

@Injectable()
export class YahooNewsProvider implements NewsProvider {
  readonly name = 'yahoo-finance';
  private readonly logger = new Logger(YahooNewsProvider.name);
  private readonly yf: any;

  constructor(@Optional() config?: AppConfig) {
    this.yf = createYahooClient(config);
  }

  async getNews(symbol: string, limit: number): Promise<ProviderResult<RawNewsItem[]>> {
    try {
      const res = await this.yf.search(
        toYahooSymbol(symbol),
        { quotesCount: 0, newsCount: Math.max(1, Math.min(limit, 20)) },
        { validateResult: false },
      );
      return { available: true, data: normalizeYahooNews(res) };
    } catch (error) {
      const { code, reason } = classifyYahooError(error);
      this.logger.warn(`yahoo news ${symbol} failed: ${safeErrorMessage(error)}`);
      return unavailable(reason, code);
    }
  }
}
