/**
 * News as data, never as narrative. An article is a headline with a source, a time and a
 * link; Indonesian Stock Bot attaches the tickers it is about and the corporate-action events its title names. There
 * is deliberately no sentiment field: no deterministic method available here can justify one, and the
 * language model is never asked to invent one (see docs/news.md).
 */
export const NEWS_EVENTS = [
  'dividend',
  'rups',
  'right_issue',
  'stock_split',
  'suspension',
  'uma',
  'earnings',
  'acquisition',
  'ipo',
  'buyback',
  'bond',
  'management',
] as const;

export type NewsEvent = (typeof NEWS_EVENTS)[number];

export const EVENT_LABEL: Record<NewsEvent, string> = {
  dividend: 'dividen',
  rups: 'RUPS',
  right_issue: 'right issue',
  stock_split: 'stock split',
  suspension: 'suspensi',
  uma: 'UMA',
  earnings: 'kinerja/laporan keuangan',
  acquisition: 'akuisisi/merger',
  ipo: 'IPO/pencatatan',
  buyback: 'buyback',
  bond: 'obligasi',
  management: 'manajemen',
};

/** 'direct' = the provider or the headline names the stock; 'related' = returned for it without naming it. */
export type NewsRelevance = 'direct' | 'related';

/** What a news provider returns: nothing interpreted yet. */
export interface RawNewsItem {
  /** Provider-stable id (used for de-duplication across fetches). */
  id: string;
  title: string;
  publisher: string;
  url: string | null;
  publishedAt: Date;
  /** Tickers the provider associates with the item, already in IDX form (no ".JK"). */
  relatedTickers: string[];
}

export interface NewsArticle {
  externalId: string;
  title: string;
  source: string;
  url: string | null;
  publishedAt: Date;
  symbols: string[];
  events: NewsEvent[];
  relevance: NewsRelevance;
}

export interface NewsReport {
  symbol: string;
  articles: NewsArticle[];
  /** True when the provider was unavailable and the articles come from Indonesian Stock Bot's archive. */
  fromArchive: boolean;
  /** Set when neither the provider nor the archive has anything, with the provider's reason. */
  unavailableReason?: string;
  maxAgeDays: number;
  fetchedAt: Date;
}
