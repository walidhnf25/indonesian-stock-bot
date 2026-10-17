import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppConfig } from '../config/app-config.service';
import { BackgroundTasks } from '../common/background-tasks.service';
import { TtlCache } from '../common/cache/ttl-cache';
import { NEWS_PROVIDER, NewsProvider } from '../news/news-provider.interface';
import { RawNewsItem } from '../news/news.types';
import { Metrics } from '../common/metrics.service';
import { withRetry } from '../common/utils/retry';
import { cleanCompanyName } from '../common/utils/text';
import { safeErrorMessage } from '../common/utils/scrub';
import { PrismaService } from '../database/prisma.service';
import {
  ProviderResult,
  STOCK_DATA_PROVIDER,
  StockDataProvider,
} from './stock-data-provider.interface';
import {
  BrokerSummary,
  CompanyProfile,
  DailyCandle,
  DataResult,
  ForeignFlow,
  Fundamentals,
  HistoryRange,
  NormalizedQuote,
  StockSearchResult,
  Unavailable,
  available,
  unavailable,
} from './stock.types';
import { MarketDataGovernor } from './governance/market-data-governor';
import { TickerRegistry } from './governance/ticker-registry';

class RetryableUnavailable extends Error {
  constructor(readonly result: Unavailable) {
    super(result.reason);
  }
}

/**
 * Application-facing market data access. Adds caching, de-duplication, throttling, retries,
 * persistence and last-known-data fallback on top of a StockDataProvider.
 */
@Injectable()
export class StockService {
  private readonly logger = new Logger(StockService.name);
  private readonly quoteCache: TtlCache<NormalizedQuote>;
  private readonly historyCache: TtlCache<DailyCandle[]>;
  private readonly newsTtlMs: number;
  private readonly miscCache = new TtlCache<unknown>(10 * 60_000, 500);
  private readonly stockIds = new Map<string, string>();
  /** Last name written per symbol: an unchanged name must not issue an UPDATE (it takes a row lock that every
   * FK-referencing insert then waits behind while a candle batch is being persisted; measured ~2 s). */
  private readonly stockNames = new Map<string, string | null>();
  private readonly ensuring = new Map<string, Promise<string>>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(STOCK_DATA_PROVIDER) private readonly provider: StockDataProvider,
    @Inject(NEWS_PROVIDER) private readonly newsProvider: NewsProvider,
    private readonly prisma: PrismaService,
    private readonly background: BackgroundTasks,
    config: AppConfig,
    private readonly governor: MarketDataGovernor,
    private readonly registry: TickerRegistry,
    private readonly metrics: Metrics,
  ) {
    this.quoteCache = new TtlCache(config.get('QUOTE_CACHE_TTL_SECONDS') * 1000);
    this.historyCache = new TtlCache(config.get('HISTORY_CACHE_TTL_SECONDS') * 1000, 300);
    this.newsTtlMs = config.get('NEWS_CACHE_TTL_SECONDS') * 1000;
  }

  get providerName(): string {
    return this.provider.name;
  }

  healthCheck() {
    return this.provider.healthCheck();
  }

  /* ------------------------------------------------------------------ quote */

  async getQuote(symbol: string): Promise<DataResult<NormalizedQuote>> {
    const hit = this.quoteCache.get(symbol);
    if (hit) {
      this.metrics.inc('market_data_cache_total', { kind: 'quote', result: 'hit' });
      return available(hit.value, this.provider.name, false, new Date(hit.storedAt));
    }
    // A ticker the provider confirmed does not exist is not asked again for a few minutes: without this every
    // message naming a made-up ticker costs a provider call and a DataFetchLog row.
    if (this.registry.status(symbol) === 'missing') {
      this.metrics.inc('market_data_cache_total', { kind: 'quote', result: 'negative' });
      return unavailable('Ticker tidak ditemukan.', 'NOT_FOUND');
    }
    this.metrics.inc('market_data_cache_total', { kind: 'quote', result: 'miss' });
    return this.dedupe(`quote:${symbol}`, () => this.loadQuote(symbol));
  }

  private async loadQuote(symbol: string): Promise<DataResult<NormalizedQuote>> {
    const result = await this.guarded('quote', symbol, () => this.provider.getQuote(symbol));
    if (result.available) {
      this.quoteCache.set(symbol, result.data);
      this.registry.markVerified(symbol);
      this.background.run(this.persistQuote(result.data));
      return available(result.data, this.provider.name);
    }
    if (result.code === 'NOT_FOUND') {
      // "Not found" is only remembered for tickers that have never been seen working. A symbol this
      // process already served, that is on the IDX list or that has a stored quote is real: the provider just
      // hiccupped (it also answers NOT_FOUND for an unusable quote), and caching that for everybody would hide a
      // valid ticker for minutes. Such a symbol falls back to stored data like any outage. For the rest
      // only a repeated answer is kept (TickerRegistry.noteMissing).
      const stored = await this.loadStoredQuote(symbol);
      if (stored) return stored;
      this.registry.noteMissing(symbol);
      return result;
    }

    const stored = await this.loadStoredQuote(symbol);
    return stored ?? result;
  }

  /** Batch quote used by screener and watchlist; skips symbols the provider can't serve. */
  async getQuotes(
    symbols: string[],
    opts: { fallback?: boolean } = {},
  ): Promise<Map<string, DataResult<NormalizedQuote>>> {
    const out = new Map<string, DataResult<NormalizedQuote>>();
    const missing: string[] = [];
    for (const s of symbols) {
      const hit = this.quoteCache.get(s);
      if (hit) out.set(s, available(hit.value, this.provider.name, false, new Date(hit.storedAt)));
      else missing.push(s);
    }
    if (missing.length > 0) {
      const batch = await this.governor.execute(this.provider.name, async () => ({
        available: true as const,
        data: await this.provider.getQuotes(missing),
      }));
      const fetched = batch.available ? batch.data : new Map<string, NormalizedQuote>();
      for (const s of missing) {
        const q = fetched.get(s);
        if (q) {
          this.quoteCache.set(s, q);
          this.registry.markVerified(s);
          this.background.run(this.persistQuote(q));
          out.set(s, available(q, this.provider.name));
        }
      }
      // Anything the batch call didn't return: fall back to the single path (cache/DB/provider).
      if (opts.fallback !== false) {
        for (const s of missing) {
          if (!out.has(s)) out.set(s, await this.getQuote(s));
        }
      }
    }
    return out;
  }

  async getIndexQuote(): Promise<DataResult<NormalizedQuote>> {
    const key = 'index:IHSG';
    const hit = this.miscCache.get(key);
    if (hit)
      return available(
        hit.value as NormalizedQuote,
        this.provider.name,
        false,
        new Date(hit.storedAt),
      );
    const r = await this.guarded('index', 'IHSG', () => this.provider.getIndexQuote());
    if (!r.available) return r;
    this.miscCache.set(key, r.data, 60_000);
    return available(r.data, this.provider.name);
  }

  /* ---------------------------------------------------------------- history */

  async getHistory(symbol: string, range: HistoryRange = '1y'): Promise<DataResult<DailyCandle[]>> {
    const key = `${symbol}:${range}`;
    const hit = this.historyCache.get(key);
    if (hit) {
      this.metrics.inc('market_data_cache_total', { kind: 'history', result: 'hit' });
      return available(hit.value, this.provider.name, false, new Date(hit.storedAt));
    }
    this.metrics.inc('market_data_cache_total', { kind: 'history', result: 'miss' });
    // Expensive calls for a ticker nobody has verified wait for one cheap existence probe.
    const blocked = await this.existenceGate(symbol);
    if (blocked) {
      return blocked.code === 'NOT_FOUND'
        ? blocked
        : ((await this.loadStoredCandles(symbol)) ?? blocked);
    }
    return this.dedupe(`history:${key}`, () => this.loadHistory(symbol, range, key));
  }

  private async loadHistory(
    symbol: string,
    range: HistoryRange,
    key: string,
  ): Promise<DataResult<DailyCandle[]>> {
    const result = await this.guarded('history', symbol, () =>
      this.provider.getHistoricalPrices(symbol, { range }),
    );
    if (result.available) {
      this.historyCache.set(key, result.data);
      this.background.run(this.persistCandles(symbol, result.data));
      return available(result.data, this.provider.name);
    }
    if (result.code === 'NOT_FOUND') return result;

    const stored = await this.loadStoredCandles(symbol);
    return stored ?? result;
  }

  /* ------------------------------------------------- optional / uncached-ish */

  getProfile(symbol: string): Promise<DataResult<CompanyProfile>> {
    return this.cachedMisc(
      'profile',
      symbol,
      () => this.provider.getCompanyProfile(symbol),
      6 * 3_600_000,
      symbol,
    );
  }

  getFundamentals(symbol: string): Promise<DataResult<Fundamentals>> {
    return this.cachedMisc(
      'fund',
      symbol,
      () => this.provider.getFundamentals(symbol),
      3_600_000,
      symbol,
    );
  }

  /** Headlines through the same existence gate, quotas, breaker, cache and fetch log. */
  getNews(symbol: string): Promise<DataResult<RawNewsItem[]>> {
    return this.cachedMisc(
      'news',
      symbol,
      () => this.newsProvider.getNews(symbol, 10),
      this.newsTtlMs,
      symbol,
    );
  }

  getForeignFlow(symbol: string): Promise<DataResult<ForeignFlow>> {
    return this.cachedMisc(
      'foreign',
      symbol,
      () => this.provider.getForeignFlow(symbol),
      300_000,
      symbol,
    );
  }

  getBrokerSummary(symbol: string): Promise<DataResult<BrokerSummary>> {
    return this.cachedMisc(
      'broker',
      symbol,
      () => this.provider.getBrokerSummary(symbol),
      300_000,
      symbol,
    );
  }

  searchStocks(query: string): Promise<DataResult<StockSearchResult[]>> {
    return this.cachedMisc(
      'search',
      query.toLowerCase(),
      () => this.provider.searchStocks(query),
      3_600_000,
    );
  }

  /* ----------------------------------------------------------------- stocks */

  /** 'valid' = provider knows it; 'invalid' = provider says no such ticker; 'unknown' = provider down. */
  async validateSymbol(symbol: string): Promise<'valid' | 'invalid' | 'unknown'> {
    const q = await this.getQuote(symbol);
    if (q.available) return 'valid';
    return q.code === 'NOT_FOUND' ? 'invalid' : 'unknown';
  }

  /** Returns the DB id for a symbol, creating the Stock row on first use. */
  async ensureStock(symbol: string, rawName?: string | null): Promise<string> {
    // Provider-controlled text is cleaned (control/markup characters, length) before it is stored.
    const name = cleanCompanyName(rawName);
    const cached = this.stockIds.get(symbol);
    if (cached && (!name || this.stockNames.get(symbol) === name)) return cached;
    // The first quote and the first history of a new ticker are persisted by two background tasks at the same
    // time; two concurrent upserts of a NEW row can collide on the unique symbol. Calls for one symbol are
    // therefore chained, and a lost race is retried once (the row exists by then).
    const previous = this.ensuring.get(symbol) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const write = () =>
          this.prisma.stock.upsert({
            where: { symbol },
            create: { symbol, name },
            update: name ? { name } : {},
          });
        let stock;
        try {
          stock = await write();
        } catch (e) {
          if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
          stock = await write();
        }
        this.stockIds.set(symbol, stock.id);
        if (name) this.stockNames.set(symbol, name);
        return stock.id;
      });
    this.ensuring.set(symbol, run);
    void run
      .catch(() => undefined)
      .finally(() => {
        if (this.ensuring.get(symbol) === run) this.ensuring.delete(symbol);
      });
    return run;
  }

  /* ---------------------------------------------------------------- internals */

  /**
   * history, fundamentals and the like are only fetched for a ticker that is known to exist. For a ticker
   * nobody has verified, ONE cheap quote is the existence probe (cached, de-duplicated, charged to the caller's
   * quota). Returns null when the expensive call may go ahead, otherwise the reason it may not: NOT_FOUND, or
   * "cannot verify right now" (quota, busy, provider error).
   */
  private async existenceGate(symbol: string): Promise<Unavailable | null> {
    if (this.registry.isKnownToExist(symbol)) return null;
    if (this.registry.status(symbol) === 'missing') {
      return unavailable('Ticker tidak ditemukan.', 'NOT_FOUND');
    }
    const probe = await this.getQuote(symbol);
    if (probe.available) return null;
    this.metrics.inc('market_data_existence_gate_total', { result: probe.code.toLowerCase() });
    return probe;
  }

  /** Concurrent callers asking for the same thing share one provider round-trip. */
  private dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async cachedMisc<T>(
    kind: string,
    key: string,
    fn: () => Promise<ProviderResult<T>>,
    ttlMs: number,
    gateSymbol?: string,
  ): Promise<DataResult<T>> {
    const k = `${kind}:${key}`;
    const hit = this.miscCache.get(k);
    if (hit) {
      this.metrics.inc('market_data_cache_total', { kind, result: 'hit' });
      return available(hit.value as T, this.provider.name, false, new Date(hit.storedAt));
    }
    this.metrics.inc('market_data_cache_total', { kind, result: 'miss' });
    if (gateSymbol) {
      const blocked = await this.existenceGate(gateSymbol);
      if (blocked) return blocked;
    }
    // concurrent identical requests (many users asking the same ticker at once) share one provider call
    const r = await this.dedupe(`misc:${k}`, () => this.guarded(kind, key, fn));
    if (!r.available) return r;
    this.miscCache.set(k, r.data, ttlMs);
    return available(r.data, this.provider.name);
  }

  /** Throttle + retry (transient errors only) + fetch logging. Never throws. */
  private async guarded<T>(
    op: string,
    subject: string,
    fn: () => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> {
    const started = Date.now();
    let final: ProviderResult<T>;
    try {
      final = await withRetry(
        async () => {
          const r = await this.governor.execute(this.provider.name, fn);
          if (!r.available && (r.code === 'ERROR' || r.code === 'RATE_LIMITED')) {
            throw new RetryableUnavailable(r);
          }
          return r;
        },
        {
          retries: 2,
          baseDelayMs: 600,
          shouldRetry: (e) => e instanceof RetryableUnavailable,
        },
      );
    } catch (e) {
      final =
        e instanceof RetryableUnavailable ? e.result : unavailable('Provider error.', 'ERROR');
    }
    const latencyMs = Date.now() - started;
    this.logger.debug(
      JSON.stringify({
        evt: 'provider_call',
        provider: this.provider.name,
        op,
        subject,
        ok: final.available,
        latencyMs,
      }),
    );
    // Refusals by our own governance never reached the provider; logging them would let a flood of refused
    // calls become a flood of database rows.
    if (final.available || (final.code !== 'QUOTA' && final.code !== 'BUSY')) {
      this.background.run(this.logFetch(op, subject, final, latencyMs));
    }
    return final;
  }

  private async logFetch(
    op: string,
    subject: string,
    r: ProviderResult<unknown>,
    latencyMs: number,
  ) {
    try {
      await this.prisma.dataFetchLog.create({
        data: {
          provider: this.provider.name,
          operation: op,
          symbol: subject.slice(0, 20),
          success: r.available,
          latencyMs,
          error: r.available ? null : `${r.code}: ${r.reason}`.slice(0, 300),
        },
      });
    } catch {
      /* logging must never break the request path */
    }
  }

  private async persistQuote(q: NormalizedQuote): Promise<void> {
    try {
      const stockId = await this.ensureStock(q.symbol, q.name);
      const payload = q as unknown as Prisma.InputJsonValue;
      await this.prisma.stockQuoteSnapshot.upsert({
        where: { stockId },
        create: { stockId, payload, provider: this.provider.name, quotedAt: new Date(q.timestamp) },
        update: {
          payload,
          provider: this.provider.name,
          quotedAt: new Date(q.timestamp),
          fetchedAt: new Date(),
        },
      });
    } catch (e) {
      this.logger.warn(`persistQuote failed: ${safeErrorMessage(e)}`);
    }
  }

  private async loadStoredQuote(symbol: string): Promise<DataResult<NormalizedQuote> | null> {
    try {
      const row = await this.prisma.stockQuoteSnapshot.findFirst({ where: { stock: { symbol } } });
      if (!row) return null;
      return available(
        row.payload as unknown as NormalizedQuote,
        `${row.provider} (tersimpan)`,
        true,
        row.fetchedAt,
      );
    } catch {
      return null;
    }
  }

  private async persistCandles(symbol: string, candles: DailyCandle[]): Promise<void> {
    try {
      const stockId = await this.ensureStock(symbol);
      const provider = this.provider.name;
      const rows = candles.map((c) => ({
        stockId,
        date: new Date(`${c.date}T00:00:00.000Z`),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: BigInt(Math.round(c.volume)),
        provider,
      }));
      await this.prisma.stockDailyPrice.createMany({ data: rows, skipDuplicates: true });
      // The most recent candles can still change intraday: refresh them.
      const recent = rows.slice(-3);
      await this.prisma.$transaction(
        recent.map((r) =>
          this.prisma.stockDailyPrice.update({
            where: { stockId_date: { stockId: r.stockId, date: r.date } },
            data: { open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume },
          }),
        ),
      );
    } catch (e) {
      this.logger.warn(`persistCandles failed: ${safeErrorMessage(e)}`);
    }
  }

  private async loadStoredCandles(symbol: string): Promise<DataResult<DailyCandle[]> | null> {
    try {
      const rows = await this.prisma.stockDailyPrice.findMany({
        where: { stock: { symbol } },
        orderBy: { date: 'desc' },
        take: 300,
      });
      if (rows.length < 30) return null;
      const candles: DailyCandle[] = rows.reverse().map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: Number(r.volume),
      }));
      return available(
        candles,
        `${this.provider.name} (tersimpan)`,
        true,
        new Date(rows[rows.length - 1].date),
      );
    } catch {
      return null;
    }
  }
}
