import { Prisma } from '@prisma/client';
import {
  AccountingError,
  ZERO,
  applyBuy,
  applySell,
  d,
  totals,
  valueHolding,
} from './portfolio-accounting';

const n = (v: Prisma.Decimal) => v.toNumber();

describe('Portfolio accounting (average cost, Decimal)', () => {
  it('a first purchase sets the average cost including fees', () => {
    const r = applyBuy(null, d(1000), d(9000), d(15_000));
    expect(n(r.holding.quantity)).toBe(1000);
    expect(n(r.holding.avgCost)).toBe(9015); // (1000 * 9000 + 15000) / 1000
    expect(n(r.cashDelta)).toBe(-9_015_000);
  });

  it('a second purchase at another price moves the average cost', () => {
    const first = applyBuy(null, d(1000), d(9000), ZERO).holding;
    const r = applyBuy(first, d(1000), d(10_000), ZERO);
    expect(n(r.holding.quantity)).toBe(2000);
    expect(n(r.holding.avgCost)).toBe(9500);
  });

  it('a sale realizes (price - average) * quantity - fees and keeps the average for the rest', () => {
    const h = applyBuy(null, d(1000), d(9000), ZERO).holding;
    const r = applySell(h, d(400), d(9500), d(10_000));
    expect(n(r.realizedPnl)).toBe(400 * 500 - 10_000); // 190 000
    expect(n(r.cashDelta)).toBe(400 * 9500 - 10_000);
    expect(n(r.holding.quantity)).toBe(600);
    expect(n(r.holding.avgCost)).toBe(9000);
  });

  it('selling everything leaves zero shares and no average', () => {
    const h = applyBuy(null, d(300), d(100), ZERO).holding;
    const r = applySell(h, d(300), d(90), ZERO);
    expect(n(r.holding.quantity)).toBe(0);
    expect(n(r.holding.avgCost)).toBe(0);
    expect(n(r.realizedPnl)).toBe(-3000);
  });

  it('refuses to sell more than is held, and refuses non-positive quantities or prices', () => {
    const h = applyBuy(null, d(100), d(100), ZERO).holding;
    expect(() => applySell(h, d(101), d(100), ZERO)).toThrow(AccountingError);
    expect(() => applySell(null, d(1), d(100), ZERO)).toThrow(/melebihi/);
    expect(() => applyBuy(null, d(0), d(100), ZERO)).toThrow(/Jumlah/);
    expect(() => applyBuy(null, d(100), d(-1), ZERO)).toThrow(/Harga/);
    expect(() => applyBuy(null, d(100), d(100), d(-5))).toThrow(/Biaya/);
  });

  it('has no floating-point drift: 0.1 + 0.2 style sums stay exact', () => {
    let h = applyBuy(null, d('0.1'), d(1), ZERO).holding;
    for (let i = 0; i < 9; i++) h = applyBuy(h, d('0.1'), d(1), ZERO).holding;
    expect(h.quantity.toString()).toBe('1');
    expect(h.avgCost.toString()).toBe('1');
    const big = applyBuy(null, d(1_000_000_000), d(123_456.7891), d('0.01'));
    expect(big.cashDelta.toString()).toBe('-123456789100000.01');
  });

  it('values a holding at the trusted price, or at cost when there is none', () => {
    const h = { quantity: d(1000), avgCost: d(9000), realizedPnl: d(50_000) };
    const priced = valueHolding('TSTA', h, d(9900));
    expect(n(priced.marketValue)).toBe(9_900_000);
    expect(n(priced.unrealizedPnl)).toBe(900_000);
    expect(priced.unrealizedPct?.toNumber()).toBe(10);
    const unpriced = valueHolding('TSTA', h, null);
    expect(n(unpriced.marketValue)).toBe(9_000_000);
    expect(n(unpriced.unrealizedPnl)).toBe(0);
  });

  it('totals add cash, count unpriced holdings and allocate by market value', () => {
    const a = valueHolding(
      'TSTA',
      { quantity: d(100), avgCost: d(100), realizedPnl: ZERO },
      d(300),
    ); // 30 000
    const b = valueHolding('TSTB', { quantity: d(100), avgCost: d(100), realizedPnl: ZERO }, null); // 10 000 at cost
    const t = totals([a, b], d(10_000), d(500), d(200));
    expect(n(t.marketValue)).toBe(40_000);
    expect(n(t.costBasis)).toBe(20_000);
    expect(n(t.unrealizedPnl)).toBe(20_000);
    expect(t.unrealizedPct?.toNumber()).toBe(100);
    expect(n(t.equity)).toBe(50_000);
    expect(t.unpriced).toBe(1);
    expect(t.allocation.map((x) => `${x.symbol}:${x.percent.toNumber()}`)).toEqual([
      'TSTA:60',
      'TSTB:20',
    ]);
    expect(n(t.dividends)).toBe(200);
  });
});

describe('exact cost basis (order-independent average, 2026-10-05)', () => {
  const buys = (order: number[]) =>
    order.reduce<ReturnType<typeof applyBuy>['holding'] | null>(
      (state, i) => applyBuy(state, d(100), d(1000 + i), ZERO).holding,
      null,
    )!;

  it('twenty buys at 1000..1019 give exactly 1009.5 whatever the order they are applied in', () => {
    const asc = buys(Array.from({ length: 20 }, (_, i) => i));
    const desc = buys(Array.from({ length: 20 }, (_, i) => 19 - i));
    const shuffled = buys([7, 0, 19, 3, 11, 15, 2, 8, 18, 1, 12, 5, 16, 9, 4, 14, 6, 17, 10, 13]);
    for (const h of [asc, desc, shuffled]) {
      expect(h.quantity.toNumber()).toBe(2000);
      expect(h.avgCost.toNumber()).toBe(1009.5);
      expect(h.costBasis!.toNumber()).toBe(2_019_000);
    }
  });

  it('a sale charges the exact share of the basis and leaves the rest intact', () => {
    const after3 = buys([0, 1, 2]); // 300 shares, basis 300 300
    const sold = applySell(after3, d(100), d(1100), d(10));
    expect(sold.realizedPnl.toNumber()).toBe(110_000 - 10 - 100_100); // proceeds - 1/3 of basis
    expect(sold.holding.costBasis!.toNumber()).toBe(200_200);
    expect(sold.holding.avgCost.toNumber()).toBe(1001);
    const all = applySell(sold.holding, d(200), d(1000), ZERO);
    expect(all.holding.costBasis!.toNumber()).toBe(0);
    expect(all.holding.avgCost.toNumber()).toBe(0);
  });

  it('a state without a basis (old rows) is reconstructed from the rounded average', () => {
    const r = applyBuy({ quantity: d(100), avgCost: d(1000) }, d(100), d(1200), ZERO);
    expect(r.holding.costBasis!.toNumber()).toBe(220_000);
    expect(r.holding.avgCost.toNumber()).toBe(1100);
  });
});
