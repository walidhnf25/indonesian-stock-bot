import { DailyCandle } from '../stock/stock.types';
import {
  MomentumBias,
  MomentumStrength,
  RsiZone,
  TechnicalAnalysis,
  TechnicalClassification,
  TechnicalSnapshot,
  Trend,
} from './analysis.types';
import { atr } from './indicators/atr';
import { bollinger } from './indicators/bollinger';
import { ema } from './indicators/ema';
import { macd } from './indicators/macd';
import { rsi } from './indicators/rsi';
import { last, sma } from './indicators/sma';
import { volumeRatio, volumeSma } from './indicators/volume';
import { computeSupportResistance } from './support-resistance/support-resistance';

export const MIN_CANDLES = 30;

/**
 * Classification rules (documented, deterministic):
 *
 * TREND — each available signal votes +1 (bullish) or -1 (bearish):
 *   price vs SMA20, price vs SMA50, SMA20 vs SMA50, SMA50 vs SMA200 (if >=200 candles), MACD histogram sign.
 *   score = (bullish - bearish) / signalsAvailable   (fewer than 2 signals available => NEUTRAL)
 *   score >= +0.5 => BULLISH, score <= -0.5 => BEARISH, otherwise NEUTRAL.
 *
 * MOMENTUM — |RSI14 - 50|: >= 15 STRONG, >= 7 MODERATE, otherwise WEAK.
 *   Bias is POSITIVE when RSI > 50 and MACD histogram > 0, NEGATIVE when RSI < 50 and histogram < 0,
 *   otherwise NEUTRAL (mixed signals, or no MACD histogram yet: it needs 34 candles).
 *
 * RSI zone — >= 70 OVERBOUGHT, <= 30 OVERSOLD, otherwise NEUTRAL.
 * These are descriptions of observed data, not predictions.
 */
export function classify(s: TechnicalSnapshot): TechnicalClassification {
  const signals: string[] = [];
  let bull = 0;
  let bear = 0;
  const vote = (cond: boolean | null, bullText: string, bearText: string) => {
    if (cond === null) return;
    if (cond) {
      bull++;
      signals.push(bullText);
    } else {
      bear++;
      signals.push(bearText);
    }
  };
  const cmp = (a: number | null, b: number | null): boolean | null =>
    a === null || b === null || a === b ? null : a > b;

  vote(cmp(s.price, s.sma20), 'Harga di atas MA20', 'Harga di bawah MA20');
  vote(cmp(s.price, s.sma50), 'Harga di atas MA50', 'Harga di bawah MA50');
  vote(cmp(s.sma20, s.sma50), 'MA20 di atas MA50', 'MA20 di bawah MA50');
  vote(cmp(s.sma50, s.sma200), 'MA50 di atas MA200', 'MA50 di bawah MA200');
  vote(
    s.macdHistogram === null || s.macdHistogram === 0 ? null : s.macdHistogram > 0,
    'Histogram MACD positif',
    'Histogram MACD negatif',
  );

  const available = bull + bear;
  // A single vote (very short history) would make the trend +/-100 %: that is not evidence of a trend.
  const score = available < 2 ? 0 : (bull - bear) / available;
  const trend: Trend = score >= 0.5 ? 'BULLISH' : score <= -0.5 ? 'BEARISH' : 'NEUTRAL';

  let strength: MomentumStrength = 'WEAK';
  let bias: MomentumBias = 'NEUTRAL';
  if (s.rsi14 !== null) {
    const dist = Math.abs(s.rsi14 - 50);
    strength = dist >= 15 ? 'STRONG' : dist >= 7 ? 'MODERATE' : 'WEAK';
    const h = s.macdHistogram;
    if (s.rsi14 > 50 && h !== null && h > 0) bias = 'POSITIVE';
    else if (s.rsi14 < 50 && h !== null && h < 0) bias = 'NEGATIVE';
  }

  const rsiZone: RsiZone | null =
    s.rsi14 === null ? null : s.rsi14 >= 70 ? 'OVERBOUGHT' : s.rsi14 <= 30 ? 'OVERSOLD' : 'NEUTRAL';

  const macdState =
    s.macd === null || s.macdSignal === null
      ? null
      : s.macd > s.macdSignal
        ? 'BULLISH'
        : s.macd < s.macdSignal
          ? 'BEARISH'
          : 'NEUTRAL';

  return { trend, trendSignals: signals, momentum: { strength, bias }, rsiZone, macdState };
}

/**
 * Candles the indicators can rely on: finite, positive OHLC with high >= low, non-negative volume,
 * ascending by date, one per date (the last wins). The provider normaliser already guarantees this;
 * repeating it here keeps one corrupt row from turning every moving average into NaN.
 */
export function sanitizeCandles(candles: readonly DailyCandle[]): DailyCandle[] {
  const byDate = new Map<string, DailyCandle>();
  const ok = (v: number) => Number.isFinite(v) && v > 0;
  for (const c of candles) {
    if (!c || typeof c.date !== 'string') continue;
    if (!ok(c.open) || !ok(c.high) || !ok(c.low) || !ok(c.close) || c.high < c.low) continue;
    byDate.set(c.date, {
      ...c,
      volume: Number.isFinite(c.volume) && c.volume >= 0 ? c.volume : 0,
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface ComputeOptions {
  /**
   * Live price to classify against (price vs moving averages, support/resistance distance). Without it
   * the last candle close is used. Passed only for a TRUSTED quote, so a corrupt quote cannot steer the
   * classification, and so the trend and the printed facts compare the same price.
   */
  price?: number;
}

/** Pure function: candles (ascending) -> full technical analysis. */
export function computeTechnical(
  symbol: string,
  rawCandles: DailyCandle[],
  opts: ComputeOptions = {},
): TechnicalAnalysis {
  const candles = sanitizeCandles(rawCandles);
  if (candles.length < MIN_CANDLES) {
    throw new Error(`Insufficient history: ${candles.length} candles (need ${MIN_CANDLES}).`);
  }
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const m = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const lastCandle = candles[candles.length - 1];

  const snapshot: TechnicalSnapshot = {
    asOf: lastCandle.date,
    price: opts.price !== undefined && opts.price > 0 ? opts.price : lastCandle.close,
    sma5: last(sma(closes, 5)),
    sma20: last(sma(closes, 20)),
    sma50: last(sma(closes, 50)),
    sma100: last(sma(closes, 100)),
    sma200: last(sma(closes, 200)),
    ema12: last(ema(closes, 12)),
    ema26: last(ema(closes, 26)),
    rsi14: last(rsi(closes, 14)),
    macd: last(m.macd),
    macdSignal: last(m.signal),
    macdHistogram: last(m.histogram),
    bollingerUpper: last(bb.upper),
    bollingerMiddle: last(bb.middle),
    bollingerLower: last(bb.lower),
    atr14: last(atr(highs, lows, closes, 14)),
    volumeSma20: last(volumeSma(volumes, 20)),
    volumeRatio: volumeRatio(volumes, 20),
  };

  const { support, resistance } = computeSupportResistance(candles, snapshot.price);
  return {
    symbol,
    snapshot,
    classification: classify(snapshot),
    support,
    resistance,
    candleCount: candles.length,
    limitedHistory: candles.length < 200,
  };
}
