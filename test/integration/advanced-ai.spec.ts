import { ChatService } from '../../src/chat/chat.service';
import { createTestApp, flushBackground, resetCaches, TestApp } from '../setup/test-app';

/**
 * The catalogue the model chooses from now carries fundamentals, news events and the asking
 * user's own data — and only when each source is trustworthy and only for the right person.
 */
const plain = (html: string) => html.replace(/<[^>]+>/g, '');
const GROUP = -100_160;

describe('Advanced AI (integration)', () => {
  let t: TestApp;
  let chat: ChatService;
  const say = async (telegramId: number, text: string, chatId = telegramId) =>
    plain(
      (
        await chat.handle({
          telegramId,
          chatId,
          chatType: chatId < 0 ? 'supergroup' : 'private',
          username: `u${telegramId}`,
          text,
        })
      ).messages.join('\n'),
    );
  const lastPrompt = () => t.ai.generated[t.ai.generated.length - 1]?.prompt ?? '';

  beforeAll(async () => {
    t = await createTestApp();
    chat = t.app.get(ChatService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await flushBackground(t);
    await t.prisma.$executeRawUnsafe(
      'TRUNCATE "User","Alert","FundamentalSnapshot","NewsArticle" RESTART IDENTITY CASCADE',
    );
    resetCaches(t);
    t.ai.generated.length = 0;
    t.ai.available = true;
    t.provider.failWith = null;
    t.provider.fundamentalsUnavailable = false;
    for (const s of t.provider.stocks.values()) s.fundamentals = undefined;
    t.news.reset();
  });

  it('fundamental claims enter the catalogue with their provenance, and the card shows them', async () => {
    t.provider.stocks.get('TSTA')!.fundamentals = {
      per: 12.5,
      eps: 160,
      forwardPer: 9,
      debtToEquity: 2.6,
    };
    const reply = await say(16001, 'analisis TSTA');
    const prompt = lastPrompt();
    expect(prompt).toContain('PER 12,5x: harga sekitar 12,5 kali laba per lembar.');
    expect(prompt).toContain('Utang lebih dari dua kali ekuitas (DER 2,60x).');
    expect(prompt).not.toContain('PER forward'); // estimates are not observations by themselves
    expect(reply).toMatch(/PER 12,50x/);
    expect(reply).toContain('Utang lebih dari dua kali ekuitas'); // a data-derived risk is always shown
    // the fixed sentence changed from 'price and volume only' to one naming the sources (shown when chosen)
    expect(prompt).toContain('fundamental yang dilaporkan');
    expect(prompt).not.toContain('berita dan fundamental tidak termasuk');
  });

  it('news enters as source-grounded events only: the prompt never contains a headline', async () => {
    t.news.items.set('TSTA', [
      {
        id: 'n1',
        title: 'TSTA kena suspensi RAHASIA-JUDUL',
        publisher: 'Kontan',
        url: 'https://example.com/n1',
        publishedAt: new Date(Date.now() - 2 * 3_600_000),
        relatedTickers: ['TSTA'],
      },
    ]);
    const reply = await say(16002, 'analisis TSTA');
    const prompt = lastPrompt();
    expect(prompt).toContain('Ada 1 berita tentang saham ini');
    expect(prompt).toContain('kejadian yang disebut: suspensi');
    expect(prompt).not.toContain('RAHASIA-JUDUL');
    expect(prompt).toContain('isi berita tidak dibaca model');
    expect(reply).toContain('Ada berita suspensi tentang saham ini');
    expect(reply).toContain('Berita terkait'); // the headline itself, rendered by the app, with its source
    expect(reply).toContain('RAHASIA-JUDUL');
    expect(reply).toContain('Kontan');
  });

  it("the asking user's position and watchlist are in the catalogue in private — never in a group, never for someone else", async () => {
    await say(16003, 'beli 10 lot TSTA di 1000');
    await say(16003, 'tambahkan TSTA ke watchlist');
    await flushBackground(t);
    t.ai.generated.length = 0;

    await say(16003, 'analisis TSTA');
    expect(lastPrompt()).toContain('Kamu memegang 10 lot dengan harga rata-rata Rp1.000');
    expect(lastPrompt()).toContain('Saham ini ada di watchlist kamu.');

    t.ai.generated.length = 0;
    await say(16003, 'analisis TSTA', GROUP);
    expect(lastPrompt()).not.toContain('Kamu memegang');
    expect(lastPrompt()).not.toContain('watchlist kamu');

    t.ai.generated.length = 0;
    await say(16004, 'analisis TSTA');
    expect(lastPrompt()).not.toContain('Kamu memegang');
  });

  it('a stale fundamentals snapshot contributes nothing', async () => {
    t.provider.stocks.get('TSTA')!.fundamentals = { per: 12.5 };
    await say(16005, 'fundamental TSTA'); // stores a snapshot
    await flushBackground(t);
    await t.prisma.fundamentalSnapshot.updateMany({
      data: { asOf: new Date(Date.now() - 40 * 86_400_000) },
    });
    resetCaches(t);
    t.provider.fundamentalsUnavailable = true;
    t.ai.generated.length = 0;
    const reply = await say(16005, 'analisis TSTA');
    expect(lastPrompt()).not.toContain('PER 12,5x');
    expect(reply).toContain('(basi)'); // the card still shows the snapshot, honestly marked
    expect(lastPrompt()).toContain('hanya berdasarkan harga dan volume');
  });

  it('"jawab ringkas" trims the card but never its risks; "jawab lengkap" restores it', async () => {
    expect(await say(16006, 'jawab ringkas')).toMatch(/ringkas/);
    expect(await say(16006, 'pengaturan saya')).toMatch(/Gaya jawaban analisis: ringkas/);
    const brief = await say(16006, 'analisis TSTA');
    expect(brief).not.toContain('Level Teknis');
    expect(brief).not.toContain('Volume');
    expect(brief).toContain('Risiko');
    expect(brief).toContain('Trend:');
    expect(await say(16006, 'jawab lengkap')).toMatch(/lengkap/);
    const full = await say(16006, 'analisis TSTA');
    expect(full).toContain('Level Teknis');
  });

  it('portfolio summary: catalogue from the ledger, model selects, risks always shown; deterministic without a model; private only', async () => {
    await say(16007, 'beli 10 lot TSTA di 1000');
    await say(16007, 'beli 1 lot TSTB di 1000');
    await flushBackground(t);
    t.ai.generated.length = 0;
    const summary = await say(16007, 'ringkas portofolio saya');
    expect(t.ai.generated).toHaveLength(1);
    expect(lastPrompt()).toContain('Nilai portofolio');
    expect(lastPrompt()).not.toContain('"quote"'); // not a stock context
    expect(summary).toContain('RINGKASAN PORTOFOLIO');
    expect(summary).toContain('Porsi terbesar TSTA');
    expect(summary).toContain('Konsentrasi tinggi'); // data-derived risk, always shown
    expect(summary).not.toMatch(/\b(beli|jual) (sekarang|segera)\b/i);

    t.ai.available = false;
    const noAi = await say(16007, 'bagaimana portofolio saya?');
    expect(noAi).toContain('Nilai portofolio');
    expect(noAi).toContain('Konsentrasi tinggi');

    expect(await say(16007, 'ringkas portofolio saya', GROUP)).toMatch(/chat pribadi/);
    expect(await say(16008, 'ringkas portofolio saya')).toMatch(/Belum ada catatan portofolio/);
  });
});
