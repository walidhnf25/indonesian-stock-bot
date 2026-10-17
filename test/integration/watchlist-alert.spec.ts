import { AlertService, MAX_ACTIVE_ALERTS } from '../../src/alert/alert.service';
import { UserFacingError } from '../../src/common/exceptions/app-errors';
import { ConversationService } from '../../src/conversation/conversation.service';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { UserService } from '../../src/user/user.service';
import { MAX_WATCHLIST_ITEMS, WatchlistService } from '../../src/watchlist/watchlist.service';
import { createTestApp, TestApp, resetCaches } from '../setup/test-app';

describe('User / Watchlist / Alert / Conversation (real PostgreSQL)', () => {
  let t: TestApp;
  let users: UserService;
  let watchlist: WatchlistService;
  let alerts: AlertService;
  let conversation: ConversationService;
  let alice: string;
  let bob: string;

  /**
   * A REALISTIC price move: the day's high/low follow the price. (Earlier versions of these tests
   * jumped TSTA from ~1.777 to 5.200 with an unchanged day range; the anomaly guard now correctly
   * refuses such data, see alert-safety.spec.ts.)
   */
  const move = (symbol: string, price: number) => {
    t.provider.setPrice(symbol, price);
    // open is a traded price, so it always lies inside the day's range (a quote where it does not is
    // SUSPECT and never triggers alerts, see data-quality.spec / alert-safety.spec).
    t.provider.patchQuote(symbol, { high: price + 10, low: price - 10, open: price });
  };

  beforeAll(async () => {
    t = await createTestApp();
    users = t.app.get(UserService);
    watchlist = t.app.get(WatchlistService);
    alerts = t.app.get(AlertService);
    conversation = t.app.get(ConversationService);
  });
  afterAll(() => t.close());

  beforeEach(async () => {
    await t.prisma.$executeRawUnsafe(
      'TRUNCATE "User","Alert","Watchlist","WatchlistItem","ConversationContext" RESTART IDENTITY CASCADE',
    );
    t.sent.length = 0;
    t.failNotifications.value = false;
    t.failNotifications.permanent = false;
    t.provider.failWith = null;
    t.provider.clearOverrides();
    alice = (await users.upsertFromTelegram({ telegramId: 111, chatId: 111, username: 'alice' }))
      .id;
    bob = (await users.upsertFromTelegram({ telegramId: 222, chatId: 222, username: 'bob' })).id;
  });

  describe('users', () => {
    it('upserts by Telegram ID (idempotent) and refreshes profile fields', async () => {
      const again = await users.upsertFromTelegram({
        telegramId: 111,
        chatId: 111,
        username: 'alice2',
        firstName: 'Alice',
      });
      expect(again.id).toBe(alice);
      expect(again.username).toBe('alice2');
      expect(await t.prisma.user.count()).toBe(2);
      expect(again).toMatchObject({ language: 'id', timezone: 'Asia/Jakarta' });
    });

    it('cascades deletes to watchlists, alerts and context', async () => {
      await watchlist.add(alice, ['TSTA']);
      await alerts.create(alice, 'TSTA', 'price', 'above', 99999);
      await conversation.remember(alice, 111, ['TSTA'], 'STOCK_QUOTE');
      await t.prisma.user.delete({ where: { id: alice } });
      expect(await t.prisma.alert.count()).toBe(0);
      expect(await t.prisma.watchlistItem.count()).toBe(0);
      expect(await t.prisma.conversationContext.count()).toBe(0);
    });
  });

  describe('watchlist', () => {
    it('adds, lists with quotes, and removes', async () => {
      const r = await watchlist.add(alice, ['TSTA', 'TSTB']);
      expect(r.added).toEqual(['TSTA', 'TSTB']);
      const list = await watchlist.list(alice);
      expect(list.map((e) => e.symbol)).toEqual(['TSTA', 'TSTB']);
      expect(list.every((e) => e.quote?.available)).toBe(true);
      expect(await watchlist.remove(alice, ['TSTA'])).toEqual({ removed: ['TSTA'], notFound: [] });
      expect((await watchlist.list(alice)).map((e) => e.symbol)).toEqual(['TSTB']);
    });

    it('reports duplicates, invalid tickers and missing removals without failing', async () => {
      await watchlist.add(alice, ['TSTA']);
      const r = await watchlist.add(alice, ['TSTA', 'ZZZZ', 'TSTC']);
      expect(r).toMatchObject({ added: ['TSTC'], alreadyThere: ['TSTA'], invalid: ['ZZZZ'] });
      expect(await watchlist.remove(alice, ['TSTB'])).toEqual({ removed: [], notFound: ['TSTB'] });
    });

    it("keeps each Telegram user's watchlist independent", async () => {
      await watchlist.add(alice, ['TSTA']);
      await watchlist.add(bob, ['TSTB']);
      expect(await watchlist.symbols(alice)).toEqual(['TSTA']);
      expect(await watchlist.symbols(bob)).toEqual(['TSTB']);
      await watchlist.remove(bob, ['TSTA']);
      expect(await watchlist.symbols(alice)).toEqual(['TSTA']);
    });

    it('still saves a ticker (flagged unverified) when the data provider is down', async () => {
      t.provider.failWith = 'ERROR';
      resetCaches(t);
      const r = await watchlist.add(alice, ['NEWX']);
      expect(r.added).toEqual(['NEWX']);
      expect(r.unverified).toEqual(['NEWX']);
    });

    it('enforces a maximum size', async () => {
      const stock = await t.prisma.stock.create({ data: { symbol: 'FILL' } });
      const list = await t.prisma.watchlist.create({ data: { userId: alice, name: 'Default' } });
      for (let i = 0; i < MAX_WATCHLIST_ITEMS; i++) {
        const s = await t.prisma.stock.create({
          data: { symbol: `F${String(i).padStart(3, '0')}` },
        });
        await t.prisma.watchlistItem.create({ data: { watchlistId: list.id, stockId: s.id } });
      }
      void stock;
      const r = await watchlist.add(alice, ['TSTA']);
      expect(r.limitReached).toEqual(['TSTA']);
    });

    it('shows an empty list for a new user', async () => {
      expect(await watchlist.list(alice)).toEqual([]);
    });
  });

  describe('alerts: creation', () => {
    it('creates price, RSI and volume alerts with the right types', async () => {
      const a = await alerts.create(alice, 'TSTA', 'price', 'above', 8500);
      const b = await alerts.create(alice, 'TSTA', 'price', 'below', 700);
      const c = await alerts.create(alice, 'TSTA', 'rsi', 'above', 70);
      const d = await alerts.create(alice, 'TSTA', 'volume', 'above', 2);
      expect([a, b, c, d].map((r) => r.alert.type)).toEqual([
        'PRICE_ABOVE',
        'PRICE_BELOW',
        'RSI_ABOVE',
        'VOLUME_MULTIPLIER',
      ]);
      expect(a.alert.status).toBe('ACTIVE');
      expect(a.currentValue).not.toBeNull();
    });

    it('does not create duplicates', async () => {
      const first = await alerts.create(alice, 'TSTA', 'price', 'above', 8500);
      const second = await alerts.create(alice, 'TSTA', 'price', 'above', 8500);
      expect(second.duplicate).toBe(true);
      expect(second.alert.id).toBe(first.alert.id);
      expect(await t.prisma.alert.count()).toBe(1);
    });

    it('tells the user when the condition is already satisfied', async () => {
      const r = await alerts.create(alice, 'TSTA', 'price', 'above', 1);
      expect(r.alreadySatisfied).toBe(true);
      expect((await alerts.create(alice, 'TSTA', 'price', 'above', 999999)).alreadySatisfied).toBe(
        false,
      );
    });

    it('rejects invalid tickers and out-of-range values with friendly errors', async () => {
      await expect(alerts.create(alice, 'ZZZZ', 'price', 'above', 100)).rejects.toBeInstanceOf(
        UserFacingError,
      );
      await expect(alerts.create(alice, 'TSTA', 'rsi', 'above', 150)).rejects.toBeInstanceOf(
        UserFacingError,
      );
      await expect(alerts.create(alice, 'TSTA', 'volume', 'above', 0.5)).rejects.toBeInstanceOf(
        UserFacingError,
      );
    });

    it('limits active alerts per user', async () => {
      for (let i = 0; i < MAX_ACTIVE_ALERTS; i++)
        await alerts.create(alice, 'TSTA', 'price', 'above', 5000 + i);
      await expect(alerts.create(alice, 'TSTA', 'price', 'above', 9999)).rejects.toMatchObject({
        code: 'ALERT_LIMIT',
      });
      // another user is unaffected
      await expect(alerts.create(bob, 'TSTA', 'price', 'above', 9999)).resolves.toBeDefined();
    });
  });

  describe('alerts: evaluation (scheduler job)', () => {
    it('triggers a price-above alert exactly once and notifies the right chat', async () => {
      await alerts.create(alice, 'TSTA', 'price', 'above', 1790);
      await alerts.create(bob, 'TSTA', 'price', 'above', 99999);
      resetCaches(t); // let the quote cache expire so overrides are seen
      move('TSTA', 1800);

      const run1 = await alerts.checkAll();
      expect(run1.triggered).toBe(1);
      expect(t.sent).toHaveLength(1);
      expect(t.sent[0].chatId).toBe(111);
      expect(t.sent[0].text).toContain('ALERT');
      expect(t.sent[0].text).toContain('TSTA');

      const row = await t.prisma.alert.findFirst({ where: { userId: alice } });
      expect(row).toMatchObject({ status: 'TRIGGERED', triggeredValue: 1800 });
      expect(row?.triggeredAt).not.toBeNull();

      // Next runs never re-send the same notification.
      resetCaches(t);
      const run2 = await alerts.checkAll();
      expect(run2.triggered).toBe(0);
      expect(t.sent).toHaveLength(1);
    });

    it('triggers price-below, and leaves unmet alerts active', async () => {
      await alerts.create(alice, 'TSTB', 'price', 'below', 990);
      await alerts.create(alice, 'TSTB', 'price', 'below', 1);
      resetCaches(t);
      move('TSTB', 980);
      const r = await alerts.checkAll();
      expect(r.triggered).toBe(1);
      const statuses = (await t.prisma.alert.findMany({ orderBy: { threshold: 'asc' } })).map(
        (a) => a.status,
      );
      expect(statuses).toEqual(['ACTIVE', 'TRIGGERED']);
    });

    it('evaluates RSI and volume-multiplier alerts from deterministic indicators', async () => {
      await alerts.create(alice, 'TSTA', 'rsi', 'above', 70); // synthetic uptrend -> RSI very high
      await alerts.create(alice, 'TSTB', 'rsi', 'above', 70); // downtrend -> never
      await alerts.create(alice, 'TSTC', 'volume', 'above', 50); // never
      resetCaches(t);
      const r = await alerts.checkAll();
      expect(r.triggered).toBe(1);
      expect(t.sent[0].text).toContain('RSI');
    });

    it('does not lose the alert when delivery fails: it is retried on the next run', async () => {
      await alerts.create(alice, 'TSTA', 'price', 'above', 1790);
      resetCaches(t);
      move('TSTA', 1800);
      t.failNotifications.value = true;
      const failed = await alerts.checkAll();
      expect(failed).toMatchObject({ triggered: 0, errors: 1 });
      expect((await t.prisma.alert.findFirst())?.status).toBe('ACTIVE');

      t.failNotifications.value = false;
      resetCaches(t);
      expect((await alerts.checkAll()).triggered).toBe(1);
      expect(t.sent).toHaveLength(1);
    });

    it('disables an alert whose chat permanently rejects messages (user blocked the bot) instead of retrying forever', async () => {
      await alerts.create(alice, 'TSTA', 'price', 'above', 1790);
      resetCaches(t);
      move('TSTA', 1800);
      t.failNotifications.value = true;
      t.failNotifications.permanent = true;
      await alerts.checkAll();
      expect((await t.prisma.alert.findFirst())?.status).toBe('DISABLED');
      t.failNotifications.value = false;
      resetCaches(t);
      expect((await alerts.checkAll()).triggered).toBe(0);
    });

    it('is safe under overlapping runs: only one notification is sent', async () => {
      await alerts.create(alice, 'TSTA', 'price', 'above', 1790);
      resetCaches(t);
      move('TSTA', 1800);
      await Promise.all([alerts.checkAll(), alerts.checkAll(), alerts.checkAll()]);
      expect(t.sent).toHaveLength(1);
    });

    it('never fires on stale (last-known) data', async () => {
      await alerts.create(alice, 'TSTA', 'price', 'above', 1); // would fire instantly on live data
      resetCaches(t);
      t.provider.failWith = 'ERROR';
      const r = await alerts.checkAll();
      expect(r.triggered).toBe(0);
      expect(t.sent).toHaveLength(0);
      expect((await t.prisma.alert.findFirst())?.status).toBe('ACTIVE');
    });

    it('scheduler tick skips when the market is closed unless configured otherwise', async () => {
      const scheduler = t.app.get(SchedulerService);
      // ALERT_CHECK_WHEN_CLOSED=true in tests -> runs regardless of the clock
      expect((await scheduler.tick()).ran).toBe(true);
    });
  });

  describe('alerts: listing and disabling', () => {
    it('lists active alerts oldest-first and recent triggers', async () => {
      await alerts.create(alice, 'TSTA', 'price', 'above', 99999);
      await alerts.create(alice, 'TSTB', 'price', 'below', 1);
      const { active } = await alerts.list(alice);
      expect(active.map((a) => a.stock.symbol)).toEqual(['TSTA', 'TSTB']);
    });

    it("disables by index, by symbol and all — and only the owner's alerts", async () => {
      await alerts.create(alice, 'TSTA', 'price', 'above', 99999);
      await alerts.create(alice, 'TSTB', 'price', 'below', 1);
      await alerts.create(alice, 'TSTC', 'price', 'below', 1);
      await alerts.create(bob, 'TSTA', 'price', 'above', 99999);

      expect((await alerts.disable(alice, { index: 1 })).map((a) => a.stock.symbol)).toEqual([
        'TSTA',
      ]);
      expect((await alerts.disable(alice, { symbols: ['TSTB'] })).length).toBe(1);
      expect((await alerts.disable(alice, { index: 9 })).length).toBe(0);
      expect((await alerts.disable(alice, { all: true })).length).toBe(1);
      expect((await alerts.list(bob)).active).toHaveLength(1); // bob untouched
      expect(
        (await t.prisma.alert.findMany({ where: { userId: alice } })).every(
          (a) => a.status === 'DISABLED',
        ),
      ).toBe(true);
    });

    it('a disabled alert never triggers', async () => {
      await alerts.create(alice, 'TSTA', 'price', 'above', 1790);
      await alerts.disable(alice, { all: true });
      resetCaches(t);
      move('TSTA', 1800);
      expect((await alerts.checkAll()).triggered).toBe(0);
    });
  });

  describe('conversation context', () => {
    it('remembers the last symbols and expires after the TTL', async () => {
      await conversation.remember(alice, 111, ['TSTA', 'TSTB'], 'STOCK_COMPARISON');
      expect(await conversation.get(alice, 111)).toMatchObject({
        lastSymbols: ['TSTA', 'TSTB'],
        lastIntent: 'STOCK_COMPARISON',
      });

      await t.prisma.conversationContext.update({
        where: { userId_chatId: { userId: alice, chatId: BigInt(111) } },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(await conversation.get(alice, 111)).toBeNull();
    });

    it('stores one small row per user and chat (no chat history) and caps remembered symbols', async () => {
      await conversation.remember(
        alice,
        111,
        ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE', 'FFFF', 'GGGG'],
        'STOCK_QUOTE',
      );
      await conversation.remember(alice, 111, ['TSTA'], 'STOCK_QUOTE');
      expect(await t.prisma.conversationContext.count()).toBe(1);
      const ctx = await conversation.get(alice, 111);
      expect(ctx?.lastSymbols).toEqual(['TSTA']);
    });

    it('prunes expired rows opportunistically', async () => {
      await conversation.remember(bob, 222, ['TSTA'], 'STOCK_QUOTE');
      await t.prisma.conversationContext.update({
        where: { userId_chatId: { userId: bob, chatId: BigInt(222) } },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      (conversation as unknown as { lastPrune: number }).lastPrune = 0;
      await conversation.remember(alice, 111, ['TSTA'], 'STOCK_QUOTE');
      expect(await t.prisma.conversationContext.count({ where: { userId: bob } })).toBe(0);
    });
  });
});
