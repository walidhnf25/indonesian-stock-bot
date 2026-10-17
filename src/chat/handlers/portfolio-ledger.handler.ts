import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PortfolioParameters } from '../../intent/intent.types';
import { PortfolioService } from '../../portfolio/portfolio.service';
import {
  formatPortfolioHistory,
  formatPortfolioView,
  formatTransactionRecorded,
} from '../../telegram/telegram-response';
import { HandlerContext } from '../chat.types';

export const PORTFOLIO_PRIVATE_ONLY =
  'Portofolio hanya bisa dicatat dan dilihat di chat pribadi dengan saya, bukan di grup.';

/**
 * Portfolio bookkeeping from chat. Every mutation comes from the deterministic parser (the AI
 * classifier cannot produce these intents); the service does the accounting; this handler only formats.
 */
@Injectable()
export class PortfolioLedgerHandler {
  constructor(private readonly portfolio: PortfolioService) {}

  async record(ctx: HandlerContext): Promise<string[]> {
    const p = ctx.intent.parameters as unknown as PortfolioParameters;
    if (ctx.intent.clarification) return [ctx.intent.clarification];
    const symbol = ctx.intent.symbols[0];
    if ((p.txType === 'BUY' || p.txType === 'SELL') && ctx.intent.symbols.length > 1) {
      return ['Catat satu saham per pesan, mis. "beli 10 lot BBCA di 9000".'];
    }
    const r = await this.portfolio.record(ctx.user.id, {
      type: p.txType,
      symbol: p.txType === 'BUY' || p.txType === 'SELL' ? symbol : ctx.intent.symbols[0],
      quantity: p.quantity,
      price: p.price,
      fees: p.fees,
      amount: p.amount,
      idempotencyKey: idempotencyKeyOf(ctx),
      chatId: ctx.chat.id,
    });
    return [formatTransactionRecorded(r)];
  }

  async undo(ctx: HandlerContext): Promise<string[]> {
    const r = await this.portfolio.undoLast(ctx.user.id, idempotencyKeyOf(ctx), ctx.chat.id);
    return [formatTransactionRecorded(r)];
  }

  async view(ctx: HandlerContext): Promise<string[]> {
    return [formatPortfolioView(await this.portfolio.view(ctx.user.id))];
  }

  async history(ctx: HandlerContext): Promise<string[]> {
    return [formatPortfolioHistory(await this.portfolio.history(ctx.user.id, 10))];
  }
}

/**
 * The Telegram message id makes a retried/duplicated update record once; a caller without one (CLI, tests)
 * gets a key from the text within a one-minute bucket, so the same sentence twice in a minute is one record.
 */
export function idempotencyKeyOf(ctx: HandlerContext): string {
  if (ctx.messageId !== undefined) return `tg:${ctx.chat.id}:${ctx.messageId}`;
  const minute = Math.floor(Date.now() / 60_000);
  const digest = createHash('sha256')
    .update(`${ctx.user.id}|${ctx.intent.text}|${minute}`)
    .digest('hex');
  return `txt:${digest.slice(0, 32)}`;
}
