import { createHash } from 'node:crypto';
import { NEWS_EVENTS, NewsEvent, NewsRelevance, RawNewsItem } from './news.types';

/**
 * Deterministic event extraction from a headline: a fixed keyword rule per corporate-action type, in
 * Indonesian and English. Rules only tag what the title literally says; they never guess impact.
 */
const EVENT_RULES: Record<NewsEvent, RegExp> = {
  dividend: /\b(dividen|dividend|cum[\s-]?date|ex[\s-]?date)\b/i,
  rups: /\b(rups(?:t|lb)?|rapat umum pemegang saham|shareholders?'? meeting|agm|egm)\b/i,
  right_issue: /\b(rights? issue|hmetd|private placement|penambahan modal)\b/i,
  stock_split: /\b(stock split|reverse split|pemecahan saham|penggabungan saham)\b/i,
  suspension: /\b(suspensi|suspend(?:ed|s)?|penghentian sementara perdagangan|dibekukan)\b/i,
  uma: /\b(uma|unusual market activity)\b/i,
  earnings:
    /\b(laba bersih|rugi bersih|laporan keuangan|kinerja keuangan|net (?:profit|income|loss)|earnings|kuartal [i1-4]{1,3}|q[1-4]|semester [i1-2]{1,2})\b/i,
  acquisition:
    /\b(akuisisi|mengakuisisi|merger|acquisition|acquires?|takeover|divestasi|divestment)\b/i,
  ipo: /\b(ipo|penawaran umum perdana|initial public offering|resmi (?:melantai|tercatat)|listing perdana)\b/i,
  buyback: /\b(buy[\s-]?back|pembelian kembali saham)\b/i,
  bond: /\b(obligasi|sukuk|bonds?|surat utang)\b/i,
  management:
    /\b(direktur utama|dirut|komisaris utama|komisaris|ceo|cfo|direksi|pengangkatan|pengunduran diri|mengundurkan diri|resigns?)\b/i,
};

export function extractEvents(title: string): NewsEvent[] {
  const t = title.normalize('NFKC');
  return NEWS_EVENTS.filter((e) => EVENT_RULES[e].test(t));
}

/** Same headline with different punctuation, case or spacing hashes the same (cross-provider dedup). */
export function titleHash(title: string): string {
  const norm = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return createHash('sha1').update(norm).digest('hex');
}

/** Yahoo-style related tickers ("BBCA.JK", "^JKSE") -> IDX codes; anything not an IDX stock is dropped. */
export function mapRelatedTickers(raw: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const r of raw) {
    if (typeof r !== 'string') continue;
    const m = r.toUpperCase().match(/^([A-Z]{4})\.JK$/);
    if (m) out.add(m[1]);
  }
  return [...out];
}

export function relevanceFor(symbol: string, item: RawNewsItem): NewsRelevance {
  if (item.relatedTickers.includes(symbol)) return 'direct';
  return new RegExp(`\\b${symbol}\\b`).test(item.title.toUpperCase()) ? 'direct' : 'related';
}

/** Only http(s) links are ever rendered as links; anything else is shown as plain text. */
export function safeUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}
