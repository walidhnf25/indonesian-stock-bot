import { ChatService } from '../../src/chat/chat.service';
import { PortfolioService } from '../../src/portfolio/portfolio.service';
import { UserService } from '../../src/user/user.service';
import { createTestApp, flushBackground, resetCaches, TestApp } from '../setup/test-app';

/**
 * `PortfolioService.history()` is the one place a user's ledger is read back; if its user-scope
 * predicate is lost, user B is shown user A's transactions. The repository's tests never put two ledgers side by
 * side, so the guard could be deleted without a single failure. These tests do.
 */
const plain = (h: string) => h.replace(/<[^>]+>/g, '');

describe('portfolio history is scoped to its owner (real PostgreSQL)', () => {
  let t: TestApp;
  let portfolio: PortfolioService;
  let users: UserService;
  let chat: ChatService;
  let seq = 0;

  const mk = async (tg: number) =>
    (await users.upsertFromTelegram({ telegramId: tg, chatId: tg })).id;
  const buy = (userId: string, tg: number, symbol: string, quantity: number, price: number) =>
    portfolio.record(userId, {
      type: 'BUY',
      symbol,
      quantity,
      price,
      idempotencyKey: `iso-${++seq}`,
      chatId: tg,
    });
  const say = async (id: number, text: string) =>
    plain((await chat.handle({ telegramId: id, chatId: id, text })).messages.join('\n'));

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
  });

  it('two users with distinct ledgers each read back exactly their own entries', async () => {
    const a = await mk(75_001);
    const b = await mk(75_002);
    await buy(a, 75_001, 'TSTA', 1000, 1000);
    await buy(a, 75_001, 'TSTA', 500, 1100);
    await buy(b, 75_002, 'TSTC', 200, 2000);
    await buy(a, 75_001, 'TSTB', 300, 900);
    await buy(b, 75_002, 'TSTC', 100, 2100);

    const ha = await portfolio.history(a, 50);
    const hb = await portfolio.history(b, 50);
    expect(ha.map((r) => r.symbol).sort()).toEqual(['TSTA', 'TSTA', 'TSTB']);
    expect(hb.map((r) => r.symbol)).toEqual(['TSTC', 'TSTC']);
    expect(ha.some((r) => r.symbol === 'TSTC')).toBe(false);
    expect(hb.some((r) => r.symbol === 'TSTA' || r.symbol === 'TSTB')).toBe(false);
    // no row appears in both
    const idsA = new Set(ha.map((r) => r.id));
    expect(hb.every((r) => !idsA.has(r.id))).toBe(true);
    // every returned id really belongs to the asked user in the database
    const owned = await t.prisma.portfolioTransaction.findMany({
      where: { id: { in: ha.map((r) => r.id) } },
      select: { portfolio: { select: { userId: true } } },
    });
    expect(owned.every((r) => r.portfolio.userId === a)).toBe(true);
  });

  it("ordering (newest first) and the limit apply within the user's own ledger", async () => {
    const a = await mk(75_011);
    const b = await mk(75_012);
    await buy(a, 75_011, 'TSTA', 100, 1000);
    await buy(b, 75_012, 'TSTC', 100, 2000); // a newer row of ANOTHER user must not become A's "latest"
    await buy(a, 75_011, 'TSTB', 100, 900);
    await buy(b, 75_012, 'TSTC', 50, 2100);
    const latest = await portfolio.history(a, 1);
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ symbol: 'TSTB' });
    const two = await portfolio.history(a, 2);
    expect(two.map((r) => r.symbol)).toEqual(['TSTB', 'TSTA']);
    expect((await portfolio.history(b, 1))[0]).toMatchObject({ symbol: 'TSTC', quantity: 50 });
  });

  it("an empty history stays empty: a user without a ledger never inherits someone else's", async () => {
    const a = await mk(75_021);
    const empty = await mk(75_022);
    await buy(a, 75_021, 'TSTA', 100, 1000);
    expect(await portfolio.history(empty, 50)).toEqual([]);
    expect(await portfolio.history('00000000-0000-0000-0000-000000000000', 50)).toEqual([]);
    // a portfolio that exists but has no transactions (everything reversed away is still listed; a brand-new one is empty)
    await t.prisma.portfolio
      .create({ data: { userId: empty, name: 'default' } })
      .catch(() => undefined);
    expect(await portfolio.history(empty, 50)).toEqual([]);
  });

  it('through chat ("riwayat transaksi") a user only sees their own symbols', async () => {
    const a = await mk(75_031);
    const b = await mk(75_032);
    await buy(a, 75_031, 'TSTA', 100, 1000);
    await buy(b, 75_032, 'TSTC', 100, 2000);
    const forA = await say(75_031, 'riwayat transaksi');
    const forB = await say(75_032, 'riwayat transaksi');
    expect(forA).toMatch(/TSTA/);
    expect(forA).not.toMatch(/TSTC/);
    expect(forB).toMatch(/TSTC/);
    expect(forB).not.toMatch(/TSTA/);
    // a user who never traded gets the empty-state text, not a neighbour's trades
    await mk(75_033);
    expect(await say(75_033, 'riwayat transaksi')).not.toMatch(/TSTA|TSTC/);
  });

  it("ID substitution: naming another user's transaction id never shows or undoes it", async () => {
    const a = await mk(75_041);
    const b = await mk(75_042);
    const rec = await buy(a, 75_041, 'TSTA', 100, 1000);
    const txId = (await portfolio.history(a, 1))[0].id;
    await say(75_042, `batalkan transaksi ${txId}`);
    await say(75_042, `riwayat transaksi ${txId}`);
    expect(rec.duplicate).toBe(false);
    expect(await t.prisma.portfolioTransaction.count()).toBe(1);
    expect((await portfolio.history(a, 10))[0].reversed).toBe(false);
    expect(await portfolio.history(b, 10)).toEqual([]);
  });

  it('concurrent writes by two users do not cross: each ledger holds exactly its own 20 entries', async () => {
    const a = await mk(75_051);
    const b = await mk(75_052);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => [
        buy(a, 75_051, 'TSTA', 10 + i, 1000),
        buy(b, 75_052, 'TSTC', 10 + i, 2000),
      ]).flat(),
    );
    const ha = await portfolio.history(a, 50);
    const hb = await portfolio.history(b, 50);
    expect(ha).toHaveLength(20);
    expect(hb).toHaveLength(20);
    expect(ha.every((r) => r.symbol === 'TSTA')).toBe(true);
    expect(hb.every((r) => r.symbol === 'TSTC')).toBe(true);
  });

  it('the one-shot "portofolio saya" view is also per user', async () => {
    const a = await mk(75_061);
    await mk(75_062);
    await buy(a, 75_061, 'TSTA', 100, 1000);
    expect(await say(75_061, 'portofolio saya')).toMatch(/TSTA/);
    expect(await say(75_062, 'portofolio saya')).not.toMatch(/TSTA/);
  });
});
