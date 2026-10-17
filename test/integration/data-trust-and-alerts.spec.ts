import { AlertService } from '../../src/alert/alert.service';
import { ChatService } from '../../src/chat/chat.service';
import { NotifierService } from '../../src/notifier/notifier.service';
import { RetentionService } from '../../src/scheduler/retention.service';
import { TelegramService } from '../../src/telegram/telegram.service';
import { UserService } from '../../src/user/user.service';
import { createTestApp, TestApp, resetCaches } from '../setup/test-app';

const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const FRESHNESS_LABEL = /🟢 LIVE|🟡 DELAYED|🔴 STALE|⚪ UNKNOWN/;

describe("time references never turn into today's price (HIST fixture: weekdays 2026-01-01..2026-10-02)", () => {
  let t: TestApp;
  let chat: ChatService;
  let uid = 51_000;
  const say = async (text: string) => {
    const r = await chat.handle({ telegramId: ++uid, chatId: uid, username: `u${uid}`, text });
    return { ...r, plain: plain(r.messages.join('\n\n')) };
  };
  const providerCalls = () => Object.values(t.provider.calls).reduce((a, b) => a + b, 0);

  beforeAll(async () => {
    t = await createTestApp();
    chat = t.app.get(ChatService);
  });
  afterAll(() => t.close());

  it('"hari ini" is the current quote (with a freshness label)', async () => {
    const r = await say('harga HIST hari ini');
    expect(r.intent).toBe('STOCK_QUOTE');
    expect(r.plain).toMatch(FRESHNESS_LABEL);
  });

  it('an explicit trading date returns THAT day, with no current-price freshness label', async () => {
    const r = await say('harga HIST tanggal 2026-09-30'); // a Wednesday
    expect(r.intent).toBe('STOCK_HISTORICAL');
    expect(r.plain).toContain('Tanggal diminta: Tanggal (30 September 2026)');
    expect(r.plain).toContain('Penutupan:');
    expect(r.plain).not.toMatch(FRESHNESS_LABEL);
    expect(r.plain).not.toMatch(/Tidak ada data perdagangan/);
  });

  it('a Saturday and a Sunday say there was no trading and label the earlier session explicitly', async () => {
    const sat = await say('harga HIST 2026-09-26');
    expect(sat.plain).toContain('Tidak ada data perdagangan pada 26 September 2026');
    expect(sat.plain).toContain('Data perdagangan terakhir sebelum tanggal itu: 25 September 2026');
    const sun = await say('harga HIST 2026-09-27');
    expect(sun.plain).toContain('Tidak ada data perdagangan pada 27 September 2026');
    expect(sun.plain).toContain('25 September 2026');
    expect(sat.plain + sun.plain).not.toMatch(FRESHNESS_LABEL);
  });

  it('weekday and relative wording that used to fall through to the current quote now resolve to history', async () => {
    for (const q of [
      'harga HIST Sabtu',
      'harga HIST hari Minggu',
      'harga HIST Jumat lalu',
      'harga HIST kemarin',
      'harga HIST kemarin lusa',
      'harga HIST dua hari lalu',
      'harga HIST yesterday',
      'harga HIST minggu kemarin',
      'harga HIST bulan kemarin',
      'harga HIST 7 hari lalu',
    ]) {
      const r = await say(q);
      expect({ q, intent: r.intent }).toEqual({ q, intent: 'STOCK_HISTORICAL' });
      expect(r.plain).toContain('Tanggal diminta:');
      expect(r.plain).not.toMatch(FRESHNESS_LABEL);
    }
  });

  it('"hari bursa terakhir" and "hari bursa sebelumnya" are read off the real candles', async () => {
    const last = await say('harga HIST last trading day');
    expect(last.plain).toContain('Tanggal diminta: Sesi bursa terakhir');
    expect(last.plain).toContain('Penutupan:');
    expect(last.plain).toContain('2 Oktober 2026'); // newest candle in the fixture
    expect(last.plain).not.toMatch(/Tidak ada data perdagangan/);
    const previous = await say('harga HIST hari bursa sebelumnya');
    expect(previous.plain).toContain('1 Oktober 2026');
    expect(last.plain + previous.plain).not.toMatch(FRESHNESS_LABEL);
  });

  it('a date older than the provider history is "not available", never replaced', async () => {
    const r = await say('harga HIST 2012-01-05');
    expect(r.plain).toMatch(/tidak tersedia: riwayat dari provider dimulai/);
    expect(r.plain).not.toContain('Penutupan:');
  });

  it('a future date or "besok" is the prediction policy answer, never a price for that date', async () => {
    for (const q of ['harga HIST 2026-12-31', 'harga HIST besok', 'harga HIST Jumat depan']) {
      const r = await say(q);
      expect(r.intent).toBe('STOCK_ADVICE');
      expect(r.plain).toMatch(/Saya tidak memprediksi/);
      expect(r.plain).not.toMatch(/Tanggal diminta|Penutupan:/);
    }
  });

  it('malformed dates are refused and cost no provider call', async () => {
    resetCaches(t);
    const before = providerCalls();
    for (const q of [
      'harga HIST 31 Februari 2026',
      'harga HIST 2026-02-30',
      'harga HIST 32/01/2026',
    ]) {
      const r = await say(q);
      expect(r.plain).toMatch(/tidak valid/);
      expect(r.plain).not.toContain('Penutupan:');
    }
    expect(providerCalls()).toBe(before);
  });

  it('periods and times of day that daily closes cannot answer are explained, with no data lookup', async () => {
    resetCaches(t);
    const before = providerCalls();
    for (const [q, pattern] of [
      ['harga HIST tahun 2025', /satu tanggal tertentu/],
      ['harga HIST Agustus 2026', /satu tanggal tertentu/],
      ['analisis HIST tahun 2025', /satu tanggal tertentu/],
      ['harga HIST tadi pagi', /penutupan harian/],
      ['harga HIST 2 jam lalu', /penutupan harian/],
    ] as const) {
      const r = await say(q);
      expect(r.plain).toMatch(pattern);
      expect(r.plain).not.toMatch(FRESHNESS_LABEL);
    }
    expect(providerCalls()).toBe(before);
  });
});

describe('only a TRUSTED quote may trigger an alert', () => {
  let t: TestApp;
  let alerts: AlertService;
  let owner: string;
  const DAY = 86_400_000;

  const patchAndWait = async (patch: Parameters<typeof t.provider.patchQuote>[1]) => {
    t.provider.clearOverrides();
    t.provider.patchQuote('TSTA', patch);
    resetCaches(t); // the quote cache lives 1 s in tests
  };
  const status = async () => (await t.prisma.alert.findFirst())?.status;

  beforeAll(async () => {
    t = await createTestApp();
    alerts = t.app.get(AlertService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.prisma.$executeRawUnsafe('TRUNCATE "User","Alert" RESTART IDENTITY CASCADE');
    t.sent.length = 0;
    t.provider.clearOverrides();
    owner = (
      await t.app
        .get(UserService)
        .upsertFromTelegram({ telegramId: 111, chatId: 111, username: 'o' })
    ).id;
    await alerts.create(owner, 'TSTA', 'price', 'above', 1000); // fires on any sane TSTA quote
    resetCaches(t);
  });

  /** fixture TSTA: price 1777, previous close 1774 (= the stored daily candle), change +0,17 % */
  const cases: Array<
    [string, Parameters<TestApp['provider']['patchQuote']>[1], 'invalid' | 'suspect' | 'stale']
  > = [
    ['zero price', { price: 0 }, 'invalid'],
    ['negative price', { price: -5 }, 'invalid'],
    ['NaN price', { price: NaN }, 'invalid'],
    ['Infinity price', { price: Infinity }, 'invalid'],
    ['impossible range (high < low)', { high: 1700, low: 1800 }, 'invalid'],
    ['price above the day high', { price: 1900, high: 1787, low: 1767 }, 'invalid'],
    ['negative day low', { low: -5 }, 'invalid'],
    [
      'internally consistent corrupt quote (price=open=high=low=1)',
      { price: 1, open: 1, high: 1, low: 1, changePercent: -99.94 },
      'suspect',
    ],
    [
      'consistent +900 % jump',
      { price: 17_740, open: 17_740, high: 17_740, low: 17_740, changePercent: 900 },
      'suspect',
    ],
    ['open outside the day range', { open: 5000 }, 'suspect'],
    [
      'previous close that disagrees with the stored daily close',
      { previousClose: 1200, changePercent: 48.1 },
      'suspect',
    ],
    [
      'stale timestamp (6 days)',
      { timestamp: new Date(Date.now() - 6 * DAY).toISOString() },
      'stale',
    ],
    ['unparsable timestamp', { timestamp: 'not-a-date' }, 'stale'],
  ];

  it.each(cases)(
    '%s never triggers (%s) and the alert stays active',
    async (_label, patch, kind) => {
      await patchAndWait(patch);
      const run = await alerts.checkAll();
      expect(run.triggered).toBe(0);
      expect(kind === 'stale' ? run.skippedStale : run.skippedAnomaly).toBe(1);
      expect(t.sent).toHaveLength(0);
      expect(await status()).toBe('ACTIVE');
    },
  );

  it('CONTROL: an ordinary quote fires (so none of the above passes vacuously)', async () => {
    await patchAndWait({ price: 1800, high: 1810, low: 1790, open: 1795, changePercent: 1.47 });
    const run = await alerts.checkAll();
    expect(run).toMatchObject({ triggered: 1, skippedAnomaly: 0, skippedStale: 0 });
    expect(t.sent).toHaveLength(1);
  });

  it('legitimate large moves stay possible: an ARA-sized +35 % day is trusted', async () => {
    const price = 2395; // 1774 * 1.35
    await patchAndWait({ price, open: 2350, high: 2400, low: 2300, changePercent: 35 });
    expect(await alerts.checkAll()).toMatchObject({ triggered: 1, skippedAnomaly: 0 });
  });

  it('a missing previous close is not a reason to block when the stored daily close provides the reference', async () => {
    await patchAndWait({ previousClose: null, changePercent: null });
    expect(await alerts.checkAll()).toMatchObject({ triggered: 1, skippedAnomaly: 0 });
  });

  it('skipped alerts are not consumed: once the data is trustworthy they fire exactly once', async () => {
    await patchAndWait({ price: 1, open: 1, high: 1, low: 1, changePercent: -99.94 });
    expect((await alerts.checkAll()).triggered).toBe(0);
    await patchAndWait({ price: 1800, high: 1810, low: 1790, open: 1795, changePercent: 1.47 });
    expect((await alerts.checkAll()).triggered).toBe(1);
    resetCaches(t);
    expect((await alerts.checkAll()).triggered).toBe(0);
    expect(t.sent).toHaveLength(1);
  });

  it('indicator alerts are blocked by an untrusted quote too', async () => {
    await alerts.create(owner, 'TSTA', 'rsi', 'above', 70); // the synthetic uptrend has RSI far above 70
    await patchAndWait({ price: 1, open: 1, high: 1, low: 1, changePercent: -99.94 });
    const run = await alerts.checkAll();
    expect(run.triggered).toBe(0);
    expect(t.sent).toHaveLength(0);
  });

  it('the analysis of an invalid quote is not handed to the model (the warning is shown instead)', async () => {
    const chat = t.app.get(ChatService);
    // TSTC: not analysed earlier in this block, so no cached (60 s) report can mask the quote below
    t.provider.clearOverrides();
    t.provider.patchQuote('TSTC', { price: 0 });
    resetCaches(t);
    t.ai.generated = [];
    const r = await chat.handle({
      telegramId: 777,
      chatId: 777,
      username: 'x',
      text: 'analisis TSTC',
    });
    const text = plain(r.messages.join('\n'));
    expect(t.ai.generated).toHaveLength(0);
    expect(text).toMatch(/Analisis AI dilewati karena data harga/);
    expect(text).toMatch(/Harga terlihat tidak wajar/);
  });
});

describe('alerts stay in the chat they were created in (no "last active chat")', () => {
  let t: TestApp;
  let chat: ChatService;
  let alerts: AlertService;
  const GROUP = -1_002_000_000_001;
  const GROUP2 = -1_002_000_000_002;

  const say = async (
    text: string,
    telegramId: number,
    chatId = telegramId,
    chatType = 'private',
  ) => {
    const r = await chat.handle({ telegramId, chatId, chatType, username: `u${telegramId}`, text });
    return { ...r, plain: plain(r.messages.join('\n\n')) };
  };
  const move = async (price = 1800) => {
    t.provider.clearOverrides();
    t.provider.setPrice('TSTA', price);
    t.provider.patchQuote('TSTA', {
      high: price + 10,
      low: price - 10,
      open: price,
      changePercent: 1.5,
    });
    resetCaches(t);
  };

  beforeAll(async () => {
    t = await createTestApp();
    chat = t.app.get(ChatService);
    alerts = t.app.get(AlertService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.prisma.$executeRawUnsafe(
      'TRUNCATE "User","Alert","Watchlist" RESTART IDENTITY CASCADE',
    );
    t.sent.length = 0;
    t.provider.clearOverrides();
    resetCaches(t);
  });

  const ALERT = 'ingatkan saya kalau TSTA di atas 1790';

  it('private A, private B and a group each get their own alert, delivered to their own chat only', async () => {
    const a = await say(ALERT, 111);
    const b = await say(ALERT, 222);
    const g = await say(ALERT, 333, GROUP, 'supergroup');
    expect(a.plain).toMatch(/Notifikasi dikirim ke chat pribadimu/);
    expect(g.plain).toMatch(/milik grup ini/);

    const rows = await t.prisma.alert.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [Number(r.chatId), r.chatType])).toEqual([
      [111, 'private'],
      [222, 'private'],
      [GROUP, 'supergroup'],
    ]);

    await move();
    t.sent.length = 0;
    expect((await alerts.checkAll()).triggered).toBe(3);
    const byChat = (id: number) => t.sent.filter((s) => s.chatId === id);
    expect(byChat(111)).toHaveLength(1);
    expect(byChat(222)).toHaveLength(1);
    expect(byChat(GROUP)).toHaveLength(1);
    expect(byChat(333)).toHaveLength(0); // the group-alert's owner got nothing in private
    expect(byChat(GROUP)[0].text).toContain('Alert milik @u333'); // a group alert says whose it is
    expect(byChat(111)[0].text).not.toContain('Alert milik');
    expect(t.sent).toHaveLength(3);
    void a;
    void b;
  });

  it('the same user in private and in a group has two separate alerts; each chat lists and deletes only its own', async () => {
    await say('ingatkan saya kalau TSTB di bawah 1100', 444); // private
    await say('ingatkan saya kalau TSTB di bawah 1100', 444, GROUP2, 'group'); // same wording, in a group
    expect(await t.prisma.alert.count({ where: { status: 'ACTIVE' } })).toBe(2); // not merged as a duplicate

    const privateList = await say('lihat alert saya', 444);
    const groupList = await say('lihat alert saya', 444, GROUP2, 'group');
    expect(privateList.plain).toMatch(/ALERT AKTIF \(1\/20\)/);
    expect(groupList.plain).toMatch(/ALERT AKTIF \(1\/20\)/);

    const del = await say('hapus alert TSTB', 444, GROUP2, 'group');
    expect(del.plain).toMatch(/Alert dihapus \(1\)/);
    const rows = await t.prisma.alert.findMany();
    expect(rows.filter((r) => r.status === 'ACTIVE').map((r) => Number(r.chatId))).toEqual([444]); // private one untouched
    expect(rows.filter((r) => r.status === 'DISABLED').map((r) => Number(r.chatId))).toEqual([
      GROUP2,
    ]);
  });

  it('an alert created in private still goes to the private chat after the user writes in a group (no last-chat leak)', async () => {
    await say(ALERT, 555);
    await say('TSTB', 555, GROUP, 'supergroup'); // the same person then talks in a group
    await say('lihat alert saya', 555, GROUP2, 'group');
    const user = await t.prisma.user.findUnique({ where: { telegramId: BigInt(555) } });
    expect(Number(user?.chatId)).toBe(555); // User.chatId is never overwritten by a group chat id

    await move();
    t.sent.length = 0;
    await alerts.checkAll();
    expect(t.sent.map((s) => s.chatId)).toEqual([555]);
  });

  it('a group alert is not shown when the owner lists alerts in private', async () => {
    await say(ALERT, 666, GROUP, 'supergroup');
    const list = await say('lihat alert saya', 666);
    expect(list.plain).toMatch(/belum punya alert/);
  });

  it('a watchlist is personal: it is refused in a group and nothing is stored', async () => {
    const r = await say('tambahkan TSTA ke watchlist', 777, GROUP, 'supergroup');
    expect(r.plain).toMatch(/Watchlist bersifat pribadi/);
    expect(await t.prisma.watchlistItem.count()).toBe(0);
    const priv = await say('tambahkan TSTA ke watchlist', 777);
    expect(priv.plain).toMatch(/Ditambahkan ke watchlist/);
  });

  it('an alert whose group can no longer be reached is disabled, and the owner is told privately', async () => {
    const notifier = t.app.get(NotifierService);
    notifier.register(async (chatId, text) => {
      if (chatId < 0)
        throw Object.assign(new Error('Forbidden: bot was kicked from the group chat'), {
          error_code: 403,
        });
      t.sent.push({ chatId, text });
    });
    await say(ALERT, 888, GROUP, 'supergroup');
    await move();
    const run = await alerts.checkAll();
    expect(run.triggered).toBe(0);
    expect((await t.prisma.alert.findFirst())?.status).toBe('DISABLED');
    const notice = t.sent.find((s) => s.chatId === 888);
    expect(notice?.text).toMatch(/dinonaktifkan karena grup tujuannya tidak dapat dihubungi/);
    notifier.register(async (chatId, text) => {
      t.sent.push({ chatId, text });
    });
  });

  it('a legacy alert without a delivery chat is never guessed from user state: it is skipped', async () => {
    const user = await t.app
      .get(UserService)
      .upsertFromTelegram({ telegramId: 999, chatId: 999, username: 'legacy' });
    const stock = await t.prisma.stock.upsert({
      where: { symbol: 'TSTA' },
      create: { symbol: 'TSTA' },
      update: {},
    });
    await t.prisma.alert.create({
      data: {
        userId: user.id,
        stockId: stock.id,
        type: 'PRICE_ABOVE',
        threshold: 1000,
        chatId: null,
      },
    });
    await move();
    t.sent.length = 0;
    const run = await alerts.checkAll();
    expect(run).toMatchObject({ triggered: 0, skippedNoTarget: 1 });
    expect(t.sent).toHaveLength(0);
  });
});

describe('retention keeps storage bounded and never touches live data', () => {
  let t: TestApp;
  let retention: RetentionService;
  const NOW = new Date('2026-10-03T00:00:00.000Z');
  const DAY = 86_400_000;
  const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs);

  beforeAll(async () => {
    t = await createTestApp();
    retention = t.app.get(RetentionService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.prisma.$executeRawUnsafe(
      'TRUNCATE "User","Stock","DataFetchLog","Alert","AIAnalysis","ConversationContext" RESTART IDENTITY CASCADE',
    );
  });

  async function seed() {
    const user = await t.prisma.user.create({ data: { telegramId: BigInt(1), chatId: BigInt(1) } });
    const stock = await t.prisma.stock.create({ data: { symbol: 'TSTA' } });
    return { user, stock };
  }
  const setUpdatedAt = (id: string, at: Date) =>
    t.prisma.$executeRaw`UPDATE "Alert" SET "updatedAt" = ${at} WHERE id = ${id}`;

  it('DataFetchLog: removes rows older than the window, keeps recent ones, boundary row is kept', async () => {
    await t.prisma.dataFetchLog.createMany({
      data: [
        { provider: 'p', operation: 'quote', success: true, latencyMs: 1, createdAt: ago(8) }, // old
        { provider: 'p', operation: 'quote', success: true, latencyMs: 1, createdAt: ago(7, 1) }, // 1 ms past the window
        { provider: 'p', operation: 'quote', success: true, latencyMs: 1, createdAt: ago(7) }, // exactly at the boundary
        { provider: 'p', operation: 'quote', success: true, latencyMs: 1, createdAt: ago(6) }, // recent
        { provider: 'p', operation: 'quote', success: true, latencyMs: 1, createdAt: NOW }, // now
      ],
    });
    const r = await retention.run(NOW);
    expect(r.fetchLogs).toBe(2);
    expect(await t.prisma.dataFetchLog.count()).toBe(3);
  });

  it('AIAnalysis: 30-day window with the same boundary rule', async () => {
    const { user, stock } = await seed();
    const mk = (createdAt: Date) => ({
      userId: user.id,
      stockId: stock.id,
      analysisType: 'ANALYSIS',
      inputSnapshot: {},
      output: {},
      provider: 'p',
      createdAt,
    });
    await t.prisma.aIAnalysis.createMany({
      data: [mk(ago(31)), mk(ago(30, 1)), mk(ago(30)), mk(ago(29)), mk(NOW)],
    });
    const r = await retention.run(NOW);
    expect(r.aiAnalyses).toBe(2);
    expect(await t.prisma.aIAnalysis.count()).toBe(3);
  });

  it('Alerts: only TRIGGERED/DISABLED history older than the window is removed; ACTIVE alerts are NEVER deleted', async () => {
    const { user, stock } = await seed();
    const mk = (status: 'ACTIVE' | 'TRIGGERED' | 'DISABLED') =>
      t.prisma.alert.create({
        data: {
          userId: user.id,
          stockId: stock.id,
          type: 'PRICE_ABOVE',
          threshold: Math.random() * 1e6,
          status,
          chatId: BigInt(1),
        },
      });
    const [activeOld, triggeredOld, disabledOld, disabledEdge, disabledRecent, triggeredRecent] =
      await Promise.all([
        mk('ACTIVE'),
        mk('TRIGGERED'),
        mk('DISABLED'),
        mk('DISABLED'),
        mk('DISABLED'),
        mk('TRIGGERED'),
      ]);
    await setUpdatedAt(activeOld.id, ago(400)); // ancient but ACTIVE
    await setUpdatedAt(triggeredOld.id, ago(31));
    await setUpdatedAt(disabledOld.id, ago(30, 1));
    await setUpdatedAt(disabledEdge.id, ago(30));
    await setUpdatedAt(disabledRecent.id, ago(29));
    await setUpdatedAt(triggeredRecent.id, ago(1));

    const r = await retention.run(NOW);
    expect(r.alertHistory).toBe(2);
    const left = (await t.prisma.alert.findMany()).map((a) => a.id).sort();
    expect(left).toEqual(
      [activeOld.id, disabledEdge.id, disabledRecent.id, triggeredRecent.id].sort(),
    );
  });

  it('ConversationContext: only expired rows go', async () => {
    const { user } = await seed();
    const other = await t.prisma.user.create({
      data: { telegramId: BigInt(2), chatId: BigInt(2) },
    });
    await t.prisma.conversationContext.create({
      data: {
        userId: user.id,
        chatId: BigInt(1),
        context: {},
        expiresAt: new Date(NOW.getTime() - 1),
      },
    });
    await t.prisma.conversationContext.create({
      data: {
        userId: other.id,
        chatId: BigInt(2),
        context: {},
        expiresAt: new Date(NOW.getTime() + 60_000),
      },
    });
    const r = await retention.run(NOW);
    expect(r.conversationContexts).toBe(1);
    expect(await t.prisma.conversationContext.count()).toBe(1);
  });

  it('never deletes users, watchlists, stocks, quote snapshots or candles', async () => {
    const { user, stock } = await seed();
    await t.prisma.watchlist.create({ data: { userId: user.id, name: 'Default' } });
    await t.prisma.stockQuoteSnapshot.create({
      data: {
        stockId: stock.id,
        payload: {},
        provider: 'p',
        quotedAt: ago(500),
        fetchedAt: ago(500),
      },
    });
    await t.prisma.stockDailyPrice.create({
      data: {
        stockId: stock.id,
        date: ago(900),
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: BigInt(1),
        provider: 'p',
      },
    });
    await retention.run(new Date(NOW.getTime() + 1000 * DAY)); // far in the future: everything is "old"
    expect(await t.prisma.user.count()).toBe(1);
    expect(await t.prisma.watchlist.count()).toBe(1);
    expect(await t.prisma.stock.count()).toBe(1);
    expect(await t.prisma.stockQuoteSnapshot.count()).toBe(1);
    expect(await t.prisma.stockDailyPrice.count()).toBe(1);
  });

  it('is idempotent, reports what it removed, and a second pass removes nothing', async () => {
    await t.prisma.dataFetchLog.create({
      data: { provider: 'p', operation: 'q', success: true, latencyMs: 1, createdAt: ago(40) },
    });
    expect((await retention.run(NOW)).fetchLogs).toBe(1);
    expect(await retention.run(NOW)).toEqual({
      fetchLogs: 0,
      aiAnalyses: 0,
      alertHistory: 0,
      conversationContexts: 0,
      fundamentalSnapshots: 0,
      newsArticles: 0,
    });
  });

  it('runSafely never throws and does not overlap itself', async () => {
    const slow = retention.runSafely(NOW);
    const second = await retention.runSafely(NOW); // overlapping call is skipped
    expect(second).toBeNull();
    await slow;
    const spy = jest
      .spyOn(t.prisma.dataFetchLog, 'deleteMany')
      .mockRejectedValueOnce(new Error('db down'));
    await expect(retention.runSafely(NOW)).resolves.toBeNull();
    spy.mockRestore();
  });

  it('negative caching: repeated lookups of an unknown ticker stop reaching the provider after the second miss', async () => {
    const chat = t.app.get(ChatService);
    const before = t.provider.calls.quote;
    for (let i = 0; i < 4; i++)
      await chat.handle({ telegramId: 5, chatId: 5, username: 'n', text: 'harga ZZYX' });
    expect(t.provider.calls.quote - before).toBe(2); // 1st miss is only noted, 2nd is cached, 3rd/4th are free
  });
});

describe('tests can never start the real Telegram transport', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('the app under test has Telegram disabled: no bot, no runner, no polling', () => {
    const tg = t.app.get(TelegramService) as unknown as {
      bot?: unknown;
      runner?: unknown;
      health: { status: string };
    };
    expect(tg.health.status).toBe('disabled');
    expect(tg.bot).toBeUndefined();
    expect(tg.runner).toBeUndefined();
  });

  it('the test environment holds no bot token and says it is a test', () => {
    expect(Boolean(process.env.TELEGRAM_BOT_TOKEN)).toBe(false);
    expect(process.env.NODE_ENV).toBe('test');
    expect(process.env.TELEGRAM_ENABLED).toBe('false');
  });

  it('importing the test harness neutralises a token that was present in the environment (e.g. from .env)', () => {
    const original = process.env.TELEGRAM_BOT_TOKEN;
    try {
      process.env.TELEGRAM_BOT_TOKEN = ['123456', 'FAKE-token-that-is-not-real-0000000000000'].join(
        ':',
      );
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../setup/test-app');
      });
      expect(Boolean(process.env.TELEGRAM_BOT_TOKEN)).toBe(false);
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = original ?? '';
    }
  });

  it('even if a token reached the validated config, the transport refuses to start in a test process', async () => {
    const tg = t.app.get(TelegramService) as unknown as { start: (b: unknown) => Promise<void> };
    await expect(tg.start({})).rejects.toThrow('TELEGRAM_DISABLED_IN_TEST');
  });
});
