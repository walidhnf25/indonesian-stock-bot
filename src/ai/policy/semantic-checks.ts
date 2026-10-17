import { extractNumberTokens, isGrounded, stripNonClaims } from './numeric-grounding';

/**
 * Data-bound semantic checks. Wording alone cannot make a statement true or false, so these
 * compare what the text SAYS about an indicator with what the application COMPUTED:
 *  - RSI zone words vs the RSI value,
 *  - "di atas/di bawah MAxx" vs price and that MA,
 *  - MACD "bullish/bearish" vs the histogram sign,
 *  - "volume tinggi/rendah" vs the volume ratio,
 *  - support/resistance numbers used in the wrong role,
 *  - daily change direction vs the real change,
 * plus number ROLES: a price must be a price from the data, a percentage a percentage, a ratio a ratio,
 * and the number next to "RSI" must be the RSI. (A number that exists in the data but in another role,
 * e.g. the RSI quoted as a price, is still a fabrication.)
 */

export interface DataFacts {
  price: number | null;
  rsi: number | null;
  macdHistogram: number | null;
  ma: Record<'20' | '50' | '100' | '200', number | null>;
  volumeRatio: number | null;
  supports: number[];
  resistances: number[];
  changePercent: number | null;
  /** MACD line and signal line (for "MACD di atas/di bawah garis signal"). */
  macd?: number | null;
  macdSignal?: number | null;
  /** 52-week extremes (for "level tertinggi/terendah 52 minggu"). */
  high52?: number | null;
  low52?: number | null;
}

export interface NumberRoles {
  price: number[];
  /** The current price only (what "harga saat ini/terakhir/sekarang" must equal). */
  current: number[];
  percent: number[];
  ratio: number[];
  rsi: number[];
}

export interface SemanticViolation {
  category: 'contradiction' | 'role_mismatch';
  excerpt: string;
  detail: string;
}

/** Volume wording thresholds (ratio of today's volume to the 20-day average). */
export const VOLUME_HIGH_RATIO = 1.5;
export const VOLUME_LOW_RATIO = 0.8;

const NEG = new Set(['tidak', 'tak', 'belum', 'bukan', 'tanpa', 'kurang', 'no', 'not', 'never']);
const NEAR = new Set(['mendekati', 'menuju', 'hampir', 'dekat', 'near', 'approaching', 'nyaris']);

const snippet = (s: string, i: number, len = 70) =>
  s.slice(Math.max(0, i - 12), Math.min(s.length, i + len)).trim();

/** A negator or "approaching" word right before the match (same clause). */
function qualifiedBefore(sentence: string, index: number, words: Set<string>, window = 3): boolean {
  const clause = sentence.slice(0, index).split(/[,;:]/).pop() ?? '';
  return clause
    .trim()
    .split(/\s+/)
    .slice(-window)
    .some((w) => words.has(w.replace(/[^a-z]/g, '')));
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const sameNumber = (a: number, b: number) =>
  Math.abs(a - b) < 1e-9 || [0, 1, 2].some((d) => Math.abs(round(b, d) - a) < 1e-9);

const OVERBOUGHT = /\b(overbought|jenuh\s+beli)\b/;
const OVERSOLD = /\b(oversold|jenuh\s+jual)\b/;
const THRESHOLD_PHRASE =
  /(?:di\s*atas|di\s*bawah|diatas|dibawah|lebih\s+dari|kurang\s+dari|above|below|over|under|[<>]=?|mencapai|menembus|melewati)\s*(?:level\s*)?(?:30|70)\b/;

/** The RSI is shown with one decimal: 69.996 prints as "70,0", so the zone words get this much slack. */
const RSI_EPS = 0.05;

function checkRsi(s: string, f: DataFacts): SemanticViolation[] {
  if (f.rsi === null || !/\brsi\b/.test(s) || THRESHOLD_PHRASE.test(s)) return [];
  const out: SemanticViolation[] = [];
  // "RSI belum berada di area jenuh beli MAUPUN jenuh jual": one negator covers the whole clause
  const negated = (index: number) => qualifiedBefore(s, index, NEG, 8);
  const ob = OVERBOUGHT.exec(s);
  if (ob && f.rsi < 70 - RSI_EPS && !negated(ob.index) && !qualifiedBefore(s, ob.index, NEAR)) {
    out.push({
      category: 'contradiction',
      excerpt: snippet(s, ob.index),
      detail: `RSI ${f.rsi.toFixed(1)} is not overbought`,
    });
  }
  const os = OVERSOLD.exec(s);
  if (os && f.rsi > 30 + RSI_EPS && !negated(os.index) && !qualifiedBefore(s, os.index, NEAR)) {
    out.push({
      category: 'contradiction',
      excerpt: snippet(s, os.index),
      detail: `RSI ${f.rsi.toFixed(1)} is not oversold`,
    });
  }
  const neutral = /\bnetral\b/.exec(s);
  if (
    neutral &&
    (f.rsi >= 70 + RSI_EPS || f.rsi <= 30 - RSI_EPS) &&
    !qualifiedBefore(s, neutral.index, NEG)
  ) {
    out.push({
      category: 'contradiction',
      excerpt: snippet(s, neutral.index),
      detail: `RSI ${f.rsi.toFixed(1)} is not neutral`,
    });
  }
  return out;
}

const MA_POSITION = /(di\s*atas|di\s*bawah|diatas|dibawah|above|below)\s+((?:[^.;!?]){0,60})/g;
function checkMovingAverages(s: string, f: DataFacts): SemanticViolation[] {
  if (f.price === null || !/\b(harga|saham|price)\b/.test(s)) return [];
  const out: SemanticViolation[] = [];
  for (const m of s.matchAll(MA_POSITION)) {
    const above = /atas|above/.test(m[1]);
    // MA references after the position word, up to the next position word ("di atas MA20 dan MA50").
    const tail = m[2].split(/di\s*atas|di\s*bawah|diatas|dibawah|above|below/)[0];
    const refs = [...tail.matchAll(/\b(?:ma|sma|ema)\s?-?(20|50|100|200)\b/g)].map(
      (x) => x[1] as '20' | '50' | '100' | '200',
    );
    for (const n of refs) {
      const ma = f.ma[n];
      if (ma === null || ma === undefined) continue;
      if ((above && f.price < ma) || (!above && f.price > ma)) {
        out.push({
          category: 'contradiction',
          excerpt: snippet(s, m.index ?? 0),
          detail: `price is ${f.price < ma ? 'below' : 'above'} MA${n}, text says ${above ? 'above' : 'below'}`,
        });
      }
    }
    if (/\bsemua\b/.test(tail) && /\b(ma|rata-rata)\b/.test(tail)) {
      const vals = Object.values(f.ma).filter((v): v is number => v !== null);
      if (
        vals.length &&
        ((above && vals.some((v) => f.price! < v)) || (!above && vals.some((v) => f.price! > v)))
      ) {
        out.push({
          category: 'contradiction',
          excerpt: snippet(s, m.index ?? 0),
          detail: 'price vs "all" moving averages',
        });
      }
    }
  }
  return out;
}

function checkMacd(s: string, f: DataFacts): SemanticViolation[] {
  if (f.macdHistogram === null || !/\b(macd|histogram)\b/.test(s)) return [];
  const bull = /\b(bullish|positif|golden\s+cross|menguat)\b/.exec(s);
  const bear = /\b(bearish|negatif|death\s+cross|melemah)\b/.exec(s);
  const out: SemanticViolation[] = [];
  if (bull && !bear && f.macdHistogram < 0 && !qualifiedBefore(s, bull.index, NEG)) {
    out.push({
      category: 'contradiction',
      excerpt: snippet(s, bull.index),
      detail: 'MACD histogram is negative',
    });
  }
  if (bear && !bull && f.macdHistogram > 0 && !qualifiedBefore(s, bear.index, NEG)) {
    out.push({
      category: 'contradiction',
      excerpt: snippet(s, bear.index),
      detail: 'MACD histogram is positive',
    });
  }
  return out;
}

function checkVolume(s: string, f: DataFacts): SemanticViolation[] {
  if (f.volumeRatio === null || !/\bvolume\b/.test(s)) return [];
  const out: SemanticViolation[] = [];
  const high = /\b(tinggi|melonjak|lonjakan|membengkak|sangat\s+ramai|jauh\s+di\s+atas)\b/.exec(s);
  if (high && f.volumeRatio < VOLUME_HIGH_RATIO && !qualifiedBefore(s, high.index, NEG)) {
    out.push({
      category: 'contradiction',
      excerpt: snippet(s, high.index),
      detail: `volume ratio ${f.volumeRatio.toFixed(2)}x is not high`,
    });
  }
  const low = /\b(rendah|sepi|lesu|menyusut|jauh\s+di\s+bawah)\b/.exec(s);
  if (low && f.volumeRatio > VOLUME_LOW_RATIO && !qualifiedBefore(s, low.index, NEG)) {
    out.push({
      category: 'contradiction',
      excerpt: snippet(s, low.index),
      detail: `volume ratio ${f.volumeRatio.toFixed(2)}x is not low`,
    });
  }
  return out;
}

function checkSupportResistance(s: string, f: DataFacts): SemanticViolation[] {
  const out: SemanticViolation[] = [];
  const role = (word: RegExp, own: number[], other: number[], label: string) => {
    for (const m of s.matchAll(word)) {
      const tail = s.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 30);
      const tok = extractNumberTokens(stripNonClaims(tail))[0];
      if (!tok || tok.index > 18) continue;
      const v = tok.values.find((x) => x > 0);
      if (v === undefined) continue;
      if (!own.some((x) => sameNumber(v, x)) && other.some((x) => sameNumber(v, x))) {
        out.push({
          category: 'contradiction',
          excerpt: snippet(s, m.index ?? 0),
          detail: `${v} is a ${label === 'support' ? 'resistance' : 'support'} level, not ${label}`,
        });
      }
    }
  };
  role(
    /\b(?:support|suport)(?:\s+(?:terdekat|kuat|lemah|utama))?\b/g,
    f.supports,
    f.resistances,
    'support',
  );
  role(
    /\b(?:resistance|resisten)(?:\s+(?:terdekat|kuat|lemah|utama))?\b/g,
    f.resistances,
    f.supports,
    'resistance',
  );
  return out;
}

function checkDailyChange(s: string, f: DataFacts): SemanticViolation[] {
  if (f.changePercent === null || Math.abs(f.changePercent) < 0.05) return [];
  if (!/\b(harian|hari ini|dari penutupan|sehari)\b/.test(s)) return [];
  const out: SemanticViolation[] = [];
  const signed = /([+-])\s?(\d+(?:[.,]\d+)?)\s?%/.exec(s);
  if (signed) {
    const claimed = Number(signed[2].replace(',', '.')) * (signed[1] === '-' ? -1 : 1);
    if (Math.sign(claimed) !== Math.sign(f.changePercent) && claimed !== 0) {
      out.push({
        category: 'contradiction',
        excerpt: snippet(s, signed.index),
        detail: 'sign of the daily change is wrong',
      });
    }
  }
  const up = /\b(kenaikan|menguat|naik)\b/.exec(s);
  const down = /\b(penurunan|melemah|turun)\b/.exec(s);
  if (
    up &&
    !down &&
    f.changePercent < 0 &&
    /\d\s?%/.test(s) &&
    !qualifiedBefore(s, up.index, NEG)
  ) {
    out.push({
      category: 'contradiction',
      excerpt: snippet(s, up.index),
      detail: 'text says up, data says down',
    });
  }
  if (
    down &&
    !up &&
    f.changePercent > 0 &&
    /\d\s?%/.test(s) &&
    !qualifiedBefore(s, down.index, NEG)
  ) {
    out.push({
      category: 'contradiction',
      excerpt: snippet(s, down.index),
      detail: 'text says down, data says up',
    });
  }
  return out;
}

/** "MACD (12,3) di atas garis signal": compared with the MACD and signal values. */
function checkMacdSignal(s: string, f: DataFacts): SemanticViolation[] {
  if (f.macd == null || f.macdSignal == null || !/\bmacd\b/.test(s)) return [];
  const m = /\b(di\s*atas|di\s*bawah|diatas|dibawah|above|below)\s+(?:garis\s+)?signal\b/.exec(s);
  if (!m || qualifiedBefore(s, m.index, NEG)) return [];
  const above = /atas|above/.test(m[1]);
  if ((above && f.macd < f.macdSignal) || (!above && f.macd > f.macdSignal)) {
    return [
      {
        category: 'contradiction',
        excerpt: snippet(s, m.index),
        detail: 'MACD is on the other side of its signal line',
      },
    ];
  }
  return [];
}

/** "menembus resistance" / "jatuh di bawah support": such a level must exist on the right side of the price. */
function checkLevelBreaks(s: string, f: DataFacts): SemanticViolation[] {
  if (f.price === null) return [];
  const out: SemanticViolation[] = [];
  const price = f.price;
  const up =
    /\b(?:menembus|tembus|breakout|jebol|menjebol|melewati)\s+(?:level\s+)?(?:resistance|resisten)\b/.exec(
      s,
    );
  if (up && !f.resistances.some((r) => r <= price) && !qualifiedBefore(s, up.index, NEG)) {
    out.push({
      category: 'contradiction',
      excerpt: snippet(s, up.index),
      detail: 'no resistance level below the current price in the data',
    });
  }
  const down =
    /\b(?:menembus|tembus|breakdown|jebol|menjebol)\s+(?:level\s+)?(?:support|suport)\b|\b(?:jatuh|turun|anjlok)\s+(?:ke\s+)?di\s*bawah\s+(?:level\s+)?(?:support|suport)\b/.exec(
      s,
    );
  if (down && !f.supports.some((x) => x >= price) && !qualifiedBefore(s, down.index, NEG)) {
    out.push({
      category: 'contradiction',
      excerpt: snippet(s, down.index),
      detail: 'no support level above the current price in the data',
    });
  }
  return out;
}

/** "level tertinggi 52 minggu": compared with the 52-week extremes. */
function check52Week(s: string, f: DataFacts): SemanticViolation[] {
  if (f.price === null) return [];
  if (!/\b(?:52|lima\s+puluh\s+dua)[- ]?(?:minggu|pekan|week|w)\b|\bsetahun\b/.test(s)) return [];
  const out: SemanticViolation[] = [];
  const high = /\b(?:tertinggi|high|puncak)\b/.test(s);
  const low = /\b(?:terendah|low|dasar)\b/.test(s);
  const reached = /\b(?:di\s*atas|diatas|menembus|mencapai|mencetak|memecahkan|rekor|new)\b/.test(
    s,
  );
  const near = /\b(?:mendekati|dekat|hampir|nyaris|menuju)\b/.test(s);
  const flag = (detail: string) =>
    out.push({ category: 'contradiction', excerpt: snippet(s, 0), detail });
  if (high && !low && f.high52 != null) {
    if (reached && !near && f.price < f.high52 * 0.995) flag('price is below the 52-week high');
    if (near && (f.high52 - f.price) / f.high52 > 0.05) flag('price is not near the 52-week high');
  }
  if (low && !high && f.low52 != null) {
    // "di atas level terendah" is true whenever the price is above the low; what is false is claiming to
    // be AT or BELOW it (di bawah / menembus / mencapai / rekor)
    const reachedLow =
      /\b(?:di\s*bawah|dibawah|menembus|mencapai|mencetak|memecahkan|rekor|new)\b/.test(s);
    if (reachedLow && !near && f.price > f.low52 * 1.005) flag('price is above the 52-week low');
    if (near && (f.price - f.low52) / f.low52 > 0.05) flag('price is not near the 52-week low');
  }
  return out;
}

/** Claims that need data the application never supplies (per-day streaks, year-to-date or all-time records). */
const UNVERIFIABLE =
  /\b(?:berturut[- ]?turut|beruntun|consecutive|(?:tertinggi|terendah)\s+(?:tahun\s+ini|sepanjang\s+(?:tahun|masa|sejarah))|(?:tertinggi|terendah)\s+sejak|year[- ]to[- ]date|all[- ]time|sepanjang\s+masa|rekor\s+(?:tertinggi|terendah|baru)|konsisten\s+(?:naik|turun))\b/;
function checkUnverifiable(s: string): SemanticViolation[] {
  const m = UNVERIFIABLE.exec(s);
  if (!m) return [];
  return [
    {
      category: 'contradiction',
      excerpt: snippet(s, m.index),
      detail: 'claim not derivable from the supplied data',
    },
  ];
}

/** All sentence-level semantic checks for one canonical, lower-case sentence. */
export function semanticViolations(sentence: string, facts: DataFacts): SemanticViolation[] {
  return [
    ...checkRsi(sentence, facts),
    ...checkMovingAverages(sentence, facts),
    ...checkMacd(sentence, facts),
    ...checkVolume(sentence, facts),
    ...checkSupportResistance(sentence, facts),
    ...checkDailyChange(sentence, facts),
    ...checkMacdSignal(sentence, facts),
    ...checkLevelBreaks(sentence, facts),
    ...check52Week(sentence, facts),
    ...checkUnverifiable(sentence),
  ];
}

/* ------------------------------------------------------------------------------ number roles */

const PRICE_CONTEXT =
  /(harga|price|penutupan|ditutup|open|high|low|support|resistance|rp)\s*[a-z\s]{0,14}$/;
const DAILY_PCT_CONTEXT = /\b(hari ini|harian|dari penutupan(?: sebelumnya)?|sehari)\b/;

/**
 * Numbers that exist in the data but are used in the wrong role. `text` is the ORIGINAL model text
 * (digits must not be altered). Only plain, unambiguous cases are flagged to keep false positives low.
 */
export function roleViolations(
  text: string,
  roles: NumberRoles,
  facts: Pick<DataFacts, 'changePercent'>,
): SemanticViolation[] {
  const out: SemanticViolation[] = [];
  const cleaned = stripNonClaims(text.toLowerCase());
  for (const t of extractNumberTokens(cleaned)) {
    const before = cleaned.slice(Math.max(0, t.index - 24), t.index);
    const ok = (set: number[], scaled = false) =>
      t.values.some((v) => isGrounded(v, set, { scaled }));
    const small = t.values.every((v) => Number.isInteger(v) && Math.abs(v) <= 10);
    const asksCurrent =
      /harga\s+(?:saat\s+ini|terkini|terakhir|sekarang)\s*(?:adalah|di|sebesar|:|=)?\s*$/.test(
        before,
      );
    if ((t.unit === 'rp' || t.unit === null) && asksCurrent && !small && !ok(roles.current)) {
      out.push({ category: 'role_mismatch', excerpt: t.raw, detail: 'not the current price' });
    } else if (t.unit === 'rp') {
      if (!ok(roles.price))
        out.push({ category: 'role_mismatch', excerpt: t.raw, detail: 'not a price in the data' });
    } else if (t.unit === '%') {
      if (!ok(roles.percent) && !small)
        out.push({
          category: 'role_mismatch',
          excerpt: t.raw,
          detail: 'not a percentage in the data',
        });
      else if (
        !small &&
        DAILY_PCT_CONTEXT.test(cleaned.slice(Math.max(0, t.index - 40), t.index + 30)) &&
        facts.changePercent !== null
      ) {
        if (!t.values.some((v) => sameNumber(v, Math.abs(facts.changePercent as number)))) {
          out.push({ category: 'role_mismatch', excerpt: t.raw, detail: 'not the daily change' });
        }
      }
    } else if (t.unit === 'x') {
      if (!ok(roles.ratio) && !small)
        out.push({ category: 'role_mismatch', excerpt: t.raw, detail: 'not a ratio in the data' });
    } else if (t.unit === null) {
      if (
        /\brsi\s*(?:\(\s?14\s?\))?\s*(?:=|:|di|sebesar|sekitar|pada|adalah|berada di)?\s*$/.test(
          before,
        )
      ) {
        if (!ok(roles.rsi))
          out.push({
            category: 'role_mismatch',
            excerpt: `rsi ${t.raw}`,
            detail: 'not the RSI value',
          });
      } else if (
        !small &&
        PRICE_CONTEXT.test(before) &&
        /(harga|price|penutupan|ditutup)\s*[a-z\s]{0,14}$/.test(before)
      ) {
        if (!ok(roles.price))
          out.push({
            category: 'role_mismatch',
            excerpt: t.raw,
            detail: 'not a price in the data',
          });
      }
    }
  }
  return out;
}
