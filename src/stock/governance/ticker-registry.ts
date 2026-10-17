import { Injectable } from '@nestjs/common';
import { TtlCache } from '../../common/cache/ttl-cache';
import { AppConfig } from '../../config/app-config.service';
import { KNOWN_TICKER_SET } from '../../intent/parsers/idx-universe';

/**
 * - listed:     on the built-in IDX list; real by definition, never negatively cached;
 * - verified:   the provider has served a real quote for it (remembered for TICKER_EXISTS_TTL_SECONDS);
 * - missing:    the provider said "no such ticker" twice within a minute (remembered for TICKER_MISSING_TTL_SECONDS);
 * - unverified: nobody knows yet. Such a ticker may cost ONE existence probe (a quote); the expensive calls
 *               (history, fundamentals, ...) wait for that probe (see StockService.existenceGate).
 */
export type TickerStatus = 'listed' | 'verified' | 'missing' | 'unverified';

@Injectable()
export class TickerRegistry {
  private readonly verified: TtlCache<true>;
  private readonly missing: TtlCache<true>;
  /** First "not found" of a ticker nobody has seen working: only a second one within a minute is kept. */
  private readonly strikes = new TtlCache<true>(60_000, 1000);

  constructor(config: AppConfig) {
    this.verified = new TtlCache(config.get('TICKER_EXISTS_TTL_SECONDS') * 1000, 5000);
    this.missing = new TtlCache(config.get('TICKER_MISSING_TTL_SECONDS') * 1000, 1000);
  }

  status(symbol: string): TickerStatus {
    if (KNOWN_TICKER_SET.has(symbol)) return 'listed';
    if (this.verified.get(symbol)) return 'verified';
    if (this.missing.get(symbol)) return 'missing';
    return 'unverified';
  }

  /** True when the existence of the ticker needs no probe. */
  isKnownToExist(symbol: string): boolean {
    const s = this.status(symbol);
    return s === 'listed' || s === 'verified';
  }

  markVerified(symbol: string): void {
    this.verified.set(symbol, true);
    this.missing.delete(symbol);
    this.strikes.delete(symbol);
  }

  /**
   * Records a "no such ticker" answer. Returns true when it is now remembered as missing. A listed or verified
   * ticker is never remembered as missing: a single provider hiccup must not hide a real ticker.
   */
  noteMissing(symbol: string): boolean {
    if (this.isKnownToExist(symbol)) return false;
    if (this.strikes.get(symbol)) {
      this.missing.set(symbol, true);
      return true;
    }
    this.strikes.set(symbol, true);
    return false;
  }

  /** Forgets everything learned (tests). */
  reset(): void {
    this.verified.clear();
    this.missing.clear();
    this.strikes.clear();
  }
}
