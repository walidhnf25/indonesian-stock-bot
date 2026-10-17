import { AlertService, MAX_ACTIVE_ALERTS } from '../../src/alert/alert.service';
import { NotifierService } from '../../src/notifier/notifier.service';
import { UserService } from '../../src/user/user.service';
import { createTestApp, flushBackground, resetCaches, TestApp } from '../setup/test-app';

/**
 * create() counts ACTIVE and PAUSED toward the cap of 20; reactivate() (the path that puts a claimed alert
 * back after a transient delivery failure) used to count ACTIVE only, so a user at the cap could end up with 21 live
 * alerts. Both paths now use the same definition (`countLive`) under the same per-user lock.
 */
type Outcome = 'reactivated' | 'capped' | 'duplicate' | 'gone';

describe('alert cap is one rule for create() and reactivate() (real PostgreSQL)', () => {
  let t: TestApp;
  let alerts: AlertService;
  let users: UserService;
  let n = 0;

  const user = async () =>
    (await users.upsertFromTelegram({ telegramId: 74_000 + ++n, chatId: 74_000 + n })).id;
  const live = (userId: string) =>
    t.prisma.alert.count({ where: { userId, status: { in: ['ACTIVE', 'PAUSED'] } } });
  const reactivate = (id: string): Promise<Outcome> =>
    t.prisma.alert
      .findUniqueOrThrow({ where: { id } })
      .then((a) =>
        (alerts as unknown as { reactivate(x: unknown): Promise<Outcome> }).reactivate(a),
      );
  /** `count` alerts for the user (distinct thresholds); the first `paused` of them are PAUSED. */
  const fill = async (userId: string, count: number, paused: number) => {
    for (let i = 0; i < count; i++) await alerts.create(userId, 'TSTA', 'price', 'above', 9000 + i);
    const rows = await t.prisma.alert.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    const ids = rows.slice(0, paused).map((r) => r.id);
    await t.prisma.alert.updateMany({
      where: { id: { in: ids } },
      data: { status: 'PAUSED', activeKey: null },
    });
    return rows;
  };
  /** The alert fired and was claimed (TRIGGERED): it no longer occupies a slot. */
  const claim = (id: string) =>
    t.prisma.alert.update({
      where: { id },
      data: { status: 'TRIGGERED', activeKey: null, triggeredAt: new Date() },
    });

  beforeAll(async () => {
    t = await createTestApp();
    alerts = t.app.get(AlertService);
    users = t.app.get(UserService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await flushBackground(t);
    await t.prisma.$executeRawUnsafe(
      'TRUNCATE "User","Alert","StockQuoteSnapshot","StockDailyPrice" RESTART IDENTITY CASCADE',
    );
    resetCaches(t);
    t.sent.length = 0;
    t.failNotifications.value = false;
    t.failNotifications.permanent = false;
  });

  it('the historical attack: at the cap (10 ACTIVE + 10 PAUSED) a replacement was created while one alert was claimed; reactivating it must NOT exceed the cap', async () => {
    const u = await user();
    const rows = await fill(u, 20, 10);
    await claim(rows[19].id);
    await alerts.create(u, 'TSTB', 'price', 'above', 9999); // legitimate: 19 live -> 20
    expect(await live(u)).toBe(MAX_ACTIVE_ALERTS);
    expect(await reactivate(rows[19].id)).toBe('capped');
    expect(await live(u)).toBe(MAX_ACTIVE_ALERTS); // 21 before the fix
    expect((await t.prisma.alert.findUniqueOrThrow({ where: { id: rows[19].id } })).status).toBe(
      'DISABLED',
    );
  });

  it('PAUSED alerts count: 0 ACTIVE + 19 PAUSED + 1 replacement is at the cap', async () => {
    const u = await user();
    const rows = await fill(u, 20, 19);
    await claim(rows[19].id);
    await alerts.create(u, 'TSTB', 'price', 'above', 9999);
    expect(await reactivate(rows[19].id)).toBe('capped');
    expect(await live(u)).toBe(MAX_ACTIVE_ALERTS);
  });

  it('below the cap it is reactivated, including exactly up to the cap', async () => {
    const u = await user();
    const rows = await fill(u, 19, 9);
    await claim(rows[18].id);
    expect(await live(u)).toBe(18);
    expect(await reactivate(rows[18].id)).toBe('reactivated'); // 18 -> 19
    expect((await t.prisma.alert.findUniqueOrThrow({ where: { id: rows[18].id } })).status).toBe(
      'ACTIVE',
    );
    // the boundary: 19 live + the claimed one => 20, allowed
    const more = await fill(await user(), 20, 10);
    await claim(more[19].id);
    expect(await reactivate(more[19].id)).toBe('reactivated');
    expect(await live(more[19].userId)).toBe(MAX_ACTIVE_ALERTS);
  });

  it('is idempotent: a second reactivation of the same alert is a no-op', async () => {
    const u = await user();
    const rows = await fill(u, 3, 0);
    await claim(rows[0].id);
    expect(await reactivate(rows[0].id)).toBe('reactivated');
    expect(await reactivate(rows[0].id)).toBe('gone');
    expect(await live(u)).toBe(3);
  });

  it('a duplicate of the same alert created meanwhile wins: the reactivation reports it and keeps one live copy', async () => {
    const u = await user();
    const rows = await fill(u, 2, 0);
    await claim(rows[0].id);
    await alerts.create(u, 'TSTA', 'price', 'above', 9000); // same definition as the claimed one
    expect(await reactivate(rows[0].id)).toBe('duplicate');
    expect(await live(u)).toBe(2);
  });

  it('full path: delivery fails transiently while the user creates a replacement -> the alert is NOT put back over the cap', async () => {
    const u = await user();
    await fill(u, 19, 19); // 19 PAUSED
    const satisfied = await alerts.create(u, 'TSTA', 'price', 'above', 1500); // ACTIVE and already true (TSTA = 1 777)
    expect(await live(u)).toBe(MAX_ACTIVE_ALERTS);
    const notifier = t.app.get(NotifierService);
    const original = notifier.send.bind(notifier);
    (notifier as unknown as { send: unknown }).send = async () => {
      await alerts.create(u, 'TSTB', 'price', 'above', 9999); // the slot freed by the claim is taken
      return 'retry';
    };
    try {
      await alerts.checkAll();
    } finally {
      (notifier as unknown as { send: unknown }).send = original;
    }
    expect(await live(u)).toBeLessThanOrEqual(MAX_ACTIVE_ALERTS);
    expect(
      (await t.prisma.alert.findUniqueOrThrow({ where: { id: satisfied.alert.id } })).status,
    ).toBe('DISABLED');
  });

  it('race: create() and reactivate() at the same moment never leave more than 20 live alerts', async () => {
    for (let round = 0; round < 12; round++) {
      const u = await user();
      const rows = await fill(u, 20, 10);
      await claim(rows[19].id); // 19 live: exactly one free slot, two contenders
      const results = await Promise.allSettled([
        alerts.create(u, 'TSTB', 'price', 'above', 7000 + round),
        reactivate(rows[19].id),
      ]);
      expect(
        results.every(
          (r) =>
            r.status === 'fulfilled' ||
            /ALERT_LIMIT|batas maksimum/.test(
              String(
                (r as PromiseRejectedResult).reason?.message ?? (r as PromiseRejectedResult).reason,
              ),
            ),
        ),
      ).toBe(true);
      expect(await live(u)).toBeLessThanOrEqual(MAX_ACTIVE_ALERTS);
    }
  });

  it('race: many concurrent creates plus reactivations stay within the cap', async () => {
    const u = await user();
    const rows = await fill(u, 20, 5);
    for (const r of rows.slice(15)) await claim(r.id); // 15 live, 5 free slots
    await Promise.allSettled([
      ...Array.from({ length: 10 }, (_, i) => alerts.create(u, 'TSTB', 'price', 'above', 6000 + i)),
      ...rows.slice(15).map((r) => reactivate(r.id)),
    ]);
    expect(await live(u)).toBeLessThanOrEqual(MAX_ACTIVE_ALERTS);
  });

  it('race: expiry sweeps running while the user creates alerts never push the user over the cap or throw', async () => {
    const u = await user();
    const rows = await fill(u, 20, 0);
    await t.prisma.alert.updateMany({
      where: { id: { in: rows.slice(0, 5).map((r) => r.id) } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const results = await Promise.allSettled([
      alerts.checkAll(),
      alerts.checkAll(),
      ...Array.from({ length: 8 }, (_, i) => alerts.create(u, 'TSTB', 'price', 'above', 5000 + i)),
    ]);
    expect(
      results.filter(
        (r) =>
          r.status === 'rejected' &&
          !/ALERT_LIMIT|batas maksimum/.test(String((r as PromiseRejectedResult).reason?.message)),
      ).length,
    ).toBe(0);
    expect(await live(u)).toBeLessThanOrEqual(MAX_ACTIVE_ALERTS);
  });

  it('cap is per user: another user at the cap does not block this user, and this user cannot affect theirs', async () => {
    const a = await user();
    const b = await user();
    const rowsA = await fill(a, 20, 10);
    await fill(b, 20, 0);
    await claim(rowsA[19].id);
    expect(await reactivate(rowsA[19].id)).toBe('reactivated'); // A has room even though B is full
    expect(await live(a)).toBe(MAX_ACTIVE_ALERTS);
    expect(await live(b)).toBe(MAX_ACTIVE_ALERTS);
    // and A at the cap still cannot create
    await expect(alerts.create(a, 'TSTB', 'price', 'above', 1)).rejects.toThrow(/batas maksimum/);
  });

  it("ownership: reactivating never touches another user's alert", async () => {
    const a = await user();
    const b = await user();
    const rowsB = await fill(b, 2, 0);
    await claim(rowsB[0].id);
    await fill(a, 1, 0);
    await reactivate(rowsB[0].id);
    expect(await live(a)).toBe(1);
    expect(await live(b)).toBe(2);
  });
});
