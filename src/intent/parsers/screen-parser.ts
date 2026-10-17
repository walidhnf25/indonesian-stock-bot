import { ScreenCriteria } from '../intent.types';
import { NUMBER_TOKEN, parseIdNumber } from './number-parser';

const numAfter = (t: string, lead: string): number | null => {
  const m = t.match(new RegExp(`${lead}\\s*(${NUMBER_TOKEN})`, 'i'));
  return m ? parseIdNumber(m[1].trim()) : null;
};

const GT = String.raw`(?:di\s?atas|lebih\s(?:dari|dari\ssama\sdengan|tinggi\sdari|besar\sdari)|>=?|≥|minimal|melebihi)`;
const LT = String.raw`(?:di\s?bawah|kurang\sdari|lebih\s(?:rendah|kecil)\sdari|<=?|≤|maksimal)`;

export function isScreenRequest(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(saham|emiten)\b/.test(t) &&
    /\b(apa|mana|yang|dengan|cari|carikan|tampilkan|tunjukkan|screening|screener|filter|daftar|list|rekomendasi)\b/.test(
      t,
    )
  );
}

/** Translates a natural-language screening request into deterministic criteria. */
export function parseScreen(text: string): ScreenCriteria {
  const t = text
    .toLowerCase()
    .replace(/-nya\b/g, 'nya')
    .replace(/%/g, ' %');
  const c: ScreenCriteria = {};

  // Price change
  const up = /\b(naik|menguat|hijau|melonjak|terbang|gainer)\b/.test(t);
  const down = /\b(turun|melemah|merah|anjlok|jatuh|loser)\b/.test(t);
  if (up && !down) {
    const v = numAfter(t, `(?:naik|menguat|melonjak)\\s*${GT}?`);
    c.changePercent = { gt: v !== null && v > 0 && /%/.test(t) ? v : 0 };
    c.sort = 'changePercent_desc';
  } else if (down && !up) {
    const v = numAfter(t, `(?:turun|melemah|anjlok)\\s*${GT}?`);
    c.changePercent = { lt: v !== null && v > 0 && /%/.test(t) ? -v : 0 };
    c.sort = 'changePercent_asc';
  }

  // Volume
  if (/\bvolume/.test(t)) {
    const x = t.match(/(\d+(?:[.,]\d+)?)\s*(?:x|kali|×)\b/);
    const mult = x ? parseIdNumber(x[1]) : null;
    if (mult !== null || /(tinggi|besar|ramai|melonjak|lonjakan|spike|di\s?atas\srata)/.test(t)) {
      c.volumeRatio = { gt: mult ?? 2 };
      c.sort = c.sort ?? 'volumeRatio_desc';
    }
  }

  // RSI
  if (/\brsi(?:nya)?\b/.test(t)) {
    const lt = numAfter(t, `rsi(?:nya)?\\s*${LT}`);
    const gt = numAfter(t, `rsi(?:nya)?\\s*${GT}`);
    if (lt !== null) {
      c.rsi = { lt };
      c.sort = 'rsi_asc';
    } else if (gt !== null) {
      c.rsi = { gt };
      c.sort = 'rsi_desc';
    }
  }
  if (!c.rsi && /\b(oversold|jenuh\sjual)\b/.test(t)) {
    c.rsi = { lt: 30 };
    c.sort = 'rsi_asc';
  }
  if (!c.rsi && /\b(overbought|jenuh\sbeli)\b/.test(t)) {
    c.rsi = { gt: 70 };
    c.sort = 'rsi_desc';
  }

  // Moving averages
  const above = t.match(/(?:harga\s)?(?:di\s?atas|menembus|tembus)\s(?:ma|sma|ema)\s?(20|50|200)/);
  const below = t.match(/(?:harga\s)?(?:di\s?bawah)\s(?:ma|sma|ema)\s?(20|50|200)/);
  if (above) c.priceAboveMa = Number(above[1]) as 20 | 50 | 200;
  if (below) c.priceBelowMa = Number(below[1]) as 20 | 50 | 200;

  // Momentum
  if (/\b(momentum\spositif|bullish|uptrend|tren\snaik)\b/.test(t)) c.momentum = 'positive';
  if (/\b(momentum\snegatif|bearish|downtrend|tren\sturun)\b/.test(t)) c.momentum = 'negative';

  return c;
}

export function isEmptyCriteria(c: ScreenCriteria): boolean {
  return (
    !c.changePercent &&
    !c.volumeRatio &&
    !c.rsi &&
    !c.priceAboveMa &&
    !c.priceBelowMa &&
    !c.momentum
  );
}
