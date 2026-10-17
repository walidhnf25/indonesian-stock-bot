import { Freshness, Plausibility } from '../market/data-quality';
import { DailyCandle, NormalizedQuote } from '../stock/stock.types';

export type Trend = 'BULLISH' | 'NEUTRAL' | 'BEARISH';
export type MomentumStrength = 'STRONG' | 'MODERATE' | 'WEAK';
export type MomentumBias = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
export type RsiZone = 'OVERBOUGHT' | 'NEUTRAL' | 'OVERSOLD';
export type LevelStrength = 'weak' | 'medium' | 'strong';

export interface PriceLevel {
  price: number;
  strength: LevelStrength;
  touches: number;
}

export interface TechnicalSnapshot {
  asOf: string; // date of the last candle used
  price: number; // last close used for indicator values
  sma5: number | null;
  sma20: number | null;
  sma50: number | null;
  sma100: number | null;
  sma200: number | null;
  ema12: number | null;
  ema26: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  bollingerUpper: number | null;
  bollingerMiddle: number | null;
  bollingerLower: number | null;
  atr14: number | null;
  volumeSma20: number | null;
  volumeRatio: number | null;
}

export interface TechnicalClassification {
  trend: Trend;
  /** Human-readable signals that produced the trend (for transparency). */
  trendSignals: string[];
  momentum: { strength: MomentumStrength; bias: MomentumBias };
  rsiZone: RsiZone | null;
  macdState: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null;
}

export interface TechnicalAnalysis {
  symbol: string;
  snapshot: TechnicalSnapshot;
  classification: TechnicalClassification;
  support: PriceLevel[];
  resistance: PriceLevel[];
  candleCount: number;
  /** Number of daily candles was lower than required for some indicators. */
  limitedHistory: boolean;
}

export interface FullTechnicalReport {
  symbol: string;
  quote: NormalizedQuote;
  quoteSource: string;
  quoteStale: boolean;
  quoteFetchedAt: string;
  /** LIVE / DELAYED / STALE / UNKNOWN classification of the quote. */
  freshness: Freshness;
  /** Sanity check of the quote (anomalous prices must not drive alerts or be shown as normal). */
  plausibility: Plausibility;
  technical: TechnicalAnalysis;
  candles: DailyCandle[];
  historyStale: boolean;
}
