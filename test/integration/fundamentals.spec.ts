import { ChatService } from '../../src/chat/chat.service';
import { FundamentalsService } from '../../src/fundamentals/fundamentals.service';
import { createTestApp, flushBackground, resetCaches, TestApp } from '../setup/test-app';

/**
 * Fundamentals with provenance on the real app. The fixture provider reports a few metrics for
 * TSTA; the rest must be derived from reported inputs or listed as missing — never invented. When the
 * provider fails, the last stored snapshot is served, dated, and marked stale once it is old.
 */
const plain = (html: string) => html.replace(/<[^>]+>/g, '');

describe('Fundamentals (integration)', () => {
  let t: TestApp;
  let chat: ChatService;
  let fundamentals: FundamentalsService;
  const say = async (telegramId: number, text: string) =>
    plain(
      (
        await chat.handle({ telegramId, chatId: telegramId, chatType: 'private', text })
      ).messages.join('\n'),
    );

  beforeAll(async () => {
    t = await createTestApp();
    chat = t.app.get(ChatService);
    fundamentals = t.app.get(FundamentalsService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await flushBackground(t);
    await t.prisma.fundamentalSnapshot.deleteMany();
    resetCaches(t);
    t.provider.failWith = null;
    t.provider.fundamentalsUnavailable = false;
    t.provider.clearOverrides();
    for (const stock of t.provider.stocks.values()) stock.fundamentals = undefined;
  });

  it('reports provider figures as reported, forward figures as estimates, derives P/E from EPS and price, and lists the rest as missing', async () => {
    const stock = t.provider.stocks.get('TSTA')!;
    stock.fundamentals = { eps: 100, forwardPer: 9, revenue: 2_000_000, netIncome: 500_000 };
    const r = (await fundamentals.getReport('TSTA'))!;
    expect(r.fromSnapshot).toBe(false);
    expect(r.fields.eps).toEqual({ value: 100, status: 'reported' });
    expect(r.fields.forwardPer).toEqual({ value: 9, status: 'estimated' });
    expect(r.fields.per.status).toBe('derived');
    expect(r.fields.per.value).toBeCloseTo(1777 / 100, 3); // fixture TSTA quote = 1777
    expect(r.fields.netMargin).toEqual({ value: 25, status: 'derived' });
    expect(r.fields.pbv).toEqual({ value: null, status: 'missing' });
    expect(r.missing).toEqual(expect.arrayContaining(['pbv', 'totalDebt', 'revenueGrowth']));

    const text = await say(14001, 'fundamental TSTA');
    expect(text).toContain('EPS: Rp100');
    expect(text).toContain('PER forward: 9,00x (estimasi)');
    expect(text).toContain('PER: 17,77x (turunan)');
    expect(text).toMatch(/Tidak tersedia: .*pbv/);
    expect(text).not.toMatch(/PBV: /);
    expect(text).toMatch(/Sumber: /);
  });

  it('stores one snapshot per day and serves it, dated, when the provider fails; marks it stale when old', async () => {
    await fundamentals.getReport('TSTA');
    await fundamentals.getReport('TSTA');
    await flushBackground(t); // snapshots are written in the background
    const stock = await t.prisma.stock.findUniqueOrThrow({ where: { symbol: 'TSTA' } });
    expect(await t.prisma.fundamentalSnapshot.count({ where: { stockId: stock.id } })).toBe(1);

    resetCaches(t);
    t.provider.fundamentalsUnavailable = true;
    const fresh = (await fundamentals.getReport('TSTA'))!;
    expect(fresh.fromSnapshot).toBe(true);
    expect(fresh.stale).toBe(false);
    expect(fresh.fields.per.status).toBe('reported'); // fixture default reports PER 10
    let text = await say(14002, 'fundamental TSTA');
    expect(text).toMatch(/dari snapshot .*\(0 hari\)/);
    expect(text).not.toContain('(basi)');

    // age the snapshot past FUNDAMENTALS_STALE_DAYS
    await t.prisma.fundamentalSnapshot.updateMany({
      data: { asOf: new Date(Date.now() - 40 * 86_400_000) },
    });
    resetCaches(t);
    const old = (await fundamentals.getReport('TSTA'))!;
    expect(old.stale).toBe(true);
    expect(old.fields.per).toEqual({ value: 10, status: 'stale' });
    text = await say(14003, 'fundamental TSTA');
    expect(text).toContain('⚠️');
    expect(text).toContain('PER: 10,00x (basi)');
  });

  it('with no provider data and no snapshot it says so instead of showing numbers', async () => {
    t.provider.fundamentalsUnavailable = true;
    expect(await fundamentals.getReport('TSTA')).toBeNull();
    const text = await say(14004, 'fundamental TSTA');
    expect(text).toMatch(/belum tersedia|tidak tersedia/i);
    expect(text).not.toMatch(/PER: /);
  });

  it('compares fundamentals side by side with "–" for what one stock lacks', async () => {
    t.provider.stocks.get('TSTA')!.fundamentals = { per: 12, eps: 100 };
    t.provider.stocks.get('TSTB')!.fundamentals = { eps: 50 };
    const text = await say(14005, 'bandingkan fundamental TSTA TSTB');
    expect(text).toContain('Perbandingan fundamental: TSTA vs TSTB');
    expect(text).toContain('PER: TSTA 12,00x | TSTB');
    expect(text).toMatch(/TSTB \d+,\d\dx \(turunan\)/);
    expect(text).toContain('EPS: TSTA Rp100 | TSTB Rp50');
    expect(t.ai.generated).toHaveLength(0); // deterministic: no model involved
  });

  it('an unknown ticker never reaches the provider or the snapshot table', async () => {
    const text = await say(14006, 'fundamental ZZQX');
    expect(text).toMatch(/tidak ditemukan/i);
    expect(await t.prisma.fundamentalSnapshot.count()).toBe(0);
  });
});
