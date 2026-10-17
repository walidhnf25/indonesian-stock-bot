import { escapeHtml as h, formatWib } from '../common/utils/format';
import { safeUrl } from './news-events';
import { EVENT_LABEL, NewsArticle, NewsReport } from './news.types';

export const NEWS_FOOTER =
  'Judul dan sumber berasal dari penyedia berita; Indonesian Stock Bot tidak menilai kebenaran, sebab, maupun dampaknya terhadap harga.';

export function formatAge(publishedAt: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - publishedAt.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'kemarin' : `${days} hari lalu`;
}

export function formatArticleLine(a: NewsArticle, now: Date): string {
  const url = safeUrl(a.url);
  const title = url ? `<a href="${h(url)}">${h(a.title)}</a>` : h(a.title);
  const tags = a.events.length ? ` [${a.events.map((e) => h(EVENT_LABEL[e])).join(', ')}]` : '';
  const rel = a.relevance === 'related' ? ' (terkait)' : '';
  return `• ${h(formatAge(a.publishedAt, now))} · ${title} — ${h(a.source)}${tags}${rel}`;
}

/** The news card for one stock: headlines only, each dated, sourced and tagged with the events it names. */
export function formatNews(r: NewsReport, now = new Date()): string {
  const out = [`📰 <b>Berita ${h(r.symbol)}</b>`, ''];
  if (r.fromArchive) {
    out.push(
      'ℹ️ Penyedia berita tidak tersedia saat ini; berikut arsip Indonesian Stock Bot dari pengambilan sebelumnya.',
      '',
    );
  }
  if (r.articles.length === 0) {
    out.push(
      r.unavailableReason
        ? `Berita belum tersedia: ${h(r.unavailableReason)}`
        : `Tidak ada berita tentang ${h(r.symbol)} dalam ${r.maxAgeDays} hari terakhir dari penyedia.`,
    );
  } else {
    out.push(...r.articles.map((a) => formatArticleLine(a, now)));
  }
  out.push('', `<i>${NEWS_FOOTER}</i>`, `Diambil: ${formatWib(r.fetchedAt)}`);
  return out.join('\n');
}

/** A short "related headlines" block for an analysis answer; never a causal statement. */
export function formatRelatedNews(r: NewsReport, now = new Date(), max = 3): string | null {
  const items = r.articles.filter((a) => a.relevance === 'direct').slice(0, max);
  if (items.length === 0) return null;
  return [
    '📰 <b>Berita terkait</b> (judul dari penyedia; bukan penjelasan sebab)',
    ...items.map((a) => formatArticleLine(a, now)),
  ].join('\n');
}
