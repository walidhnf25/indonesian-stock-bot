import { ChatService } from '../../src/chat/chat.service';
import { PortfolioService } from '../../src/portfolio/portfolio.service';
import { UserService } from '../../src/user/user.service';
import { createTestApp, flushBackground, resetCaches, TestApp } from '../setup/test-app';

/**
 * Portfolio ledger on real PostgreSQL with the fixture provider (TSTA quotes at 1777, TSTB 1003).
 * Money is Decimal, the ledger is append-only, every write is idempotent and locked per user.
 */
const plain = (html: string) => html.replace(/<[^>]+>/g, '');

describe('Portfolio (integration)', () => {
  let t: TestApp;
  let portfolio: PortfolioService;
  let users: UserService;
  let chat: ChatService;
  let seq = 0;
  const key = () => `test:${Date.now()}:${++seq}`;
  const mkUser = async (telegramId: number) =>
    (await users.upsertFromTelegram({ telegramId, chatId: telegramId, username: `u${telegramId}` }))
      .id;
  const say = async (telegramId: number, text: string, chatId = telegramId, messageId?: number) => {
    const r = await chat.handle({
      telegramId,
      chatId,
      chatType: chatId > 0 ? 'private' : 'supergroup',
      username: `u${telegramId}`,
      text,
      messageId,
    });
    return plain(r.messages.join('\n'));
  };

  beforeAll(async () => {
    t = await createTestApp();
    portfolio = t.app.get(PortfolioService);
    users = t.app.get(UserService);
    chat = t.app.get(ChatService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await flushBackground(t);
    await t.prisma.$executeRawUnsafe(
      'TRUNCATE "User","Portfolio","Holding","PortfolioTransaction","PortfolioSnapshot" RESTART IDENTITY CASCADE',
    );
    resetCaches(t);
    t.provider.failWith = null;
    t.provider.clearOverrides();
  });

  describe('ledger and accounting', () => {
    it('records a buy, a second buy and a sale with average cost and realized P/L', async () => {
      const u = await mkUser(7001);
      const buy1 = await portfolio.record(u, {
        type: 'BUY',
        symbol: 'TSTA',
        quantity: 1000,
        price: 1700,
        fees: 5000,
        idempotencyKey: key(),
        chatId: 7001,
      });
      expect(buy1).toMatchObject({
        duplicate: false,
        holding: { quantity: 1000, avgCost: 1705 },
        cash: -1_705_000,
      });
      await portfolio.record(u, {
        type: 'BUY',
        symbol: 'TSTA',
        quantity: 1000,
        price: 1800,
        idempotencyKey: key(),
        chatId: 7001,
      });
      const sell = await portfolio.record(u, {
        type: 'SELL',
        symbol: 'TSTA',
        quantity: 500,
        price: 1900,
        fees: 2000,
        idempotencyKey: key(),
        chatId: 7001,
      });
      // avg = (1 705 000 + 1 800 000) / 2000 = 1752.5 ; realized = 500 * (1900 - 1752.5) - 2000
      expect(sell.realizedPnl).toBe(71_750);
      expect(sell.holding).toEqual({ quantity: 1500, avgCost: 1752.5 });
      const view = await portfolio.view(u);
      expect(view.holdings[0]).toMatchObject({ symbol: 'TSTA' });
      expect(view.totals.realizedPnl.toNumber()).toBe(71_750);
      expect(view.holdings[0].price?.toNumber()).toBe(1777); // trusted fixture quote
      expect(view.holdings[0].marketValue.toNumber()).toBe(1500 * 1777);
    });

    it('refuses to sell more than held, and withdrawals beyond recorded cash', async () => {
      const u = await mkUser(7002);
      await portfolio.record(u, {
        type: 'BUY',
        symbol: 'TSTA',
        quantity: 100,
        price: 1700,
        idempotencyKey: key(),
        chatId: 7002,
      });
      await expect(
        portfolio.record(u, {
          type: 'SELL',
          symbol: 'TSTA',
          quantity: 101,
          price: 1700,
          idempotencyKey: key(),
          chatId: 7002,
        }),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_INVALID' });
      await portfolio.record(u, {
        type: 'DEPOSIT',
        amount: 50_000,
        idempotencyKey: key(),
        chatId: 7002,
      });
      await expect(
        portfolio.record(u, {
          type: 'WITHDRAWAL',
          amount: 1_000_000,
          idempotencyKey: key(),
          chatId: 7002,
        }),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_INVALID' });
      expect(await t.prisma.portfolioTransaction.count()).toBe(2); // refused entries leave no rows
    });

    it('rejects an unknown ticker, non-integer shares and nonsense numbers', async () => {
      const u = await mkUser(7003);
      await expect(
        portfolio.record(u, {
          type: 'BUY',
          symbol: 'ZZQX',
          quantity: 100,
          price: 10,
          idempotencyKey: key(),
          chatId: 7003,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_TICKER' });
      await expect(
        portfolio.record(u, {
          type: 'BUY',
          symbol: 'TSTA',
          quantity: 10.5,
          price: 10,
          idempotencyKey: key(),
          chatId: 7003,
        }),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_INVALID' });
      await expect(
        portfolio.record(u, {
          type: 'BUY',
          symbol: 'TSTA',
          quantity: 100,
          price: Number.NaN,
          idempotencyKey: key(),
          chatId: 7003,
        }),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_INVALID' });
      await expect(
        portfolio.record(u, { type: 'DEPOSIT', amount: -5, idempotencyKey: key(), chatId: 7003 }),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_INVALID' });
    });
  });

  describe('idempotency and concurrency', () => {
    it('the same idempotency key records once, however many times it is sent', async () => {
      const u = await mkUser(7010);
      const k = key();
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          portfolio.record(u, {
            type: 'BUY',
            symbol: 'TSTA',
            quantity: 100,
            price: 1700,
            idempotencyKey: k,
            chatId: 7010,
          }),
        ),
      );
      expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
      expect(await t.prisma.portfolioTransaction.count()).toBe(1);
      expect((await portfolio.view(u)).holdings[0].quantity.toNumber()).toBe(100);
    });

    it('20 concurrent distinct buys of one user are all applied exactly once, in a consistent state', async () => {
      const u = await mkUser(7011);
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          portfolio.record(u, {
            type: 'BUY',
            symbol: 'TSTA',
            quantity: 100,
            price: 1000 + i,
            idempotencyKey: key(),
            chatId: 7011,
          }),
        ),
      );
      const v = await portfolio.view(u);
      expect(v.holdings[0].quantity.toNumber()).toBe(2000);
      // average of 1000..1019 = 1009.5
      expect(v.holdings[0].avgCost.toNumber()).toBe(1009.5);
      expect(v.totals.cash.toNumber()).toBe(-(100 * (1000 * 20 + 190)));
    });

    it('a sale racing with buys never oversells', async () => {
      const u = await mkUser(7012);
      await portfolio.record(u, {
        type: 'BUY',
        symbol: 'TSTA',
        quantity: 100,
        price: 1000,
        idempotencyKey: key(),
        chatId: 7012,
      });
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          portfolio.record(u, {
            type: 'SELL',
            symbol: 'TSTA',
            quantity: 100,
            price: 1000,
            idempotencyKey: key(),
            chatId: 7012,
          }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await portfolio.view(u)).holdings.filter((h) => h.quantity.gt(0))).toHaveLength(0);
    });
  });

  describe('undo', () => {
    it('reverses the last transaction exactly and refuses to reverse it twice', async () => {
      const u = await mkUser(7020);
      await portfolio.record(u, {
        type: 'BUY',
        symbol: 'TSTA',
        quantity: 1000,
        price: 1700,
        idempotencyKey: key(),
        chatId: 7020,
      });
      await portfolio.record(u, {
        type: 'BUY',
        symbol: 'TSTA',
        quantity: 1000,
        price: 1800,
        idempotencyKey: key(),
        chatId: 7020,
      });
      const undo = await portfolio.undoLast(u, key(), 7020);
      expect(undo.type).toBe('REVERSAL');
      expect(undo.holding).toEqual({ quantity: 1000, avgCost: 1700 }); // exact prior state, not a recomputation
      expect(undo.cash).toBe(-1_700_000);
      await expect(portfolio.undoLast(u, key(), 7020)).rejects.toMatchObject({
        code: 'PORTFOLIO_EMPTY',
      });
      expect(await t.prisma.portfolioTransaction.count()).toBe(3); // nothing deleted
      const history = await portfolio.history(u);
      expect(history.map((h) => h.type)).toEqual(['REVERSAL', 'BUY', 'BUY']);
      expect(history[1].reversed).toBe(true);
    });

    it('undoing a sale gives back the shares and the realized P/L', async () => {
      const u = await mkUser(7021);
      await portfolio.record(u, {
        type: 'BUY',
        symbol: 'TSTA',
        quantity: 100,
        price: 1000,
        idempotencyKey: key(),
        chatId: 7021,
      });
      await portfolio.record(u, {
        type: 'SELL',
        symbol: 'TSTA',
        quantity: 100,
        price: 1200,
        idempotencyKey: key(),
        chatId: 7021,
      });
      expect((await portfolio.view(u)).totals.realizedPnl.toNumber()).toBe(20_000);
      await portfolio.undoLast(u, key(), 7021);
      const v = await portfolio.view(u);
      expect(v.totals.realizedPnl.toNumber()).toBe(0);
      expect(v.holdings[0].quantity.toNumber()).toBe(100);
    });
  });

  describe('valuation and data quality', () => {
    it('a suspect quote is never used for valuation: the holding is valued at cost and flagged', async () => {
      const u = await mkUser(7030);
      await portfolio.record(u, {
        type: 'BUY',
        symbol: 'TSTA',
        quantity: 100,
        price: 1700,
        idempotencyKey: key(),
        chatId: 7030,
      });
      t.provider.setPrice('TSTA', 1777 * 5); // +400 %: implausible
      resetCaches(t);
      const v = await portfolio.view(u);
      expect(v.holdings[0].price).toBeNull();
      expect(v.holdings[0].marketValue.toNumber()).toBe(170_000);
      expect(v.unpriced).toEqual([{ symbol: 'TSTA', reason: 'harga terlihat tidak wajar' }]);
      expect(v.totals.unpriced).toBe(1);
    });

    it('a provider outage values at cost and says the price is unavailable', async () => {
      const u = await mkUser(7031);
      await portfolio.record(u, {
        type: 'BUY',
        symbol: 'TSTA',
        quantity: 100,
        price: 1700,
        idempotencyKey: key(),
        chatId: 7031,
      });
      await t.prisma.stockQuoteSnapshot.deleteMany({});
      t.provider.failWith = 'ERROR';
      resetCaches(t);
      const v = await portfolio.view(u);
      expect(v.unpriced[0]).toMatchObject({ symbol: 'TSTA', reason: 'harga tidak tersedia' });
    });

    it('snapshots are written once per Jakarta day and updated on rerun', async () => {
      const u = await mkUser(7032);
      await portfolio.record(u, {
        type: 'BUY',
        symbol: 'TSTA',
        quantity: 100,
        price: 1700,
        idempotencyKey: key(),
        chatId: 7032,
      });
      expect(await portfolio.snapshotAll()).toBe(1);
      expect(await portfolio.snapshotAll()).toBe(1);
      expect(await t.prisma.portfolioSnapshot.count()).toBe(1);
      const s = await t.prisma.portfolioSnapshot.findFirstOrThrow();
      expect(s.marketValue.toNumber()).toBe(177_700);
    });
  });

  describe('through the chat: privacy and idempotency by message id', () => {
    it('records from natural language, shows the portfolio, and the same Telegram message twice records once', async () => {
      const first = await say(7040, 'beli 10 lot TSTA di 1700', 7040, 501);
      expect(first).toMatch(/Pembelian dicatat/);
      expect(first).toMatch(/10 lot @ Rp1\.700/);
      const again = await say(7040, 'beli 10 lot TSTA di 1700', 7040, 501); // Telegram re-delivered the update
      expect(again).toMatch(/sudah tercatat sebelumnya/);
      expect(await t.prisma.portfolioTransaction.count()).toBe(1);
      const view = await say(7040, 'portofolio saya');
      expect(view).toMatch(/TSTA 10 lot/);
      expect(view).toMatch(/Modal: Rp1\.700\.000/);
      expect(view).toMatch(/bukan saran/);
    });

    it('portfolio commands in a group are refused and reveal nothing', async () => {
      await say(7041, 'beli 10 lot TSTA di 1700', 7041, 601);
      const inGroup = await say(7041, 'portofolio saya', -100900);
      expect(inGroup).toMatch(/hanya bisa .* di chat pribadi/);
      expect(inGroup).not.toMatch(/TSTA|1\.700/);
      const recordInGroup = await say(7041, 'beli 5 lot TSTB di 1000', -100900, 602);
      expect(recordInGroup).toMatch(/chat pribadi/);
      expect(await t.prisma.portfolioTransaction.count()).toBe(1);
    });

    it("one user can never see or change another user's portfolio", async () => {
      await say(7042, 'beli 10 lot TSTA di 1700', 7042, 701);
      const other = await say(7043, 'portofolio saya');
      expect(other).toMatch(/Belum ada catatan/);
      expect(other).not.toMatch(/TSTA/);
      const undo = await say(7043, 'batalkan transaksi terakhir');
      expect(undo).toMatch(/Belum ada transaksi/);
      expect(await t.prisma.portfolioTransaction.count()).toBe(1);
    });

    it('a vague message classified by the AI as a portfolio change is refused', async () => {
      t.ai.script = [
        () =>
          JSON.stringify({
            intent: 'PORTFOLIO_RECORD',
            symbols: ['TSTA'],
            parameters: { txType: 'SELL', quantity: 100, price: 1 },
          }),
      ];
      await say(7044, 'beli 10 lot TSTA di 1700', 7044, 801);
      const reply = await say(7044, 'tolong rapikan semuanya ya');
      expect(reply).not.toMatch(/Penjualan dicatat/);
      expect(await t.prisma.portfolioTransaction.count()).toBe(1);
    });
  });
});
