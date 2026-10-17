import { AdviceKind, SmallTalkKind } from '../intent.types';
import { canonicalize } from '../../ai/policy/canonical';

/* ------------------------------------------------------------------ small talk (no AI) */

const FILLER_SUFFIX = new Set([
  'kak',
  'min',
  'bos',
  'bro',
  'bot',
  'admin',
  'gan',
  'sis',
  'ya',
  'dong',
  'deh',
  'nih',
  'banget',
  'sekali',
  'banyak',
  'semua',
  'kawan',
  'teman',
]);

// Phrases are stored with repeated letters collapsed ("hello" -> "helo", "makasiii" -> "makasi").
const THANKS = new Set([
  'terima kasih',
  'terimakasih',
  'trims',
  'trimakasih',
  'makasih',
  'makasi',
  'mksh',
  'thanks',
  'thank you',
  'thx',
  'tq',
  'thanx',
]);
const GREETING = new Set([
  'halo',
  'helo',
  'hai',
  'hi',
  'hei',
  'hey',
  'selamat pagi',
  'selamat siang',
  'selamat sore',
  'selamat malam',
  'pagi',
  'siang',
  'sore',
  'malam',
  'assalamualaikum',
  'assalamu alaikum',
  'permisi',
]);
const ACK = new Set([
  'oke',
  'ok',
  'okay',
  'okey',
  'oke deh',
  'oke siap',
  'sip',
  'siap',
  'baik',
  'baiklah',
  'mantap',
  'noted',
  'sip sip',
]);

const collapse = (s: string) => s.replace(/(.)\1+/g, '$1');

export interface SmallTalk {
  kind: SmallTalkKind;
  /** "pagi" | "siang" | "sore" | "malam" when the greeting named a part of the day. */
  daypart?: string;
}

/**
 * Whole-message match only ("oke BBCA" is NOT small talk). Returns null for anything longer or
 * not in the small sets, so real questions are never swallowed.
 */
export function matchSmallTalk(lowerText: string): SmallTalk | null {
  const cleaned = lowerText
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.split(' ').length > 6) return null;
  const words = collapse(cleaned).split(' ');
  while (words.length > 1 && FILLER_SUFFIX.has(words[words.length - 1])) words.pop();
  const phrase = words.join(' ');
  if (THANKS.has(phrase)) return { kind: 'thanks' };
  if (GREETING.has(phrase)) {
    const part = phrase.match(/\b(pagi|siang|sore|malam)\b/);
    return { kind: 'greeting', daypart: part?.[1] };
  }
  if (ACK.has(phrase)) return { kind: 'ack' };
  return null;
}

/* ------------------------------------------------------------------ advice-style questions */

const GUARANTEE_RE =
  /\b(pasti|dijamin|menjamin|jaminan|strong\s?(?:buy|sell)|bebas\s+risiko|tidak\s+mungkin\s+rugi|guaranteed|cuan\s+besar)\b|\b100\s?%|\b(?:no|zero)\s+risk\b|\btanpa\s+risiko\b|\brisk[- ]?free\b|\b(?:profit|cuan|untung)\s+(?:pasti|dijamin)\b/;
const TARGET_RE =
  /\b(target(?:\s+harga)?|price\s*target|target\s+price|fair\s*value|harga\s+wajar|harga\s+ideal)\b/;
const TRADE_RE =
  /\b(beli|membeli|dibeli|jual|menjual|dijual|buy|sell|hold|tahan|menahan|serok|akumulasi|cut\s?loss|take\s?profit|entry\s+(?:point|price|level|harga|sekarang|dulu|aman)|(?:kapan|waktu|saatnya)\s+entry|average\s+(?:down|up)|all\s?in|borong|sikat|hajar|gaskeun|gas+\s+(?:beli|masuk|buy|sekarang|terus|pol|aja|saja)|masuk\s+(?:[a-z]{4}\s+)?(?:sekarang|dulu|aja|saja|gak|nggak|ga|enggak)|keluar\s+(?:sekarang|dulu)|tambah\s+posisi|ambil\s+posisi|worth\s+it|waktu\s+(?:yang\s+)?tepat|saatnya|waktunya|cuan\s+(?:gak|nggak|ga|enggak|tidak|kah)|ketinggalan|kehabisan|fomo|harus\s+apa|tindakan\s+(?:yang\s+)?(?:paling\s+)?tepat|(?:kalau|jika|andai)\s+(?:kamu|anda|lo|lu)\s+(?:jadi|di)\s+(?:posisi\s+)?saya|if\s+you\s+were\s+me|recommended?|direkomendasikan|(?:tp|sl)\s+(?:berapa|dimana|di\s+mana|ideal|aman)|dikoleksi|mengoleksi|(?:layak|cocok|bagus|worth|boleh|mau|perlu)\s+(?:di)?koleksi|dipegang|(?:mau|boleh|perlu|haruskah)\s+(?:saya\s+|aku\s+)?pegang|pegang\s+(?:terus|dulu|jangka)|prospek(?:nya)?\s+(?:gimana|bagaimana|ke\s?depan|jangka\s+\w+|saham|harga)|prospektif|layak\s+(?:invest|investasi|dibeli|dikoleksi|dipegang)|(?:aman|layak|cocok|pantas)(?:\s+(?:ga|gak|nggak|enggak|tidak|kah))?\s+(?:buat|untuk|dipegang|dibeli|jangka)|(?:bagus|cocok|menarik)\s+untuk\s+(?:jangka|dibeli|dikoleksi|dipegang|investasi|trading))\b|^\s*(?:gas+|sikat|hajar|serok)\b|(?:prospek(?:nya)?|(?:aman|layak|cocok)(?:\s+(?:ga|gak|nggak|enggak|tidak|kah))?)\s*[?!]+\s*$/;
const PREDICTION_RE =
  /\b(prediksi|memprediksi|prakiraan|ramalan|meramal|forecast|proyeksi|bakal|bakalan|akan\s+(?:naik|turun|menguat|melemah|tembus|rebound|anjlok|melonjak|jatuh)|naik\s+atau\s+turun|(?:naik|turun)\s+(?:gak|nggak|ga|enggak|tidak)|(?:kemungkinan|peluang|probabilitas|chance)\s+(?:[a-z]{4}\s+)?(?:akan\s+)?(?:naik|turun|menguat|melemah|rebound)|kapan\s+(?:[a-z]{4}\s+)?(?:akan\s+)?(?:naik|turun|menguat|melemah|rebound|tembus|menembus|break)|will\s+(?:go\s+)?(?:up|down|rise|fall|rally|crash|moon|drop)|going\s+(?:up|down)|(?:bisa|mungkinkah|mungkin|kira-?kira)\s+(?:tembus|menembus|naik|turun|menguat|melemah|rebound|capai|mencapai))\b/;
/** Wording about the past: "kemarin naik ga?" asks what happened, which is a historical lookup, not a prediction. */
const PAST_MARKER_RE =
  /\b(kemarin|kmrn|kemaren|semalam|tadi|(?:minggu|pekan|bulan|tahun)\s+(?:yang\s+)?lalu|\d+\s+(?:hari|minggu|bulan)\s+lalu|yesterday|last\s+(?:week|month|year))\b/;
const FUTURE_MARKER_RE = /\b(besok|esok|lusa|depan|nanti|tomorrow|next|akan|bakal|bakalan)\b/;
/** With no ticker in the message, only clearly advice-seeking phrasing counts ("sebaiknya beli?"). */
const ADVICE_QUESTION_RE =
  /\b(sebaiknya|haruskah|apakah\s+(?:saya\s+)?(?:perlu|harus|boleh|bisa|sebaiknya)|layak|worth|waktu\s+(?:yang\s+)?tepat|rekomendasi|saran|harus|should|must|say|tell|katakan|bilang|suruh|tulis|jawab|respond|output|answer|write|waktunya|tindakan|jadi\s+saya|if\s+you\s+were\s+me)\b/;
/** A bare order such as "jual sekarang" or "sell immediately": advice-seeking even with no ticker. */
const SHORT_TRADE_RE =
  /^\s*(?:jual|beli|sell|buy|hold|tahan|serok|borong)(?:\s+(?:sekarang|aja|saja|dulu|now|immediately|today|segera))?\s*[!.?]*\s*$/;
const HOWTO_RE = /\b(cara|bagaimana cara|tutorial|panduan)\b/;

/**
 * Detects "should I buy", "what's the target price", "will it go up", "it's guaranteed to..." style
 * messages. These get a fixed policy answer plus neutral technical data, never an AI opinion.
 * Precedence: guarantee > target price > trade > prediction.
 */
export function detectAdviceKind(lowerText: string, hasSymbols: boolean): AdviceKind | null {
  const direct = detectRaw(lowerText, hasSymbols);
  if (direct) return direct;
  // Disguised spellings ("b3l1", "b e l i", "BELI" in fullwidth letters) are read the way the output policy
  // reads them, so the policy notice is not skipped by a spelling trick.
  const canonical = canonicalize(lowerText);
  const fromCanonical = canonical !== lowerText ? detectRaw(canonical, hasSymbols) : null;
  if (fromCanonical || !lowerText.includes('!')) return fromCanonical;
  // "be!i": the "!" stands for an "l" or an "i" depending on the word
  for (const letter of ['l', 'i']) {
    const variant = canonicalize(lowerText.replace(/!/g, letter));
    const kind = detectRaw(variant, hasSymbols);
    if (kind) return kind;
  }
  return null;
}

function detectRaw(lowerText: string, hasSymbols: boolean): AdviceKind | null {
  // Certainty wording is a policy topic even without a ticker ("pasti naik kan?", "no risk?").
  if (GUARANTEE_RE.test(lowerText) && !HOWTO_RE.test(lowerText)) return 'guarantee';
  if (!hasSymbols && SHORT_TRADE_RE.test(lowerText)) return 'trade';
  if (!hasSymbols && (HOWTO_RE.test(lowerText) || !ADVICE_QUESTION_RE.test(lowerText))) return null;
  if (TARGET_RE.test(lowerText)) return 'target_price';
  if (TRADE_RE.test(lowerText)) return 'trade';
  if (PREDICTION_RE.test(lowerText)) {
    // "TSTA kemarin naik ga?" is about the past: let it become a historical lookup
    return PAST_MARKER_RE.test(lowerText) && !FUTURE_MARKER_RE.test(lowerText)
      ? null
      : 'prediction';
  }
  return null;
}
