import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { BackgroundTasks } from '../common/background-tasks.service';
import { Metrics } from '../common/metrics.service';
import { safeErrorMessage } from '../common/utils/scrub';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../database/prisma.service';
import { StockService } from '../stock/stock.service';
import { Fundamentals } from '../stock/stock.types';
import { deriveFields, markStale, missingMetrics } from './derive';
import { FundamentalsReport } from './fundamentals.types';

const DAY_MS = 86_400_000;

/**
 * Fundamentals with provenance and a stored history.
 *
 * Fresh figures come from the governed, cached provider path (StockService). Each successful fetch is
 * stored as a daily snapshot, so when the provider is unavailable the last known figures can still be
 * shown — flagged, with their date, and marked 'stale' once older than FUNDAMENTALS_STALE_DAYS. Nothing
 * is ever invented: a metric the provider does not supply and that cannot be derived from reported
 * figures is listed as missing.
 */
@Injectable()
export class FundamentalsService {
  private readonly logger = new Logger(FundamentalsService.name);
  private readonly staleDays: number;
  /** (symbol -> day + hash of the figures) already written by this process: avoids an UPSERT per request. */
  private readonly written = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly stocks: StockService,
    private readonly metrics: Metrics,
    private readonly background: BackgroundTasks,
    private readonly config: AppConfig,
  ) {
    this.staleDays = config.get('FUNDAMENTALS_STALE_DAYS');
  }

  /** Null only when the ticker is unknown AND nothing is stored for it. */
  async getReport(symbol: string): Promise<FundamentalsReport | null> {
    // quote first: it settles the ticker's existence (no probe) and keeps one governed call per user at a time
    const quote = await this.stocks.getQuote(symbol);
    const fund = await this.stocks.getFundamentals(symbol);
    const name = quote.available ? quote.data.name : null;
    const price = quote.available ? quote.data.price : null;

    if (fund.available) {
      const fields = deriveFields(fund.data, price);
      const asOf = new Date(fund.fetchedAt);
      // persisted in the background: a write that references the Stock row waits behind the candle
      // persistence transaction (measured ~2 s) and the answer does not need it
      this.background.run(this.storeSnapshot(symbol, fund.data, asOf, fund.source));
      this.metrics.inc('fundamentals_reports_total', { origin: 'provider' });
      return {
        symbol,
        name,
        fields,
        missing: missingMetrics(fields),
        asOf,
        ageDays: this.ageDays(asOf),
        fromSnapshot: false,
        stale: false,
        source: fund.source,
      };
    }

    // provider unavailable (or the ticker is known but has no fundamentals): fall back to history
    const snapshot = await this.latestSnapshot(symbol);
    if (!snapshot) {
      this.metrics.inc('fundamentals_reports_total', { origin: 'none' });
      return null;
    }
    const ageDays = this.ageDays(snapshot.asOf);
    const stale = ageDays > this.staleDays;
    const base = deriveFields(snapshot.data, price);
    const fields = stale ? markStale(base) : base;
    this.metrics.inc('fundamentals_reports_total', {
      origin: stale ? 'snapshot_stale' : 'snapshot',
    });
    return {
      symbol,
      name,
      fields,
      missing: missingMetrics(fields),
      asOf: snapshot.asOf,
      ageDays,
      fromSnapshot: true,
      stale,
      source: snapshot.source,
    };
  }

  /** One snapshot per stock per day (the latest fetch of the day wins). Best effort. */
  private async storeSnapshot(
    symbol: string,
    data: Fundamentals,
    asOf: Date,
    source: string,
  ): Promise<void> {
    const day = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
    const stamp = `${day.toISOString().slice(0, 10)}:${createHash('sha1').update(JSON.stringify(data)).digest('hex')}`;
    if (this.written.get(symbol) === stamp) return;
    if (this.written.size > 5000) this.written.clear();
    this.written.set(symbol, stamp);
    try {
      // no name here: an UPDATE on the Stock row would wait behind the background candle inserts that hold
      // share locks on it (measured: ~2 s); the quote path already keeps the name current
      const stockId = await this.stocks.ensureStock(symbol);
      await this.prisma.fundamentalSnapshot.upsert({
        where: { stockId_day: { stockId, day } },
        create: { stockId, day, asOf, source, data: data as unknown as Prisma.InputJsonObject },
        update: { asOf, source, data: data as unknown as Prisma.InputJsonObject },
      });
    } catch (e) {
      this.logger.warn(`fundamental snapshot not stored: ${safeErrorMessage(e)}`);
    }
  }

  private async latestSnapshot(
    symbol: string,
  ): Promise<{ data: Fundamentals; asOf: Date; source: string } | null> {
    try {
      const row = await this.prisma.fundamentalSnapshot.findFirst({
        where: { stock: { symbol } },
        orderBy: { asOf: 'desc' },
      });
      if (!row) return null;
      return { data: row.data as unknown as Fundamentals, asOf: row.asOf, source: row.source };
    } catch (e) {
      this.logger.warn(`fundamental snapshot read failed: ${safeErrorMessage(e)}`);
      return null;
    }
  }

  private ageDays(asOf: Date): number {
    return Math.max(0, Math.floor((Date.now() - asOf.getTime()) / DAY_MS));
  }
}
