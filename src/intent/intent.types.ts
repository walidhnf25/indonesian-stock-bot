export const INTENTS = [
  'STOCK_QUOTE',
  'STOCK_TECHNICAL',
  'STOCK_ANALYSIS',
  'STOCK_COMPARISON',
  'STOCK_QUESTION',
  'STOCK_HISTORICAL',
  'STOCK_ADVICE',
  'STOCK_SCREEN',
  'FOREIGN_FLOW',
  'BROKER_SUMMARY',
  'FUNDAMENTALS',
  'STOCK_NEWS',
  'WATCHLIST_ADD',
  'WATCHLIST_REMOVE',
  'WATCHLIST_LIST',
  'ALERT_CREATE',
  'ALERT_LIST',
  'ALERT_DELETE',
  'ALERT_PAUSE',
  'ALERT_RESUME',
  'PORTFOLIO_RECORD',
  'PORTFOLIO_VIEW',
  'PORTFOLIO_HISTORY',
  'PORTFOLIO_UNDO',
  'PORTFOLIO_SUMMARY',
  'CONTEXT_RECALL',
  'CONTEXT_CLEAR',
  'PREFERENCE_VIEW',
  'PREFERENCE_SET',
  'PREFERENCE_CLEAR',
  'DATA_DELETE',
  'NOTE_ADD',
  'NOTE_LIST',
  'NOTE_DELETE',
  'NOTE_SEARCH',
  'MARKET_STATUS',
  'SMALL_TALK',
  'GENERAL_QUESTION',
  'HELP',
  'UNKNOWN',
] as const;

export type IntentName = (typeof INTENTS)[number];

/** 'ma' = MA20/MA50 crossover (above = golden cross, below = death cross); it has no threshold. */
export type AlertMetric = 'price' | 'rsi' | 'volume' | 'ma';
export type AlertCondition = 'above' | 'below';

export interface AlertParameters {
  metric?: AlertMetric;
  condition?: AlertCondition;
  value?: number;
}

export type PortfolioTxKind = 'BUY' | 'SELL' | 'DIVIDEND' | 'DEPOSIT' | 'WITHDRAWAL';

export interface PortfolioParameters {
  txType: PortfolioTxKind;
  /** Shares (lots are converted by the parser: 1 lot = 100 shares). */
  quantity?: number;
  /** Price per share. */
  price?: number;
  fees?: number;
  /** Cash amount for DIVIDEND/DEPOSIT/WITHDRAWAL. */
  amount?: number;
}

export interface AlertDeleteParameters {
  /** 1-based position in the user's alert list. */
  index?: number;
  all?: boolean;
}

export interface NumericRange {
  gt?: number;
  lt?: number;
}

export interface ScreenCriteria {
  changePercent?: NumericRange;
  volumeRatio?: NumericRange;
  rsi?: NumericRange;
  priceAboveMa?: 20 | 50 | 200;
  priceBelowMa?: 20 | 50 | 200;
  momentum?: 'positive' | 'negative';
  sort?: 'changePercent_desc' | 'changePercent_asc' | 'volumeRatio_desc' | 'rsi_asc' | 'rsi_desc';
}

export type TechnicalTopic =
  'rsi' | 'macd' | 'ma' | 'bollinger' | 'atr' | 'volume' | 'support' | 'resistance';

export interface ParsedIntent {
  intent: IntentName;
  symbols: string[];
  parameters: Record<string, unknown>;
  /** 'high' = unambiguous deterministic match; 'low' = guessed. */
  confidence: 'high' | 'low';
  source: 'rules' | 'context' | 'ai';
  /** Original (trimmed) user text; used for AI questions. */
  text: string;
  /** Non-null when required parameters are missing and the user should be asked. */
  clarification?: string;
  /** AI classification bookkeeping, for logs. */
  ai?: { skipped?: 'quota' | 'busy' | 'unavailable' | 'failed' | 'empty'; ms?: number };
}

/** One remembered lookup: which tickers, what kind of request, when. Never the message text. */
export interface ConversationTurn {
  symbols: string[];
  intent: IntentName;
  at: string;
}

export interface ConversationState {
  lastSymbols: string[];
  lastIntent?: IntentName;
  /** Prior alert-creation draft waiting for missing info is intentionally not kept (keep memory small). */
  updatedAt: string;
  /** The last few lookups in this chat, newest first (bounded, see MAX_RECENT_TURNS). */
  recent?: ConversationTurn[];
  /** A pending "hapus data saya" request, valid until this ISO time. */
  deletionRequestedUntil?: string;
}

/** What kind of advice-style question was asked (answered with a fixed policy message, never by AI). */
export type AdviceKind = 'trade' | 'target_price' | 'prediction' | 'guarantee';

export type SmallTalkKind = 'greeting' | 'thanks' | 'ack';

/** Time reference found in a message. A reference to another time is never treated as "now". */
export type TemporalRef =
  | { kind: 'date'; date: string; label: string; relative: boolean }
  /** The last (offset 0) or previous (offset -1) trading session, resolved against the real candles. */
  | { kind: 'session'; offset: 0 | -1; label: string }
  | { kind: 'future'; label: string }
  | { kind: 'invalid'; label: string }
  /** A time reference that daily closes cannot answer (time of day, or a whole period). */
  | { kind: 'unsupported'; reason: 'intraday' | 'period' | 'incomplete'; label: string };
