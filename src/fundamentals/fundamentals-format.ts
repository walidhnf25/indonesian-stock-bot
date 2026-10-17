import {
  escapeHtml as h,
  formatCompactId,
  formatNumber,
  formatPercent,
  formatRupiah,
  formatWib,
} from '../common/utils/format';
import {
  FundamentalField,
  FundamentalMetric,
  FundamentalsReport,
  METRIC_GROUPS,
  METRIC_LABEL,
  METRIC_UNIT,
  MetricStatus,
} from './fundamentals.types';

const STATUS_MARK: Record<MetricStatus, string> = {
  reported: '',
  estimated: ' (estimasi)',
  derived: ' (turunan)',
  stale: ' (basi)',
  missing: '',
};

export const PROVENANCE_LEGEND =
  'estimasi = perkiraan analis dari provider; turunan = dihitung Indonesian Stock Bot dari angka lain yang dilaporkan; basi = dari snapshot lama karena provider tidak tersedia.';

/** Closing sentence of every card: descriptive, never a forecast. */
export const FUNDAMENTALS_NOTE =
  'Angka fundamental menggambarkan laporan masa lalu dan harga saat ini, bukan kepastian kinerja berikutnya.';

export function formatMetricValue(metric: FundamentalMetric, value: number): string {
  switch (METRIC_UNIT[metric]) {
    case 'rupiah':
      return `Rp${formatCompactId(value)}`;
    case 'multiple':
      return `${formatNumber(value, 2)}x`;
    case 'percent':
      return formatPercent(value, 2, false);
    case 'rupiahPerShare':
      return formatRupiah(value);
  }
}

function line(metric: FundamentalMetric, f: FundamentalField): string | null {
  if (f.value === null || f.status === 'missing') return null;
  return `${METRIC_LABEL[metric]}: ${formatMetricValue(metric, f.value)}${STATUS_MARK[f.status]}`;
}

/** The fundamentals card: grouped metrics, each with its provenance, and an explicit list of what is missing. */
export function formatFundamentalsReport(r: FundamentalsReport): string {
  const title = `🏦 <b>Fundamental ${h(r.symbol)}</b>${r.name ? ` — ${h(r.name)}` : ''}`;
  const out: string[] = [title, ''];
  if (r.fromSnapshot) {
    out.push(
      r.stale
        ? `⚠️ Provider fundamental tidak tersedia; angka di bawah dari snapshot ${formatWib(r.asOf)} (${r.ageDays} hari, basi).`
        : `ℹ️ Provider fundamental tidak tersedia; angka di bawah dari snapshot ${formatWib(r.asOf)} (${r.ageDays} hari).`,
      '',
    );
  }
  let shown = 0;
  for (const group of METRIC_GROUPS) {
    const lines = group.metrics
      .map((m) => line(m, r.fields[m]))
      .filter((l): l is string => l !== null);
    if (lines.length === 0) continue;
    shown += lines.length;
    out.push(`<b>${group.title}</b>`, ...lines.map((l) => `• ${h(l)}`), '');
  }
  if (shown === 0) out.push('Tidak ada metrik fundamental yang tersedia dari provider.', '');
  if (r.missing.length > 0) {
    out.push(
      `Tidak tersedia: ${h(r.missing.map((m) => METRIC_LABEL[m].toLowerCase()).join(', '))}.`,
    );
  }
  const marks = new Set(
    Object.values(r.fields)
      .map((f) => f.status)
      .filter((s) => s === 'estimated' || s === 'derived' || s === 'stale'),
  );
  if (marks.size > 0) out.push(`<i>${h(PROVENANCE_LEGEND)}</i>`);
  out.push(FUNDAMENTALS_NOTE, `Sumber: ${h(r.source)} · Data: ${formatWib(r.asOf)}`);
  return out.join('\n');
}

/** Side-by-side fundamentals for two to five stocks; a missing value shows as "–", never as a number. */
export function formatFundamentalsComparison(reports: FundamentalsReport[]): string {
  const head = `🏦 <b>Perbandingan fundamental</b>: ${reports.map((r) => h(r.symbol)).join(' vs ')}`;
  const out: string[] = [head, ''];
  const stale = reports.filter((r) => r.fromSnapshot);
  if (stale.length > 0) {
    out.push(
      `ℹ️ Dari snapshot (provider tidak tersedia): ${stale
        .map((r) => `${h(r.symbol)} ${formatWib(r.asOf)}${r.stale ? ' (basi)' : ''}`)
        .join(', ')}`,
      '',
    );
  }
  let anyMark = false;
  for (const group of METRIC_GROUPS) {
    const rows: string[] = [];
    for (const m of group.metrics) {
      const cells = reports.map((r) => {
        const f = r.fields[m];
        if (f.value === null || f.status === 'missing') return '–';
        if (f.status !== 'reported') anyMark = true;
        return `${formatMetricValue(m, f.value)}${STATUS_MARK[f.status]}`;
      });
      if (cells.every((c) => c === '–')) continue;
      rows.push(
        `• ${h(METRIC_LABEL[m])}: ${cells.map((c, i) => `${h(reports[i].symbol)} ${h(c)}`).join(' | ')}`,
      );
    }
    if (rows.length > 0) out.push(`<b>${group.title}</b>`, ...rows, '');
  }
  if (out.length === 2)
    out.push('Tidak ada metrik fundamental yang tersedia untuk saham-saham ini.', '');
  if (anyMark) out.push(`<i>${h(PROVENANCE_LEGEND)}</i>`);
  out.push(
    'Perbandingan ini hanya menyandingkan angka yang dilaporkan; sektor dan periode laporan bisa berbeda.',
  );
  return out.join('\n');
}
