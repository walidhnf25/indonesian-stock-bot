import { FullTechnicalReport } from '../analysis/analysis.types';
import { cleanCompanyName } from '../common/utils/text';
import {
  FIXED_RISKS,
  GENERIC_RISK,
  NO_NEWS_RISK,
  SOURCES_RISK,
  observationClaims,
  riskClaims,
} from './claims';
import {
  formatCompactId,
  formatNumber,
  formatPercent,
  formatRatio,
  formatRupiah,
  jakartaParts,
  round,
} from '../common/utils/format';
import { formatIsoDateId } from '../intent/parsers/temporal-parser';
import { BrokerSummary, DataResult, ForeignFlow, Fundamentals } from '../stock/stock.types';
import { FundamentalsReport } from '../fundamentals/fundamentals.types';
import { NewsReport } from '../news/news.types';
import {
  fundamentalClaims,
  holdingClaims,
  HoldingContext,
  newsClaims,
  watchlistClaims,
} from './extra-claims';

export interface OptionalData {
  fundamentals?: DataResult<Fundamentals>;
  foreignFlow?: DataResult<ForeignFlow>;
  brokerSummary?: DataResult<BrokerSummary>;
  /** Richer, verified sources; each contributes application-written claims or nothing. */
  fundamentalsReport?: FundamentalsReport | null;
  news?: NewsReport | null;
  /** The asking user's own position (private chat only). */
  holding?: HoldingContext | null;
  onWatchlist?: boolean;
}

const r = (v: number | null, d = 2) => (v === null ? null : round(v, d));

/**
 * Change over the last `daysBack` sessions. The end point is the same price the sentences quote as "Harga
 * terakhir" (the live quote when it is trusted), not the last daily candle, so the numbers in one answer
 * agree with each other. When the live price is newer than the last candle, that candle is itself
 * one session back, so the base candle moves by one.
 */
export function periodChange(report: FullTechnicalReport, daysBack: number): number | null {
  const { candles, quote } = report;
  if (candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const quoteDay = quote.timestamp ? jakartaParts(new Date(quote.timestamp)).isoDate : null;
  // Without a timestamp nobody can say whether the live price is newer than the last candle: use the candles.
  const live =
    report.plausibility.quality === 'trusted' &&
    quoteDay !== null &&
    Number.isFinite(quote.price) &&
    quote.price > 0;
  const lastIsToday = quoteDay !== null && last.date === quoteDay;
  const to = live ? quote.price : last.close;
  const baseIndex =
    live && !lastIsToday ? candles.length - daysBack : candles.length - 1 - daysBack;
  if (baseIndex < 0 || baseIndex >= candles.length) return null;
  const from = candles[baseIndex].close;
  return from > 0 ? round(((to - from) / from) * 100, 2) : null;
}

/**
 * Deterministic Indonesian fact statements derived from calculated values. Small local models
 * copy these reliably instead of re-deriving (and sometimes contradicting) the numbers.
 */
/** "hari ini" when the last daily candle is the quote's day, else the named session (weekend, stale history). */
export function volumeDayLabel(report: FullTechnicalReport): string {
  const last = report.candles[report.candles.length - 1];
  const quoteDay = report.quote.timestamp
    ? jakartaParts(new Date(report.quote.timestamp)).isoDate
    : null;
  if (!last || quoteDay === null || last.date === quoteDay) return 'hari ini';
  return `sesi ${formatIsoDateId(last.date)}`;
}

export function buildFacts(report: FullTechnicalReport): string[] {
  const { quote, technical: t } = report;
  const s = t.snapshot;
  const c = t.classification;
  const price = quote.price;
  const facts: string[] = [];
  const dir = (v: number | null) =>
    v === null ? null : v > 0 ? 'naik' : v < 0 ? 'turun' : 'tidak berubah';

  if (quote.changePercent !== null && quote.previousClose !== null) {
    facts.push(
      `Harga terakhir ${formatRupiah(price)}, ${dir(quote.changePercent)} ${formatPercent(Math.abs(quote.changePercent), 2, false)} dari penutupan sebelumnya (${formatRupiah(quote.previousClose)}).`,
    );
  }
  if (quote.open !== null && quote.high !== null && quote.low !== null) {
    facts.push(
      `Rentang hari ini: low ${formatRupiah(quote.low)}, high ${formatRupiah(quote.high)}, open ${formatRupiah(quote.open)}.`,
    );
  }
  const vs = (label: string, ma: number | null) => {
    if (ma === null) return;
    const pct = ((price - ma) / ma) * 100;
    if (Math.abs(pct) < 0.005) {
      facts.push(`Harga sama dengan ${label} (${formatRupiah(Math.round(ma))}).`); // an exact tie is not "0,00% above"
      return;
    }
    facts.push(
      `Harga ${pct > 0 ? 'di atas' : 'di bawah'} ${label} (${formatRupiah(Math.round(ma))}) sebesar ${formatPercent(Math.abs(pct), 2, false)}.`,
    );
  };
  vs('MA20', s.sma20);
  vs('MA50', s.sma50);
  vs('MA200', s.sma200);
  if (s.rsi14 !== null) {
    const zone =
      c.rsiZone === 'OVERBOUGHT'
        ? 'area jenuh beli'
        : c.rsiZone === 'OVERSOLD'
          ? 'area jenuh jual'
          : s.rsi14 < 40
            ? 'zona netral bawah (mendekati jenuh jual)'
            : s.rsi14 > 60
              ? 'zona netral atas (mendekati jenuh beli)'
              : 'zona netral';
    facts.push(`RSI(14) = ${formatNumber(s.rsi14, 1)}, ${zone}.`);
  }
  if (s.macd !== null && s.macdSignal !== null && s.macdHistogram !== null) {
    facts.push(
      `MACD (${formatNumber(s.macd, 1)}) ${s.macd >= s.macdSignal ? 'di atas' : 'di bawah'} garis signal (${formatNumber(s.macdSignal, 1)}); histogram ${s.macdHistogram >= 0 ? 'positif' : 'negatif'} (${formatNumber(s.macdHistogram, 1)}).`,
    );
  }
  // The ratio is computed from the daily candle's volume, so that is the volume printed next to it
  // (the live quote volume can be ahead of the cached history).
  const lastCandle = report.candles[report.candles.length - 1];
  const candleVolume = lastCandle?.volume;
  const volumeDay = volumeDayLabel(report); // the last candle can be the previous session (weekend, stale history)
  if (s.volumeRatio !== null && typeof candleVolume === 'number' && candleVolume > 0) {
    const rel = s.volumeRatio >= 1.05 ? 'di atas' : s.volumeRatio <= 0.95 ? 'di bawah' : 'sekitar';
    facts.push(
      `Volume ${volumeDay} ${formatCompactId(candleVolume)} lembar = ${formatRatio(s.volumeRatio)} rata-rata 20 hari sebelumnya (${rel} rata-rata).`,
    );
  }
  if (s.bollingerUpper !== null && s.bollingerLower !== null) {
    const pos =
      price > s.bollingerUpper
        ? 'di atas band atas'
        : price < s.bollingerLower
          ? 'di bawah band bawah'
          : 'di dalam band';
    facts.push(
      `Harga ${pos} Bollinger (bawah ${formatRupiah(Math.round(s.bollingerLower))}, atas ${formatRupiah(Math.round(s.bollingerUpper))}).`,
    );
  }
  for (const [label, n] of [
    ['5 hari', 5],
    ['20 hari', 20],
    ['60 hari', 60],
  ] as const) {
    const p = periodChange(report, n);
    if (p !== null) facts.push(`Perubahan harga ${label} terakhir: ${formatPercent(p)}.`);
  }
  const sup = t.support[0];
  const res = t.resistance[0];
  if (sup)
    facts.push(
      `Support terdekat ${formatRupiah(sup.price)} (${formatPercent(((sup.price - price) / price) * 100)} dari harga, kekuatan ${sup.strength}).`,
    );
  if (res)
    facts.push(
      `Resistance terdekat ${formatRupiah(res.price)} (${formatPercent(((res.price - price) / price) * 100)} dari harga, kekuatan ${res.strength}).`,
    );
  return facts;
}

/**
 * Risk sentences derived from the data. Like the facts they are application-authored and purely
 * descriptive; the model can only pick among them (see claims.ts).
 */
export function buildRiskStatements(report: FullTechnicalReport): string[] {
  const { quote, technical: t } = report;
  const s = t.snapshot;
  const price = quote.price;
  const risks: string[] = [];
  if (s.rsi14 !== null && s.rsi14 >= 70) risks.push('RSI berada di area jenuh beli.');
  if (s.rsi14 !== null && s.rsi14 <= 30) risks.push('RSI berada di area jenuh jual.');
  const res = t.resistance[0];
  if (res && price > 0 && (res.price - price) / price < 0.02 && res.price >= price)
    risks.push('Harga dekat level resistance.');
  const sup = t.support[0];
  if (sup && price > 0 && (price - sup.price) / price < 0.02 && price >= sup.price)
    risks.push('Harga dekat level support.');
  if (s.volumeRatio !== null && s.volumeRatio < 0.8)
    risks.push(`Volume ${volumeDayLabel(report)} di bawah rata-rata 20 hari.`);
  if (s.volumeRatio !== null && s.volumeRatio >= 1.5)
    risks.push(`Volume ${volumeDayLabel(report)} jauh di atas rata-rata 20 hari.`);
  if (s.sma50 !== null && price < s.sma50) risks.push('Harga berada di bawah MA50.');
  risks.push(GENERIC_RISK);
  risks.push(NO_NEWS_RISK);
  return risks;
}

/**
 * Compact structured JSON given to the model. Only calculated/observed values; no raw history dumps.
 * Unavailable optional data is `null` so the model must state it is unavailable.
 */
export function buildAnalysisContext(report: FullTechnicalReport, extras: OptionalData = {}) {
  const { quote, technical } = report;
  const s = technical.snapshot;
  const c = technical.classification;
  const price = quote.price;
  const facts = buildFacts(report);

  const unwrap = <T>(res?: DataResult<T>): T | null => (res && res.available ? res.data : null);
  const limitations: string[] = [];
  if (report.quoteStale)
    limitations.push('Harga yang ditampilkan adalah data tersimpan terakhir, bukan data terbaru.');
  if (report.historyStale) limitations.push('Data historis berasal dari penyimpanan lokal.');
  if (report.freshness.state === 'STALE' && !report.quoteStale) {
    limitations.push(`Data tidak terkini (STALE): ${report.freshness.reason}`);
  }
  if (!report.plausibility.ok) {
    limitations.push('Harga terlihat tidak wajar; jangan menarik kesimpulan dari angka harga ini.');
  }
  if (technical.limitedHistory)
    limitations.push(
      `Riwayat harga hanya ${technical.candleCount} hari (${technical.candleCount < 50 ? 'MA50 dan MA200' : 'MA200'} mungkin tidak tersedia).`,
    );
  if (quote.delayMinutes) limitations.push(`Data tertunda sekitar ${quote.delayMinutes} menit.`);
  if (extras.foreignFlow && !extras.foreignFlow.available)
    limitations.push('Data foreign flow tidak tersedia dari provider.');
  if (extras.brokerSummary && !extras.brokerSummary.available)
    limitations.push('Data broker summary tidak tersedia dari provider.');
  // Claims from the other verified sources (silence when a source is not trustworthy)
  const fund = fundamentalClaims(extras.fundamentalsReport);
  const news = newsClaims(extras.news);
  const own = [holdingClaims(extras.holding), watchlistClaims(extras.onWatchlist)];
  const extraObservations = [
    ...fund.observations,
    ...news.observations,
    ...own.flatMap((o) => o.observations),
  ];
  const extraRisks = [...fund.risks, ...news.risks];
  const extraNumbers = [...fund.numbers, ...news.numbers, ...own.flatMap((o) => o.numbers)];
  const richer = fund.observations.length > 0 || news.observations.length > 0;
  limitations.push(
    news.observations.length > 0
      ? 'Berita dihitung sebagai kejadian berjangkar sumber; isi berita tidak dibaca model dan tidak ada analisis sentimen.'
      : 'Berita dan data sentimen tidak tersedia; analisis hanya berdasarkan harga dan volume.',
  );
  const baseRisks = buildRiskStatements(report);
  const derivedRisks = baseRisks.filter((x) => !FIXED_RISKS.includes(x));
  const fixedRisks = baseRisks
    .filter((x) => FIXED_RISKS.includes(x))
    .map((x) => (x === NO_NEWS_RISK && richer ? SOURCES_RISK : x));

  return {
    symbol: report.symbol,
    companyName: cleanCompanyName(quote.name),
    currency: quote.currency,
    facts,
    claims: {
      observations: observationClaims([...facts, ...extraObservations]),
      risks: riskClaims([...derivedRisks, ...extraRisks, ...fixedRisks]),
    },
    dataFreshness: { state: report.freshness.state, reason: report.freshness.reason },
    quote: {
      price,
      change: r(quote.change),
      changePercent: r(quote.changePercent),
      open: quote.open,
      high: quote.high,
      low: quote.low,
      previousClose: quote.previousClose,
      volume: quote.volume,
      averageVolume: quote.averageVolume,
      fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
      timestamp: quote.timestamp,
      marketState: quote.marketState,
    },
    technical: {
      trend: c.trend,
      momentum: c.momentum,
      rsi14: r(s.rsi14),
      rsiZone: c.rsiZone,
      macd: {
        value: r(s.macd),
        signal: r(s.macdSignal),
        histogram: r(s.macdHistogram),
        state: c.macdState,
      },
      ma: {
        ma5: r(s.sma5),
        ma20: r(s.sma20),
        ma50: r(s.sma50),
        ma100: r(s.sma100),
        ma200: r(s.sma200),
      },
      atr14: r(s.atr14),
      volumeRatioVs20DayAvg: r(s.volumeRatio),
      priceVsMa20Percent: s.sma20 ? round(((price - s.sma20) / s.sma20) * 100, 2) : null,
      priceVsMa50Percent: s.sma50 ? round(((price - s.sma50) / s.sma50) * 100, 2) : null,
    },
    priceStats: {
      changePercent5d: periodChange(report, 5),
      changePercent20d: periodChange(report, 20),
      changePercent60d: periodChange(report, 60),
      distanceFrom52wHighPercent: quote.fiftyTwoWeekHigh
        ? round(((price - quote.fiftyTwoWeekHigh) / quote.fiftyTwoWeekHigh) * 100, 2)
        : null,
    },
    support: technical.support.map((l) => ({ price: l.price, strength: l.strength })),
    resistance: technical.resistance.map((l) => ({ price: l.price, strength: l.strength })),
    foreignFlow: unwrap(extras.foreignFlow),
    brokerSummary: unwrap(extras.brokerSummary),
    fundamental: unwrap(extras.fundamentals),
    // numbers quoted by the extra claims, so the output policy can ground them
    extraNumbers,
    holding: extras.holding ?? null,
    knownDataLimitations: limitations,
    dataTimestamp: quote.timestamp,
  };
}

export type AnalysisContext = ReturnType<typeof buildAnalysisContext>;

/** Smaller per-symbol context used in comparisons. */
export function buildComparisonEntry(report: FullTechnicalReport) {
  const full = buildAnalysisContext(report);
  return {
    symbol: full.symbol,
    companyName: full.companyName,
    price: full.quote.price,
    changePercent: full.quote.changePercent,
    trend: full.technical.trend,
    momentum: full.technical.momentum,
    rsi14: full.technical.rsi14,
    macdState: full.technical.macd.state,
    ma20: full.technical.ma.ma20,
    ma50: full.technical.ma.ma50,
    volumeRatio: full.technical.volumeRatioVs20DayAvg,
    changePercent20d: full.priceStats.changePercent20d,
    nearestSupport: full.support[0]?.price ?? null,
    nearestResistance: full.resistance[0]?.price ?? null,
  };
}
