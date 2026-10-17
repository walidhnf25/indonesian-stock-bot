import { Prisma } from '@prisma/client';

/**
 * Pure, deterministic portfolio arithmetic. Average-cost method, fees included in cost on
 * purchase and deducted from proceeds on sale. Everything is Prisma.Decimal: money is never a float.
 * The AI never calls this; it only ever reads the results.
 */
export type D = Prisma.Decimal;
export const d = (v: Prisma.Decimal.Value): D => new Prisma.Decimal(v);
export const ZERO = d(0);

/** Shares per lot on the IDX. */
export const SHARES_PER_LOT = 100;

export interface HoldingState {
  quantity: D;
  /** Average cost per share, rounded to 4 dp: for display and for the ledger's "before" snapshot. */
  avgCost: D;
  /**
   * Exact cost of the shares held (money, 2 dp), the source of truth for the average. Deriving the next
   * average from the previous ROUNDED average made the result depend on the order concurrent buys were
   * applied in (1009.4999 vs 1009.5 for twenty buys at 1000..1019). Optional only for callers that still
   * hold the old shape; then it is reconstructed as quantity * avgCost.
   */
  costBasis?: D;
}

/** The exact basis of a state, reconstructed from the rounded average when a caller did not carry it. */
export function basisOf(current: HoldingState | null): D {
  if (!current) return ZERO;
  return current.costBasis ?? money(current.quantity.mul(current.avgCost));
}

export interface BuyResult {
  holding: HoldingState;
  /** Negative: cash leaves the portfolio. */
  cashDelta: D;
}

export interface SellResult {
  holding: HoldingState;
  /** Positive: proceeds after fees. */
  cashDelta: D;
  realizedPnl: D;
}

const money = (v: D): D => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_EVEN);
const perShare = (v: D): D => v.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_EVEN);

export class AccountingError extends Error {
  constructor(
    message: string,
    readonly code: 'INSUFFICIENT_SHARES' | 'INSUFFICIENT_CASH' | 'INVALID_INPUT',
  ) {
    super(message);
    this.name = 'AccountingError';
  }
}

function assertPositive(label: string, v: D, allowZero = false): void {
  if (!v.isFinite() || v.isNegative() || (!allowZero && v.isZero())) {
    throw new AccountingError(`${label} harus lebih dari 0.`, 'INVALID_INPUT');
  }
}

/** New average cost after buying `quantity` shares at `price` with `fees` (fees are capitalised). */
export function applyBuy(current: HoldingState | null, quantity: D, price: D, fees: D): BuyResult {
  assertPositive('Jumlah', quantity);
  assertPositive('Harga', price);
  assertPositive('Biaya', fees, true);
  const prevQty = current?.quantity ?? ZERO;
  const cost = money(quantity.mul(price).add(fees));
  const newQty = prevQty.add(quantity);
  const costBasis = money(basisOf(current).add(cost));
  const newAvg = perShare(costBasis.div(newQty));
  return { holding: { quantity: newQty, avgCost: newAvg, costBasis }, cashDelta: cost.neg() };
}

/** Sells `quantity` shares at `price`; realized P/L = proceeds after fees - quantity * average cost. */
export function applySell(
  current: HoldingState | null,
  quantity: D,
  price: D,
  fees: D,
): SellResult {
  assertPositive('Jumlah', quantity);
  assertPositive('Harga', price);
  assertPositive('Biaya', fees, true);
  const prevQty = current?.quantity ?? ZERO;
  if (quantity.gt(prevQty)) {
    throw new AccountingError(
      `Jumlah yang dijual (${quantity.toFixed(0)} lembar) melebihi yang dimiliki (${prevQty.toFixed(0)} lembar).`,
      'INSUFFICIENT_SHARES',
    );
  }
  const basis = basisOf(current);
  const proceeds = money(quantity.mul(price).sub(fees));
  // the sold shares carry their exact share of the basis (never the rounded average times the quantity)
  const costOfSold = prevQty.isZero() ? ZERO : money(basis.mul(quantity).div(prevQty));
  const realized = money(proceeds.sub(costOfSold));
  const newQty = prevQty.sub(quantity);
  const costBasis = newQty.isZero() ? ZERO : money(basis.sub(costOfSold));
  return {
    holding: {
      quantity: newQty,
      avgCost: newQty.isZero() ? ZERO : perShare(costBasis.div(newQty)),
      costBasis,
    },
    cashDelta: proceeds,
    realizedPnl: realized,
  };
}

export interface ValuedHolding {
  symbol: string;
  quantity: D;
  avgCost: D;
  /** Trusted market price, or null when none was available (then valued at cost). */
  price: D | null;
  costBasis: D;
  marketValue: D;
  unrealizedPnl: D;
  unrealizedPct: D | null;
  realizedPnl: D;
}

export function valueHolding(
  symbol: string,
  h: HoldingState & { realizedPnl: D },
  price: D | null,
): ValuedHolding {
  const costBasis = basisOf(h);
  const marketValue = price === null ? costBasis : money(h.quantity.mul(price));
  const unrealized = marketValue.sub(costBasis);
  return {
    symbol,
    quantity: h.quantity,
    avgCost: h.avgCost,
    price,
    costBasis,
    marketValue,
    unrealizedPnl: unrealized,
    unrealizedPct: costBasis.isZero()
      ? null
      : unrealized.div(costBasis).mul(100).toDecimalPlaces(2),
    realizedPnl: h.realizedPnl,
  };
}

export interface PortfolioTotals {
  costBasis: D;
  marketValue: D;
  unrealizedPnl: D;
  unrealizedPct: D | null;
  realizedPnl: D;
  dividends: D;
  cash: D;
  /** Market value + cash. */
  equity: D;
  unpriced: number;
  /** Share of equity per holding (percent), largest first. */
  allocation: Array<{ symbol: string; percent: D }>;
}

export function totals(
  holdings: ValuedHolding[],
  cash: D,
  realizedPnl: D,
  dividends: D,
): PortfolioTotals {
  const sum = (pick: (v: ValuedHolding) => D) =>
    holdings.reduce((acc, v) => acc.add(pick(v)), ZERO);
  const costBasis = sum((v) => v.costBasis);
  const marketValue = sum((v) => v.marketValue);
  const unrealized = marketValue.sub(costBasis);
  const equity = marketValue.add(cash);
  const allocation = holdings
    .filter((v) => v.quantity.gt(0))
    .map((v) => ({
      symbol: v.symbol,
      percent: equity.gt(0) ? v.marketValue.div(equity).mul(100).toDecimalPlaces(1) : ZERO,
    }))
    .sort((a, b) => b.percent.comparedTo(a.percent));
  return {
    costBasis,
    marketValue,
    unrealizedPnl: unrealized,
    unrealizedPct: costBasis.isZero()
      ? null
      : unrealized.div(costBasis).mul(100).toDecimalPlaces(2),
    realizedPnl,
    dividends,
    cash,
    equity,
    unpriced: holdings.filter((v) => v.price === null && v.quantity.gt(0)).length,
    allocation,
  };
}
