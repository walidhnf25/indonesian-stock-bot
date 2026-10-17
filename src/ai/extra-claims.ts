import { formatNumber, formatPercent, formatRupiah } from '../common/utils/format';
import { FundamentalsReport, MetricStatus } from '../fundamentals/fundamentals.types';
import { formatAge } from '../news/news-format';
import { EVENT_LABEL, NewsReport } from '../news/news.types';
import { PortfolioView } from '../portfolio/portfolio.types';

/**
 * Sentences from the non-technical sources, for the claims catalogue. Like every other claim,
 * these are written by the application from data the application verified; the model only ever picks
 * their ids. Each builder also returns the numbers its sentences quote, so the output policy can
 * ground them. Sources that are not trustworthy (stale snapshot, missing metric, archived or
 * unavailable news) produce nothing — silence, never a guess.
 */
export interface ExtraClaims {
  observations: string[];
  risks: string[];
  numbers: number[];
}

const EMPTY: ExtraClaims = { observations: [], risks: [], numbers: [] };
const MAX_FUNDAMENTAL_OBSERVATIONS = 6;
const MARK: Partial<Record<MetricStatus, string>> = {
  derived: ' (turunan)',
  estimated: ' (estimasi analis)',
};
const USABLE = new Set<MetricStatus>(['reported', 'derived', 'estimated']);

const round = (v: number, d: number) => Number(v.toFixed(d));

/* ------------------------------------------------------------- fundamentals */

export function fundamentalClaims(r: FundamentalsReport | null | undefined): ExtraClaims {
  if (!r || r.stale) return EMPTY;
  const out: ExtraClaims = { observations: [], risks: [], numbers: [] };
  const use = (key: keyof FundamentalsReport['fields']) => {
    const f = r.fields[key];
    return f.value !== null && USABLE.has(f.status)
      ? { v: f.value, mark: MARK[f.status] ?? '' }
      : null;
  };
  const obs = (text: string, ...nums: number[]) => {
    if (out.observations.length >= MAX_FUNDAMENTAL_OBSERVATIONS) return;
    out.observations.push(text);
    out.numbers.push(...nums);
  };

  const per = use('per');
  if (per)
    obs(
      `PER ${formatNumber(per.v, 1)}x${per.mark}: harga sekitar ${formatNumber(per.v, 1)} kali laba per lembar.`,
      round(per.v, 1),
    );
  const pbv = use('pbv');
  if (pbv)
    obs(
      `PBV ${formatNumber(pbv.v, 2)}x${pbv.mark}: harga sekitar ${formatNumber(pbv.v, 2)} kali nilai buku per lembar.`,
      round(pbv.v, 2),
    );
  const roe = use('roe');
  if (roe) obs(`ROE ${formatPercent(roe.v, 1, false)}${roe.mark}.`, round(roe.v, 1));
  const dy = use('dividendYield');
  if (dy)
    obs(
      `Dividend yield ${formatPercent(dy.v, 2, false)}${dy.mark}, dihitung dari dividen masa lalu.`,
      round(dy.v, 2),
    );
  const margin = use('netMargin');
  if (margin)
    obs(`Margin bersih ${formatPercent(margin.v, 1, false)}${margin.mark}.`, round(margin.v, 1));
  const rg = use('revenueGrowth');
  if (rg)
    obs(
      `Pendapatan ${rg.v >= 0 ? 'tumbuh' : 'turun'} ${formatPercent(Math.abs(rg.v), 1, false)}${rg.mark} dibanding periode sebelumnya.`,
      round(Math.abs(rg.v), 1),
    );
  const eg = use('earningsGrowth');
  if (eg)
    obs(
      `Laba ${eg.v >= 0 ? 'tumbuh' : 'turun'} ${formatPercent(Math.abs(eg.v), 1, false)}${eg.mark} dibanding periode sebelumnya.`,
      round(Math.abs(eg.v), 1),
    );
  const der = use('debtToEquity');
  if (der)
    obs(
      `DER ${formatNumber(der.v, 2)}x${der.mark}: utang ${formatNumber(der.v, 2)} kali ekuitas.`,
      round(der.v, 2),
    );

  // data-derived risks (always shown by the validator, whatever the model picks)
  if (der && der.v > 2) {
    out.risks.push(`Utang lebih dari dua kali ekuitas (DER ${formatNumber(der.v, 2)}x).`);
    out.numbers.push(round(der.v, 2));
  }
  if (eg && eg.v < -20) {
    out.risks.push(
      `Laba turun ${formatPercent(Math.abs(eg.v), 1, false)} dibanding periode sebelumnya.`,
    );
    out.numbers.push(round(Math.abs(eg.v), 1));
  }
  if (margin && margin.v < 0) {
    out.risks.push(
      `Margin bersih negatif (${formatPercent(margin.v, 1, false)}): perusahaan mencatat rugi.`,
    );
    out.numbers.push(round(margin.v, 1));
  }
  if (per && per.v > 50) {
    out.risks.push(`PER ${formatNumber(per.v, 1)}x: harga lebih dari 50 kali laba per lembar.`);
    out.numbers.push(round(per.v, 1), 50);
  }
  return out;
}

/* --------------------------------------------------------------------- news */

const ageNumber = (age: string): number | null => {
  const m = age.match(/^(\d+)/);
  return m ? Number(m[1]) : null;
};

/** Headlines never reach the model: only counts, ages, sources and literal event tags do. */
export function newsClaims(r: NewsReport | null | undefined, now = new Date()): ExtraClaims {
  if (!r || r.fromArchive || r.articles.length === 0) return EMPTY;
  const direct = r.articles.filter((a) => a.relevance === 'direct');
  if (direct.length === 0) return EMPTY;
  const out: ExtraClaims = { observations: [], risks: [], numbers: [] };
  const latest = direct[0];
  const age = formatAge(latest.publishedAt, now);
  const events = [...new Set(direct.flatMap((a) => a.events))];
  out.observations.push(
    `Ada ${direct.length} berita tentang saham ini dalam ${r.maxAgeDays} hari terakhir; terbaru ${age} (${latest.source})${
      events.length
        ? `; kejadian yang disebut: ${events.map((e) => EVENT_LABEL[e]).join(', ')}`
        : ''
    }.`,
  );
  out.numbers.push(direct.length, r.maxAgeDays);
  const n = ageNumber(age);
  if (n !== null) out.numbers.push(n);

  for (const a of direct) {
    const serious = a.events.filter((e) => e === 'suspension' || e === 'uma');
    if (serious.length === 0) continue;
    const when = formatAge(a.publishedAt, now);
    out.risks.push(
      `Ada berita ${serious.map((e) => EVENT_LABEL[e]).join('/')} tentang saham ini (${a.source}, ${when}).`,
    );
    const k = ageNumber(when);
    if (k !== null) out.numbers.push(k);
    if (out.risks.length >= 2) break;
  }
  return out;
}

/* ---------------------------------------------------------- user's own data */

export interface HoldingContext {
  lots: number;
  avgPrice: number;
  unrealizedPct: number | null;
}

/** Only ever built from the asking user's own private-chat portfolio. */
export function holdingClaims(h: HoldingContext | null | undefined): ExtraClaims {
  if (!h || h.lots <= 0) return EMPTY;
  const pct =
    h.unrealizedPct === null
      ? ''
      : `; posisi saat ini ${h.unrealizedPct >= 0 ? '+' : '-'}${formatPercent(Math.abs(h.unrealizedPct), 2, false)}`;
  const numbers = [h.lots, h.avgPrice];
  if (h.unrealizedPct !== null) numbers.push(round(Math.abs(h.unrealizedPct), 2));
  return {
    observations: [
      `Kamu memegang ${h.lots} lot dengan harga rata-rata ${formatRupiah(h.avgPrice)}${pct}.`,
    ],
    risks: [],
    numbers,
  };
}

export function watchlistClaims(onWatchlist: boolean | undefined): ExtraClaims {
  return onWatchlist
    ? { observations: ['Saham ini ada di watchlist kamu.'], risks: [], numbers: [] }
    : EMPTY;
}

/* ----------------------------------------------------------------- portfolio */

const num = (v: unknown): number => Number(v);
const signed = (pct: number) => `${pct >= 0 ? '+' : '-'}${formatPercent(Math.abs(pct), 2, false)}`;

/** The whole portfolio as a catalogue ("ringkas portofolio saya"). */
export function portfolioClaims(view: PortfolioView): ExtraClaims {
  const t = view.totals;
  const out: ExtraClaims = { observations: [], risks: [], numbers: [] };
  const push = (text: string, ...nums: number[]) => {
    out.observations.push(text);
    out.numbers.push(...nums);
  };
  const equity = num(t.equity);
  const marketValue = num(t.marketValue);
  const cash = num(t.cash);
  push(
    `Nilai portofolio ${formatRupiah(equity)}: ${view.holdings.length} saham senilai ${formatRupiah(marketValue)} dan kas ${formatRupiah(cash)}.`,
    equity,
    view.holdings.length,
    marketValue,
    cash,
  );
  if (t.unrealizedPct !== null) {
    const pct = num(t.unrealizedPct);
    push(
      `Laba/rugi mengambang ${signed(pct)} (${formatRupiah(num(t.unrealizedPnl))}) terhadap modal ${formatRupiah(num(t.costBasis))}.`,
      round(Math.abs(pct), 2),
      num(t.unrealizedPnl),
      num(t.costBasis),
    );
    if (pct < -20) {
      out.risks.push(`Rugi mengambang ${formatPercent(Math.abs(pct), 2, false)} dari modal.`);
      out.numbers.push(round(Math.abs(pct), 2));
    }
  }
  if (num(t.realizedPnl) !== 0)
    push(`Laba/rugi terealisasi ${formatRupiah(num(t.realizedPnl))}.`, num(t.realizedPnl));
  if (num(t.dividends) > 0)
    push(`Dividen yang diterima ${formatRupiah(num(t.dividends))}.`, num(t.dividends));
  const top = t.allocation[0];
  if (top) {
    const share = num(top.percent);
    push(
      `Porsi terbesar ${top.symbol}, ${formatPercent(share, 1, false)} dari ekuitas.`,
      round(share, 1),
    );
    if (share > 50) {
      out.risks.push(
        `Konsentrasi tinggi: ${top.symbol} ${formatPercent(share, 1, false)} dari ekuitas.`,
      );
      out.numbers.push(round(share, 1));
    }
  }
  const priced = view.holdings.filter((h) => h.unrealizedPct !== null);
  if (priced.length >= 2) {
    const sorted = [...priced].sort((a, b) => num(b.unrealizedPct) - num(a.unrealizedPct));
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    push(
      `Posisi terbaik ${best.symbol} (${signed(num(best.unrealizedPct))}), terlemah ${worst.symbol} (${signed(num(worst.unrealizedPct))}).`,
      round(Math.abs(num(best.unrealizedPct)), 2),
      round(Math.abs(num(worst.unrealizedPct)), 2),
    );
  }
  if (t.unpriced > 0) {
    out.risks.push(
      `${t.unpriced} saham dinilai pada harga perolehan karena kutipan harganya tidak tepercaya.`,
    );
    out.numbers.push(t.unpriced);
  }
  if (view.anyStale) out.risks.push('Sebagian harga yang dipakai tidak terkini.');
  return out;
}
