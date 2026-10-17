import { AlertService } from '../../src/alert/alert.service';
import { AnalysisService } from '../../src/analysis/analysis.service';
import { ChatService } from '../../src/chat/chat.service';
import { TickerRegistry } from '../../src/stock/governance/ticker-registry';
import { UserService } from '../../src/user/user.service';
import { createTestApp, TestApp, resetCaches, flushBackground, sleep } from '../setup/test-app';

/**
 * Regression tests for an earlier independent review (alert races, context scoping, negative caching, REST exposure).
 * Fake provider + fake AI, real PostgreSQL (ai_stock_test).
 */
const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

describe('Scoping and races (integration)', () => {
  let t: TestApp;
  let chat: ChatService;
  let alerts: AlertService;
  let users: UserService;

  const reset = async () => {
    await t.prisma.$executeRawUnsafe(
      'TRUNCATE "User","Alert","Watchlist","WatchlistItem","ConversationContext","DataFetchLog","StockQuoteSnapshot" RESTART IDENTITY CASCADE',
    );
    t.sent.length = 0;
    t.provider.clearOverrides();
    t.failNotifications.value = false;
  };
  const mkUser = async (telegramId: number) =>
    (await users.upsertFromTelegram({ telegramId, chatId: telegramId, username: `u${telegramId}` }))
      .id;
  const say = async (text: string, telegramId: number, chatId = telegramId) => {
    const chatType = chatId > 0 ? 'private' : 'supergroup';
    const r = await chat.handle({ telegramId, chatId, chatType, username: `u${telegramId}`, text });
    return { ...r, plain: plain(r.messages.join('\n')) };
  };

  beforeAll(async () => {
    t = await createTestApp();
    chat = t.app.get(ChatService);
    alerts = t.app.get(AlertService);
    users = t.app.get(UserService);
  });
  afterAll(() => t.close());
  beforeEach(reset);

  describe('alert creation is race-free', () => {
    it('40 concurrent creates by one user end at exactly the cap (20), the rest are refused', async () => {
      const u = await mkUser(1001);
      const res = await Promise.allSettled(
        Array.from({ length: 40 }, (_, i) => alerts.create(u, 'TSTA', 'price', 'above', 5000 + i)),
      );
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(20);
      const refused = res.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(refused).toHaveLength(20);
      refused.forEach((r) => expect(r.reason).toMatchObject({ code: 'ALERT_LIMIT' }));
      expect(await t.prisma.alert.count({ where: { userId: u, status: 'ACTIVE' } })).toBe(20);
    });

    it('20 identical concurrent creates leave exactly ONE active alert; the rest report "duplicate"', async () => {
      const u = await mkUser(1002);
      const res = await Promise.all(
        Array.from({ length: 20 }, () => alerts.create(u, 'TSTA', 'price', 'above', 5000)),
      );
      expect(res.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(res.filter((r) => r.duplicate)).toHaveLength(19);
      expect(await t.prisma.alert.count({ where: { userId: u, status: 'ACTIVE' } })).toBe(1);
      expect(new Set(res.map((r) => r.alert.id)).size).toBe(1);
    });

    it('the same alert in different chats of one user is allowed (scope is part of identity)', async () => {
      const u = await mkUser(1003);
      const a = await alerts.create(u, 'TSTA', 'price', 'above', 5000, {
        chatId: 1003,
        chatType: 'private',
      });
      const b = await alerts.create(u, 'TSTA', 'price', 'above', 5000, {
        chatId: -100777,
        chatType: 'supergroup',
      });
      expect(a.alert.id).not.toBe(b.alert.id);
      expect(b.duplicate).toBe(false);
    });

    it('through ChatService, parallel requests from several chats of one account respect the cap', async () => {
      // The per-user message limit (20/min) would also bound the count and make this test pass for the
      // wrong reason, so it is lifted: only the database rule can produce the cap here.
      (chat as unknown as { userLimitPerMinute: number }).userLimitPerMinute = 1000;
      await mkUser(1004);
      const chats = [1004, -1001, -1002, -1003];
      const jobs = chats.flatMap((cid, ci) =>
        Array.from({ length: 8 }, (_, i) =>
          say(`ingatkan saya kalau TSTA di atas ${6000 + ci * 10 + i}`, 1004, cid),
        ),
      ); // 32 distinct alerts requested, 12 more than allowed
      const replies = await Promise.all(jobs);
      expect(await t.prisma.alert.count({ where: { status: 'ACTIVE' } })).toBe(20);
      expect(replies.filter((r) => /batas maksimum/i.test(r.plain))).toHaveLength(12);
    });

    it('reactivating a claimed alert cannot push the user past the cap', async () => {
      const u = await mkUser(1010);
      const made = [];
      for (let i = 0; i < 20; i++)
        made.push(await alerts.create(u, 'TSTA', 'price', 'above', 7000 + i));
      // alert #0 fires and is claimed (TRIGGERED, key released) while delivery is still running
      await t.prisma.alert.update({
        where: { id: made[0].alert.id },
        data: { status: 'TRIGGERED', activeKey: null },
      });
      await alerts.create(u, 'TSTA', 'price', 'above', 7500); // the user fills the freed slot meanwhile
      expect(await t.prisma.alert.count({ where: { userId: u, status: 'ACTIVE' } })).toBe(20);

      const outcome = await (
        alerts as unknown as { reactivate: (x: unknown) => Promise<string> }
      ).reactivate(await t.prisma.alert.findUniqueOrThrow({ where: { id: made[0].alert.id } }));
      expect(outcome).toBe('capped');
      expect(await t.prisma.alert.count({ where: { userId: u, status: 'ACTIVE' } })).toBe(20);
      expect(await t.prisma.alert.findUnique({ where: { id: made[0].alert.id } })).toMatchObject({
        status: 'DISABLED',
        activeKey: null,
      });
    });

    it('create and reactivate racing for the last slot end at exactly the cap', async () => {
      const u = await mkUser(1011);
      const made = [];
      for (let i = 0; i < 20; i++)
        made.push(await alerts.create(u, 'TSTA', 'price', 'above', 7000 + i));
      await t.prisma.alert.update({
        where: { id: made[0].alert.id },
        data: { status: 'TRIGGERED', activeKey: null },
      });
      const claimed = await t.prisma.alert.findUniqueOrThrow({ where: { id: made[0].alert.id } });
      const reactivate = (
        alerts as unknown as { reactivate: (x: unknown) => Promise<string> }
      ).reactivate.bind(alerts);
      await Promise.allSettled([
        reactivate(claimed),
        alerts.create(u, 'TSTA', 'price', 'above', 7600),
        alerts.create(u, 'TSTA', 'price', 'above', 7601),
      ]);
      expect(await t.prisma.alert.count({ where: { userId: u, status: 'ACTIVE' } })).toBe(20);
    });

    it('reactivate and create both wait for the per-user advisory lock (removing the lock must fail a test)', async () => {
      const u = await mkUser(1013);
      const made = await alerts.create(u, 'TSTA', 'price', 'above', 7000);
      await t.prisma.alert.update({
        where: { id: made.alert.id },
        data: { status: 'TRIGGERED', activeKey: null },
      });
      const claimed = await t.prisma.alert.findUniqueOrThrow({ where: { id: made.alert.id } });
      const reactivate = (
        alerts as unknown as { reactivate: (x: unknown) => Promise<string> }
      ).reactivate.bind(alerts);

      let reactivated: Promise<string> | undefined;
      let created: Promise<unknown> | undefined;
      let reactivateDone = false;
      let createDone = false;
      await t.prisma.$transaction(
        async (tx) => {
          // this transaction holds the user's lock, exactly as another create/reactivate would
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${u}, 0))`;
          reactivated = reactivate(claimed).then((r) => ((reactivateDone = true), r));
          created = alerts
            .create(u, 'TSTA', 'price', 'above', 7100)
            .then((r) => ((createDone = true), r));
          await sleep(500);
          expect(reactivateDone).toBe(false); // still waiting for the lock
          expect(createDone).toBe(false);
        },
        { timeout: 15_000 },
      );
      expect(await reactivated).toBe('reactivated');
      await created;
      expect(await t.prisma.alert.count({ where: { userId: u, status: 'ACTIVE' } })).toBe(2);
    });

    it('a threshold is stored quantised and its key is plain decimal text', async () => {
      const u = await mkUser(1012);
      const tiny = await alerts.create(u, 'TSTA', 'price', 'above', 0.00001);
      expect(
        (await t.prisma.alert.findUniqueOrThrow({ where: { id: tiny.alert.id } })).activeKey,
      ).toMatch(/:PRICE_ABOVE:0\.00001:1012$/);
      await expect(alerts.create(u, 'TSTA', 'price', 'above', 1e-9)).rejects.toThrow(
        /terlalu kecil/,
      );
      await expect(alerts.create(u, 'TSTA', 'price', 'above', 1e12)).rejects.toThrow(
        /tidak masuk akal/,
      );
      await expect(alerts.create(u, 'TSTA', 'price', 'above', Number.NaN)).rejects.toThrow(
        /tidak masuk akal/,
      );
      const a = await alerts.create(u, 'TSTA', 'price', 'above', 0.1 + 0.2);
      const b = await alerts.create(u, 'TSTA', 'price', 'above', 0.3);
      expect(b.duplicate).toBe(true);
      expect(b.alert.id).toBe(a.alert.id);
    });

    it('activeKey exists only while ACTIVE; identical alerts may be recreated after disable or trigger', async () => {
      const u = await mkUser(1005);
      const first = await alerts.create(u, 'TSTA', 'price', 'above', 1500);
      expect(
        (await t.prisma.alert.findUnique({ where: { id: first.alert.id } }))?.activeKey,
      ).toMatch(/:PRICE_ABOVE:1500:1005$/);
      await alerts.disable(u, { all: true });
      const afterDisable = await t.prisma.alert.findUnique({ where: { id: first.alert.id } });
      expect(afterDisable).toMatchObject({ status: 'DISABLED', activeKey: null });

      const second = await alerts.create(u, 'TSTA', 'price', 'above', 1500);
      expect(second.duplicate).toBe(false);
      await alerts.checkAll(); // TSTA is at 1777: fires, delivered
      expect(t.sent).toHaveLength(1);
      expect(await t.prisma.alert.findUnique({ where: { id: second.alert.id } })).toMatchObject({
        status: 'TRIGGERED',
        activeKey: null,
      });

      const third = await alerts.create(u, 'TSTA', 'price', 'above', 1500);
      expect(third.duplicate).toBe(false);
      expect(await t.prisma.alert.count({ where: { userId: u } })).toBe(3);
    });

    it('a transient delivery failure restores the unique key; a clash with a newer identical alert disables the old one', async () => {
      const u = await mkUser(1006);
      const a = await alerts.create(u, 'TSTA', 'price', 'above', 1500);
      t.failNotifications.value = true;
      await alerts.checkAll();
      expect(await t.prisma.alert.findUnique({ where: { id: a.alert.id } })).toMatchObject({
        status: 'ACTIVE',
      });
      expect(
        (await t.prisma.alert.findUnique({ where: { id: a.alert.id } }))?.activeKey,
      ).not.toBeNull();

      // Same situation, but an identical active alert appears while the first is "in flight".
      await t.prisma.alert.update({
        where: { id: a.alert.id },
        data: { status: 'TRIGGERED', activeKey: null },
      });
      const newer = await alerts.create(u, 'TSTA', 'price', 'above', 1500);
      expect(newer.duplicate).toBe(false);
      await (alerts as unknown as { reactivate: (x: unknown) => Promise<void> }).reactivate(
        await t.prisma.alert.findUniqueOrThrow({ where: { id: a.alert.id } }),
      );
      expect(await t.prisma.alert.findUnique({ where: { id: a.alert.id } })).toMatchObject({
        status: 'DISABLED',
        activeKey: null,
      });
      expect(await t.prisma.alert.count({ where: { userId: u, status: 'ACTIVE' } })).toBe(1);
    });
  });

  describe('conversation context is per chat', () => {
    it('a ticker looked up in private is not used by a bare command in a group (and vice versa)', async () => {
      await say('analisis TSTB', 2001, 2001); // private
      const group = await say('/technical', 2001, -100888);
      expect(group.plain).toMatch(/Saham mana yang kamu maksud/);
      expect(group.plain).not.toMatch(/TSTB/);

      await say('harga TSTA', 2001, -100888); // group lookup
      const privateFollowUp = await say('/technical', 2001, 2001);
      expect(privateFollowUp.plain).toMatch(/TSTB/); // still the PRIVATE context
      expect(privateFollowUp.plain).not.toMatch(/TSTA/);
      expect(await t.prisma.conversationContext.count()).toBe(2);
    });

    it('two groups do not share context either', async () => {
      await say('harga TSTA', 2002, -100111);
      const other = await say('/technical', 2002, -100222);
      expect(other.plain).toMatch(/Saham mana yang kamu maksud/);
    });
  });

  describe('a transient NOT_FOUND does not hide a valid ticker', () => {
    const flipOnce = (symbol: string) => {
      const original = t.provider.getQuote.bind(t.provider);
      let flipped = false;
      t.provider.getQuote = async (s: string) => {
        if (s === symbol && !flipped) {
          flipped = true;
          return { available: false, error: 'unusable quote', code: 'NOT_FOUND' } as never;
        }
        return original(s);
      };
      return () => {
        t.provider.getQuote = original;
      };
    };

    it('a ticker with a stored quote falls back to it, and recovers as soon as the provider does', async () => {
      resetCaches(t); // an earlier test may have left TSTB in the 1 s quote cache (then nothing is stored)
      expect((await say('harga TSTB', 3001)).plain).toContain('FIXTURE B Tbk');
      await flushBackground(t); // background persistence of the snapshot
      resetCaches(t); // quote cache TTL is 1 s in tests
      const restore = flipOnce('TSTB');
      const hiccup = await say('harga TSTB', 3002);
      expect(hiccup.plain).not.toMatch(/tidak ditemukan/i);
      expect(hiccup.plain).toContain('FIXTURE B Tbk'); // stored copy, labelled by the freshness line
      resetCaches(t);
      const after = await say('harga TSTB', 3003);
      expect(after.plain).toContain('FIXTURE B Tbk');
      expect(after.plain).not.toMatch(/tidak ditemukan/i);
      restore();
    });

    it('a ticker that was served before is not negative-cached even without a stored copy', async () => {
      resetCaches(t);
      expect((await say('harga TSTC', 3011)).plain).toContain('FIXTURE C Tbk');
      await flushBackground(t);
      await t.prisma.stockQuoteSnapshot.deleteMany({});
      resetCaches(t);
      const restore = flipOnce('TSTC');
      expect((await say('harga TSTC', 3012)).plain).toMatch(/tidak ditemukan/i); // this one request fails
      resetCaches(t);
      const next = await say('harga TSTC', 3013); // ...but nothing was cached against the ticker
      expect(next.plain).toContain('FIXTURE C Tbk');
      restore();
    });

    it('a made-up ticker is remembered as unknown after the SECOND miss, not one provider call per message', async () => {
      const before = t.provider.calls.quote;
      for (let i = 0; i < 4; i++) await say('harga ZZQX', 3021 + i);
      expect(t.provider.calls.quote - before).toBe(2); // 1st miss: not cached; 2nd miss: cached; 3rd/4th: free
    });

    it('a listed IDX ticker that has never been served is never negative-cached', async () => {
      // BBCA is on the IDX list but unknown to the fixture provider, which answers NOT_FOUND for it
      const before = t.provider.calls.quote;
      for (let i = 0; i < 3; i++) await say('harga BBCA', 3031 + i);
      expect(t.provider.calls.quote - before).toBe(3); // asked every time: a hiccup cannot stick
    });

    it('one transient NOT_FOUND for a valid ticker this process has not served does not hide it from the next user', async () => {
      t.app.get(TickerRegistry).reset(); // this process has not served the ticker
      await t.prisma.stockQuoteSnapshot.deleteMany({});
      resetCaches(t);
      const restore = flipOnce('TSTC');
      expect((await say('harga TSTC', 3041)).plain).toMatch(/tidak ditemukan/i); // the hiccup
      resetCaches(t);
      expect((await say('harga TSTC', 3042)).plain).toContain('FIXTURE C Tbk'); // not cached against it
      restore();
    });
  });

  describe('routing and time handling end to end', () => {
    const aiCalls = () => t.ai.generated.length;

    it.each([
      'harga TSTA 2025',
      'harga TSTA 2/10',
      'harga TSTA kuartal lalu',
      'harga TSTA saat pembukaan',
      'harga TSTA pukul 09.15 kemarin',
    ])('"%s" is answered with an explanation, never with the current quote', async (text) => {
      const r = await say(text, 4001);
      expect(r.plain).toMatch(/(satu tanggal tertentu|belum lengkap|data per jam)/);
      expect(r.plain).not.toMatch(/Harga Rp|FIXTURE A Tbk/);
    });

    it('advice-style wording without a ticker gets the fixed policy answer: no model call, no ticker prompt', async () => {
      t.ai.generated.length = 0;
      for (const text of ['Jual sekarang.', 'Sell immediately.', 'Pasti naik kan?', 'No risk?']) {
        const r = await say(text, 4002);
        expect(r.intent).toBe('STOCK_ADVICE');
        expect(r.plain).toMatch(/Sebutkan kode sahamnya/);
        expect(r.plain).not.toMatch(/Saham mana yang kamu maksud/);
      }
      expect(aiCalls()).toBe(0);
    });

    it('a question that also asks for advice gets the policy notice above the data-based answer', async () => {
      const r = await say('kenapa TSTA naik? sebaiknya beli?', 4003);
      expect(r.intent).toBe('STOCK_QUESTION');
      expect(r.plain).toMatch(
        /Saya tidak memberikan instruksi beli\/jual, target harga, atau prediksi/,
      );
      expect(r.plain).toMatch(/Penyebab pergerakan \(berita\/fundamental\) tidak tersedia/);
      expect(r.plain.indexOf('Saya tidak memberikan')).toBeLessThan(r.plain.indexOf('FIXTURE A'));
    });

    it('conceptual phrasings reach the glossary (no ticker prompt, no model)', async () => {
      t.ai.generated.length = 0;
      for (const text of ['Bagaimana RSI bekerja?', 'RSI itu apa sih?', 'Buat saya paham RSI']) {
        const r = await say(text, 4004);
        expect(r.intent).toBe('GENERAL_QUESTION');
        expect(r.plain).toMatch(/Relative Strength Index/);
      }
      expect(aiCalls()).toBe(0);
    });

    it('"kasih tahu apakah …" is a question, not an alert', async () => {
      const r = await say(
        'Jangan bilang "beli", tapi kasih tahu apakah saya harus masuk TSTA.',
        4005,
      );
      expect(r.intent).toBe('STOCK_ADVICE');
      expect(await t.prisma.alert.count()).toBe(0);
    });
  });

  describe('data trust end to end', () => {
    it('an alert waits (stays ACTIVE) when no stored previous-session close can verify the quote', async () => {
      const u = await mkUser(5001);
      await alerts.create(u, 'TSTA', 'price', 'above', 1500);
      await t.prisma.stockDailyPrice.deleteMany({});
      const original = t.provider.getHistoricalPrices.bind(t.provider);
      t.provider.getHistoricalPrices = async () =>
        ({ available: false, error: 'history down', code: 'ERROR' }) as never;
      try {
        resetCaches(t); // quote and history caches are 1 s in tests
        const s = await alerts.checkAll();
        expect(s.skippedAnomaly).toBe(1);
        expect(s.triggered).toBe(0);
        expect(t.sent).toHaveLength(0);
        expect(await t.prisma.alert.count({ where: { userId: u, status: 'ACTIVE' } })).toBe(1);
      } finally {
        t.provider.getHistoricalPrices = original;
      }
      resetCaches(t);
      await alerts.checkAll(); // history is back: the same quote is now verifiable and fires
      expect(t.sent).toHaveLength(1);
    });

    it('a self-consistent corrupt quote cannot fire an alert even when history is gone', async () => {
      const u = await mkUser(5002);
      await alerts.create(u, 'TSTB', 'price', 'below', 2000);
      await t.prisma.stockDailyPrice.deleteMany({});
      const original = t.provider.getHistoricalPrices.bind(t.provider);
      t.provider.getHistoricalPrices = async () =>
        ({ available: false, error: 'history down', code: 'ERROR' }) as never;
      try {
        t.provider.setPrice('TSTB', 1);
        t.provider.patchQuote('TSTB', {
          open: 1,
          high: 1,
          low: 1,
          previousClose: 1,
          change: 0,
          changePercent: 0,
        });
        resetCaches(t);
        await alerts.checkAll();
        expect(t.sent).toHaveLength(0);
      } finally {
        t.provider.getHistoricalPrices = original;
        t.provider.clearOverrides();
      }
    });

    it('a quote with a negative volume is never trusted for alerts', async () => {
      const u = await mkUser(5003);
      await alerts.create(u, 'TSTC', 'price', 'above', 1500);
      t.provider.patchQuote('TSTC', { volume: -5 });
      resetCaches(t);
      const s = await alerts.checkAll();
      expect(s.skippedAnomaly).toBe(1);
      expect(t.sent).toHaveLength(0);
      t.provider.clearOverrides();
    });

    it('the technical report classifies against the live price only when the quote is trusted', async () => {
      const analysis = t.app.get(AnalysisService);
      const cache = (analysis as unknown as { cache: { clear(): void } }).cache;
      cache.clear();
      t.provider.clearOverrides();
      resetCaches(t);
      const lastClose = (await analysis.getReport('TSTC')).technical.snapshot.price;

      cache.clear();
      t.provider.setPrice('TSTC', lastClose + 5);
      t.provider.patchQuote('TSTC', {
        open: lastClose + 5,
        high: lastClose + 8,
        low: lastClose + 2,
      });
      resetCaches(t);
      const live = await analysis.getReport('TSTC');
      expect(live.plausibility.quality).toBe('trusted');
      expect(live.technical.snapshot.price).toBe(lastClose + 5);

      cache.clear();
      t.provider.clearOverrides();
      t.provider.setPrice('TSTC', 1);
      t.provider.patchQuote('TSTC', { open: 1, high: 1, low: 1, changePercent: -99.9 });
      resetCaches(t);
      const corrupt = await analysis.getReport('TSTC');
      expect(corrupt.plausibility.quality).not.toBe('trusted');
      expect(corrupt.technical.snapshot.price).toBe(lastClose); // the corrupt price steers nothing
      t.provider.clearOverrides();
    });
  });
});
