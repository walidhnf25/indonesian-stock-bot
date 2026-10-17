import { AnalysisOutput, ComparisonOutput, MAX_RISKS } from '../ai/ai-output';
import { DISCLAIMER } from '../ai/prompts/prompts';
import { cleanCompanyName } from '../common/utils/text';
import { FullTechnicalReport, LevelStrength, PriceLevel, Trend } from '../analysis/analysis.types';
import {
  escapeHtml as h,
  formatCompactId,
  formatNumber,
  formatPercent,
  formatRatio,
  formatRupiah,
  formatSigned,
  formatWib,
  jakartaParts,
} from '../common/utils/format';
import { TechnicalTopic } from '../intent/intent.types';
import { formatIsoDateId as formatDateId } from '../intent/parsers/temporal-parser';
import { MarketStatus } from '../market/market.service';
import {
  Freshness,
  FreshnessState,
  Plausibility,
  describePlausibility,
  worstFreshness,
} from '../market/data-quality';
import {
  DailyCandle,
  DataResult,
  ForeignFlow,
  Fundamentals,
  NormalizedQuote,
} from '../stock/stock.types';
import { AI_NOTICE } from './policy-messages';
import { GENERIC_RISK } from '../ai/claims';
import { portfolioClaims } from '../ai/extra-claims';
import { formatMetricValue } from '../fundamentals/fundamentals-format';
import { FundamentalsReport } from '../fundamentals/fundamentals.types';
import { formatRelatedNews } from '../news/news-format';
import { NewsReport } from '../news/news.types';
import { LedgerRow, PortfolioView, RecordResult } from '../portfolio/portfolio.types';

/* ------------------------------------------------------------------ helpers */

/** Computed levels (MA, Bollinger, EMA) are shown in whole rupiah. */
/** " — Company Name" for a header line. Names are cleaned again here: old rows and any other source may still carry control or bidi characters. */
const nameSuffix = (name: string | null | undefined): string => {
  const cleaned = cleanCompanyName(name);
  return cleaned ? ` — ${h(cleaned)}` : '';
};
const rp0 = (v: number | null): string => formatRupiah(v === null ? null : Math.round(v));

const TRENDS: Record<Trend, string> = { BULLISH: 'Bullish', NEUTRAL: 'Netral', BEARISH: 'Bearish' };
const STRENGTH_ID: Record<LevelStrength, string> = {
  weak: 'lemah',
  medium: 'sedang',
  strong: 'kuat',
};
const MOMENTUM_ID = { STRONG: 'Kuat', MODERATE: 'Moderat', WEAK: 'Lemah' } as const;
const BIAS_ID = {
  POSITIVE: 'bias positif',
  NEGATIVE: 'bias negatif',
  NEUTRAL: 'bias campuran',
} as const;

export function prettySource(source: string): string {
  return source
    .replace(/^yahoo-finance/, 'Yahoo Finance')
    .replace('(tersimpan)', '(data tersimpan)');
}

export function trendLabel(t: Trend): string {
  return TRENDS[t];
}

const FRESH_ICON: Record<FreshnessState, string> = {
  LIVE: '🟢',
  DELAYED: '🟡',
  STALE: '🔴',
  UNKNOWN: '⚪',
};

/** "🟡 DELAYED — Data tertunda ±10 menit." (stored-copy data just says STALE; its own line explains). */
export function freshnessStatusLine(f: Freshness): string {
  if (f.fromFallback) return `${FRESH_ICON.STALE} STALE`;
  return `${FRESH_ICON[f.state]} ${f.state} — ${h(f.reason)}`;
}

const dataLabel = (f: Freshness | null | undefined) =>
  f?.state === 'STALE' ? '🕐 Data terakhir tersedia:' : '🕐 Data:';

function freshnessLines(args: {
  quote: NormalizedQuote;
  source: string;
  fetchedAt: string;
  freshness: Freshness;
  plausibility?: Plausibility;
}): string[] {
  const { quote: q, source, fetchedAt, freshness: f, plausibility: p } = args;
  const lines: string[] = [];
  if (f.fromFallback) {
    lines.push(
      `⚠️ Data terbaru tidak tersedia. Menampilkan data terakhir yang tersimpan pada ${formatWib(fetchedAt)}.`,
    );
  }
  if (p && !p.ok) {
    lines.push(
      `⚠️ Harga terlihat tidak wajar (${h(describePlausibility(p))}); verifikasi di sumber lain sebelum dipakai.`,
    );
  }
  lines.push(freshnessStatusLine(f));
  lines.push(`${dataLabel(f)} ${formatWib(q.timestamp)}`);
  const delay = q.delayMinutes && q.delayMinutes > 0 ? ` — tertunda ±${q.delayMinutes} menit` : '';
  lines.push(`Sumber: ${h(prettySource(source))}${delay}`);
  return lines;
}

function reportFreshnessLines(report: FullTechnicalReport): string[] {
  return freshnessLines({
    quote: report.quote,
    source: report.quoteSource,
    fetchedAt: report.quoteFetchedAt,
    freshness: report.freshness,
    plausibility: report.plausibility,
  });
}

function levels(list: PriceLevel[]): string {
  if (list.length === 0) return 'tidak teridentifikasi';
  return list.map((l) => `${formatRupiah(l.price)} (${STRENGTH_ID[l.strength]})`).join(', ');
}

/** Splits a long message on paragraph boundaries so each piece fits Telegram's 4096 limit. */
export function chunkMessage(text: string, max = 3800): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const para of text.split('\n\n')) {
    if ((current + '\n\n' + para).length > max && current) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
    while (current.length > max) {
      chunks.push(current.slice(0, max));
      current = current.slice(max);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/* -------------------------------------------------------------------- quote */

export function formatQuote(
  q: NormalizedQuote,
  meta: {
    source: string;
    fetchedAt: string;
    freshness: Freshness;
    plausibility?: Plausibility;
  },
): string {
  const up = (q.change ?? 0) >= 0;
  const lines = [
    `📊 <b>${h(q.symbol)}</b>${nameSuffix(q.name)}`,
    '',
    '💰 <b>Harga</b>',
    formatRupiah(q.price),
    '',
    `${up ? '📈' : '📉'} <b>Perubahan</b>`,
    `${formatSigned(q.change)} (${formatPercent(q.changePercent)})`,
    '',
    `Open: ${formatRupiah(q.open)}`,
    `High: ${formatRupiah(q.high)}`,
    `Low: ${formatRupiah(q.low)}`,
    `Penutupan sebelumnya: ${formatRupiah(q.previousClose)}`,
    `Volume: ${formatCompactId(q.volume)} lembar`,
    '',
    ...freshnessLines({ quote: q, ...meta }),
  ];
  return lines.join('\n');
}

/* ---------------------------------------------------------------- technical */

export function formatTechnical(
  report: FullTechnicalReport,
  topics: TechnicalTopic[] = [],
): string {
  const { quote, technical: t } = report;
  const s = t.snapshot;
  const c = t.classification;
  const want = (k: TechnicalTopic) => topics.length === 0 || topics.includes(k);
  const lines: string[] = [`📈 <b>${h(report.symbol)}</b> — Teknikal`, ''];

  lines.push(`Harga: ${formatRupiah(quote.price)} (${formatPercent(quote.changePercent)})`);
  if (topics.length === 0) {
    lines.push(`Kondisi teknikal: <b>${TRENDS[c.trend]}</b>`);
    lines.push(`Momentum: ${MOMENTUM_ID[c.momentum.strength]} (${BIAS_ID[c.momentum.bias]})`);
  }
  lines.push('');

  if (want('ma')) {
    const rel = (ma: number | null) =>
      ma === null ? '' : quote.price >= ma ? ' (harga di atasnya)' : ' (harga di bawahnya)';
    lines.push(`MA20: ${rp0(s.sma20)}${rel(s.sma20)}`);
    lines.push(`MA50: ${rp0(s.sma50)}${rel(s.sma50)}`);
    lines.push(
      `MA200: ${s.sma200 === null ? 'belum tersedia (riwayat kurang)' : rp0(s.sma200) + rel(s.sma200)}`,
    );
    if (topics.includes('ma')) {
      lines.push(`MA5: ${rp0(s.sma5)}`, `MA100: ${s.sma100 === null ? '-' : rp0(s.sma100)}`);
      lines.push(`EMA12: ${rp0(s.ema12)} | EMA26: ${rp0(s.ema26)}`);
    }
    lines.push('');
  }
  if (want('rsi')) {
    const zone =
      c.rsiZone === 'OVERBOUGHT'
        ? ' — area jenuh beli'
        : c.rsiZone === 'OVERSOLD'
          ? ' — area jenuh jual'
          : ' — zona netral';
    lines.push(`RSI (14): ${formatNumber(s.rsi14, 1)}${s.rsi14 === null ? '' : zone}`, '');
  }
  if (want('macd')) {
    const state =
      c.macdState === 'BULLISH' ? 'bullish' : c.macdState === 'BEARISH' ? 'bearish' : '-';
    lines.push(
      `MACD: ${formatNumber(s.macd, 1)} | Signal: ${formatNumber(s.macdSignal, 1)} | Histogram: ${formatNumber(s.macdHistogram, 1)}`,
      `Status MACD: ${state}`,
      '',
    );
  }
  if (want('bollinger')) {
    lines.push(
      `Bollinger (20,2): ${rp0(s.bollingerLower)} – ${rp0(s.bollingerMiddle)} – ${rp0(s.bollingerUpper)}`,
      '',
    );
  }
  if (want('atr')) {
    lines.push(
      `ATR (14): ${formatNumber(s.atr14, 1)} (±${formatNumber(s.atr14 && quote.price ? (s.atr14 / quote.price) * 100 : null, 2)}% dari harga)`,
      '',
    );
  }
  if (want('volume')) {
    // The ratio below is computed from the last DAILY candle, so that is the volume printed next to it (the
    // live quote volume can be ahead of the cached history); the session is named when it is not today's.
    const lastCandle = report.candles[report.candles.length - 1];
    const quoteDay = quote.timestamp ? jakartaParts(new Date(quote.timestamp)).isoDate : null;
    const fromCandle = lastCandle !== undefined && lastCandle.volume > 0 && s.volumeRatio !== null;
    const volume = fromCandle ? lastCandle.volume : quote.volume;
    const session =
      fromCandle && lastCandle.date !== quoteDay ? ` (sesi ${formatDateId(lastCandle.date)})` : '';
    lines.push(
      `Volume: ${formatCompactId(volume)} lembar${session}`,
      `Rasio volume: ${formatRatio(s.volumeRatio)} dari rata-rata 20 hari`,
      '',
    );
  }
  if (want('support')) lines.push(`Support: ${levels(t.support)}`);
  if (want('resistance')) lines.push(`Resistance: ${levels(t.resistance)}`);
  if (want('support') || want('resistance')) lines.push('');

  if (t.limitedHistory) {
    lines.push(
      `ℹ️ Riwayat harga ${t.candleCount} hari; indikator berperiode panjang mungkin belum tersedia.`,
      '',
    );
  }
  lines.push(...reportFreshnessLines(report));
  lines.push(`Kandel harian terakhir: ${s.asOf}`);
  return lines.join('\n');
}

/* ----------------------------------------------------------------- analysis */

/** Rule-based observations used when AI is unavailable (derived only from calculated values). */
export function deterministicObservations(report: FullTechnicalReport): string[] {
  const { quote, technical: t } = report;
  const s = t.snapshot;
  const out = [...t.classification.trendSignals];
  if (s.rsi14 !== null) out.push(`RSI ${formatNumber(s.rsi14, 1)}`);
  if (s.volumeRatio !== null) out.push(`Volume ${formatRatio(s.volumeRatio)} rata-rata 20 hari`);
  if (t.resistance[0]) out.push(`Resistance terdekat ${formatRupiah(t.resistance[0].price)}`);
  if (t.support[0]) out.push(`Support terdekat ${formatRupiah(t.support[0].price)}`);
  void quote;
  return out;
}

export function deterministicRisks(report: FullTechnicalReport): string[] {
  const { quote, technical: t } = report;
  const risks: string[] = [];
  const r = t.snapshot.rsi14;
  if (r !== null && r >= 70) risks.push('RSI di area jenuh beli; koreksi dapat terjadi');
  if (r !== null && r <= 30) risks.push('RSI di area jenuh jual; tekanan jual dapat berlanjut');
  const res = t.resistance[0];
  if (res && (res.price - quote.price) / quote.price < 0.02)
    risks.push('Harga dekat level resistance');
  const sup = t.support[0];
  if (sup && (quote.price - sup.price) / quote.price < 0.02)
    risks.push('Harga dekat level support; jika ditembus tekanan dapat meningkat');
  risks.push('Momentum dapat berubah sewaktu-waktu');
  return risks;
}

export interface ExtraData {
  foreignFlow?: DataResult<ForeignFlow>;
  fundamentals?: DataResult<Fundamentals>;
  /** Fundamentals with provenance and related headlines, when available. */
  fundamentalsReport?: FundamentalsReport | null;
  news?: NewsReport | null;
}

const PROVENANCE_MARK: Record<string, string> = {
  estimated: ' (estimasi)',
  derived: ' (turunan)',
  stale: ' (basi)',
};

/** PER | PBV | ROE | dividend yield, each with its provenance mark; empty when nothing is usable. */
function fundamentalBits(r: FundamentalsReport): string[] {
  const bits: string[] = [];
  for (const m of ['per', 'pbv', 'roe', 'dividendYield'] as const) {
    const f = r.fields[m];
    if (f.value === null || f.status === 'missing') continue;
    const label = m === 'dividendYield' ? 'Dividen' : m.toUpperCase();
    bits.push(`${label} ${formatMetricValue(m, f.value)}${PROVENANCE_MARK[f.status] ?? ''}`);
  }
  return bits;
}

export function formatAnalysis(
  report: FullTechnicalReport,
  ai: AnalysisOutput | null,
  extras: ExtraData = {},
  opts: { heading?: string; question?: string; aiNotice?: string; brief?: boolean } = {},
): string {
  const { quote, technical: t } = report;
  const s = t.snapshot;
  const c = t.classification;
  const heading = opts.heading ?? `🤖 <b>AI ANALYSIS — ${h(report.symbol)}</b>`;

  const lines: string[] = [heading];
  if (cleanCompanyName(quote.name)) lines.push(h(cleanCompanyName(quote.name) as string));
  lines.push(
    '',
    '💰 <b>Harga</b>',
    `${formatRupiah(quote.price)}  ${formatPercent(quote.changePercent)}`,
    '',
    '📈 <b>Kondisi Teknikal</b>',
    `Trend: ${TRENDS[c.trend]}`,
    `Momentum: ${MOMENTUM_ID[c.momentum.strength]} (${BIAS_ID[c.momentum.bias]})`,
    `RSI: ${formatNumber(s.rsi14, 1)}`,
    `MACD: ${c.macdState === 'BULLISH' ? 'Bullish' : c.macdState === 'BEARISH' ? 'Bearish' : '-'}`,
    `MA20: ${rp0(s.sma20)}`,
    `MA50: ${rp0(s.sma50)}`,
    '',
    '📊 <b>Volume</b>',
    s.volumeRatio === null
      ? 'Rasio volume tidak tersedia'
      : `${formatRatio(s.volumeRatio)} rata-rata 20 hari`,
    '',
    '🎯 <b>Level Teknis</b>',
    `Support: ${levels(t.support)}`,
    `Resistance: ${levels(t.resistance)}`,
  );
  if (opts.brief) {
    // "jawab ringkas": keep price and trend, drop the volume and level sections (risks are never cut)
    const from = lines.indexOf('📊 <b>Volume</b>') - 1;
    if (from > 0) lines.splice(from);
  }

  const fr = extras.fundamentalsReport;
  if (fr && !opts.brief) {
    const bits = fundamentalBits(fr);
    if (bits.length) {
      lines.push('', '🏦 <b>Fundamental</b>', bits.join(' | '));
      if (fr.fromSnapshot)
        lines.push(`(dari snapshot ${formatWib(fr.asOf)}${fr.stale ? ', basi' : ''})`);
    }
  }
  const f = extras.fundamentals;
  if (f?.available && !fr && !opts.brief) {
    const d = f.data;
    const bits = [
      d.per !== null ? `PER ${formatNumber(d.per, 1)}x` : null,
      d.pbv !== null ? `PBV ${formatNumber(d.pbv, 2)}x` : null,
      d.roe !== null ? `ROE ${formatPercent(d.roe, 1, false)}` : null,
      d.dividendYield !== null ? `Dividen ${formatPercent(d.dividendYield, 2, false)}` : null,
    ].filter(Boolean);
    if (bits.length) lines.push('', '🏦 <b>Fundamental</b>', bits.join(' | '));
  }

  lines.push('', '🧠 <b>Analisis</b>');
  if (ai) {
    lines.push(h(ai.summary));
    const shown = opts.brief ? ai.technical_observations.slice(0, 2) : ai.technical_observations;
    if (shown.length) {
      lines.push('', ...shown.map((o) => `• ${h(o)}`));
    }
  } else {
    lines.push(
      `⚠️ ${h(opts.aiNotice ?? AI_NOTICE.unavailable)}`,
      ...deterministicObservations(report).map((o) => `• ${h(o)}`),
    );
  }

  const risks = ai?.risk_factors.length ? ai.risk_factors : deterministicRisks(report);
  lines.push('', '⚠️ <b>Risiko</b>', ...risks.map((r) => `• ${h(r)}`));
  if (extras.news && !opts.brief) {
    const block = formatRelatedNews(extras.news);
    if (block) lines.push('', block);
  }

  const limits = [...(ai?.data_limitations ?? [])];
  const mentions = (re: RegExp) => limits.some((l) => re.test(l));
  if (extras.foreignFlow && !extras.foreignFlow.available && !mentions(/foreign|asing/i)) {
    limits.push('Data foreign flow tidak tersedia dari provider.');
  }
  if (!mentions(/berita|sentimen/i))
    limits.push('Berita & sentimen tidak termasuk dalam analisis.');
  const seen = new Set<string>();
  const uniqueLimits = limits
    .filter((l) => {
      const key = l.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
  if (uniqueLimits.length)
    lines.push('', 'ℹ️ <b>Keterbatasan data</b>', ...uniqueLimits.map((l) => `• ${h(l)}`));

  lines.push('', ...reportFreshnessLines(report));
  lines.push('', `<i>${DISCLAIMER}</i>`);
  return lines.join('\n');
}

/** Answer to a free-form question about one stock (e.g. "kenapa BBCA naik?"). */
export function formatStockAnswer(
  report: FullTechnicalReport,
  ai: AnalysisOutput | null,
  question: string,
  opts: { aiNotice?: string } = {},
): string {
  const { quote, technical: t } = report;
  const s = t.snapshot;
  const lines = [
    `💬 <b>${h(report.symbol)}</b>${nameSuffix(quote.name)}`,
    '',
    `Harga: ${formatRupiah(quote.price)} (${formatPercent(quote.changePercent)})`,
    `Trend: ${TRENDS[t.classification.trend]} | RSI: ${formatNumber(s.rsi14, 1)} | Volume: ${formatRatio(s.volumeRatio)} rata-rata`,
    '',
  ];
  if (ai) {
    lines.push(h(ai.summary));
    if (ai.technical_observations.length)
      lines.push('', ...ai.technical_observations.slice(0, 4).map((o) => `• ${h(o)}`));
    const risks = ai.risk_factors.slice(0, MAX_RISKS);
    if (risks.length) lines.push('', '⚠️ <b>Catatan risiko</b>', ...risks.map((r) => `• ${h(r)}`));
  } else {
    lines.push(
      `⚠️ ${h(opts.aiNotice ?? 'Penjelasan AI sedang tidak tersedia. Yang terlihat dari data:')}`,
      ...deterministicObservations(report)
        .slice(0, 6)
        .map((o) => `• ${h(o)}`),
    );
  }
  lines.push(
    '',
    'ℹ️ Penyebab pergerakan (berita/fundamental) tidak tersedia dalam data; penjelasan hanya berdasarkan harga dan volume.',
  );
  lines.push('', ...reportFreshnessLines(report));
  lines.push('', `<i>${DISCLAIMER}</i>`);
  void question;
  return lines.join('\n');
}

/* --------------------------------------------------------------- comparison */

export function formatComparison(
  reports: FullTechnicalReport[],
  ai: ComparisonOutput | null,
): string {
  const lines: string[] = [
    `⚖️ <b>PERBANDINGAN ${reports.map((r) => h(r.symbol)).join(' vs ')}</b>`,
    '',
  ];

  const rows: Array<[string, (r: FullTechnicalReport) => string]> = [
    ['Harga', (r) => formatRupiah(r.quote.price)],
    ['Perubahan', (r) => formatPercent(r.quote.changePercent)],
    ['RSI', (r) => formatNumber(r.technical.snapshot.rsi14, 1)],
    ['MA20', (r) => rp0(r.technical.snapshot.sma20)],
    ['MA50', (r) => rp0(r.technical.snapshot.sma50)],
    ['Vol Ratio', (r) => formatRatio(r.technical.snapshot.volumeRatio)],
    ['Trend', (r) => TRENDS[r.technical.classification.trend]],
  ];

  // Mobile-friendly: at most 3 symbols per table.
  for (let i = 0; i < reports.length; i += 3) {
    const group = reports.slice(i, i + 3);
    const labelW = Math.max(...rows.map(([l]) => l.length));
    const colW = Math.max(
      9,
      ...group.flatMap((r) => rows.map(([, f]) => f(r).length)),
      ...group.map((r) => r.symbol.length),
    );
    const header = ''.padEnd(labelW) + group.map((r) => r.symbol.padStart(colW + 1)).join('');
    const body = rows.map(
      ([label, f]) => label.padEnd(labelW) + group.map((r) => f(r).padStart(colW + 1)).join(''),
    );
    lines.push(`<pre>${[header, ...body].map(h).join('\n')}</pre>`);
  }

  const oldest = reports.reduce((a, b) =>
    new Date(a.quote.timestamp) < new Date(b.quote.timestamp) ? a : b,
  );
  const worst = worstFreshness(reports.map((r) => r.freshness));
  if (reports.some((r) => r.freshness.fromFallback)) {
    lines.push('⚠️ Sebagian data adalah data tersimpan terakhir (bukan data terbaru).');
  }
  const odd = reports.filter((r) => !r.plausibility.ok).map((r) => r.symbol);
  if (odd.length) {
    lines.push(
      `⚠️ Harga ${odd.map(h).join(', ')} terlihat tidak wajar; verifikasi di sumber lain.`,
    );
  }

  if (ai) {
    lines.push('', '🧠 <b>Catatan perbandingan</b>', h(ai.summary));
    if (ai.differences.length) lines.push('', ...ai.differences.map((d) => `• ${h(d)}`));
    if (ai.considerations.length)
      lines.push('', '⚠️ <b>Pertimbangan</b>', ...ai.considerations.map((d) => `• ${h(d)}`));
  } else {
    lines.push('', 'ℹ️ Penjelasan AI tidak tersedia; tabel di atas dihitung langsung dari data.');
  }

  if (worst) lines.push('', freshnessStatusLine(worst));
  lines.push(`${dataLabel(worst)} ${formatWib(oldest.quote.timestamp)}`);
  lines.push(`Sumber: ${h(prettySource(oldest.quoteSource))}`);
  lines.push(
    '',
    `<i>Perbandingan ini bersifat informatif dan tidak menyatakan saham terbaik/terburuk. ${DISCLAIMER}</i>`,
  );
  return lines.join('\n');
}

/* ---------------------------------------------------------------- watchlist */

export function formatWatchlist(
  entries: Array<{
    symbol: string;
    quote: DataResult<NormalizedQuote> | null;
    freshness?: Freshness | null;
  }>,
): string {
  if (entries.length === 0) {
    return '📋 <b>WATCHLIST</b>\n\nWatchlist kamu masih kosong. Coba: "tambahkan BBCA ke watchlist".';
  }
  const lines = ['📋 <b>WATCHLIST</b>', ''];
  let newest: string | null = null;
  let anyFallback = false;
  const states: Freshness[] = [];
  for (const e of entries) {
    lines.push(`<b>${h(e.symbol)}</b>`);
    if (e.quote && e.quote.available) {
      const q = e.quote.data;
      const stale = e.freshness?.state === 'STALE' ? ' ⚠️ STALE' : '';
      lines.push(`${formatRupiah(q.price)}  ${formatPercent(q.changePercent)}${stale}`);
      if (!newest || q.timestamp > newest) newest = q.timestamp;
      if (e.quote.stale) anyFallback = true;
      if (e.freshness) states.push(e.freshness);
    } else {
      lines.push('Data belum tersedia');
    }
    lines.push('');
  }
  const worst = worstFreshness(states);
  if (anyFallback) lines.push('⚠️ Sebagian harga adalah data tersimpan terakhir.');
  if (worst) lines.push(freshnessStatusLine(worst));
  lines.push(
    newest ? `${dataLabel(worst)} ${formatWib(newest)}` : 'Data harga tidak tersedia saat ini.',
  );
  return lines.join('\n');
}

/* -------------------------------------------------------------------- misc */

export function formatForeignFlow(symbol: string, res: DataResult<ForeignFlow>): string {
  if (!res.available) {
    return `🌐 <b>Foreign Flow ${h(symbol)}</b>\n\nData foreign flow tidak tersedia dari provider saat ini.`;
  }
  const d = res.data;
  return [
    `🌐 <b>Foreign Flow ${h(symbol)}</b>`,
    '',
    `Beli asing: ${formatCompactId(d.foreignBuy)}`,
    `Jual asing: ${formatCompactId(d.foreignSell)}`,
    `Net asing: ${formatCompactId(d.netForeign)}`,
    '',
    `🕐 Data: ${formatWib(d.asOf)}`,
  ].join('\n');
}

export function formatMarketStatus(
  status: MarketStatus,
  description: string,
  index?: DataResult<NormalizedQuote>,
): string {
  const icon = status.isTrading ? '🟢' : '🔴';
  const lines = [`${icon} <b>Status Bursa (IDX)</b>`, '', h(description)];
  if (index?.available) {
    const q = index.data;
    lines.push(
      '',
      `📊 <b>IHSG</b>: ${formatNumber(q.price, 2)} (${formatPercent(q.changePercent)})`,
      `🕐 Data: ${formatWib(q.timestamp)}`,
    );
  } else if (index) {
    lines.push('', 'Data IHSG tidak tersedia saat ini.');
  }
  lines.push('', `Waktu sekarang: ${formatWib(status.checkedAt)}`);
  return lines.join('\n');
}

export function formatAlertTriggered(args: {
  symbol: string;
  label: string;
  observed: string;
  quoteTime: string;
  /** Set for alerts delivered to a group: whose alert it is. */
  owner?: string;
}): string {
  return [
    `🔔 <b>ALERT — ${h(args.symbol)}</b>`,
    ...(args.owner ? [`👤 Alert milik ${h(args.owner)}`] : []),
    '',
    h(args.label),
    `Nilai saat ini: ${h(args.observed)}`,
    '',
    `🕐 Data: ${formatWib(args.quoteTime)}`,
    'Alert ini sudah terpicu dan dinonaktifkan. Buat lagi jika ingin dipantau kembali.',
  ].join('\n');
}

export const HELP_TEXT = [
  '🤖 <b>INDONESIAN STOCK BOT</b>',
  '',
  'Kamu tidak perlu menghafal command.',
  'Cukup tulis seperti berbicara biasa:',
  '',
  '• "BBCA" — harga terkini',
  '• "analisis BBCA" — analisis teknikal + AI',
  '• "kenapa BBCA naik?" — penjelasan berbasis data',
  '• "bandingkan BBCA BBRI" — perbandingan',
  '• "berapa RSI BBCA?" — indikator teknikal',
  '• "saham apa yang volumenya tinggi?" — screening',
  '• "tambahkan BBCA ke watchlist" / "lihat watchlist saya"',
  '• "ingatkan saya kalau BBCA di atas 8500"',
  '• "lihat alert saya" / "hapus alert BBCA"',
  '• "jam berapa market buka?"',
  '• "pengaturan saya" / "lupakan konteks" / "hapus data saya"',
  '• "apa itu ARA?" — penjelasan istilah; "catat: BBCA cum date 20 Mei" / "catatan saya"',
  '• "berita BBCA" — judul berita terbaru (sumber dan waktu)',
  '• "ringkas portofolio saya" / "jawab ringkas" (gaya jawaban)',
  '',
  'Untuk bantuan:',
  '/help',
  '',
  `<i>${DISCLAIMER}</i>`,
].join('\n');

export const START_TEXT = [
  'Selamat datang di <b>AI Indonesian Stock Bot</b> 👋',
  '',
  'Saya dapat membantu membaca data saham IDX, analisis teknikal, screening, watchlist, alert, dan analisis berbasis AI.',
  '',
  'Cukup tulis pertanyaanmu secara natural.',
  '',
  'Contoh:',
  '"BBCA"',
  '"analisis BBCA"',
  '"kenapa BBCA naik?"',
  '"bandingkan BBCA BBRI"',
  '"tambahkan BBCA ke watchlist"',
  '',
  'Gunakan /help untuk bantuan.',
  '',
  `<i>${DISCLAIMER}</i>`,
].join('\n');

/* ---------------------------------------------------------------- screening */

export function formatScreen(res: import('../screener/screener.service').ScreenResult): string {
  const lines = ['🔎 <b>HASIL SCREENING</b>', ''];
  if (res.criteriaText.length) lines.push(...res.criteriaText.map((c) => `• ${h(c)}`), '');

  if (res.quotedCount === 0) {
    return [
      ...lines,
      'Data harga tidak dapat diambil dari provider saat ini. Coba lagi beberapa saat lagi.',
    ].join('\n');
  }
  if (res.rows.length === 0) {
    lines.push('Tidak ada saham yang memenuhi kriteria saat ini.');
  } else {
    res.rows.forEach((r, i) => {
      const extra = [
        r.volumeRatio !== null ? `Vol ${formatRatio(r.volumeRatio)}` : null,
        r.rsi !== null ? `RSI ${formatNumber(r.rsi, 1)}` : null,
        r.trend ? TRENDS[r.trend] : null,
      ].filter(Boolean);
      lines.push(
        `${i + 1}. <b>${h(r.symbol)}</b>  ${formatRupiah(r.price)}  ${formatPercent(r.changePercent)}`,
      );
      if (extra.length) lines.push(`    ${extra.join(' | ')}`);
    });
  }
  lines.push('');
  lines.push(
    `ℹ️ Screening saat ini menggunakan ${res.universeSize} saham yang tersedia dari daftar pantauan bot dan provider data (${res.quotedCount} berhasil diambil) — bukan seluruh saham IDX.`,
  );
  if (res.indicatorScanned !== null) {
    lines.push(
      `Indikator dihitung untuk ${res.indicatorScanned} kandidat${res.indicatorCapped ? ' (dibatasi)' : ''}.`,
    );
  }
  if (res.criteriaText.some((c) => c.startsWith('Rasio volume'))) {
    lines.push(
      'Rasio volume = volume hari ini ÷ rata-rata volume harian 3 bulan; pada jam awal sesi nilainya masih rendah.',
    );
  }
  if (res.anyStale) lines.push('⚠️ Sebagian data adalah data tersimpan terakhir.');
  if (res.freshness) lines.push(freshnessStatusLine(res.freshness));
  if (res.asOf) {
    lines.push(`${dataLabel(res.freshness)} ${formatWib(res.asOf)}`, 'Sumber: Yahoo Finance');
  }
  return lines.join('\n');
}

/* --------------------------------------------------------------- historical */

export interface HistoricalView {
  symbol: string;
  name: string | null;
  /** What the user asked for, e.g. "Kemarin (2 Oktober 2026)". */
  requestLabel: string;
  requestDate: string;
  /** Candle found for the date, or the nearest earlier trading day. */
  found: { candle: DailyCandle; previous: DailyCandle | null; exact: boolean } | null;
  /** First candle date the provider returned (to explain "too far back"). */
  earliestDate: string | null;
  /** Most recent candle, to show change since then for relative requests. */
  latest: DailyCandle | null;
  relative: boolean;
  /** The user asked "why" about that date. */
  question: boolean;
  source: string;
  fromFallback: boolean;
  fetchedAt: string;
}

/**
 * Past-date price lookups. Never substitutes today's data: either the requested date's candle, the
 * nearest earlier trading day (clearly labelled), or an explicit "not available".
 */
export function formatHistorical(v: HistoricalView): string {
  const lines = [
    `📅 <b>${h(v.symbol)}</b>${nameSuffix(v.name)}`,
    `Tanggal diminta: ${h(v.requestLabel)}`,
    '',
  ];
  if (!v.found) {
    lines.push(
      v.earliestDate
        ? `⚠️ Data harian untuk tanggal itu tidak tersedia: riwayat dari provider dimulai ${formatDateId(v.earliestDate)}.`
        : '⚠️ Data harian untuk tanggal itu tidak tersedia dari provider.',
    );
  } else {
    const { candle, previous, exact } = v.found;
    if (!exact) {
      lines.push(
        `⚠️ Tidak ada data perdagangan pada ${formatDateId(v.requestDate)} (akhir pekan/libur bursa, atau data belum tersedia).`,
        `Data perdagangan terakhir sebelum tanggal itu: <b>${formatDateId(candle.date)}</b>.`,
        '',
      );
    }
    const change =
      previous && previous.close > 0
        ? ` (${formatPercent(((candle.close - previous.close) / previous.close) * 100)} dari penutupan ${formatDateId(previous.date)})`
        : '';
    lines.push(
      `Penutupan: <b>${formatRupiah(candle.close)}</b>${change}`,
      `Open: ${formatRupiah(candle.open)} | High: ${formatRupiah(candle.high)} | Low: ${formatRupiah(candle.low)}`,
      `Volume: ${formatCompactId(candle.volume)} lembar`,
    );
    if (v.relative && v.latest && v.latest.date !== candle.date && candle.close > 0) {
      lines.push(
        '',
        `Dibanding penutupan terakhir yang tersedia (${formatRupiah(v.latest.close)} pada ${formatDateId(v.latest.date)}): ${formatPercent(((v.latest.close - candle.close) / candle.close) * 100)}.`,
      );
    }
  }
  lines.push('');
  if (v.question) {
    lines.push(
      'ℹ️ Penyebab pergerakan pada tanggal itu (berita/fundamental) tidak tersedia dalam data.',
    );
  }
  lines.push('ℹ️ Data historis harian (end-of-day) dari provider, bukan data real-time.');
  if (v.fromFallback) {
    lines.push(`⚠️ Riwayat diambil dari data tersimpan (pembaruan ${formatWib(v.fetchedAt)}).`);
  }
  lines.push(`Sumber: ${h(prettySource(v.source))}`);
  return lines.join('\n');
}

/* ---------------------------------------------------------------- portfolio */

const TX_LABEL: Record<RecordResult['type'], string> = {
  BUY: 'Pembelian',
  SELL: 'Penjualan',
  DIVIDEND: 'Dividen',
  DEPOSIT: 'Setoran',
  WITHDRAWAL: 'Penarikan',
  REVERSAL: 'Pembatalan',
};

const lots = (shares: number): string => {
  const l = shares / 100;
  return Number.isInteger(l) ? `${formatNumber(l)} lot` : `${formatNumber(shares)} lembar`;
};

const signedRupiah = (v: number): string => `${v < 0 ? '-' : '+'}${formatRupiah(Math.abs(v))}`;

export function formatTransactionRecorded(r: RecordResult): string {
  const lines: string[] = [];
  if (r.duplicate) {
    lines.push(
      'ℹ️ Transaksi ini sudah tercatat sebelumnya (pesan yang sama tidak dicatat dua kali).',
    );
  } else {
    lines.push(`✅ <b>${TX_LABEL[r.type]} dicatat</b>`);
  }
  if (
    (r.type === 'BUY' || r.type === 'SELL' || r.type === 'REVERSAL') &&
    r.symbol &&
    r.quantity !== null
  ) {
    const price = r.price !== null ? ` @ ${formatRupiah(r.price)}` : '';
    lines.push(
      `${h(r.symbol)}: ${lots(r.quantity)}${price}${r.fees ? `, biaya ${formatRupiah(r.fees)}` : ''}`,
    );
  }
  if (r.type === 'SELL' || (r.type === 'REVERSAL' && r.realizedPnl !== 0)) {
    lines.push(`P/L terealisasi: ${signedRupiah(r.realizedPnl)}`);
  }
  if (r.holding) {
    lines.push(
      r.holding.quantity > 0
        ? `Posisi sekarang: ${lots(r.holding.quantity)}, harga rata-rata ${formatRupiah(r.holding.avgCost)}`
        : 'Posisi sekarang: tidak ada (sudah terjual semua)',
    );
  }
  lines.push(`Kas tercatat: ${formatRupiah(r.cash)}`);
  if (!r.duplicate && r.type !== 'REVERSAL') {
    lines.push('', '<i>Salah catat? Ketik "batalkan transaksi terakhir".</i>');
  }
  return lines.join('\n');
}

/** The model's selection over the portfolio catalogue, or the catalogue itself without a model. */
export function formatPortfolioSummary(
  view: PortfolioView,
  ai: AnalysisOutput | null,
  aiNotice?: string,
): string {
  const claims = portfolioClaims(view);
  const lines = ['🧠 <b>RINGKASAN PORTOFOLIO</b>', ''];
  if (ai) {
    lines.push(h(ai.summary));
    if (ai.technical_observations.length) {
      lines.push('', ...ai.technical_observations.map((o) => `• ${h(o)}`));
    }
  } else {
    lines.push(
      `⚠️ ${h(aiNotice ?? AI_NOTICE.unavailable)}`,
      ...claims.observations.map((o) => `• ${h(o)}`),
    );
  }
  const risks = ai?.risk_factors.length ? ai.risk_factors : [...claims.risks, GENERIC_RISK];
  lines.push('', '⚠️ <b>Risiko</b>', ...risks.map((r) => `• ${h(r)}`));
  lines.push(
    '',
    'Ringkasan ini hanya dari catatan yang kamu masukkan sendiri dan harga tepercaya terakhir; rincian: "portofolio saya".',
    '',
    `<i>${DISCLAIMER}</i>`,
  );
  return lines.join('\n');
}

export function formatPortfolioView(v: PortfolioView): string {
  const t = v.totals;
  if (v.holdings.length === 0 && t.cash.isZero()) {
    return [
      '💼 <b>PORTOFOLIO</b>',
      '',
      'Belum ada catatan. Catat transaksi dengan kalimat seperti:',
      '• "beli 10 lot BBCA di 9000"',
      '• "jual 5 lot BBCA di 9500 fee 15000"',
      '• "setor 10 juta", "dividen BBCA 150000"',
      '',
      '<i>Indonesian Stock Bot hanya mencatat; tidak ada transaksi nyata yang dilakukan.</i>',
    ].join('\n');
  }
  const lines = ['💼 <b>PORTOFOLIO</b>', ''];
  for (const hld of v.holdings.filter((x) => x.quantity.gt(0))) {
    const pct =
      hld.unrealizedPct === null ? '' : ` (${formatPercent(hld.unrealizedPct.toNumber())})`;
    const priceText =
      hld.price === null
        ? 'harga: tidak tersedia, dinilai dari modal'
        : `harga ${formatRupiah(hld.price.toNumber())}`;
    lines.push(
      `<b>${h(hld.symbol)}</b> ${lots(hld.quantity.toNumber())} · rata-rata ${formatRupiah(hld.avgCost.toNumber())}`,
      `${priceText} · nilai ${formatRupiah(hld.marketValue.toNumber())} · P/L ${signedRupiah(hld.unrealizedPnl.toNumber())}${pct}`,
      '',
    );
  }
  const totalPct =
    t.unrealizedPct === null ? '' : ` (${formatPercent(t.unrealizedPct.toNumber())})`;
  lines.push(
    '📊 <b>Ringkasan</b>',
    `Modal: ${formatRupiah(t.costBasis.toNumber())}`,
    `Nilai pasar: ${formatRupiah(t.marketValue.toNumber())}`,
    `P/L belum terealisasi: ${signedRupiah(t.unrealizedPnl.toNumber())}${totalPct}`,
    `P/L terealisasi: ${signedRupiah(t.realizedPnl.toNumber())}`,
  );
  if (!t.dividends.isZero())
    lines.push(`Dividen diterima: ${formatRupiah(t.dividends.toNumber())}`);
  lines.push(
    `Kas tercatat: ${formatRupiah(t.cash.toNumber())}`,
    `Total: ${formatRupiah(t.equity.toNumber())}`,
  );
  if (t.allocation.length > 1) {
    lines.push(
      '',
      'Alokasi: ' +
        t.allocation
          .map((a) => `${h(a.symbol)} ${formatNumber(a.percent.toNumber(), 1)}%`)
          .join(', '),
    );
  }
  if (v.unpriced.length) {
    lines.push(
      '',
      `⚠️ Dinilai dari modal (bukan harga pasar): ${v.unpriced.map((u) => `${h(u.symbol)} (${h(u.reason)})`).join(', ')}`,
    );
  }
  if (v.anyStale) lines.push('⚠️ Sebagian harga adalah data tersimpan terakhir.');
  if (v.newestQuoteAt) lines.push(`🕐 Harga per ${formatWib(v.newestQuoteAt)} WIB`);
  lines.push(
    '',
    '<i>Angka dihitung dari catatanmu sendiri; bukan saran untuk membeli atau menjual.</i>',
  );
  return lines.join('\n');
}

export function formatPortfolioHistory(rows: LedgerRow[]): string {
  if (rows.length === 0) return '📒 <b>RIWAYAT TRANSAKSI</b>\n\nBelum ada transaksi tercatat.';
  const lines = ['📒 <b>RIWAYAT TRANSAKSI</b> (terbaru dulu)', ''];
  for (const r of rows) {
    const when = formatWib(r.occurredAt);
    let what: string;
    if (r.type === 'BUY' || r.type === 'SELL') {
      what = `${TX_LABEL[r.type]} ${h(r.symbol ?? '?')} ${lots(r.quantity ?? 0)} @ ${formatRupiah(r.price ?? 0)}`;
    } else if (r.type === 'REVERSAL') {
      what = `Pembatalan${r.symbol ? ` ${h(r.symbol)}` : ''}`;
    } else {
      what = `${TX_LABEL[r.type]}${r.symbol ? ` ${h(r.symbol)}` : ''} ${formatRupiah(Math.abs(r.cashDelta))}`;
    }
    lines.push(`${when} · ${what}${r.reversed ? ' <i>(dibatalkan)</i>' : ''}`);
  }
  return lines.join('\n');
}
