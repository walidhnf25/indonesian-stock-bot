import { ChatService } from '../../src/chat/chat.service';
import { NewsService } from '../../src/news/news.service';
import { RawNewsItem } from '../../src/news/news.types';
import { createTestApp, flushBackground, resetCaches, TestApp } from '../setup/test-app';

/**
 * Headlines as data. The fake news provider serves scripted items for TSTA; the tests check
 * de-duplication, freshness, the archive fallback, honesty when nothing exists, the governed provider
 * path and — most importantly — that the language model never sees news text.
 */
const plain = (html: string) => html.replace(/<[^>]+>/g, '');
const H = 3_600_000;
const item = (over: Partial<RawNewsItem> = {}): RawNewsItem => ({
  id: 'n1',
  title: 'TSTA bagikan dividen, cum date 20 Mei',
  publisher: 'Kontan',
  url: 'https://example.com/n1',
  publishedAt: new Date(Date.now() - 2 * H),
  relatedTickers: ['TSTA'],
  ...over,
});

describe('News (integration)', () => {
  let t: TestApp;
  let chat: ChatService;
  let news: NewsService;
  const say = async (telegramId: number, text: string) =>
    plain(
      (
        await chat.handle({ telegramId, chatId: telegramId, chatType: 'private', text })
      ).messages.join('\n'),
    );

  beforeAll(async () => {
    t = await createTestApp();
    chat = t.app.get(ChatService);
    news = t.app.get(NewsService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await flushBackground(t);
    await t.prisma.newsArticle.deleteMany();
    resetCaches(t);
    t.provider.failWith = null;
    t.news.reset();
    t.ai.generated.length = 0;
  });

  it('shows dated, sourced, tagged headlines and stores each article once', async () => {
    t.news.items.set('TSTA', [
      item(),
      item({
        id: 'n2',
        title: 'Sektor bank menguat',
        relatedTickers: ['TSTB'],
        publishedAt: new Date(Date.now() - 30 * H),
      }),
    ]);
    const text = await say(15001, 'berita TSTA');
    expect(text).toContain('📰 Berita TSTA');
    expect(text).toMatch(/2 jam lalu · TSTA bagikan dividen, cum date 20 Mei — Kontan \[dividen\]/);
    expect(text).toMatch(/kemarin · Sektor bank menguat — Kontan \(terkait\)/);
    await flushBackground(t); // the archive is written in the background
    expect(await t.prisma.newsArticle.count()).toBe(2);
    const stored = await t.prisma.newsArticle.findUniqueOrThrow({ where: { externalId: 'n1' } });
    expect(stored).toMatchObject({ events: ['dividend'], symbols: ['TSTA'] });
  });

  it('de-duplicates by provider id and by normalised title across fetches and outlets', async () => {
    t.news.items.set('TSTA', [
      item(),
      item({
        id: 'n1-dup',
        title: '  tsta BAGIKAN dividen, cum date 20 mei!',
        publisher: 'Bisnis',
      }),
    ]);
    await news.getNews('TSTA');
    await flushBackground(t);
    resetCaches(t);
    await news.getNews('TSTA');
    await flushBackground(t);
    expect(await t.prisma.newsArticle.count()).toBe(1);
    const r = await news.getNews('TSTA');
    expect(r.articles).toHaveLength(1);
  });

  it('a fetch for another stock only adds that stock to an already stored article', async () => {
    t.news.items.set('TSTA', [item({ relatedTickers: ['TSTA', 'TSTB'] })]);
    t.news.items.set('TSTB', [item({ relatedTickers: ['TSTA', 'TSTB'] })]);
    await news.getNews('TSTA');
    await news.getNews('TSTB');
    await flushBackground(t);
    const rows = await t.prisma.newsArticle.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].symbols.sort()).toEqual(['TSTA', 'TSTB']);
  });

  it('only fresh items are shown, oldest first dropped, junk discarded', async () => {
    t.news.items.set('TSTA', [
      item({ id: 'old', publishedAt: new Date(Date.now() - 40 * 24 * H) }),
      item({ id: 'future', publishedAt: new Date(Date.now() + 5 * H) }),
      item({ id: 'junk', title: 'x' }),
      item({ id: 'ok', title: 'TSTA gelar RUPS tahunan', publishedAt: new Date(Date.now() - H) }),
    ]);
    const r = await news.getNews('TSTA');
    expect(r.articles.map((a) => a.externalId)).toEqual(['ok']);
    expect(r.articles[0].events).toEqual(['rups']);
    await flushBackground(t);
    expect(await t.prisma.newsArticle.count()).toBe(2); // old is stored (archive), future and junk are not
  });

  it('when the provider fails the archive answers, flagged; with nothing stored the reason is shown', async () => {
    t.news.items.set('TSTA', [item()]);
    await news.getNews('TSTA');
    await flushBackground(t);
    resetCaches(t);
    t.news.failWith = 'ERROR';
    let text = await say(15002, 'berita TSTA');
    expect(text).toContain('arsip Indonesian Stock Bot');
    expect(text).toContain('TSTA bagikan dividen');

    await t.prisma.newsArticle.deleteMany();
    resetCaches(t);
    text = await say(15003, 'berita TSTA');
    expect(text).toMatch(/Berita belum tersedia/);
    expect(text).not.toContain('TSTA bagikan dividen');
  });

  it('an unknown ticker never reaches the news provider', async () => {
    const text = await say(15004, 'berita ZZQX');
    expect(text).toMatch(/tidak ditemukan/i);
    expect(t.news.calls).toBe(0);
  });

  it('a "why" question gets related headlines as a separate, source-grounded block — and the model never sees them', async () => {
    t.news.items.set('TSTA', [item({ title: 'TSTA umumkan buyback saham RAHASIA-UNIK' })]);
    const reply = await chat.handle({
      telegramId: 15005,
      chatId: 15005,
      chatType: 'private',
      text: 'kenapa TSTA naik?',
    });
    const joined = plain(reply.messages.join('\n'));
    expect(joined).toContain('Berita terkait');
    expect(joined).toContain('bukan penjelasan sebab');
    expect(joined).toContain('RAHASIA-UNIK');
    for (const req of t.ai.generated) {
      expect(req.prompt).not.toContain('RAHASIA-UNIK');
      expect(req.system).not.toContain('RAHASIA-UNIK');
    }
  });

  it('news cards never contain the model and the header lists the honest footer', async () => {
    t.news.items.set('TSTA', [item()]);
    const text = await say(15006, 'headline TSTA');
    expect(text).toContain('Indonesian Stock Bot tidak menilai kebenaran');
    expect(t.ai.generated).toHaveLength(0);
  });
});
