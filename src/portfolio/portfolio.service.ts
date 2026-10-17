import { Injectable, Logger } from '@nestjs/common';
import { Holding, Portfolio, PortfolioTransaction, Prisma } from '@prisma/client';
import { UserFacingError } from '../common/exceptions/app-errors';
import { safeErrorMessage } from '../common/utils/scrub';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../database/prisma.service';
import { DataQualityService } from '../market/data-quality.service';
import { StockService } from '../stock/stock.service';
import {
  AccountingError,
  D,
  HoldingState,
  ZERO,
  applyBuy,
  applySell,
  d,
  totals,
  valueHolding,
} from './portfolio-accounting';
import { LedgerRow, PortfolioView, RecordInput, RecordResult } from './portfolio.types';

const DEFAULT_NAME = 'Utama';
/** Transactions this old can no longer be undone from chat. */
const UNDO_WINDOW_MS = 24 * 3_600_000;
const MAX_SHARES = 1_000_000_000_000;
const MAX_MONEY = 1_000_000_000_000_000;

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * Portfolio ledger and valuation. Rules:
 *  - every query is scoped by the authenticated user id (a portfolio id is never taken from input);
 *  - the ledger is append-only; mistakes are undone by a REVERSAL row that restores the exact prior state;
 *  - all writes of one user run under a per-user advisory lock in one transaction, with an idempotency key,
 *    so a retried or duplicated message cannot double-record;
 *  - valuation uses only TRUSTED quotes; anything else is valued at cost and said so;
 *  - the AI never calls this service to change anything, and only reads already computed numbers.
 */
@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);
  private readonly maxHoldings: number;
  private readonly maxTxPerDay: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stocks: StockService,
    private readonly quality: DataQualityService,
    config: AppConfig,
  ) {
    this.maxHoldings = config.get('PORTFOLIO_MAX_HOLDINGS');
    this.maxTxPerDay = config.get('PORTFOLIO_MAX_TRANSACTIONS_PER_DAY');
  }

  /* ----------------------------------------------------------------- write */

  async record(userId: string, input: RecordInput): Promise<RecordResult> {
    this.validate(input);
    let stockId: string | null = null;
    if (input.symbol) {
      if (input.type === 'BUY' || input.type === 'SELL') {
        // the ticker must exist: a typo must not create a phantom holding
        const verdict = await this.stocks.validateSymbol(input.symbol);
        if (verdict === 'invalid') {
          throw new UserFacingError(`Ticker ${input.symbol} tidak ditemukan.`, 'INVALID_TICKER');
        }
      }
      const q = await this.stocks.getQuote(input.symbol);
      stockId = await this.stocks.ensureStock(input.symbol, q.available ? q.data.name : null);
    }

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await this.lock(tx, userId);
          const portfolio = await this.ensurePortfolio(tx, userId);
          const existing = await tx.portfolioTransaction.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
            include: { stock: true },
          });
          if (existing) {
            return this.toResult(existing, portfolio, null, true);
          }
          await this.checkDailyLimit(tx, portfolio.id);
          return this.applyRecord(tx, portfolio, stockId, input);
        },
        { maxWait: 5_000, timeout: 15_000 },
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        const existing = await this.prisma.portfolioTransaction.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          include: { stock: true, portfolio: true },
        });
        if (existing) return this.toResult(existing, existing.portfolio, null, true);
      }
      if (e instanceof AccountingError) throw new UserFacingError(e.message, 'PORTFOLIO_INVALID');
      throw e;
    }
  }

  /** Undoes the newest transaction (within 24 h) by appending its exact reversal. */
  async undoLast(userId: string, idempotencyKey: string, chatId: number): Promise<RecordResult> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await this.lock(tx, userId);
          const portfolio = await this.ensurePortfolio(tx, userId);
          const existing = await tx.portfolioTransaction.findUnique({
            where: { idempotencyKey },
            include: { stock: true },
          });
          if (existing) return this.toResult(existing, portfolio, null, true);
          const last = await tx.portfolioTransaction.findFirst({
            where: { portfolioId: portfolio.id },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            include: { stock: true },
          });
          if (!last)
            throw new UserFacingError(
              'Belum ada transaksi yang bisa dibatalkan.',
              'PORTFOLIO_EMPTY',
            );
          if (last.type === 'REVERSAL') {
            throw new UserFacingError(
              'Transaksi terakhir adalah pembatalan; tidak ada yang bisa dibatalkan lagi.',
              'PORTFOLIO_EMPTY',
            );
          }
          const reversed = await tx.portfolioTransaction.findUnique({
            where: { reversesId: last.id },
          });
          if (reversed)
            throw new UserFacingError('Transaksi terakhir sudah dibatalkan.', 'PORTFOLIO_EMPTY');
          if (Date.now() - last.createdAt.getTime() > UNDO_WINDOW_MS) {
            throw new UserFacingError(
              'Hanya transaksi dalam 24 jam terakhir yang bisa dibatalkan dari chat.',
              'PORTFOLIO_UNDO_WINDOW',
            );
          }
          return this.applyReversal(tx, portfolio, last, idempotencyKey, chatId);
        },
        { maxWait: 5_000, timeout: 15_000 },
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        const existing = await this.prisma.portfolioTransaction.findUnique({
          where: { idempotencyKey },
          include: { stock: true, portfolio: true },
        });
        if (existing) return this.toResult(existing, existing.portfolio, null, true);
      }
      throw e;
    }
  }

  /* ------------------------------------------------------------------ read */

  /**
   * One holding of the user, from the database only: the analysis card needs just this
   * row, not a valuation of the whole portfolio (which would spend provider quota on every other stock).
   */
  async holdingOf(
    userId: string,
    symbol: string,
  ): Promise<{ quantity: D; avgCost: D; costBasis: D } | null> {
    const row = await this.prisma.holding.findFirst({
      where: { portfolio: { userId, name: DEFAULT_NAME }, stock: { symbol }, quantity: { gt: 0 } },
      select: { quantity: true, avgCost: true, costBasis: true },
    });
    return row;
  }

  async view(userId: string): Promise<PortfolioView> {
    const portfolio = await this.prisma.portfolio.findUnique({
      where: { userId_name: { userId, name: DEFAULT_NAME } },
      include: { holdings: { include: { stock: true }, orderBy: { updatedAt: 'asc' } } },
    });
    const held = (portfolio?.holdings ?? []).filter((h) => h.quantity.gt(0));
    const quotes = held.length
      ? await this.stocks.getQuotes(
          held.map((h) => h.stock.symbol),
          { fallback: true },
        )
      : new Map();
    const unpriced: PortfolioView['unpriced'] = [];
    let newest: string | null = null;
    let anyStale = false;
    const valued = held.map((h) => {
      const q = quotes.get(h.stock.symbol);
      let price: D | null = null;
      if (q && q.available) {
        const plausibility = this.quality.plausibilityOf(q.data);
        if (plausibility.quality === 'trusted') {
          price = d(q.data.price);
          if (!newest || q.data.timestamp > newest) newest = q.data.timestamp;
          if (q.stale) anyStale = true;
        } else {
          unpriced.push({ symbol: h.stock.symbol, reason: 'harga terlihat tidak wajar' });
        }
      } else {
        unpriced.push({ symbol: h.stock.symbol, reason: 'harga tidak tersedia' });
      }
      return valueHolding(
        h.stock.symbol,
        {
          quantity: h.quantity,
          avgCost: h.avgCost,
          costBasis: h.costBasis,
          realizedPnl: h.realizedPnl,
        },
        price,
      );
    });
    const dividends = portfolio
      ? await this.prisma.portfolioTransaction.aggregate({
          where: { portfolioId: portfolio.id, type: 'DIVIDEND' },
          _sum: { cashDelta: true },
        })
      : null;
    const reversedDividends = portfolio
      ? await this.prisma.portfolioTransaction.aggregate({
          where: {
            portfolioId: portfolio.id,
            type: 'REVERSAL',
            note: { startsWith: 'reverses DIVIDEND' },
          },
          _sum: { cashDelta: true },
        })
      : null;
    const dividendTotal = (dividends?._sum.cashDelta ?? ZERO).add(
      reversedDividends?._sum.cashDelta ?? ZERO,
    );
    return {
      name: portfolio?.name ?? DEFAULT_NAME,
      holdings: valued,
      totals: totals(
        valued,
        portfolio?.cash ?? ZERO,
        portfolio?.realizedPnl ?? ZERO,
        dividendTotal,
      ),
      unpriced,
      newestQuoteAt: newest,
      anyStale,
    };
  }

  async history(userId: string, limit = 10): Promise<LedgerRow[]> {
    const portfolio = await this.prisma.portfolio.findUnique({
      where: { userId_name: { userId, name: DEFAULT_NAME } },
    });
    if (!portfolio) return [];
    const rows = await this.prisma.portfolioTransaction.findMany({
      where: { portfolioId: portfolio.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(50, Math.max(1, limit)),
      include: { stock: true },
    });
    const reversals = await this.prisma.portfolioTransaction.findMany({
      where: { reversesId: { in: rows.map((r) => r.id) } },
      select: { reversesId: true },
    });
    const reversedIds = new Set(reversals.map((r) => r.reversesId));
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      symbol: r.stock?.symbol ?? null,
      quantity: r.quantity ? r.quantity.toNumber() : null,
      price: r.price ? r.price.toNumber() : null,
      fees: r.fees.toNumber(),
      cashDelta: r.cashDelta.toNumber(),
      realizedPnl: r.realizedPnl.toNumber(),
      occurredAt: r.occurredAt,
      reversed: reversedIds.has(r.id),
      reversesId: r.reversesId,
    }));
  }

  /** Writes today's snapshot (Asia/Jakarta calendar day) for every portfolio with holdings or cash. */
  async snapshotAll(now = new Date()): Promise<number> {
    const day = jakartaDay(now);
    const portfolios = await this.prisma.portfolio.findMany({ select: { id: true, userId: true } });
    let written = 0;
    for (const p of portfolios) {
      try {
        const v = await this.view(p.userId);
        if (v.holdings.length === 0 && v.totals.cash.isZero()) continue;
        await this.prisma.portfolioSnapshot.upsert({
          where: { portfolioId_asOf: { portfolioId: p.id, asOf: day } },
          create: {
            portfolioId: p.id,
            asOf: day,
            marketValue: v.totals.marketValue,
            cash: v.totals.cash,
            costBasis: v.totals.costBasis,
            unrealizedPnl: v.totals.unrealizedPnl,
            realizedPnl: v.totals.realizedPnl,
            unpriced: v.totals.unpriced,
          },
          update: {
            marketValue: v.totals.marketValue,
            cash: v.totals.cash,
            costBasis: v.totals.costBasis,
            unrealizedPnl: v.totals.unrealizedPnl,
            realizedPnl: v.totals.realizedPnl,
            unpriced: v.totals.unpriced,
          },
        });
        written++;
      } catch (e) {
        this.logger.warn(`snapshot failed for one portfolio: ${safeErrorMessage(e)}`);
      }
    }
    return written;
  }

  /* ------------------------------------------------------------- internals */

  private validate(input: RecordInput): void {
    const money = (label: string, v: number | undefined, required: boolean) => {
      if (v === undefined) {
        if (required) throw new UserFacingError(`${label} belum disebut.`, 'PORTFOLIO_INVALID');
        return;
      }
      if (!Number.isFinite(v) || v < 0 || v > MAX_MONEY) {
        throw new UserFacingError(`${label} tidak masuk akal.`, 'PORTFOLIO_INVALID');
      }
    };
    switch (input.type) {
      case 'BUY':
      case 'SELL': {
        if (!input.symbol)
          throw new UserFacingError('Saham mana yang kamu maksud?', 'PORTFOLIO_INVALID');
        const q = input.quantity;
        if (
          q === undefined ||
          !Number.isFinite(q) ||
          q <= 0 ||
          q > MAX_SHARES ||
          !Number.isInteger(q)
        ) {
          throw new UserFacingError(
            'Jumlah lembar harus bilangan bulat positif (1 lot = 100 lembar).',
            'PORTFOLIO_INVALID',
          );
        }
        if (input.price === undefined || !Number.isFinite(input.price) || input.price <= 0) {
          throw new UserFacingError('Harga per lembar harus lebih dari 0.', 'PORTFOLIO_INVALID');
        }
        money('Harga', input.price, true);
        money('Biaya', input.fees, false);
        return;
      }
      case 'DIVIDEND':
      case 'DEPOSIT':
      case 'WITHDRAWAL':
        money('Jumlah', input.amount, true);
        if ((input.amount as number) <= 0) {
          throw new UserFacingError('Jumlah harus lebih dari 0.', 'PORTFOLIO_INVALID');
        }
        return;
      default:
        throw new UserFacingError('Jenis transaksi tidak dikenal.', 'PORTFOLIO_INVALID');
    }
  }

  private async lock(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'portfolio:' + userId}, 0))`;
  }

  private async ensurePortfolio(tx: Prisma.TransactionClient, userId: string): Promise<Portfolio> {
    return tx.portfolio.upsert({
      where: { userId_name: { userId, name: DEFAULT_NAME } },
      create: { userId, name: DEFAULT_NAME },
      update: {},
    });
  }

  private async checkDailyLimit(tx: Prisma.TransactionClient, portfolioId: string): Promise<void> {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const n = await tx.portfolioTransaction.count({
      where: { portfolioId, createdAt: { gte: since } },
    });
    if (n >= this.maxTxPerDay) {
      throw new UserFacingError(
        `Batas ${this.maxTxPerDay} transaksi per hari tercapai. Coba lagi besok.`,
        'PORTFOLIO_LIMIT',
      );
    }
  }

  private async applyRecord(
    tx: Prisma.TransactionClient,
    portfolio: Portfolio,
    stockId: string | null,
    input: RecordInput,
  ): Promise<RecordResult> {
    let holdingAfter: HoldingState | null = null;
    let before: HoldingState | null = null;
    let cashDelta: D;
    let realized = ZERO;
    let holdingRow: Holding | null = null;

    if (input.type === 'BUY' || input.type === 'SELL') {
      holdingRow = await tx.holding.findUnique({
        where: { portfolioId_stockId: { portfolioId: portfolio.id, stockId: stockId as string } },
      });
      before = holdingRow
        ? {
            quantity: holdingRow.quantity,
            avgCost: holdingRow.avgCost,
            costBasis: holdingRow.costBasis,
          }
        : null;
      const qty = d(input.quantity as number);
      const price = d(input.price as number);
      const fees = d(input.fees ?? 0);
      if (input.type === 'BUY') {
        if (!holdingRow || holdingRow.quantity.isZero()) {
          const open = await tx.holding.count({
            where: { portfolioId: portfolio.id, quantity: { gt: 0 } },
          });
          if (open >= this.maxHoldings) {
            throw new UserFacingError(
              `Batas ${this.maxHoldings} saham berbeda dalam portofolio tercapai.`,
              'PORTFOLIO_LIMIT',
            );
          }
        }
        const r = applyBuy(before, qty, price, fees);
        holdingAfter = r.holding;
        cashDelta = r.cashDelta;
      } else {
        const r = applySell(before, qty, price, fees);
        holdingAfter = r.holding;
        cashDelta = r.cashDelta;
        realized = r.realizedPnl;
      }
    } else {
      const amount = d(input.amount as number).toDecimalPlaces(2);
      if (input.type === 'WITHDRAWAL') {
        if (amount.gt(portfolio.cash)) {
          throw new UserFacingError(
            `Kas yang tercatat hanya ${portfolio.cash.toFixed(0)}; penarikan ${amount.toFixed(0)} tidak bisa dicatat.`,
            'PORTFOLIO_INVALID',
          );
        }
        cashDelta = amount.neg();
      } else {
        cashDelta = amount;
      }
    }

    const row = await tx.portfolioTransaction.create({
      data: {
        portfolioId: portfolio.id,
        stockId,
        type: input.type,
        quantity: input.quantity !== undefined ? d(input.quantity) : null,
        price: input.price !== undefined ? d(input.price) : null,
        fees: d(input.fees ?? 0),
        cashDelta,
        realizedPnl: realized,
        qtyBefore: before?.quantity ?? (holdingAfter ? ZERO : null),
        avgCostBefore: before?.avgCost ?? (holdingAfter ? ZERO : null),
        costBasisBefore: before?.costBasis ?? (holdingAfter ? ZERO : null),
        note: input.note?.slice(0, 120) ?? null,
        idempotencyKey: input.idempotencyKey,
        chatId: BigInt(input.chatId),
      },
      include: { stock: true },
    });
    if (holdingAfter && stockId) {
      await tx.holding.upsert({
        where: { portfolioId_stockId: { portfolioId: portfolio.id, stockId } },
        create: {
          portfolioId: portfolio.id,
          stockId,
          quantity: holdingAfter.quantity,
          avgCost: holdingAfter.avgCost,
          costBasis: holdingAfter.costBasis ?? ZERO,
          realizedPnl: realized,
        },
        update: {
          quantity: holdingAfter.quantity,
          avgCost: holdingAfter.avgCost,
          costBasis: holdingAfter.costBasis ?? ZERO,
          realizedPnl: { increment: realized },
        },
      });
    }
    const updated = await tx.portfolio.update({
      where: { id: portfolio.id },
      data: { cash: { increment: cashDelta }, realizedPnl: { increment: realized } },
    });
    return this.toResult(row, updated, holdingAfter, false);
  }

  private async applyReversal(
    tx: Prisma.TransactionClient,
    portfolio: Portfolio,
    last: PortfolioTransaction & { stock: { symbol: string } | null },
    idempotencyKey: string,
    chatId: number,
  ): Promise<RecordResult> {
    let holdingAfter: HoldingState | null = null;
    if ((last.type === 'BUY' || last.type === 'SELL') && last.stockId) {
      // exact restore of the state recorded before the last row (it is the newest row, so nothing came after)
      const qtyBefore = last.qtyBefore ?? ZERO;
      const avgBefore = last.avgCostBefore ?? ZERO;
      holdingAfter = {
        quantity: qtyBefore,
        avgCost: avgBefore,
        // rows written before the exact basis existed fall back to the rounded reconstruction
        costBasis: last.costBasisBefore ?? qtyBefore.mul(avgBefore).toDecimalPlaces(2),
      };
      await tx.holding.update({
        where: { portfolioId_stockId: { portfolioId: portfolio.id, stockId: last.stockId } },
        data: {
          quantity: holdingAfter.quantity,
          avgCost: holdingAfter.avgCost,
          costBasis: holdingAfter.costBasis,
          realizedPnl: { decrement: last.realizedPnl },
        },
      });
    }
    const row = await tx.portfolioTransaction.create({
      data: {
        portfolioId: portfolio.id,
        stockId: last.stockId,
        type: 'REVERSAL',
        quantity: last.quantity,
        price: last.price,
        fees: last.fees,
        cashDelta: last.cashDelta.neg(),
        realizedPnl: last.realizedPnl.neg(),
        reversesId: last.id,
        note: `reverses ${last.type}`,
        idempotencyKey,
        chatId: BigInt(chatId),
      },
      include: { stock: true },
    });
    const updated = await tx.portfolio.update({
      where: { id: portfolio.id },
      data: { cash: { decrement: last.cashDelta }, realizedPnl: { decrement: last.realizedPnl } },
    });
    return this.toResult(row, updated, holdingAfter, false);
  }

  private toResult(
    row: PortfolioTransaction & { stock: { symbol: string } | null },
    portfolio: Portfolio,
    holding: HoldingState | null,
    duplicate: boolean,
  ): RecordResult {
    return {
      transactionId: row.id,
      type: row.type,
      symbol: row.stock?.symbol ?? null,
      quantity: row.quantity ? row.quantity.toNumber() : null,
      price: row.price ? row.price.toNumber() : null,
      fees: row.fees.toNumber(),
      cashDelta: row.cashDelta.toNumber(),
      realizedPnl: row.realizedPnl.toNumber(),
      holding: holding
        ? { quantity: holding.quantity.toNumber(), avgCost: holding.avgCost.toNumber() }
        : null,
      cash: portfolio.cash.toNumber(),
      duplicate,
    };
  }
}

/** 00:00 UTC of the Asia/Jakarta calendar day of `now`. */
export function jakartaDay(now: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return new Date(`${parts}T00:00:00.000Z`);
}
