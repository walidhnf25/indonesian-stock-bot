import { jakartaParts } from '../common/utils/format';
import { NormalizedQuote } from '../stock/stock.types';

/* ------------------------------------------------------------------------------ freshness */

export type FreshnessState = 'LIVE' | 'DELAYED' | 'STALE' | 'UNKNOWN';

export interface Freshness {
  state: FreshnessState;
  /** Minutes between the provider's timestamp and now (null when unknown). */
  ageMinutes: number | null;
  /** Short Indonesian explanation shown to the user for STALE/UNKNOWN and used in logs. */
  reason: string;
  /** True when the exchange is not in a trading session (the price is the last close/trade). */
  marketClosed: boolean;
  /** True when the data came from our stored copy because the provider failed. */
  fromFallback: boolean;
}

export interface FreshnessInput {
  quoteTimestamp: string | null | undefined;
  /** Delay the provider itself declares (Yahoo: ~10 min for IDX). */
  delayMinutes: number | null | undefined;
  servedFromFallback: boolean;
  now: Date;
  marketIsTrading: boolean;
  /** ISO date (WIB) of the most recent trading session that has started. */
  lastTradingDate: string;
  /** During a session, data older than this (plus the declared delay) is STALE. */
  staleAfterMinutes: number;
}

/**
 * Classifies a quote.
 *
 *  - STALE   : served from our stored copy; OR (market open) older than staleAfterMinutes+delay;
 *              OR (market closed) dated before the last trading session.
 *  - UNKNOWN : timestamp missing/invalid/in the future.
 *  - DELAYED : fresh enough, but the provider feed is delayed (always the case for Yahoo/IDX), or
 *              older than a few minutes.
 *  - LIVE    : provider declares no delay and the timestamp is within ~5 minutes.
 *
 * Outside trading hours old timestamps are NORMAL (weekend, lunch, evening): the rule is
 * "not older than the last trading session", not "younger than N minutes". Illiquid stocks may show
 * an old last-trade time during a session; they are reported STALE rather than silently trusted.
 */
export function classifyFreshness(i: FreshnessInput): Freshness {
  const base = { marketClosed: !i.marketIsTrading, fromFallback: i.servedFromFallback };
  if (i.servedFromFallback) {
    return {
      ...base,
      state: 'STALE',
      ageMinutes: ageOf(i.quoteTimestamp, i.now),
      reason: 'Data terbaru tidak tersedia; ini data tersimpan terakhir.',
    };
  }
  const ts = i.quoteTimestamp ? new Date(i.quoteTimestamp) : null;
  if (!ts || Number.isNaN(ts.getTime())) {
    return { ...base, state: 'UNKNOWN', ageMinutes: null, reason: 'Waktu data tidak diketahui.' };
  }
  const age = (i.now.getTime() - ts.getTime()) / 60_000;
  if (age < -5) {
    return {
      ...base,
      state: 'UNKNOWN',
      ageMinutes: age,
      reason: 'Waktu data tidak wajar (di masa depan).',
    };
  }
  const delay = Math.max(0, i.delayMinutes ?? 0);

  if (i.marketIsTrading) {
    const limit = i.staleAfterMinutes + delay;
    if (age > limit) {
      return {
        ...base,
        state: 'STALE',
        ageMinutes: age,
        reason: `Tidak ada pembaruan selama ${Math.round(age)} menit saat bursa buka (batas ${limit} menit); saham mungkin jarang diperdagangkan.`,
      };
    }
    return {
      ...base,
      state: delay > 0 || age > 5 ? 'DELAYED' : 'LIVE',
      ageMinutes: age,
      reason: delay > 0 ? `Data tertunda ±${delay} menit.` : 'Data terkini.',
    };
  }

  const quoteDate = jakartaParts(ts).isoDate;
  if (quoteDate < i.lastTradingDate) {
    return {
      ...base,
      state: 'STALE',
      ageMinutes: age,
      reason: `Data lebih lama dari sesi bursa terakhir (${i.lastTradingDate}); bisa jadi hari libur bursa atau provider belum memperbarui.`,
    };
  }
  return {
    ...base,
    state: delay > 0 ? 'DELAYED' : 'LIVE',
    ageMinutes: age,
    reason: 'Bursa tutup; ini harga penutupan terakhir.',
  };
}

function ageOf(ts: string | null | undefined, now: Date): number | null {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  return Number.isNaN(t) ? null : (now.getTime() - t) / 60_000;
}

/** The worst state in a list (STALE > UNKNOWN > DELAYED > LIVE), for multi-quote responses. */
export function worstFreshness(list: readonly Freshness[]): Freshness | null {
  if (list.length === 0) return null;
  const rank: Record<FreshnessState, number> = { STALE: 3, UNKNOWN: 2, DELAYED: 1, LIVE: 0 };
  return list.reduce((a, b) => (rank[b.state] > rank[a.state] ? b : a));
}

/* ---------------------------------------------------------------------------- plausibility */

/**
 * How far a quote may be trusted:
 *  - `trusted` : internally consistent and consistent with independent reference data;
 *  - `suspect` : numerically valid but unexplained (a huge jump, no reference, provider fields that
 *                disagree). Shown with a warning; NEVER allowed to trigger an alert;
 *  - `invalid` : impossible (non-finite/zero/negative price, high < low, price outside the day's
 *                range). Rejected: no alert, no AI interpretation.
 */
export type QuoteQuality = 'trusted' | 'suspect' | 'invalid';

export type PlausibilityReason =
  | 'price_invalid'
  | 'ohlc_inconsistent'
  | 'extreme_change'
  | 'change_mismatch'
  | 'open_outside_range'
  | 'no_reference'
  | 'reference_mismatch'
  | 'volume_invalid';

export interface Plausibility {
  /** True only for `trusted` (kept for callers that just need "can I rely on this price?"). */
  ok: boolean;
  quality: QuoteQuality;
  reasons: PlausibilityReason[];
}

export const PLAUSIBILITY_TEXT: Record<PlausibilityReason, string> = {
  price_invalid: 'harga nol/tidak valid',
  ohlc_inconsistent:
    'harga di luar rentang harian (open/high/low) atau data open/high/low tidak valid',
  extreme_change: 'lonjakan/penurunan ekstrem dibanding penutupan sebelumnya',
  change_mismatch: 'persentase perubahan dari provider tidak konsisten',
  open_outside_range: 'harga pembukaan di luar rentang harian',
  no_reference: 'tidak ada penutupan sebelumnya sebagai pembanding',
  reference_mismatch: 'penutupan sebelumnya dari provider berbeda dengan data harian tersimpan',
  volume_invalid: 'volume negatif atau bukan angka',
};

const INVALID_REASONS = new Set<PlausibilityReason>(['price_invalid', 'ohlc_inconsistent']);

export interface PlausibilityOptions {
  /** A move bigger than this (percent) vs the previous close is suspect. Configurable. */
  maxChangePercent: number;
  /** Previous-session close from the stored daily candles (an independent field of the data). */
  referenceClose?: number | null;
  /** Allowed gap (percent) between the quote's previous close and `referenceClose`. */
  referenceTolerancePercent?: number;
}

/**
 * Trust assessment of a normalized quote. There is no fixed price floor (low-priced stocks exist);
 * the quote is compared with itself and with the previous close:
 *  - price must be a finite positive number; open/high/low, when present, must be finite positive,
 *    high >= low, and price must lie inside the day's [low, high] (1 % tolerance) -> else INVALID;
 *  - a move beyond `maxChangePercent` vs the previous close is SUSPECT. A quote whose own fields all
 *    agree (price = open = high = low = 1) is no evidence at all, so there is NO "corroborated" exemption;
 *  - provider change % that disagrees with price/previousClose, an open outside the day's range, no
 *    previous close to compare with, and a previous close that disagrees with the stored daily close
 *    are SUSPECT.
 * Real ARA/ARB days (about +/-35 %) stay trusted. A real move beyond the threshold, a split or another
 * corporate action is SUSPECT by design: an alert threshold set before it would be meaningless anyway.
 * The threshold is configurable (PRICE_ANOMALY_MAX_CHANGE_PERCENT); see the README for the limits.
 */
export function assessPlausibility(q: NormalizedQuote, opts: PlausibilityOptions): Plausibility {
  const reasons: PlausibilityReason[] = [];
  const price = q.price;
  const finitePositive = (v: number | null | undefined) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0;

  if (!finitePositive(price)) {
    return { ok: false, quality: 'invalid', reasons: ['price_invalid'] };
  }

  const { high, low, open } = q;
  for (const field of [high, low, open]) {
    if (field !== null && field !== undefined && !finitePositive(field)) {
      reasons.push('ohlc_inconsistent');
      break;
    }
  }
  const haveRange = finitePositive(high) && finitePositive(low);
  if (haveRange) {
    if ((high as number) < (low as number)) reasons.push('ohlc_inconsistent');
    else if (price > (high as number) * 1.01 || price < (low as number) * 0.99) {
      reasons.push('ohlc_inconsistent');
    }
    if (
      finitePositive(open) &&
      ((open as number) > (high as number) * 1.01 || (open as number) < (low as number) * 0.99)
    ) {
      reasons.push('open_outside_range');
    }
  }

  // Volume is not part of price sanity, but a negative or non-numeric volume proves the row is corrupt.
  if (q.volume !== null && q.volume !== undefined && (!Number.isFinite(q.volume) || q.volume < 0)) {
    reasons.push('volume_invalid');
  }

  const prevOk = finitePositive(q.previousClose);
  const ref = prevOk ? (q.previousClose as number) : (opts.referenceClose ?? null);
  if (!ref || ref <= 0) {
    reasons.push('no_reference');
  } else {
    const movePct = Math.abs(price / ref - 1) * 100;
    if (movePct > opts.maxChangePercent) reasons.push('extreme_change');
    if (prevOk && q.changePercent !== null) {
      const computed = (price / (q.previousClose as number) - 1) * 100;
      if (Math.abs(computed - q.changePercent) > 5) reasons.push('change_mismatch');
    }
  }
  if (prevOk && finitePositive(opts.referenceClose)) {
    const gap = Math.abs((q.previousClose as number) / (opts.referenceClose as number) - 1) * 100;
    if (gap > (opts.referenceTolerancePercent ?? 5)) reasons.push('reference_mismatch');
  }

  const unique = [...new Set(reasons)];
  const quality: QuoteQuality = unique.some((r) => INVALID_REASONS.has(r))
    ? 'invalid'
    : unique.length > 0
      ? 'suspect'
      : 'trusted';
  return { ok: quality === 'trusted', quality, reasons: unique };
}

export function describePlausibility(p: Plausibility): string {
  return p.reasons.map((r) => PLAUSIBILITY_TEXT[r]).join('; ');
}

/**
 * Previous-session close taken from daily candles, aligned with the quote's own session: when the
 * newest candle belongs to the quote's session (or the timestamp is unknown) the previous close is the
 * one before it; when the quote is from a later session than the newest candle, it is the newest candle.
 */
export function referenceCloseFromCandles(
  candles: ReadonlyArray<{ date: string; close: number }>,
  quoteTimestamp: string | null | undefined,
): number | null {
  if (candles.length === 0) return null;
  const t = quoteTimestamp ? new Date(quoteTimestamp) : null;
  // Without a usable timestamp the quote's session is unknown, so no honest reference exists.
  if (!t || Number.isNaN(t.getTime())) return null;
  const sessionDate = jakartaParts(t).isoDate;
  // The last candle strictly BEFORE the quote's session: the newest candle when the quote is for a
  // newer session, the one before it when the candle for this session already exists, and the right
  // older one when the quote itself is an older (stored) copy.
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].date < sessionDate) return candles[i].close;
  }
  return null;
}
