/**
 * Canonical form of model text for policy checks.
 *
 * A blacklist can only match what it can read. These steps turn the usual ways of dressing up a
 * forbidden word into the plain word, so the rules run on what a human would read:
 *
 *  - NFKC (fullwidth/compatibility letters -> ASCII),
 *  - invisible/format characters (zero-width, soft hyphen, bidi controls, variation selectors, tags),
 *  - accents/combining marks,
 *  - look-alike letters from other alphabets (Cyrillic/Greek) -> Latin,
 *  - leetspeak inside words ("be1i", "str0ng"),
 *  - letters separated by spaces/dots/dashes ("b u y", "b.u.y", "s-t-r-o-n-g"),
 *  - letters stretched by repetition ("beliii", "paastiii").
 *
 * It is only used to DETECT; the text shown to users is never rewritten.
 */

// The class deliberately lists format/combining code points: removing them is the whole point.
const INVISIBLE =
  // eslint-disable-next-line no-misleading-character-class
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}]/gu;
const COMBINING_MARKS = /\p{M}/gu;

/**
 * Cleans raw chat text before ANY parsing: compatibility forms (fullwidth letters) are folded by
 * NFKC, invisible/format characters and control characters are removed. Unlike canonicalize() this
 * keeps case and wording, so it is safe to use for the text the user typed.
 */
export function sanitizeInput(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\p{Cc}/gu, ' ');
}

/** Cyrillic/Greek/other letters that are visually identical to Latin ones. */
const CONFUSABLES: Record<string, string> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  у: 'y',
  і: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  һ: 'h',
  ԛ: 'q',
  ԝ: 'w',
  ӏ: 'l',
  к: 'k',
  м: 'm',
  н: 'h',
  т: 't',
  в: 'b',
  ь: 'b',
  г: 'r',
  ч: 'y',
  ο: 'o',
  α: 'a',
  ν: 'v',
  ι: 'i',
  κ: 'k',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  ε: 'e',
  β: 'b',
  η: 'n',
  χ: 'x',
  μ: 'u',
  ɡ: 'g',
  ı: 'i',
  ʏ: 'y',
  ᴀ: 'a',
  ʙ: 'b',
  ᴄ: 'c',
  ᴅ: 'd',
  ᴇ: 'e',
  ɢ: 'g',
  ʜ: 'h',
  ɪ: 'i',
  ᴊ: 'j',
  ᴋ: 'k',
  ʟ: 'l',
  ᴍ: 'm',
  ɴ: 'n',
  ᴏ: 'o',
  ᴘ: 'p',
  ʀ: 'r',
  ꜱ: 's',
  ᴛ: 't',
  ᴜ: 'u',
  ᴠ: 'v',
  ᴡ: 'w',
  ᴢ: 'z',
};

const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
};
/** Tokens that legitimately mix letters and digits (indicator names with periods, scaled numbers). */
const INDICATOR_TOKEN = /^(?:ma|sma|ema|rsi|macd|atr|bb|lq|idx)\d{1,3}$/;

function unLeet(word: string): string {
  if (INDICATOR_TOKEN.test(word)) return word;
  const letters = (word.match(/[a-z]/g) ?? []).length;
  const leets = (word.match(/[0-9@$]/g) ?? []).length;
  if (letters < 2 || leets === 0 || leets > 2 || letters < leets) return word;
  const as = (one: string) => word.replace(/[0-9@$]/g, (c) => (c === '1' ? one : (LEET[c] ?? c)));
  // "1" is ambiguous (be1i = beli, p4st1 = pasti): keep both readings, the rules read either.
  return word.includes('1') ? `${as('l')} ${as('i')}` : as('i');
}

const SEPARATORS = `[\\s.\\-_*·•|/\\\\,;:+~=!?'"()\\[\\]{}<>]`;
/** Three or more single letters separated by short runs of separators: "s t r o n g  b u y". */
const SPACED_LETTERS = new RegExp(
  `(?<![a-z0-9])(?:[a-z]${SEPARATORS}{1,3}){2,}[a-z](?![a-z0-9])`,
  'g',
);

/** Short fragments that, written apart ("be li", "bu y"), spell an instruction word. */
const JOINABLE_STEMS = new Set(['beli', 'buy', 'sell', 'jual', 'serok', 'borong', 'hold', 'tahan']);

export function canonicalize(text: string): string {
  let t = text.normalize('NFKC').replace(INVISIBLE, '');
  // control characters (NUL, ESC...) are used to split words; whitespace controls are kept as spaces
  // eslint-disable-next-line no-control-regex
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  // regional-indicator symbols are letters in disguise (U+1F1E6..U+1F1FF = A..Z)
  t = t.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, (c) =>
    String.fromCharCode((c.codePointAt(0) as number) - 0x1f1e6 + 97),
  );
  t = t.normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC');
  t = Array.from(t, (c) => CONFUSABLES[c] ?? CONFUSABLES[c.toLowerCase()] ?? c).join('');
  t = t.toLowerCase();
  t = t.replace(/[a-z0-9@$]{3,}/g, unLeet);
  t = t.replace(SPACED_LETTERS, (m) => m.replace(new RegExp(SEPARATORS, 'g'), ''));
  t = t.replace(/([a-z])\1{2,}/g, '$1');
  // every letter doubled ("bbeellii"): a word made of at least three identical pairs
  t = t.replace(/(?<![a-z])(?:([a-z])\1){3,}(?![a-z])/g, (m) => m.replace(/(.)\1/g, '$1'));
  // two short fragments that together spell an instruction word ("be li", "bu y")
  t = t.replace(/(?<![a-z])([a-z]{1,3}) ([a-z]{1,3})(?![a-z])/g, (m, a: string, b: string) =>
    JOINABLE_STEMS.has(a + b) ? a + b : m,
  );
  return t.replace(/\s+/g, ' ').trim();
}

/** Lower-case word list (letters/digits only), used for the echo guard. */
export function wordsOf(text: string): string[] {
  return canonicalize(text).match(/[a-z0-9]+/g) ?? [];
}
