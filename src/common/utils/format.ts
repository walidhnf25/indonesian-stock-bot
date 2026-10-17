const TZ = 'Asia/Jakarta';

const nf0 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });

function nf(decimals: number): Intl.NumberFormat {
  return new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatNumber(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return (decimals === 0 ? nf0 : nf(decimals)).format(value);
}

export function formatRupiah(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const hasFraction = Math.abs(value - Math.round(value)) > 1e-9;
  return `Rp${formatNumber(value, hasFraction ? 2 : 0)}`;
}

export function formatPercent(
  value: number | null | undefined,
  decimals = 2,
  signed = true,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${nf(decimals).format(value)}%`;
}

export function formatSigned(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatNumber(value, decimals)}`;
}

/** Compact Indonesian big-number format: 1,2 T / 340 M / 12 jt. */
export function formatCompactId(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${formatNumber(value / 1e12, 2)} T`;
  if (abs >= 1e9) return `${formatNumber(value / 1e9, 2)} M`;
  if (abs >= 1e6) return `${formatNumber(value / 1e6, 2)} jt`;
  if (abs >= 1e3) return `${formatNumber(value / 1e3, 1)} rb`;
  return formatNumber(value, 0);
}

export function formatRatio(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return `${formatNumber(value, 2)}x`;
}

/** "1 Oktober 2026, 15:59 WIB" */
export function formatWib(date: Date | string | number): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '-';
  const datePart = new Intl.DateTimeFormat('id-ID', {
    timeZone: TZ,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);
  const timePart = new Intl.DateTimeFormat('id-ID', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(d)
    .replace('.', ':');
  return `${datePart}, ${timePart} WIB`;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Rounds half AWAY from zero, like `toFixed` does for the text we print. `Math.round` alone sends
 * -9.125 to -9.12 while the printed fact says "9,13%", which made the output policy reject the
 * application's own sentence on exact negative ties.
 */
export function round(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  const r = (Math.sign(value) * Math.round(Math.abs(value) * f)) / f;
  return r === 0 ? 0 : r; // never -0
}

/** Wall-clock components in Asia/Jakarta. */
export function jakartaParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=Sun..6=Sat
  isoDate: string;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  return {
    year,
    month,
    day,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: weekdays.indexOf(get('weekday')),
    isoDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}
