import { GENERAL_ANSWER_POLICY, checkTextPolicy } from '../ai/policy/ai-policy';
import { formatAge, formatNews, formatRelatedNews, NEWS_FOOTER } from './news-format';
import { NewsArticle, NewsReport } from './news.types';

const now = new Date('2026-10-04T10:00:00Z');
const article = (over: Partial<NewsArticle> = {}): NewsArticle => ({
  externalId: 'x1',
  title: 'TSTA bagikan dividen <b>besar</b>',
  source: 'Kontan',
  url: 'https://example.com/a',
  publishedAt: new Date('2026-10-04T07:00:00Z'),
  symbols: ['TSTA'],
  events: ['dividend'],
  relevance: 'direct',
  ...over,
});
const report = (over: Partial<NewsReport> = {}): NewsReport => ({
  symbol: 'TSTA',
  articles: [article()],
  fromArchive: false,
  maxAgeDays: 14,
  fetchedAt: now,
  ...over,
});

describe('News formatting', () => {
  it('ages are humane', () => {
    expect(formatAge(new Date(now.getTime() - 5 * 60_000), now)).toBe('5 menit lalu');
    expect(formatAge(new Date(now.getTime() - 3 * 3_600_000), now)).toBe('3 jam lalu');
    expect(formatAge(new Date(now.getTime() - 26 * 3_600_000), now)).toBe('kemarin');
    expect(formatAge(new Date(now.getTime() - 5 * 86_400_000), now)).toBe('5 hari lalu');
    expect(formatAge(new Date(now.getTime() + 3_600_000), now)).toBe('0 menit lalu'); // clock skew never negative
  });

  it('renders a dated, sourced, tagged, HTML-escaped headline with a safe link', () => {
    const t = formatNews(report(), now);
    expect(t).toContain('📰 <b>Berita TSTA</b>');
    expect(t).toContain(
      '• 3 jam lalu · <a href="https://example.com/a">TSTA bagikan dividen &lt;b&gt;besar&lt;/b&gt;</a> — Kontan [dividen]',
    );
    expect(t).toContain(NEWS_FOOTER);
    expect(t).not.toContain('<b>besar</b>');
  });

  it('an unsafe link becomes plain text and a related item is marked', () => {
    const t = formatNews(
      report({
        articles: [article({ url: 'javascript:alert(1)', relevance: 'related', events: [] })],
      }),
      now,
    );
    expect(t).not.toContain('<a href');
    expect(t).not.toContain('javascript:');
    expect(t).toContain('(terkait)');
  });

  it('archive, empty and unavailable states are explicit', () => {
    expect(formatNews(report({ fromArchive: true }), now)).toContain('arsip Indonesian Stock Bot');
    expect(formatNews(report({ articles: [] }), now)).toContain(
      'Tidak ada berita tentang TSTA dalam 14 hari terakhir',
    );
    expect(formatNews(report({ articles: [], unavailableReason: 'provider mati' }), now)).toContain(
      'Berita belum tersedia: provider mati',
    );
  });

  it('the related block only lists direct headlines and never claims causation', () => {
    expect(
      formatRelatedNews(report({ articles: [article({ relevance: 'related' })] }), now),
    ).toBeNull();
    const block = formatRelatedNews(report(), now)!;
    expect(block).toContain('bukan penjelasan sebab');
    expect(block).toContain('TSTA bagikan dividen');
  });

  it('cards pass the output policy', () => {
    const plain = formatNews(report(), now).replace(/<[^>]+>/g, '');
    expect(checkTextPolicy([plain], GENERAL_ANSWER_POLICY)).toEqual([]);
  });
});
