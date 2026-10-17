import { AlertService } from '../../src/alert/alert.service';
import { ChatService } from '../../src/chat/chat.service';
import { UserService } from '../../src/user/user.service';
import { syntheticCandles } from '../../src/testing/fixtures';
import { createTestApp, flushBackground, resetCaches, TestApp } from '../setup/test-app';

/**
 * Alert lifecycle (PAUSED / EXPIRED), MA20/MA50 crossover alerts and delivery tracking, on real
 * PostgreSQL with the fixture provider (TSTA quotes at 1777 with a 1-year uptrend history).
 */
const plain = (html: string) => html.replace(/<[^>]+>/g, '');

describe('Alert lifecycle (integration)', () => {
  let t: TestApp;
  let alerts: AlertService;
  let users: UserService;
  let chat: ChatService;
  const mkUser = async (telegramId: number) =>
    (await users.upsertFromTelegram({ telegramId, chatId: telegramId, username: `u${telegramId}` }))
      .id;
  const say = async (telegramId: number, text: string) =>
    plain(
      (
        await chat.handle({
          telegramId,
          chatId: telegramId,
          chatType: 'private',
          username: `u${telegramId}`,
          text,
        })
      ).messages.join('\n'),
    );

  beforeAll(async () => {
    t = await createTestApp();
    alerts = t.app.get(AlertService);
    users = t.app.get(UserService);
    chat = t.app.get(ChatService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await flushBackground(t);
    await t.prisma.$executeRawUnsafe(
      'TRUNCATE "User","Alert","StockQuoteSnapshot","StockDailyPrice" RESTART IDENTITY CASCADE',
    );
    resetCaches(t);
    t.sent.length = 0;
    t.provider.failWith = null;
    t.provider.clearOverrides();
    t.failNotifications.value = false;
  });

  describe('pause and resume', () => {
    it('a paused alert is not evaluated, keeps its slot and identity, and fires again after resume', async () => {
      const u = await mkUser(8001);
      await alerts.create(u, 'TSTA', 'price', 'above', 1500); // already satisfied at 1777
      const paused = await alerts.pause(u, { all: true });
      expect(paused).toHaveLength(1);
      expect(await t.prisma.alert.findFirst()).toMatchObject({ status: 'PAUSED' });
      expect((await t.prisma.alert.findFirst())?.activeKey).not.toBeNull(); // still unique while paused
      await alerts.checkAll();
      expect(t.sent).toHaveLength(0);
      expect(await t.prisma.alert.count({ where: { status: 'PAUSED' } })).toBe(1);
      // an identical alert cannot be created while the paused one exists
      const dup = await alerts.create(u, 'TSTA', 'price', 'above', 1500);
      expect(dup.duplicate).toBe(true);
      const resumed = await alerts.resume(u, { all: true });
      expect(resumed).toHaveLength(1);
      await alerts.checkAll();
      expect(t.sent).toHaveLength(1);
      const fired = await t.prisma.alert.findFirst();
      expect(fired).toMatchObject({ status: 'TRIGGERED' });
      expect(fired?.deliveredAt).not.toBeNull(); // delivery tracked
    });

    it('paused alerts count towards the cap', async () => {
      const u = await mkUser(8002);
      for (let i = 0; i < 20; i++) await alerts.create(u, 'TSTA', 'price', 'above', 5000 + i);
      await alerts.pause(u, { index: 1 });
      await expect(alerts.create(u, 'TSTA', 'price', 'above', 9999)).rejects.toMatchObject({
        code: 'ALERT_LIMIT',
      });
    });

    it('works from chat with numbers and symbols, listing paused alerts separately', async () => {
      await say(8003, 'ingatkan saya kalau TSTA di atas 5000');
      await say(8003, 'ingatkan saya kalau TSTB di bawah 500');
      expect(await say(8003, 'jeda alert 1')).toMatch(/dijeda/i);
      const list = await say(8003, 'lihat alert saya');
      expect(list).toMatch(/DIJEDA/);
      expect(list).toMatch(/TSTA/);
      expect(await say(8003, 'lanjutkan alert TSTA')).toMatch(/diaktifkan lagi/i);
      expect(await say(8003, 'lihat alert saya')).not.toMatch(/DIJEDA/);
    });
  });

  describe('expiry', () => {
    it('an alert past its expiresAt is marked EXPIRED, frees its key and tells the owner once', async () => {
      const u = await mkUser(8010);
      const made = await alerts.create(u, 'TSTA', 'price', 'above', 99_999);
      const row = await t.prisma.alert.findUniqueOrThrow({ where: { id: made.alert.id } });
      expect(row.expiresAt).not.toBeNull();
      await t.prisma.alert.update({
        where: { id: made.alert.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await alerts.checkAll();
      await alerts.checkAll(); // a second run must not notify again
      expect(await t.prisma.alert.findUnique({ where: { id: made.alert.id } })).toMatchObject({
        status: 'EXPIRED',
        activeKey: null,
      });
      expect(t.sent.filter((m) => /kedaluwarsa/.test(m.text))).toHaveLength(1);
      // the same alert can be created again
      expect((await alerts.create(u, 'TSTA', 'price', 'above', 99_999)).duplicate).toBe(false);
    });

    it('expired alerts are listed as recent history, not as active', async () => {
      const u = await mkUser(8011);
      const made = await alerts.create(u, 'TSTA', 'price', 'above', 99_999);
      await t.prisma.alert.update({
        where: { id: made.alert.id },
        data: { status: 'EXPIRED', activeKey: null },
      });
      const list = await alerts.list(u);
      expect(list.active).toHaveLength(0);
      expect(list.paused).toHaveLength(0);
    });
  });

  describe('MA20/MA50 crossover', () => {
    const crossing = (direction: 'up' | 'down') => {
      // 92 flat sessions (MA20 == MA50), then one jump on the LAST session: MA20 moves by jump/20 and MA50
      // by jump/50, so the sign of MA20 - MA50 changes exactly on that session and nowhere before
      const all = syntheticCandles(93, 'flat', 1000);
      const close = direction === 'up' ? 1300 : 700;
      all[all.length - 1] = {
        ...all[all.length - 1],
        open: close,
        high: close + 10,
        low: close - 10,
        close,
      };
      return all;
    };

    it('fires on a golden cross and only on the session where the cross happens', async () => {
      const u = await mkUser(8020);
      const stock = t.provider.stocks.get('TSTA')!;
      const original = stock.candles;
      const originalPrice = stock.price;
      const originalPct = stock.changePercent;
      try {
        stock.candles = crossing('up');
        // the quote follows the last candle: price, change and previous close stay consistent
        stock.price = undefined;
        stock.changePercent = undefined;
        resetCaches(t);
        await alerts.create(u, 'TSTA', 'ma', 'above', 0);
        await alerts.checkAll();
        expect(t.sent).toHaveLength(1);
        expect(t.sent[0].text).toMatch(/MA20 memotong MA50 ke atas/);
        expect(await t.prisma.alert.findFirst()).toMatchObject({ status: 'TRIGGERED' });
      } finally {
        stock.candles = original;
        stock.price = originalPrice;
        stock.changePercent = originalPct;
      }
    });

    it('does not fire when MA20 is above MA50 without a cross on the last session', async () => {
      const u = await mkUser(8021);
      await alerts.create(u, 'TSTA', 'ma', 'above', 0); // TSTA fixture: long uptrend, no fresh cross
      await alerts.checkAll();
      expect(t.sent).toHaveLength(0);
      expect(await t.prisma.alert.findFirst()).toMatchObject({ status: 'ACTIVE' });
    });

    it('a death-cross alert fires on a cross below', async () => {
      const u = await mkUser(8022);
      const stock = t.provider.stocks.get('TSTA')!;
      const original = stock.candles;
      const originalPrice = stock.price;
      const originalPct = stock.changePercent;
      try {
        stock.candles = crossing('down');
        // the quote follows the last candle: price, change and previous close stay consistent
        stock.price = undefined;
        stock.changePercent = undefined;
        resetCaches(t);
        await alerts.create(u, 'TSTA', 'ma', 'below', 0);
        await alerts.checkAll();
        expect(t.sent).toHaveLength(1);
        expect(t.sent[0].text).toMatch(/ke bawah/);
      } finally {
        stock.candles = original;
        stock.price = originalPrice;
        stock.changePercent = originalPct;
      }
    });

    it('is created from natural language', async () => {
      const reply = await say(8023, 'ingatkan saya kalau TSTA golden cross');
      expect(reply).toMatch(/Alert dibuat/);
      expect(reply).toMatch(/MA20 memotong MA50 ke atas/);
      expect(await t.prisma.alert.findFirst()).toMatchObject({ type: 'MA_CROSS_ABOVE' });
    });
  });

  describe('delivery tracking', () => {
    it('a permanently undeliverable alert records the error and is disabled', async () => {
      const u = await mkUser(8030);
      await alerts.create(u, 'TSTA', 'price', 'above', 1500);
      t.failNotifications.value = true;
      t.failNotifications.permanent = true;
      await alerts.checkAll();
      const row = await t.prisma.alert.findFirst();
      expect(row).toMatchObject({ status: 'DISABLED' });
      expect(row?.deliveryError).toMatch(/403|blocked/i);
      expect(row?.deliveredAt).toBeNull();
      t.failNotifications.permanent = false;
    });
  });
});
