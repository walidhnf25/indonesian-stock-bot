import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config.service';
import { NormalizedQuote } from '../stock/stock.types';
import { Freshness, Plausibility, assessPlausibility, classifyFreshness } from './data-quality';
import { MarketService } from './market.service';

/** Applies the configured thresholds and the live market calendar to the pure data-quality rules. */
@Injectable()
export class DataQualityService {
  constructor(
    private readonly market: MarketService,
    private readonly config: AppConfig,
  ) {}

  freshnessOf(
    quote: Pick<NormalizedQuote, 'timestamp' | 'delayMinutes'>,
    opts: { stale?: boolean; now?: Date } = {},
  ): Freshness {
    const now = opts.now ?? new Date();
    return classifyFreshness({
      quoteTimestamp: quote.timestamp,
      delayMinutes: quote.delayMinutes,
      servedFromFallback: opts.stale ?? false,
      now,
      marketIsTrading: this.market.getStatus(now).isTrading,
      lastTradingDate: this.market.lastTradingDate(now),
      staleAfterMinutes: this.config.get('MARKET_DATA_STALE_AFTER_MINUTES'),
    });
  }

  plausibilityOf(quote: NormalizedQuote, referenceClose?: number | null): Plausibility {
    return assessPlausibility(quote, {
      maxChangePercent: this.config.get('PRICE_ANOMALY_MAX_CHANGE_PERCENT'),
      referenceClose,
      referenceTolerancePercent: this.config.get('PRICE_REFERENCE_TOLERANCE_PERCENT'),
    });
  }
}
