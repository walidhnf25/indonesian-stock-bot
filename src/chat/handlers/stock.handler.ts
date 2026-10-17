import { Injectable, Logger } from '@nestjs/common';
import { buildAnalysisContext, buildComparisonEntry } from '../../ai/ai-context';
import { AnalysisOutput, ComparisonOutput } from '../../ai/ai-output';
import { AiQuotaService } from '../../ai/ai-quota.service';
import { AIResult, AIService } from '../../ai/ai.service';
import { AnalysisService, unavailableToError } from '../../analysis/analysis.service';
import { FullTechnicalReport } from '../../analysis/analysis.types';
import { BackgroundTasks } from '../../common/background-tasks.service';
import { UserFacingError } from '../../common/exceptions/app-errors';
import { escapeHtml, jakartaParts } from '../../common/utils/format';
import { safeErrorMessage } from '../../common/utils/scrub';
import { PrismaService } from '../../database/prisma.service';
import { AdviceKind, ScreenCriteria, TechnicalTopic, TemporalRef } from '../../intent/intent.types';
import { isEmptyCriteria } from '../../intent/parsers/screen-parser';
import { DataQualityService } from '../../market/data-quality.service';
import { MarketService } from '../../market/market.service';
import { ScreenerService } from '../../screener/screener.service';
import { StockService } from '../../stock/stock.service';
import {
  formatFundamentalsComparison,
  formatFundamentalsReport,
} from '../../fundamentals/fundamentals-format';
import { FundamentalsService } from '../../fundamentals/fundamentals.service';
import { formatNews, formatRelatedNews } from '../../news/news-format';
import { NewsService } from '../../news/news.service';
import { HoldingContext, portfolioClaims } from '../../ai/extra-claims';
import { GENERIC_RISK, observationClaims, riskClaims } from '../../ai/claims';
import { PortfolioService } from '../../portfolio/portfolio.service';
import { readPreferences } from '../../user/user-preferences';
import { WatchlistService } from '../../watchlist/watchlist.service';
import { formatIsoDateId } from '../../intent/parsers/temporal-parser';
import { UNSUPPORTED_MESSAGE } from '../../stock/stock.types';
import {
  AI_NOTICE,
  AiNoticeKind,
  POLICY_NOTICE,
  SCREEN_GUIDANCE,
  adviceMessage,
} from '../../telegram/policy-messages';
import {
  formatAnalysis,
  formatComparison,
  formatForeignFlow,
  formatHistorical,
  formatMarketStatus,
  formatQuote,
  formatScreen,
  formatStockAnswer,
  formatTechnical,
  formatPortfolioSummary,
} from '../../telegram/telegram-response';
import { HandlerContext } from '../chat.types';

const ASK_DATE =
  'Sebutkan tanggalnya, mis. "harga BBCA kemarin" atau "harga BBCA tanggal 1 Oktober 2026".';

const noticeFor = (reason: string): AiNoticeKind => {
  switch (reason) {
    case 'timeout':
      return 'timeout';
    case 'busy':
      return 'busy';
    case 'user_busy':
      return 'userBusy';
    case 'unsafe':
      return 'unsafe';
    case 'invalid':
      return 'invalid';
    default:
      return 'unavailable';
  }
};

@Injectable()
export class StockHandler {
  private readonly logger = new Logger(StockHandler.name);

  constructor(
    private readonly stocks: StockService,
    private readonly fundamentalsSvc: FundamentalsService,
    private readonly newsSvc: NewsService,
    private readonly portfolio: PortfolioService,
    private readonly watchlist: WatchlistService,
    private readonly analysis: AnalysisService,
    private readonly ai: AIService,
    private readonly quota: AiQuotaService,
    private readonly screener: ScreenerService,
    private readonly market: MarketService,
    private readonly quality: DataQualityService,
    private readonly prisma: PrismaService,
    private readonly background: BackgroundTasks,
  ) {}

  /* -------------------------------------------------------------- quote */

  async quote(ctx: HandlerContext): Promise<string[]> {
    const parts: string[] = [];
    for (const symbol of ctx.intent.symbols) {
      const res = await this.stocks.getQuote(symbol);
      if (res.available) {
        const freshness = this.quality.freshnessOf(res.data, { stale: res.stale });
        const plausibility = this.quality.plausibilityOf(res.data);
        ctx.log.provider = this.stocks.providerName;
        ctx.log.freshness = freshness.state;
        if (!plausibility.ok) ctx.log.plausibility = plausibility.reasons;
        parts.push(
          formatQuote(res.data, {
            source: res.source,
            fetchedAt: res.fetchedAt,
            freshness,
            plausibility,
          }),
        );
      } else {
        parts.push(unavailableToError(symbol, res).userMessage);
      }
    }
    return parts;
  }

  /* --------------------------------------------------------- historical */

  /**
   * "harga BBCA kemarin / tanggal 1 Oktober 2026 / minggu lalu": answered from daily candles.
   * Today's price is never substituted for a past date.
   */
  async historical(ctx: HandlerContext): Promise<string[]> {
    const temporal = ctx.intent.parameters.temporal as TemporalRef | undefined;
    if (!temporal || (temporal.kind !== 'date' && temporal.kind !== 'session')) return [ASK_DATE];
    const question = ctx.intent.parameters.question === true;

    const out: string[] = [];
    for (const symbol of ctx.intent.symbols) {
      const [history, quote] = await Promise.all([
        this.stocks.getHistory(symbol, '2y'),
        this.stocks.getQuote(symbol),
      ]);
      if (!history.available) {
        out.push(unavailableToError(symbol, history).userMessage);
        continue;
      }
      ctx.log.provider = this.stocks.providerName;
      const candles = history.data;
      // Resolve which candle was asked for. A trading-session reference ("hari bursa terakhir")
      // is read off the real candles, so holidays/weekends can never turn it into "today".
      let idx: number;
      let exact: boolean;
      let requestDate: string;
      if (temporal.kind === 'session') {
        const todayIso = jakartaParts(new Date()).isoDate;
        let last = -1;
        for (let i = candles.length - 1; i >= 0; i--) {
          if (candles[i].date <= todayIso) {
            last = i;
            break;
          }
        }
        idx = temporal.offset === -1 ? last - 1 : last;
        exact = true;
        requestDate = idx >= 0 ? candles[idx].date : todayIso;
      } else {
        requestDate = temporal.date;
        idx = candles.findIndex((c) => c.date === temporal.date);
        exact = idx >= 0;
        if (!exact) {
          for (let i = candles.length - 1; i >= 0; i--) {
            if (candles[i].date < temporal.date) {
              idx = i;
              break;
            }
          }
        }
      }
      out.push(
        formatHistorical({
          symbol,
          name: quote.available ? quote.data.name : null,
          // A session reference ("hari bursa terakhir") must say WHICH day it resolved to.
          requestLabel:
            temporal.kind === 'session'
              ? `${temporal.label} (${formatIsoDateId(requestDate)})`
              : temporal.label,
          requestDate,
          found:
            idx >= 0 ? { candle: candles[idx], previous: candles[idx - 1] ?? null, exact } : null,
          earliestDate: candles[0]?.date ?? null,
          latest: candles[candles.length - 1] ?? null,
          relative: temporal.kind === 'date' ? temporal.relative : false,
          question,
          source: history.source,
          fromFallback: history.stale,
          fetchedAt: history.fetchedAt,
        }),
      );
    }
    return out;
  }

  /* ---------------------------------------------------------- technical */

  async technical(ctx: HandlerContext): Promise<string[]> {
    const topics = (ctx.intent.parameters.topics as TechnicalTopic[] | undefined) ?? [];
    return this.eachReport(ctx, (report) => formatTechnical(report, topics));
  }

  /* --------------------------------------------------------------- advice */

  /**
   * Buy/sell, target price, prediction and guarantee questions: a fixed policy message plus neutral
   * technical data. The LLM is never involved, so it cannot be talked into giving advice.
   */
  async advice(ctx: HandlerContext): Promise<string[]> {
    const kind = (ctx.intent.parameters.adviceKind as AdviceKind | undefined) ?? 'trade';
    const header = adviceMessage(kind, ctx.intent.symbols);
    ctx.log.adviceKind = kind;
    const sections: string[] = [];
    for (const symbol of ctx.intent.symbols) {
      try {
        const report = await this.analysis.getReport(symbol);
        ctx.log.provider = this.stocks.providerName;
        ctx.log.freshness = report.freshness.state;
        sections.push(formatTechnical(report));
      } catch (e) {
        sections.push(
          e instanceof UserFacingError
            ? e.userMessage
            : 'Data teknikal belum dapat diambil sekarang. Coba lagi beberapa saat lagi.',
        );
      }
    }
    if (sections.length === 0) return [header];
    return [`${header}\n\n${sections[0]}`, ...sections.slice(1)];
  }

  /* ------------------------------------------------- analysis / question */

  async analyze(ctx: HandlerContext, question?: string): Promise<string[]> {
    const symbols = ctx.intent.symbols;
    const policyNotice = ctx.intent.parameters.policyNotice !== undefined;
    const out: string[] = [];
    let skipAi: AiNoticeKind | null = null;

    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];
      const label = symbols.length > 1 ? ` (${i + 1}/${symbols.length})` : '';
      await ctx.progress?.(
        `⏳ Menganalisis <b>${escapeHtml(symbol)}</b>${label}… (biasanya kurang dari 1 menit)`,
      );

      let text: string;
      try {
        const report = await this.analysis.getReport(symbol);
        ctx.log.provider = this.stocks.providerName;
        ctx.log.freshness = report.freshness.state;
        // governed provider calls one at a time per user (a burst would hit the per-user provider queue and
        // retry with backoff); the cached fundamentals and the user's own rows are cheap afterwards
        const fundamentalsReport = await this.fundamentalsSvc.getReport(symbol).catch(() => null);
        const news = await this.newsSvc.getNews(symbol).catch(() => null);
        const [fundamentals, foreignFlow, own] = await Promise.all([
          this.stocks.getFundamentals(symbol),
          this.stocks.getForeignFlow(symbol),
          this.ownContext(ctx, symbol, report),
        ]);
        const extras = { fundamentals, foreignFlow, fundamentalsReport, news, ...own };
        const brief = readPreferences(ctx.user.preferences).detail === 'ringkas';
        ctx.log.sources = {
          fundamentals: Boolean(fundamentalsReport && !fundamentalsReport.stale),
          news: Boolean(news && !news.fromArchive && news.articles.length),
          holding: own.holding !== null,
          brief,
        };

        let aiNotice: string | undefined;
        let output: AnalysisOutput | null = null;
        if (report.plausibility.quality === 'invalid') {
          // An impossible quote (zero/negative price, high < low...) is never interpreted by the model.
          aiNotice = AI_NOTICE.invalidData;
          this.logger.warn(
            JSON.stringify({
              evt: 'QUOTE_QUALITY_REJECTED',
              symbol,
              quality: 'invalid',
              where: 'ai',
            }),
          );
        } else if (skipAi) {
          aiNotice = AI_NOTICE[skipAi];
        } else {
          const r = await this.runAi(
            ctx,
            () =>
              this.ai.analyze(buildAnalysisContext(report, extras), question, {
                userKey: ctx.user.id,
              }),
            { symbol, type: question ? 'QUESTION' : 'ANALYSIS', report },
          );
          output = r.output;
          if (r.notice) {
            aiNotice = AI_NOTICE[r.notice];
            // Timeouts/outages/overload would repeat for the remaining symbols: don't wait again.
            if (
              r.notice === 'timeout' ||
              r.notice === 'unavailable' ||
              r.notice === 'busy' ||
              r.notice === 'userBusy'
            ) {
              skipAi = r.notice;
            }
          }
        }
        text = question
          ? formatStockAnswer(report, output, question, { aiNotice })
          : formatAnalysis(report, output, extras, { aiNotice, brief });
      } catch (e) {
        if (!(e instanceof UserFacingError)) throw e;
        text = e.userMessage;
      }
      if (policyNotice && i === 0) text = `${POLICY_NOTICE}\n\n${text}`;

      // Stream finished symbols immediately so the user is not kept waiting for the whole batch.
      if (ctx.progress && i < symbols.length - 1) await ctx.progress(text);
      else out.push(text);
    }
    return out;
  }

  /* --------------------------------------------------------- comparison */

  async compare(ctx: HandlerContext): Promise<string[]> {
    if (ctx.intent.parameters.fundamental === true) return this.compareFundamentals(ctx);
    const symbols = ctx.intent.symbols;
    await ctx.progress?.(`⏳ Membandingkan ${symbols.map(escapeHtml).join(', ')}…`);
    const settled = await Promise.allSettled(symbols.map((s) => this.analysis.getReport(s)));
    const reports: FullTechnicalReport[] = [];
    const problems: string[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') reports.push(r.value);
      else {
        problems.push(
          r.reason instanceof UserFacingError
            ? r.reason.userMessage
            : `Data ${escapeHtml(symbols[i])} tidak dapat diambil.`,
        );
      }
    });
    if (reports.length < 2) {
      throw new UserFacingError(
        ['Perbandingan membutuhkan minimal dua saham dengan data valid.', ...problems].join('\n'),
        'COMPARE_INSUFFICIENT',
      );
    }
    ctx.log.provider = this.stocks.providerName;

    const { output, notice } = await this.runAi<ComparisonOutput>(ctx, () =>
      this.ai.compare(reports.map(buildComparisonEntry), { userKey: ctx.user.id }),
    );
    const lines = [formatComparison(reports, output)];
    if (problems.length) lines.push(problems.join('\n'));
    if (notice && notice !== 'unavailable') lines.push(`ℹ️ ${escapeHtml(AI_NOTICE[notice])}`);
    return [lines.join('\n\n')];
  }

  /* ---------------------------------------------------------- screening */

  async screen(ctx: HandlerContext): Promise<string[]> {
    const criteria = (ctx.intent.parameters.criteria ?? {}) as ScreenCriteria;
    // "saham apa yang bagus?" has no measurable criteria: explain what can be filtered instead of
    // inventing a ranking.
    if (isEmptyCriteria(criteria)) return [SCREEN_GUIDANCE];
    await ctx.progress?.('⏳ Memindai saham…');
    const result = await this.screener.run(criteria);
    ctx.log.provider = this.stocks.providerName;
    if (result.freshness) ctx.log.freshness = result.freshness.state;
    return [formatScreen(result)];
  }

  /* ------------------------------------------------------- data lookups */

  async foreignFlow(ctx: HandlerContext): Promise<string[]> {
    const out: string[] = [];
    for (const symbol of ctx.intent.symbols) {
      out.push(formatForeignFlow(symbol, await this.stocks.getForeignFlow(symbol)));
    }
    return out;
  }

  brokerSummary(ctx: HandlerContext): Promise<string[]> {
    return Promise.resolve(
      ctx.intent.symbols.map(
        (s) =>
          `🏢 <b>Broker Summary ${escapeHtml(s)}</b>\n\nData broker summary tidak tersedia dari provider saat ini. ${UNSUPPORTED_MESSAGE}`,
      ),
    );
  }

  /** Fundamentals with provenance: reported / estimated / derived / stale, missing listed. */
  async fundamentals(ctx: HandlerContext): Promise<string[]> {
    const out: string[] = [];
    for (const symbol of ctx.intent.symbols) {
      const quote = await this.stocks.getQuote(symbol);
      if (!quote.available && quote.code === 'NOT_FOUND') {
        out.push(unavailableToError(symbol, quote).userMessage);
        continue;
      }
      const report = await this.fundamentalsSvc.getReport(symbol);
      ctx.log.fundamentals = report
        ? { fromSnapshot: report.fromSnapshot, stale: report.stale, missing: report.missing.length }
        : 'none';
      out.push(
        report
          ? formatFundamentalsReport(report)
          : `🏦 <b>Fundamental ${escapeHtml(symbol)}</b>\n\nData fundamental belum tersedia dari provider saat ini, dan Indonesian Stock Bot belum punya snapshot tersimpan untuk saham ini.`,
      );
    }
    return out;
  }

  /** "bandingkan fundamental BBCA BBRI": the same metrics side by side, deterministic. */
  private async compareFundamentals(ctx: HandlerContext): Promise<string[]> {
    const reports = await Promise.all(
      ctx.intent.symbols.map((s) => this.fundamentalsSvc.getReport(s)),
    );
    const found = reports.filter((r): r is NonNullable<typeof r> => r !== null);
    const none = ctx.intent.symbols.filter((_, i) => reports[i] === null);
    const out: string[] = [];
    if (found.length >= 2) out.push(formatFundamentalsComparison(found));
    else if (found.length === 1) out.push(formatFundamentalsReport(found[0]));
    if (none.length > 0) {
      out.push(
        `Data fundamental tidak tersedia untuk ${none.map(escapeHtml).join(', ')} (provider tidak menyediakannya dan tidak ada snapshot).`,
      );
    }
    return out;
  }

  async marketStatus(ctx: HandlerContext): Promise<string[]> {
    const status = this.market.getStatus();
    const index = ctx.intent.parameters.includeIndex
      ? await this.stocks.getIndexQuote()
      : undefined;
    return [formatMarketStatus(status, this.market.describe(), index)];
  }

  /** The asking user's own position and watchlist membership: private chat only, never anyone else's. */
  private async ownContext(
    ctx: HandlerContext,
    symbol: string,
    report: FullTechnicalReport,
  ): Promise<{ holding: HoldingContext | null; onWatchlist: boolean }> {
    if (ctx.chat.type !== 'private') return { holding: null, onWatchlist: false };
    try {
      // database only: the whole-portfolio valuation would spend provider quota on every other holding
      const [held, symbols] = await Promise.all([
        this.portfolio.holdingOf(ctx.user.id, symbol),
        this.watchlist.symbols(ctx.user.id),
      ]);
      let holding: HoldingContext | null = null;
      if (held) {
        const avg = Number(held.avgCost);
        const price = report.plausibility.ok && !report.quoteStale ? report.quote.price : null;
        holding = {
          lots: Number(held.quantity) / 100,
          avgPrice: avg,
          unrealizedPct:
            price !== null && avg > 0 ? Number((((price - avg) / avg) * 100).toFixed(2)) : null,
        };
      }
      return { holding, onWatchlist: symbols.includes(symbol) };
    } catch (e) {
      this.logger.debug(`own context skipped: ${safeErrorMessage(e)}`);
      return { holding: null, onWatchlist: false };
    }
  }

  /** "ringkas portofolio saya": the model picks from a catalogue built from the user's own ledger. */
  async portfolioSummary(ctx: HandlerContext): Promise<string[]> {
    const view = await this.portfolio.view(ctx.user.id);
    if (view.holdings.length === 0 && Number(view.totals.cash) === 0) {
      return ['Belum ada catatan portofolio. Mulai dengan "beli 10 lot BBCA di 9000".'];
    }
    const claims = portfolioClaims(view);
    const context = {
      kind: 'portfolio',
      facts: claims.observations,
      claims: {
        observations: observationClaims(claims.observations),
        risks: riskClaims([...claims.risks, GENERIC_RISK]),
      },
      numbers: claims.numbers,
      knownDataLimitations: [
        'Ringkasan hanya dari catatan yang kamu masukkan sendiri dan harga tepercaya terakhir.',
      ],
    };
    const r = await this.runAi(ctx, () =>
      this.ai.analyze(context, undefined, { userKey: ctx.user.id }),
    );
    return [formatPortfolioSummary(view, r.output, r.notice ? AI_NOTICE[r.notice] : undefined)];
  }

  /** Headlines as data: dated, sourced, tagged; archive when the provider is down. */
  async news(ctx: HandlerContext): Promise<string[]> {
    const out: string[] = [];
    for (const symbol of ctx.intent.symbols) {
      const quote = await this.stocks.getQuote(symbol);
      if (!quote.available && quote.code === 'NOT_FOUND') {
        out.push(unavailableToError(symbol, quote).userMessage);
        continue;
      }
      const report = await this.newsSvc.getNews(symbol);
      ctx.log.news = { articles: report.articles.length, fromArchive: report.fromArchive };
      out.push(formatNews(report));
    }
    return out;
  }

  /** Related headlines for a question about one stock; empty when there are none. Never throws. */
  async relatedNews(ctx: HandlerContext): Promise<string[]> {
    if (ctx.intent.symbols.length !== 1) return [];
    try {
      const report = await this.newsSvc.getNews(ctx.intent.symbols[0]);
      const block = formatRelatedNews(report);
      if (block) ctx.log.relatedNews = report.articles.length;
      return block ? [block] : [];
    } catch (e) {
      this.logger.debug(`related news skipped: ${safeErrorMessage(e)}`);
      return [];
    }
  }

  /* ---------------------------------------------------------- internals */

  /** Runs `render` for every requested symbol; per-symbol user errors become that symbol's message. */
  private async eachReport(
    ctx: HandlerContext,
    render: (report: FullTechnicalReport) => string,
  ): Promise<string[]> {
    const out: string[] = [];
    for (const symbol of ctx.intent.symbols) {
      try {
        const report = await this.analysis.getReport(symbol);
        ctx.log.provider = this.stocks.providerName;
        ctx.log.freshness = report.freshness.state;
        out.push(render(report));
      } catch (e) {
        if (!(e instanceof UserFacingError)) throw e;
        out.push(e.userMessage);
      }
    }
    return out;
  }

  /**
   * Runs an AI call if health and the per-user budget allow. Always resolves: `output` is null when
   * AI is unavailable / over budget / too slow / busy / rejected by the output policy, together
   * with the kind of notice to show, so callers fall back to deterministic output.
   */
  private async runAi<T extends AnalysisOutput | ComparisonOutput>(
    ctx: HandlerContext,
    call: () => Promise<AIResult<T>>,
    persist?: { symbol: string; type: string; report: FullTechnicalReport },
  ): Promise<{ output: T | null; notice?: AiNoticeKind }> {
    const health = await this.ai.checkHealth();
    if (!health.available) {
      ctx.log.ai = { provider: this.ai.providerName, status: 'unavailable' };
      return { output: null, notice: 'unavailable' };
    }
    if (!(await this.quota.tryUse(ctx.user.id, 'analysis'))) {
      ctx.log.ai = { provider: this.ai.providerName, status: 'quota' };
      return { output: null, notice: 'quota' };
    }
    const res = await call();
    if (!res.ok) {
      ctx.log.ai = { provider: this.ai.providerName, status: res.reason };
      return { output: null, notice: noticeFor(res.reason) };
    }
    ctx.log.ai = {
      provider: res.provider,
      model: res.model,
      execMs: res.latencyMs,
      queueWaitMs: res.queueWaitMs,
      attempts: res.attempts,
    };
    if (persist) this.background.run(this.store(ctx.user.id, persist, res.value, res));
    return { output: res.value };
  }

  private async store(
    userId: string,
    p: { symbol: string; type: string; report: FullTechnicalReport },
    output: AnalysisOutput | ComparisonOutput,
    meta: { provider: string; model: string | null; latencyMs: number },
  ): Promise<void> {
    try {
      const stockId = await this.stocks.ensureStock(p.symbol);
      await this.prisma.aIAnalysis.create({
        data: {
          userId,
          stockId,
          analysisType: p.type,
          inputSnapshot: JSON.parse(JSON.stringify(buildAnalysisContext(p.report))),
          output: JSON.parse(JSON.stringify(output)),
          provider: meta.provider,
          model: meta.model,
          latencyMs: meta.latencyMs,
        },
      });
    } catch (e) {
      this.logger.warn(`store analysis failed: ${safeErrorMessage(e)}`);
    }
  }
}
