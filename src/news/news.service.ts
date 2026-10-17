import { Injectable, Logger } from '@nestjs/common';
import { BackgroundTasks } from '../common/background-tasks.service';
import { Metrics } from '../common/metrics.service';
import { safeErrorMessage } from '../common/utils/scrub';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../database/prisma.service';
import { StockService } from '../stock/stock.service';
import { extractEvents, relevanceFor, safeUrl, titleHash } from './news-events';
import { NewsArticle, NewsEvent, NewsReport, RawNewsItem } from './news.types';

const DAY_MS = 86_400_000;
const MAX_SHOWN = 8;
const TITLE_MAX = 300;

/**
 * Headlines for a stock, from the governed provider path, stored and de-duplicated.
 *
 * - Fetching goes through StockService (existence gate, quotas, breaker, cache, fetch log), so news
 *   costs the same budget as any other provider call and an unknown ticker never reaches the vendor.
 * - Every fetched item is stored once (provider id) and once per headline (title hash), with the
 *   tickers it is about and the events its title names. Repeated fetches add nothing.
 * - Freshness is explicit: only items younger than NEWS_MAX_AGE_DAYS are shown, each with its age.
 * - When the provider is unavailable the archive answers, flagged as such. Nothing is ever generated:
 *   no sentiment, no summary, no causal reading; the language model does not see news text.
 */
@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);
  private readonly maxAgeDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stocks: StockService,
    private readonly metrics: Metrics,
    private readonly background: BackgroundTasks,
    config: AppConfig,
  ) {
    this.maxAgeDays = config.get('NEWS_MAX_AGE_DAYS');
  }

  async getNews(symbol: string): Promise<NewsReport> {
    const now = new Date();
    const res = await this.stocks.getNews(symbol);
    if (res.available) {
      const articles = this.normalize(symbol, res.data, now);
      this.background.run(this.store(symbol, articles)); // archive write never delays the answer
      const shown = articles
        .filter((a) => now.getTime() - a.publishedAt.getTime() <= this.maxAgeDays * DAY_MS)
        .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
        .slice(0, MAX_SHOWN);
      this.metrics.inc('news_reports_total', { origin: 'provider' });
      return {
        symbol,
        articles: shown,
        fromArchive: false,
        maxAgeDays: this.maxAgeDays,
        fetchedAt: new Date(res.fetchedAt),
      };
    }

    const archive = await this.fromArchive(symbol, now);
    if (archive.length > 0) {
      this.metrics.inc('news_reports_total', { origin: 'archive' });
      return {
        symbol,
        articles: archive,
        fromArchive: true,
        maxAgeDays: this.maxAgeDays,
        fetchedAt: now,
      };
    }
    this.metrics.inc('news_reports_total', { origin: 'none' });
    return {
      symbol,
      articles: [],
      fromArchive: false,
      unavailableReason: res.reason,
      maxAgeDays: this.maxAgeDays,
      fetchedAt: now,
    };
  }

  /** Raw items -> articles: tickers, events and relevance; junk (no title, future date) is dropped. */
  private normalize(symbol: string, items: RawNewsItem[], now: Date): NewsArticle[] {
    const out: NewsArticle[] = [];
    const seenHash = new Set<string>();
    for (const item of items) {
      const title = (item.title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
      if (title.length < 5 || !item.id) continue;
      const publishedAt =
        item.publishedAt instanceof Date ? item.publishedAt : new Date(item.publishedAt);
      if (Number.isNaN(publishedAt.getTime()) || publishedAt.getTime() > now.getTime() + 3_600_000)
        continue;
      const hash = titleHash(title);
      if (seenHash.has(hash)) continue; // same headline from two outlets in one batch
      seenHash.add(hash);
      const symbols = [...new Set([symbol, ...item.relatedTickers])];
      out.push({
        externalId: item.id,
        title,
        source: (item.publisher ?? '').trim().slice(0, 80) || 'tidak diketahui',
        url: safeUrl(item.url),
        publishedAt,
        symbols,
        events: extractEvents(title),
        relevance: relevanceFor(symbol, { ...item, title }),
      });
    }
    return out;
  }

  /** Idempotent: an article is written once; a later fetch may only add the stock it was asked for. */
  private async store(symbol: string, articles: NewsArticle[]): Promise<void> {
    for (const a of articles) {
      try {
        const hash = titleHash(a.title);
        const existing = await this.prisma.newsArticle.findFirst({
          where: { OR: [{ externalId: a.externalId }, { titleHash: hash }] },
          select: { id: true, symbols: true },
        });
        if (existing) {
          if (!existing.symbols.includes(symbol)) {
            await this.prisma.newsArticle.update({
              where: { id: existing.id },
              data: { symbols: [...existing.symbols, symbol] },
            });
          }
          continue;
        }
        await this.prisma.newsArticle.create({
          data: {
            externalId: a.externalId,
            titleHash: hash,
            title: a.title,
            source: a.source,
            url: a.url,
            publishedAt: a.publishedAt,
            symbols: a.symbols,
            events: a.events,
          },
        });
      } catch (e) {
        // a concurrent insert of the same article is fine; anything else is logged and skipped
        this.logger.debug(`news not stored: ${safeErrorMessage(e)}`);
      }
    }
  }

  private async fromArchive(symbol: string, now: Date): Promise<NewsArticle[]> {
    try {
      const rows = await this.prisma.newsArticle.findMany({
        where: {
          symbols: { has: symbol },
          publishedAt: { gte: new Date(now.getTime() - this.maxAgeDays * DAY_MS) },
        },
        orderBy: { publishedAt: 'desc' },
        take: MAX_SHOWN,
      });
      return rows.map((r) => ({
        externalId: r.externalId,
        title: r.title,
        source: r.source,
        url: r.url,
        publishedAt: r.publishedAt,
        symbols: r.symbols,
        events: r.events as NewsEvent[],
        relevance: relevanceFor(symbol, {
          id: r.externalId,
          title: r.title,
          publisher: r.source,
          url: r.url,
          publishedAt: r.publishedAt,
          relatedTickers: r.symbols,
        }),
      }));
    } catch (e) {
      this.logger.warn(`news archive read failed: ${safeErrorMessage(e)}`);
      return [];
    }
  }
}
