import { PortfolioTxType } from '@prisma/client';
import { PortfolioTotals, ValuedHolding } from './portfolio-accounting';

export interface RecordInput {
  type: Exclude<PortfolioTxType, 'REVERSAL'>;
  /** Required for BUY/SELL/DIVIDEND (DIVIDEND may omit it for a cash-only entry). */
  symbol?: string;
  /** Shares, for BUY/SELL. */
  quantity?: number;
  /** Price per share, for BUY/SELL. */
  price?: number;
  fees?: number;
  /** Cash amount for DIVIDEND/DEPOSIT/WITHDRAWAL. */
  amount?: number;
  /** Same key = same transaction; a repeat returns the first row instead of creating another. */
  idempotencyKey: string;
  chatId: number;
  note?: string;
}

export interface RecordResult {
  transactionId: string;
  type: PortfolioTxType;
  symbol: string | null;
  quantity: number | null;
  price: number | null;
  fees: number;
  cashDelta: number;
  realizedPnl: number;
  /** The holding after the transaction (BUY/SELL). */
  holding: { quantity: number; avgCost: number } | null;
  cash: number;
  /** True when the idempotency key was seen before: nothing new was recorded. */
  duplicate: boolean;
}

export interface PortfolioView {
  name: string;
  holdings: ValuedHolding[];
  totals: PortfolioTotals;
  /** Symbols whose quote was not trusted (valued at cost), with the reason. */
  unpriced: Array<{ symbol: string; reason: string }>;
  /** Newest quote timestamp among the trusted prices, for the freshness line. */
  newestQuoteAt: string | null;
  anyStale: boolean;
}

export interface LedgerRow {
  id: string;
  type: PortfolioTxType;
  symbol: string | null;
  quantity: number | null;
  price: number | null;
  fees: number;
  cashDelta: number;
  realizedPnl: number;
  occurredAt: Date;
  reversed: boolean;
  reversesId: string | null;
}
