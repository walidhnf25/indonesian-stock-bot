import { ProviderResult } from '../stock/stock-data-provider.interface';
import { RawNewsItem } from './news.types';

/**
 * A source of headlines for one stock. Business logic never talks to a news vendor directly: it goes
 * through StockService (existence gate, quotas, breaker, cache, fetch log) and then this interface, so a
 * second provider (an Indonesian news API, RSS, …) only has to implement `getNews`.
 */
export interface NewsProvider {
  readonly name: string;
  getNews(symbol: string, limit: number): Promise<ProviderResult<RawNewsItem[]>>;
}

export const NEWS_PROVIDER = Symbol('NEWS_PROVIDER');

/** The provider used when no news source is configured: every request is honestly unsupported. */
export class NullNewsProvider implements NewsProvider {
  readonly name = 'none';
  getNews(): Promise<ProviderResult<RawNewsItem[]>> {
    return Promise.resolve({
      available: false,
      reason: 'Tidak ada penyedia berita yang dikonfigurasi.',
      code: 'UNSUPPORTED',
    });
  }
}
