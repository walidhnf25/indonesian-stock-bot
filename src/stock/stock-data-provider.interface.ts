import {
  BrokerSummary,
  CompanyProfile,
  DailyCandle,
  ForeignFlow,
  Fundamentals,
  HistoryOptions,
  NormalizedQuote,
  StockSearchResult,
  Unavailable,
} from './stock.types';

/** Raw (non-cached) result a provider returns. Services wrap it with metadata. */
export type ProviderResult<T> = { available: true; data: T } | Unavailable;

/**
 * Contract every market-data provider implements. Methods the provider cannot serve must
 * return `{ available: false, ... }` rather than throwing or fabricating data.
 */
export interface StockDataProvider {
  readonly name: string;

  getQuote(symbol: string): Promise<ProviderResult<NormalizedQuote>>;
  getQuotes(symbols: string[]): Promise<Map<string, NormalizedQuote>>;
  getHistoricalPrices(
    symbol: string,
    options?: HistoryOptions,
  ): Promise<ProviderResult<DailyCandle[]>>;
  getCompanyProfile(symbol: string): Promise<ProviderResult<CompanyProfile>>;
  getFundamentals(symbol: string): Promise<ProviderResult<Fundamentals>>;
  getForeignFlow(symbol: string): Promise<ProviderResult<ForeignFlow>>;
  getBrokerSummary(symbol: string): Promise<ProviderResult<BrokerSummary>>;
  searchStocks(query: string): Promise<ProviderResult<StockSearchResult[]>>;
  /** Composite index (IHSG) quote, if supported. */
  getIndexQuote(): Promise<ProviderResult<NormalizedQuote>>;
  /** Cheap liveness probe used by /health. */
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

export const STOCK_DATA_PROVIDER = Symbol('STOCK_DATA_PROVIDER');
