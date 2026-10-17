import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Ip,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { buildAnalysisContext } from '../ai/ai-context';
import { AiQuotaService } from '../ai/ai-quota.service';
import { AIService } from '../ai/ai.service';
import { AnalysisService, unavailableToError } from '../analysis/analysis.service';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { SymbolPipe } from '../common/pipes/symbol.pipe';
import { StockService } from '../stock/stock.service';
import { HistoryQueryDto } from './dto/history-query.dto';

@UseGuards(RateLimitGuard)
@Controller()
export class StockController {
  constructor(
    private readonly stocks: StockService,
    private readonly analysis: AnalysisService,
    private readonly ai: AIService,
    private readonly quota: AiQuotaService,
  ) {}

  @Get('stocks/:symbol')
  async quote(@Param('symbol', SymbolPipe) symbol: string) {
    const res = await this.stocks.getQuote(symbol);
    if (!res.available) throw unavailableToError(symbol, res);
    return {
      symbol,
      quote: res.data,
      source: res.source,
      stale: res.stale,
      fetchedAt: res.fetchedAt,
    };
  }

  @Get('stocks/:symbol/technical')
  async technical(@Param('symbol', SymbolPipe) symbol: string) {
    const r = await this.analysis.getReport(symbol);
    return {
      symbol,
      price: r.quote.price,
      quoteTimestamp: r.quote.timestamp,
      source: r.quoteSource,
      stale: r.quoteStale || r.historyStale,
      indicators: r.technical.snapshot,
      classification: r.technical.classification,
      support: r.technical.support,
      resistance: r.technical.resistance,
      candleCount: r.technical.candleCount,
    };
  }

  @Get('stocks/:symbol/history')
  async history(@Param('symbol', SymbolPipe) symbol: string, @Query() query: HistoryQueryDto) {
    const res = await this.stocks.getHistory(symbol, query.range ?? '3mo');
    if (!res.available) throw unavailableToError(symbol, res);
    return {
      symbol,
      range: query.range ?? '3mo',
      candles: res.data,
      source: res.source,
      stale: res.stale,
    };
  }

  @Post('analysis/:symbol')
  async analyze(@Param('symbol', SymbolPipe) symbol: string, @Ip() ip: string) {
    // Same AI budget as a Telegram user, per caller address; and a caller's own fairness key instead of
    // one shared key for every REST client.
    const caller = `rest:${ip || 'unknown'}`;
    if (!(await this.quota.tryUse(caller, 'analysis'))) {
      throw new HttpException(
        { statusCode: 429, message: 'Batas penggunaan AI per menit tercapai. Coba lagi sebentar.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const report = await this.analysis.getReport(symbol);
    const context = buildAnalysisContext(report);
    const health = await this.ai.checkHealth();
    const aiResult = health.available
      ? await this.ai.analyze(context, undefined, { userKey: caller })
      : null;
    return {
      symbol,
      technical: {
        classification: report.technical.classification,
        indicators: report.technical.snapshot,
        support: report.technical.support,
        resistance: report.technical.resistance,
      },
      ai: aiResult?.ok
        ? {
            available: true,
            provider: aiResult.provider,
            model: aiResult.model,
            output: aiResult.value,
          }
        : {
            available: false,
            reason: health.available
              ? aiResult && !aiResult.ok
                ? aiResult.reason
                : 'unknown'
              : 'unavailable',
          },
      dataTimestamp: report.quote.timestamp,
      stale: report.quoteStale || report.historyStale,
      disclaimer:
        'Informasi ini bersifat edukasi dan analisis berbasis data, bukan rekomendasi investasi.',
    };
  }
}
