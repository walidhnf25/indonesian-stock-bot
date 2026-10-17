import { jakartaParts } from '../../common/utils/format';
import { TemporalRef } from '../intent.types';

const MONTHS: Array<[string, number]> = [
  ['january', 1],
  ['february', 2],
  ['march', 3],
  ['may', 5],
  ['june', 6],
  ['july', 7],
  ['august', 8],
  ['october', 10],
  ['december', 12],
  ['januari', 1],
  ['februari', 2],
  ['maret', 3],
  ['april', 4],
  ['mei', 5],
  ['juni', 6],
  ['juli', 7],
  ['agustus', 8],
  ['september', 9],
  ['oktober', 10],
  ['november', 11],
  ['desember', 12],
  ['jan', 1],
  ['feb', 2],
  ['mar', 3],
  ['apr', 4],
  ['jun', 6],
  ['jul', 7],
  ['agu', 8],
  ['agt', 8],
  ['aug', 8],
  ['sep', 9],
  ['sept', 9],
  ['okt', 10],
  ['oct', 10],
  ['nov', 11],
  ['des', 12],
  ['dec', 12],
];
const MONTH_ALT = MONTHS.map(([n]) => n).join('|');
const MONTH_BY_NAME = new Map(MONTHS);
const MONTH_NAMES_ID = [
  '',
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
];
const FULL_MONTHS =
  'januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember';

const pad = (n: number) => String(n).padStart(2, '0');
const toIso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isRealDate(y: number, m: number, d: number): boolean {
  return y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** "2026-10-02" -> "2 Oktober 2026" */
export function formatIsoDateId(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTH_NAMES_ID[m]} ${y}`;
}

export function shiftDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return toIso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Calendar month shift that clamps the day (31 Mar - 1 month = 28/29 Feb). */
export function shiftMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return toIso(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/* ----------------------------------------------------------------------------- vocabulary */

const NUMBER_WORDS: Record<string, number> = {
  satu: 1,
  dua: 2,
  tiga: 3,
  empat: 4,
  lima: 5,
  enam: 6,
  tujuh: 7,
  delapan: 8,
  sembilan: 9,
  sepuluh: 10,
  sebelas: 11,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const NUM = `(\\d{1,6}|${Object.keys(NUMBER_WORDS).join('|')})`;
const toNumber = (s: string): number => (/^\d+$/.test(s) ? Number(s) : (NUMBER_WORDS[s] ?? NaN));

const FUTURE_RE =
  /\b(besok|esok(?:\s+hari)?|lusa|(?:minggu|pekan|bulan|tahun)\s+depan|(?:senin|selasa|rabu|kamis|jum'?at|sabtu|ahad)\s+depan|ke\s+depan|nanti|tomorrow|next\s+(?:week|month|year)|in\s+the\s+future)\b/;
const ISO_RE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/;
const NUMERIC_DATE_RE = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/;
/** The month must be a full name or an exact abbreviation: "5 marketing" or "3 desimal" are not dates. */
const TEXT_DATE_RE = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_ALT})\\.?(?![a-z])(?:\\s+(\\d{4}))?\\b`);
/** "tanggal 1" / "tgl 15": a day of the month without a month. */
const DAY_ONLY_RE = /\b(?:tanggal|tgl)\s+(?:ke-?)?(\d{1,2})\b(?!\s*[/-]\s*\d)/;
/** "tanggal 15 bulan lalu" / "tgl 3 bulan ini": the month is given relatively. */
const DAY_OF_RELATIVE_MONTH_RE = new RegExp(
  '\\b(?:tanggal|tgl)\\s+(?:ke-?)?(\\d{1,2})\\s+bulan\\s+(lalu|kemarin|ini)\\b',
);
/** Words after which a 4-digit number is a price or level, not a year ("tembus 2000", "di atas 2100"). */
const PRICE_CONTEXT_RE =
  /(?:(?:^|[^a-z])(?:harga|tembus|tembak|menembus|di\s*atas|diatas|di\s*bawah|dibawah|above|below|target|capai|mencapai|sampai|hingga|ke|jadi|menjadi|level|support|resist(?:ance)?|rp|idr)|[@=<>])\s*$/;

const DAY_BEFORE_YESTERDAY_RE =
  /\b(?:kemarin\s+lusa|lusa\s+kemarin|the\s+day\s+before\s+yesterday)\b/;
const YESTERDAY_RE = /\b(?:kemarin|kmrn|kemaren|semalam|yesterday)\b/;
const LAST_PERIOD_KEMARIN_RE = /\b(minggu|pekan|bulan|tahun)\s+kemarin\b/;
/** "3 hari lalu", "dua minggu yang lalu", "sehari lalu" (group 1 = number/word, group 2 = "se" form, 3 = unit). */
const N_AGO_ID_RE = new RegExp(
  `\\b(?:${NUM}\\s*|(se))(hari|minggu|pekan|bulan|tahun)\\s*(?:yang\\s+|yg\\s+)?(?:lalu|kemarin|sebelumnya)\\b`,
);
const N_AGO_EN_RE = new RegExp(`\\b${NUM}\\s+(day|week|month|year)s?\\s+ago\\b`);
const LAST_EN_RE = /\blast\s+(week|month|year)\b/;
const WEEK_AGO_RE = /\b(?:minggu|pekan)\s+(?:yang\s+)?lalu\b/;
const MONTH_AGO_RE = /\bbulan\s+(?:yang\s+)?lalu\b/;
const YEAR_AGO_RE = /\btahun\s+(?:yang\s+)?lalu\b/;

const WEEKDAYS: Record<string, number> = {
  senin: 1,
  selasa: 2,
  rabu: 3,
  kamis: 4,
  jumat: 5,
  "jum'at": 5,
  sabtu: 6,
  ahad: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 0,
};
const QUALIFIER = `(?:\\s+(?:yang\\s+)?(?:lalu|kemarin|sebelumnya)|\\s+last)`;
const WEEKDAY_RE = new RegExp(
  `\\b(?:hari\\s+)?(senin|selasa|rabu|kamis|jum'?at|sabtu|ahad|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b(${QUALIFIER})?`,
);
/** "minggu" alone is a WEEK ("minggu lalu"); it is the weekday Sunday only after "hari". */
const SUNDAY_RE = new RegExp(`\\bhari\\s+minggu\\b(${QUALIFIER})?`);

const LAST_SESSION_RE =
  /\b(?:hari\s+(?:bursa|perdagangan)\s+terakhir|sesi\s+(?:bursa\s+|perdagangan\s+)?terakhir|penutupan\s+terakhir|last\s+trading\s+(?:day|session)|last\s+close)\b/;
const PREVIOUS_SESSION_RE =
  /\b(?:hari\s+(?:bursa|perdagangan)\s+sebelumnya|sesi\s+(?:bursa\s+|perdagangan\s+)?sebelumnya|previous\s+trading\s+(?:day|session)|prior\s+trading\s+day)\b/;

/** Intraday wording: only daily closes are available, never a time of day. */
const INTRADAY_RE = new RegExp(
  `\\b(?:tadi\\s+(?:pagi|siang|sore|malam)|(?:pas|saat|waktu|ketika)\\s+(?:buka|pembukaan|pembuka|opening)|pas\\s+tutup|saat\\s+penutupan|${NUM}\\s*(?:jam|menit|detik)\\s+(?:yang\\s+)?(?:lalu|kemarin|sebelumnya)|jam\\s+\\d{1,2}(?:[:.]\\d{2})?|pukul\\s+\\d{1,2}(?:[:.]\\d{2})?|intraday|${NUM}\\s+(?:hours?|minutes?)\\s+ago|this\\s+morning)\\b`,
);
/** A period (year, month, quarter...) instead of one day: the bot answers for single dates only. */
const PERIOD_RE = new RegExp(
  `\\b(?:tahun\\s+(?:19|20)\\d{2}|(?:di|pada|sepanjang|selama|sejak|in)\\s+(?:tahun\\s+)?(?:19|20)\\d{2}|(?:${FULL_MONTHS})\\s+(?:19|20)\\d{2}|bulan\\s+(?:${FULL_MONTHS})|(?:kuartal|triwulan|quarter)(?:\\s*\\d)?|q[1-4]|(?:awal|akhir|pertengahan)\\s+(?:bulan|tahun|minggu|pekan)|semester(?:\\s*\\d)?|waktu\\s+ipo|saat\\s+covid|(?:${FULL_MONTHS})|waktu\\s+itu|(?:zaman|jaman)\\s+dulu|sebelum\\s+(?:pandemi|covid|krisis)|(?:pas|saat|waktu)\\s+(?:lebaran|natal|tahun\\s+baru|pemilu|krisis|pandemi))\\b`,
);
/** "2/10" or "2-10": day and month without a year (ambiguous: which year, and day-first or month-first). */
const PARTIAL_DATE_RE = /(?<![\d/.,-])(\d{1,2})[/-](\d{1,2})(?![\d/.,-])/;
/** A lone year such as "BBCA 2025" (not part of a number, a price or a time). */
const BARE_YEAR_RE = /(?<![\d.,/:-])(?<!rp\s{0,2})(?:19|20)\d{2}(?![\d.,/:%-])/;

/**
 * Time-like fragments that are NOT a complete date, found only when no full reference was recognised:
 * "2/10" (no year) or a lone year. Callers use it for quote-like questions, where silently answering
 * with today's price would be wrong.
 */
export function incompleteTimeReference(text: string): TemporalRef | null {
  const t = text.toLowerCase();
  const partial = PARTIAL_DATE_RE.exec(t);
  if (partial && Number(partial[1]) >= 1 && Number(partial[1]) <= 31 && Number(partial[2]) <= 12) {
    return { kind: 'unsupported', reason: 'incomplete', label: partial[0] };
  }
  const dayOnly = DAY_ONLY_RE.exec(t);
  if (dayOnly) return { kind: 'unsupported', reason: 'incomplete', label: dayOnly[0] };
  // every candidate is checked: in "tembus 2000 2025?" the first number is a price, the second a year
  for (const year of t.matchAll(new RegExp(BARE_YEAR_RE.source, 'g'))) {
    if (!PRICE_CONTEXT_RE.test(t.slice(0, year.index))) {
      return { kind: 'unsupported', reason: 'period', label: year[0] };
    }
  }
  return null;
}

/**
 * Extracts a time reference from a chat message, relative to `now` (Asia/Jakarta calendar).
 * Returns null ONLY when the message is about "now" (no temporal expression), so callers keep
 * today's behaviour. Every other time reference is resolved to a date or a trading session, or
 * returned as `unsupported`/`future`/`invalid`: it is NEVER silently treated as "now".
 */
export function parseTemporal(text: string, now: Date = new Date()): TemporalRef | null {
  const t = text.toLowerCase();
  const today = jakartaParts(now).isoDate;
  const todayYear = Number(today.slice(0, 4));
  const dated = (date: string, label: string, relative: boolean): TemporalRef =>
    date > today
      ? { kind: 'future', label: `${label} (${formatIsoDateId(date)})` }
      : { kind: 'date', date, label: `${label} (${formatIsoDateId(date)})`, relative };
  const ago = (n: number, unit: string): TemporalRef | null => {
    if (!Number.isFinite(n) || n <= 0) return null;
    const wording = unit === 'pekan' ? 'minggu' : unit;
    const label = `${n} ${wording} lalu`;
    const date =
      unit === 'hari'
        ? shiftDays(today, -n)
        : unit === 'minggu' || unit === 'pekan'
          ? shiftDays(today, -7 * n)
          : unit === 'bulan'
            ? shiftMonths(today, -n)
            : shiftMonths(today, -12 * n);
    // "9999 tahun lalu" is not a date the bot can look up: say so instead of printing a broken label
    const [y, mo, d] = date.split('-').map(Number);
    if (!isRealDate(y, mo, d)) return { kind: 'invalid', label };
    return dated(date, label, true);
  };

  // 0) a time of day wins over any date next to it: daily closes cannot answer "jam 10:00" even on a
  //    named day, and dropping the time would answer a different question than the one asked
  let m = t.match(INTRADAY_RE);
  if (m) return { kind: 'unsupported', reason: 'intraday', label: m[0].trim() };

  // 1) explicit dates
  m = t.match(ISO_RE);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isRealDate(y, mo, d)
      ? dated(toIso(y, mo, d), 'Tanggal', false)
      : { kind: 'invalid', label: m[0] };
  }
  m = t.match(NUMERIC_DATE_RE);
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]; // day-first (Indonesia)
    return isRealDate(y, mo, d)
      ? dated(toIso(y, mo, d), 'Tanggal', false)
      : { kind: 'invalid', label: m[0] };
  }
  m = t.match(TEXT_DATE_RE);
  if (m) {
    const d = Number(m[1]);
    const mo = MONTH_BY_NAME.get(m[2]) as number;
    if (m[3]) {
      const y = Number(m[3]);
      return isRealDate(y, mo, d)
        ? dated(toIso(y, mo, d), 'Tanggal', false)
        : { kind: 'invalid', label: m[0].trim() };
    }
    // Without a year the most recent PAST occurrence is meant ("31 desember" said on 1 January is
    // yesterday). A date in the next few days is the FUTURE, not last year ("5 oktober" on 4 October), and
    // 29 February resolves to the last real leap day. The resolved date is always printed in the label.
    const thisYear = isRealDate(todayYear, mo, d) ? toIso(todayYear, mo, d) : null;
    if (thisYear !== null && thisYear > today && thisYear <= shiftDays(today, 7)) {
      return dated(thisYear, 'Tanggal', false);
    }
    for (let y = todayYear; y >= todayYear - 8; y--) {
      if (isRealDate(y, mo, d) && toIso(y, mo, d) <= today) {
        return dated(toIso(y, mo, d), 'Tanggal', false);
      }
    }
    return { kind: 'invalid', label: m[0].trim() };
  }
  m = t.match(DAY_OF_RELATIVE_MONTH_RE);
  if (m) {
    const day = Number(m[1]);
    const base = m[2] === 'ini' ? today : shiftMonths(today, -1);
    const [by, bm] = base.split('-').map(Number);
    return isRealDate(by, bm, day)
      ? dated(toIso(by, bm, day), 'Tanggal', false)
      : { kind: 'invalid', label: m[0] };
  }
  // "tanggal 1" without a month is incomplete: never answer with today's price instead
  m = t.match(DAY_ONLY_RE);
  if (m && !t.match(TEXT_DATE_RE))
    return { kind: 'unsupported', reason: 'incomplete', label: m[0] };

  // 2) wording that cannot be answered with a daily close: say so instead of showing a price
  m = t.match(INTRADAY_RE);
  if (m) return { kind: 'unsupported', reason: 'intraday', label: m[0].trim() };
  m = t.match(PERIOD_RE);
  if (m) return { kind: 'unsupported', reason: 'period', label: m[0].trim() };

  // 3) trading-session references (resolved against the real candles by the handler)
  if (PREVIOUS_SESSION_RE.test(t)) {
    return { kind: 'session', offset: -1, label: 'Sesi bursa sebelumnya' };
  }
  if (LAST_SESSION_RE.test(t)) return { kind: 'session', offset: 0, label: 'Sesi bursa terakhir' };

  // 4) "kemarin lusa" (the day before yesterday) contains "lusa" (day after tomorrow): check it first.
  if (DAY_BEFORE_YESTERDAY_RE.test(t)) return dated(shiftDays(today, -2), 'Kemarin lusa', false);

  // 5) future wording
  const future = t.match(FUTURE_RE);
  if (future) return { kind: 'future', label: future[0] };

  // 6) "minggu/bulan/tahun kemarin" = last week/month/year (must precede the bare word "kemarin")
  m = t.match(LAST_PERIOD_KEMARIN_RE);
  if (m) return ago(1, m[1]);

  // 7) weekday names: "Jumat lalu" = the previous Friday; "Sabtu" = the most recent Saturday
  //    (today included, so a Saturday request on a Saturday is the non-trading day itself)
  const sunday = t.match(SUNDAY_RE);
  const weekday = sunday ? null : t.match(WEEKDAY_RE);
  if (sunday || weekday) {
    const target = sunday ? 0 : (WEEKDAYS[weekday![1]] as number);
    const qualifier = sunday ? sunday[1] : weekday![2];
    const todayDow = new Date(`${today}T00:00:00Z`).getUTCDay();
    let back = (todayDow - target + 7) % 7;
    if (qualifier && back === 0) back = 7; // "Jumat lalu" said on a Friday = last week's Friday
    const name = sunday ? 'Minggu' : weekday![1].charAt(0).toUpperCase() + weekday![1].slice(1);
    return dated(shiftDays(today, -back), qualifier ? `${name} lalu` : name, false);
  }

  // 8) relative past
  if (YESTERDAY_RE.test(t)) return dated(shiftDays(today, -1), 'Kemarin', false);
  m = t.match(N_AGO_ID_RE);
  if (m) return ago(m[1] !== undefined ? toNumber(m[1]) : 1, m[3]);
  m = t.match(N_AGO_EN_RE);
  if (m) {
    const unit = { day: 'hari', week: 'minggu', month: 'bulan', year: 'tahun' }[m[2]] as string;
    return ago(toNumber(m[1]), unit);
  }
  m = t.match(LAST_EN_RE);
  if (m) return ago(1, { week: 'minggu', month: 'bulan', year: 'tahun' }[m[1]] as string);
  if (WEEK_AGO_RE.test(t)) return dated(shiftDays(today, -7), '1 minggu lalu', true);
  if (MONTH_AGO_RE.test(t)) return dated(shiftMonths(today, -1), '1 bulan lalu', true);
  if (YEAR_AGO_RE.test(t)) return dated(shiftMonths(today, -12), '1 tahun lalu', true);

  return null;
}
