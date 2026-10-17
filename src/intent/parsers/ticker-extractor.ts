import { KNOWN_TICKER_SET, NAME_ALIASES, UNIVERSE_SET } from './idx-universe';

/** Words that are 4 letters long but are not tickers (Indonesian/English chat vocabulary). */
const STOPWORDS = new Set(
  (
    'yang dari atau naik jual beli buka tadi bisa masa kena mana saja juga akan pada kasih beri tahu hapus buang tapi ' +
    'lihat nilai data tren bagi baik buruk bagus besok hari lalu lagi saat kini jadi bila jika pasti sedang masih sudah ' +
    'belum tidak bukan cuma hanya biar agar maka mari ayo yuk lah kah pun cari cara coba cuan rugi laba risk atas ' +
    'stok arah agak amat baru bawa beda bank dana emas uang rata sama pagi sore siap oke halo hai ' +
    'what this that with show list view last high lows open info help menu stop loss gain news buys sell hold ' +
    'tolong minta bantu saya kamu anda kita kami aku gue dong nih sih deh tuh mau apa ada kok ' +
    'harga tutup turun naik tinggi rendah ' +
    'flow summ net buy summary saya tanya apakah bagaimana macd ihsg wib rsi ' +
    'bull bear long term down sini gitu aman lain kode test pria kalo gimana trend tren ' +
    'does work mean when will have your they them then than from into over very much more some such ' +
    'only also just like make take give tell know want need feel look good best well how why who ' +
    // people and purposes that follow "untuk/buat": "aman buat anak saya" is not a ticker
    'anak ibu bapak ayah istri suami adik kakak orang teman bosku mama papa ortu keluarga pensiun masa depan'
  ).split(/\s+/),
);

/** Uppercase tokens that look like tickers but are indicator / market names. */
const NON_TICKERS = new Set(['MACD', 'IHSG', 'BOLL', 'RSIS', 'VWAP', 'LQ45', 'IDX']);
/** Technical words that appear in pasted markup ("</USER_REQUEST>", "JSON"); never a ticker unless it is a listed one. */
const MARKUP_WORDS = new Set([
  'JSON',
  'USER',
  'HTML',
  'HTTP',
  'NULL',
  'TRUE',
  'FALSE',
  'TEXT',
  'ROLE',
]);

/**
 * Upper-case chat abbreviations ("analisis BBCA ASAP"). Ignored unless the code is a listed IDX
 * ticker, so a real ticker is never lost. Needed since every named ticker is now processed (a
 * stray "ASAP" would otherwise become a second, failing lookup).
 */
const CHAT_ABBREVIATIONS = new Set([
  'ASAP',
  'IMHO',
  'FOMO',
  'YOLO',
  'DYOR',
  'HODL',
  'THNX',
  'PLIS',
]);

/** Words right before a ticker that make an unknown lower-case 4-letter word a ticker candidate. */
const TRIGGERS = new Set([
  'analisis',
  'analisa',
  'analyze',
  'harga',
  'saham',
  'bandingkan',
  'banding',
  'compare',
  'vs',
  'versus',
  'dan',
  'dengan',
  'tambahkan',
  'tambah',
  'masukkan',
  'hapus',
  'buang',
  'kode',
  'ticker',
  'untuk',
  'di',
  'rsi',
  'macd',
  'support',
  'resistance',
  'teknikal',
  'kenapa',
  'mengapa',
  'kok',
  'ulas',
  'review',
  'info',
  'kondisi',
  'alert',
  'ingatkan',
  'kalau',
  'jika',
  'bila',
  'ma20',
  'ma50',
  'ma200',
  'volume',
  'atas',
  'bawah',
  'per',
  'pbv',
  'pbr',
  'roe',
  'eps',
  'dividen',
  'fundamental',
  'flow',
  'summary',
  'valuasi',
  'bollinger',
  'atr',
  'sma',
  'ema',
]);

const SEPARATORS = new Set(['dan', 'dengan', 'vs', 'versus', '&', ',', 'sama']);

/**
 * Extracts IDX tickers from free text, in order of appearance, de-duplicated.
 * Heuristics are deliberately conservative: the data provider validates existence afterwards.
 */
export function extractSymbols(text: string): string[] {
  const found: Array<{ pos: number; symbol: string }> = [];
  const isAllCaps = text === text.toUpperCase() && /[A-Z]/.test(text);
  const words = [...text.matchAll(/[A-Za-z0-9.&,]+/g)];
  const lowerWords = words.map((w) => w[0].toLowerCase().replace(/[.,]+$/, ''));
  const significant = words.filter((w) => /[A-Za-z]/.test(w[0]));

  words.forEach((w, idx) => {
    const raw = w[0].replace(/[.,]+$/, '');
    const m = raw.match(/^([A-Za-z]{4})(?:\.jk)?$/i);
    if (!m) return;
    const token = m[1];
    const upper = token.toUpperCase();
    const lower = token.toLowerCase();
    if (NON_TICKERS.has(upper)) return;
    if (MARKUP_WORDS.has(upper) && !UNIVERSE_SET.has(upper)) return;
    if (CHAT_ABBREVIATIONS.has(upper) && !UNIVERSE_SET.has(upper)) return;

    const originalUpper = token === upper;
    const stop = STOPWORDS.has(lower);
    const prev = lowerWords[idx - 1] ?? '';
    const prevIsTrigger = TRIGGERS.has(prev);
    const prevIsSeparator = SEPARATORS.has(prev) || /,$/.test(words[idx - 1]?.[0] ?? '');
    const soleToken = significant.length === 1;

    let accept = false;
    if (stop) {
      // "BUKA" in a mixed-case sentence is a ticker; "buka" is just the word "open".
      accept = originalUpper && !isAllCaps && KNOWN_TICKER_SET.has(upper);
    } else if (originalUpper && !isAllCaps) {
      accept = true;
    } else if (UNIVERSE_SET.has(upper)) {
      accept = true;
    } else if (soleToken || prevIsTrigger || prevIsSeparator) {
      accept = true; // unknown, but positioned like a ticker; provider will validate
    }
    if (accept) found.push({ pos: w.index ?? idx, symbol: upper });
  });

  // Names/aliases ("bca", "telkom", "bank central asia")
  const lowered = text.toLowerCase();
  for (const [alias, symbol] of Object.entries(NAME_ALIASES)) {
    const re = new RegExp(`(?<![a-z0-9])${alias.replace(/ /g, '\\s+')}(?![a-z0-9])`, 'i');
    const m = re.exec(lowered);
    if (m) found.push({ pos: m.index, symbol });
  }

  found.sort((a, b) => a.pos - b.pos);
  return [...new Set(found.map((f) => f.symbol))];
}
