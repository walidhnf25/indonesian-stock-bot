import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { StockService } from '../stock/stock.service';
import { DataResult, NormalizedQuote } from '../stock/stock.types';

export const MAX_WATCHLIST_ITEMS = 30;

export interface WatchlistAddResult {
  added: string[];
  alreadyThere: string[];
  invalid: string[];
  /** Added but not verified because the data provider was unreachable. */
  unverified: string[];
  limitReached: string[];
}

export interface WatchlistRemoveResult {
  removed: string[];
  notFound: string[];
}

export interface WatchlistEntry {
  symbol: string;
  quote: DataResult<NormalizedQuote> | null;
}

@Injectable()
export class WatchlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stocks: StockService,
  ) {}

  private async defaultList(userId: string) {
    return this.prisma.watchlist.upsert({
      where: { userId_name: { userId, name: 'Default' } },
      create: { userId, name: 'Default' },
      update: {},
    });
  }

  async add(userId: string, symbols: string[]): Promise<WatchlistAddResult> {
    const list = await this.defaultList(userId);
    const result: WatchlistAddResult = {
      added: [],
      alreadyThere: [],
      invalid: [],
      unverified: [],
      limitReached: [],
    };
    let count = await this.prisma.watchlistItem.count({ where: { watchlistId: list.id } });

    for (const symbol of symbols) {
      const existing = await this.prisma.watchlistItem.findFirst({
        where: { watchlistId: list.id, stock: { symbol } },
      });
      if (existing) {
        result.alreadyThere.push(symbol);
        continue;
      }
      if (count >= MAX_WATCHLIST_ITEMS) {
        result.limitReached.push(symbol);
        continue;
      }
      const verdict = await this.stocks.validateSymbol(symbol);
      if (verdict === 'invalid') {
        result.invalid.push(symbol);
        continue;
      }
      const q = await this.stocks.getQuote(symbol);
      const stockId = await this.stocks.ensureStock(symbol, q.available ? q.data.name : null);
      await this.prisma.watchlistItem.create({ data: { watchlistId: list.id, stockId } });
      count++;
      result.added.push(symbol);
      if (verdict === 'unknown') result.unverified.push(symbol);
    }
    return result;
  }

  async remove(userId: string, symbols: string[]): Promise<WatchlistRemoveResult> {
    const list = await this.defaultList(userId);
    const result: WatchlistRemoveResult = { removed: [], notFound: [] };
    for (const symbol of symbols) {
      const { count } = await this.prisma.watchlistItem.deleteMany({
        where: { watchlistId: list.id, stock: { symbol } },
      });
      (count > 0 ? result.removed : result.notFound).push(symbol);
    }
    return result;
  }

  async symbols(userId: string): Promise<string[]> {
    const list = await this.defaultList(userId);
    const items = await this.prisma.watchlistItem.findMany({
      where: { watchlistId: list.id },
      include: { stock: true },
      orderBy: { createdAt: 'asc' },
    });
    return items.map((i) => i.stock.symbol);
  }

  /** Watchlist with latest quotes (cached/batched). */
  async list(userId: string): Promise<WatchlistEntry[]> {
    const symbols = await this.symbols(userId);
    if (symbols.length === 0) return [];
    const quotes = await this.stocks.getQuotes(symbols);
    return symbols.map((symbol) => ({ symbol, quote: quotes.get(symbol) ?? null }));
  }
}
