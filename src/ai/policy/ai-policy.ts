import { canonicalize, wordsOf } from './canonical';
import { collectAllowedNumbers, findUngroundedNumbers } from './numeric-grounding';
import { DataFacts, NumberRoles, roleViolations, semanticViolations } from './semantic-checks';

/**
 * AI output policy. Safety is checked by CATEGORY (what the sentence claims), not by a short list of
 * exact phrases. Every category handles negation, so neutral disclaimers ("tidak ada jaminan",
 * "belum pasti", "target harga tidak tersedia") are allowed while the unsafe claim is not.
 *
 * This is a second line of defence behind the prompt: output that fails is regenerated once with a
 * stricter prompt and then replaced by deterministic text. Unsafe model output is never shown.
 */

export type PolicyCategory =
  | 'trade_instruction'
  | 'guarantee'
  | 'price_prediction'
  | 'target_price'
  | 'external_cause'
  | 'unsupported_data_claim'
  | 'contradiction'
  | 'ungrounded_number'
  | 'role_mismatch'
  | 'prompt_echo';

export interface PolicyViolation {
  category: PolicyCategory;
  excerpt: string;
  detail?: string;
}

export interface PolicyContext {
  /** Numbers the model may quote (from the structured context + pre-computed facts). */
  allowedNumbers: readonly number[];
  /** Actual last-session price change %, to catch direction contradictions. */
  priceChangePercent: number | null;
  trend: 'BULLISH' | 'NEUTRAL' | 'BEARISH' | null;
  foreignFlowAvailable: boolean;
  brokerAvailable: boolean;
  /** Check numbers against `allowedNumbers` (off for conceptual answers, see `generalAnswer`). */
  checkNumbers: boolean;
  /** Conceptual answers have no market data: any Rp amount counts as invented. */
  generalAnswer?: boolean;
  /** The user's own words: the model may not hand them back as its answer (echo guard). */
  userText?: string;
  /** Text the application itself supplied (facts, names), so legitimate overlaps are not "echo". */
  appText?: string;
  /** Computed values the wording is compared against (RSI zone, MA position, MACD, volume...). */
  facts?: DataFacts;
  /** Which numbers are prices / percentages / ratios / the RSI. */
  roles?: NumberRoles;
}

/** Longest run of identical consecutive words allowed between the user's text and the answer. */
const ECHO_WORDS = 5;

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const normalize = (t: string) =>
  t.replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim().toLowerCase();
const snippet = (s: string, i: number, len = 60) =>
  s.slice(Math.max(0, i - 15), Math.min(s.length, i + len)).trim();

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+|\n+/).filter((s) => s.trim().length > 0);
}

const NEGATIONS = new Set([
  'tidak',
  'tak',
  'belum',
  'bukan',
  'tanpa',
  'jangan',
  'kurang',
  'no',
  'not',
  'never',
  'without',
  'nor',
  'neither',
]);

/**
 * "Tidak perlu ragu", "jangan khawatir", "tanpa ragu": the negator applies to the doubt, not to what
 * follows, so these must NOT cancel a certainty/advice claim ("Tidak perlu ragu, pasti naik").
 */
const NOT_A_NEGATION_OF_CLAIM = new Set([
  'perlu',
  'usah',
  'ragu',
  'diragukan',
  'meragukan',
  'khawatir',
  'takut',
  'segan',
  'sungkan',
  'malu',
  'bimbang',
  'salah',
  'cemas',
  'panik',
  'worry',
  'hesitate',
  'afraid',
]);

/**
 * True when a negator earlier in the SAME clause negates the match ("tidak ada jaminan",
 * "bukan rekomendasi beli"). A comma/period/colon ends the clause, so "Jangan khawatir, harga pasti
 * naik" is not negated, and a negator that only negates a worry ("tidak perlu ragu") is ignored.
 */
function negatedBefore(lower: string, index: number): boolean {
  const head = lower.slice(0, index);
  const clauseStart =
    Math.max(
      ...[',', ';', ':', '.', '!', '?', '\n', '(', '—', '–'].map((c) => head.lastIndexOf(c)),
    ) + 1;
  const words = head
    .slice(clauseStart)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(-8)
    .map((w) => w.replace(/[^a-z]/g, ''));
  return words.some((w, i) => NEGATIONS.has(w) && !NOT_A_NEGATION_OF_CLAIM.has(words[i + 1] ?? ''));
}

/* ---------------------------------------------------------------------------------- rules */

const DIRECT_TRADE: RegExp[] = [
  /\bstrong\s*(buy|sell)\b/,
  /\b(saatnya|waktunya)\s+(untuk\s+)?(beli|membeli|jual|menjual|masuk|keluar|akumulasi|take profit|cut loss|buy|sell)\b/,
  /\b(rekomendasi|rating|signal|sinyal|call|saran|anjuran)(?:\s+(?:saya|kami|kita|untuk\s+anda|anda))?\s*:?\s*(strong\s*)?(beli|jual|hold|tahan|buy|sell|akumulasi)\b/,
  /\b(buy|sell)\s+(now|immediately|today|signal|rating|call)\b/,
  /\b(you should|should you|i recommend|we recommend|recommended to|consider)\s+(buy|sell|hold)/,
  /\b(take profit|cut loss)\s+(sekarang|segera|di|pada)\b/,
  /\bakumulasi\s+(beli|di area|bertahap)\b/,
  /\b(serok|hajar|borong)\b/,
  /\b(layak|cocok|pantas|bagus|menarik|aman)\s+(untuk\s+)?(di)?(beli|dibeli|dikoleksi|diakumulasi|ditahan|dijual)\b/,
];

/**
 * Slang, bare verbs and hype that carry a trading instruction without the classic phrasing. Run on
 * the canonical text (see canonical.ts), so spacing/homoglyph/leet disguises are already undone.
 * Deliberately limited to forms that are not descriptive Indonesian ("masuk area support" is fine,
 * "masuk sekarang" is not).
 */
const ADVICE_SLANG: RegExp[] = [
  /\ball\s?in\b/,
  /\bgas(?:s+)?\s*(?:beli|masuk|buy|sekarang|terus|pol|aja|saja|lah)\b|\bgaskeun\b|\bgaskan\b/,
  /\b(?:borong|sikat|serok|hajar)\b/,
  /\bcut\s?loss\s+(?:sekarang|segera|aja|saja|dulu)\b|\bcutloss\s+(?:sekarang|segera|aja|saja|dulu)\b/,
  /\bmasuk\s+(?:sekarang|segera|dulu|aja|saja|bertahap|pelan)\b|\bkeluar\s+(?:sekarang|segera|dulu|aja|saja)\b/,
  /\b(?:saatnya|waktunya|waktu\s+(?:yang\s+)?tepat|momen\s+(?:yang\s+)?tepat|saat\s+(?:yang\s+)?(?:baik|tepat))\s+(?:untuk\s+)?(?:masuk|keluar|menambah|membeli|menjual|akumulasi|beli|jual|buy|sell)\b/,
  /\b(?:tambah|ambil|kurangi|tambahkan)\s+posisi\b|\bmenambah\s+posisi\b|\bmengurangi\s+posisi\b/,
  /\blepas\s+(?:saham|posisi|sekarang|aja|saja)\b/,
  /\b(?:peluang|kesempatan)\s+(?:emas|langka)\b|\bjangan\s+(?:sampai\s+)?(?:ketinggalan|lewatkan|terlewat)\b/,
  /\b(?:tahan|hold|simpan|pegang)\s+(?:dulu|aja|saja|terus|erat)\b/,
  /\bhold\s+(?:saham|bbca|posisi)\b|\bsebaiknya\s+(?:tahan|pegang|simpan)\b/,
  /\bto\s+the\s+moon\b|\bmoon(?:ing)?\b(?!\s*(?:phase|light))/,
  /\bbuy\s+(?:the\s+dip|low|more|sekarang|dulu|aja|saja)\b|\bsell\s+(?:high|off|sekarang|dulu|aja|saja)\b|\baccumulate\b|\bgo\s+long\b/,
  /\b(?:kesimpulan|verdict|rating|rekomendasi|call|action|aksi)\s*[:=-]?\s*(?:strong\s+)?(?:buy|sell|hold|beli|jual|tahan|akumulasi|overweight|underweight)\b/,
  /\b(?:wajib|harus|mesti)\s+(?:segera\s+)?(?:beli|jual|tahan|masuk|keluar|buy|sell|hold)\b/,
];
/** "jangan jual", "hindari saham ini": a prohibition IS advice ("tidak ada rekomendasi beli" is not). */
const PROHIBITION_ADVICE =
  /\b(?:jangan|hindari|menghindari|avoid|don'?t|do not)\s+(?:(?!rekomendasi|saran|anjuran|ajakan|dianggap|diartikan|menjadi|sebagai)\w+\s+)?(?:beli|membeli|jual|menjual|buy|sell|hold|tahan|menahan|masuk|keluar|lepas|saham\s+ini)\b|\b(?:sebaiknya|baiknya|lebih\s+baik)\s+(?:anda\s+|kamu\s+|kita\s+|investor\s+)?(?:tidak|jangan)\s+(?:\w+\s+)?(?:beli|membeli|jual|menjual|buy|sell|hold|tahan|menahan|masuk|keluar)\b/;
/** Bare English trading verbs, except the foreign-flow phrase "net buy/sell" and "overbought/oversold". */
const BARE_ENGLISH_VERB =
  /(?<!net\s)(?<![a-z])\b(?:buy|sell)\b(?!\s*(?:side|volume|pressure|signal\s+(?:tidak|bukan)))/;
/** Rocket/hype emoji have no place in a technical description. */
const HYPE_EMOJI = /[\u{1F680}\u{1F315}\u{1F911}\u{1F4B8}]/u;

const ADVISORY = [
  'sebaiknya',
  'disarankan',
  'dianjurkan',
  'direkomendasikan',
  'rekomendasi',
  'anjuran',
  'saatnya',
  'waktunya',
  'layak',
  'cocok',
  'pantas',
  'segera',
  'silakan',
  'ayo',
  'mari',
  'wajib',
  'harus',
  'boleh',
  'bisa',
  'dapat',
  'pertimbangkan',
  'anda',
  'kamu',
  'investor',
  'trader',
  'baiknya',
  'should',
  'must',
  'consider',
  'recommend',
  'recommended',
];
const DESCRIPTIVE_BEFORE = new Set([
  'jenuh',
  'tekanan',
  'minat',
  'aksi',
  'volume',
  'sinyal',
  'zona',
  'area',
  'kecenderungan',
  'sentimen',
  'dominasi',
  'arus',
  'transaksi',
  'order',
  'net',
  'minat',
  'dorongan',
  'momentum',
  'antrean',
  'antrian',
]);

/** "sebaiknya beli", "investor bisa menjual", bare imperative "Beli saham ini". */
function findTradeVerbInstruction(lower: string): string | null {
  for (const sentence of splitSentences(lower)) {
    // Indonesian prefixes: mem+beli, men+jual, di+beli/jual, plus the irregular me+nahan / di+tahan.
    const re = /\b(?:(mem|men|me|di)?(beli|jual|tahan)(?:kan|lah)?|(menahan|ditahan))\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sentence))) {
      const idx = m.index;
      const base = m[2] ?? 'tahan';
      const prefixed = Boolean(m[1]) || Boolean(m[3]);
      const before = sentence.slice(0, idx).trim().split(/\s+/).filter(Boolean);
      // words of the current clause only: "Tanpa ragu, beli sekarang" -> the verb opens a clause
      const clauseBefore = (sentence.slice(0, idx).split(/[,;:]/).pop() ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const prev = before[before.length - 1]?.replace(/[^a-z]/g, '') ?? '';
      const after =
        sentence
          .slice(re.lastIndex)
          .trim()
          .split(/\s+/)[0]
          ?.replace(/[^a-z]/g, '') ?? '';
      if (DESCRIPTIVE_BEFORE.has(prev)) continue; // "tekanan jual", "jenuh beli"
      if ((base === 'beli' && after === 'jual') || (base === 'jual' && after === 'beli')) continue; // "jual beli"
      const advisory = before.slice(-5).some((w) => ADVISORY.includes(w.replace(/[^a-z]/g, '')));
      const urgentAfter = ['sekarang', 'segera', 'dulu', 'saja', 'aja'].includes(after);
      if (base === 'tahan' && !advisory) continue; // "tahan" alone is too ambiguous without advice
      if (negatedBefore(sentence, idx)) continue;
      const bareImperative = !prefixed && clauseBefore.length === 0; // clause starts with "Beli ..."
      if (advisory || bareImperative || (!prefixed && urgentAfter)) return snippet(sentence, idx);
    }
  }
  return null;
}

const GUARANTEE_WORDS =
  /\b(pasti|dijamin|menjamin|jaminan|garansi|dipastikan|bebas\s+risiko|tanpa\s+risiko|risk[- ]free|guarantee[sd]?|definitely|surely|certainly)\b/g;
const GUARANTEE_PHRASES: RegExp[] = [
  /\b100\s?%\s*(cuan|untung|profit|aman|pasti|akurat|yakin|berhasil|menang)\b/,
  /\b(tidak mungkin|mustahil|no way)\b(?:\s+\w+){0,3}\s+(rugi|merugi|turun|jatuh|anjlok|gagal|salah|loss|lose|fall)\b/,
  /\b(cuan|untung)\s+(besar|banyak|pasti|menanti|menunggu|maksimal)\b/,
  /\bpotensi\s+(cuan|untung|profit|keuntungan)\s+(besar|tinggi|pasti)\b/,
];

const FUTURE_MARKER =
  /\b(akan|bakal|bakalan|diprediksi|diperkirakan|diproyeksikan|diramalkan|berpotensi|berpeluang|besok|lusa|minggu depan|pekan depan|bulan depan|tahun depan|ke depan|nanti|will|going to|expected to|forecast|predicted|projected|likely to|could reach|may reach|should reach)\b/;
const PRICE_NUMBER = /(rp\.?\s?\d[\d.,]*|\b\d{1,3}(?:[.,]\d{3})+\b|\b\d{3,}\b)/;
const DIRECTIONAL_FUTURE =
  /\b(akan|bakal|bakalan|will)\s+(?:\w+\s+){0,2}(naik|turun|menguat|melemah|rebound|anjlok|melonjak|menembus|tembus|jatuh|rise|fall|drop|increase|decrease|rally|crash)\b/;
const HEDGES =
  /\b(jika|apabila|bila|kalau|seandainya|andai|mungkin|kemungkinan|bisa|dapat|berpotensi|berisiko|risiko|tidak|tak|belum|bukan|if|may|might|could|unless)\b/;

const TARGET_RE = /\b(target(\s+harga)?|price\s+target|target\s+price)\b/;
const SENTENCE_NEGATION =
  /\b(tidak|tak|bukan|belum|tanpa|no|not|unavailable|tersedia|menetapkan|memberikan)\b/;

const EXTERNAL_CAUSE =
  /\b(didorong|dipicu|disebabkan|akibat|imbas|dampak|berkat|karena|dikarenakan|efek)\s+(?:\w+\s+){0,3}(berita|sentimen|rumor|isu|rilis|laporan\s+keuangan|kinerja\s+keuangan|aksi\s+korporasi|dividen|kebijakan|suku\s+bunga|the\s+fed|inflasi|investor\s+asing|dana\s+asing|bandar|big\s+player|akumulasi|distribusi|spekulasi|profit\s+taking|aksi\s+ambil\s+untung)\b/;

const FOREIGN_CLAIM =
  /\b(asing|foreign)\b(?:\s+\w+){0,4}\s+(net\s*(buy|sell)|beli\s+bersih|jual\s+bersih|akumulasi|distribusi|inflow|outflow|membeli|menjual|memborong|melepas)\b|\bnet\s+foreign\b/;
const BROKER_CLAIM =
  /\b(broker|bandar)\b(?:\s+\w+){0,4}\s+(akumulasi|distribusi|net\s*(buy|sell)|membeli|menjual|memborong|melepas|top\s+(buyer|seller))\b/;
const UNAVAILABLE_WORDS = /\b(tidak|tak|belum|tanpa)\b|\btersedia\b|\bunavailable\b/;

const UP_WORDS = /\b(naik|menguat|menghijau|melonjak|meningkat)\b/;
const DOWN_WORDS = /\b(turun|melemah|merosot|anjlok|terkoreksi|jatuh|memerah)\b/;
const PRICE_SUBJECT =
  /\b(harga|saham)\b[^.;]{0,25}\b(naik|menguat|menghijau|melonjak|meningkat|turun|melemah|merosot|anjlok|terkoreksi|jatuh|memerah)\b/;

/**
 * RSI threshold meaning. A small local model was seen (live run, 2026-10-03) explaining "di bawah 30
 * ... overbought, di atas 70 ... oversold", i.e. inverted. It is the most common conceptual question,
 * and the correct meaning is fixed, so it is checked per clause: "below 30" must not be paired with an
 * overbought label, nor "above 70" with an oversold label.
 */
const CLAUSE_SPLIT = /[,;:]|\b(?:dan|sedangkan|sementara|serta|and|while|whereas)\b/;
const RSI_LOW = /\b(?:di\s+bawah|kurang\s+dari|dibawah|below|under|<)\s*30\b/;
const RSI_HIGH = /\b(?:di\s+atas|lebih\s+dari|diatas|above|over|>)\s*70\b/;
const OVERBOUGHT = /\b(?:overbought|jenuh\s+beli)\b/;
const OVERSOLD = /\b(?:oversold|jenuh\s+jual)\b/;

/* -------------------------------------------------------------------------------- checker */

function checkNormalized(
  texts: readonly string[],
  ctx: PolicyContext | undefined,
  norm: (t: string) => string,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const add = (category: PolicyCategory, excerpt: string, detail?: string) => {
    if (!violations.some((v) => v.category === category && v.excerpt === excerpt)) {
      violations.push({ category, excerpt, detail });
    }
  };

  for (const original of texts) {
    if (!original || !original.trim()) continue;
    const lower = norm(original);

    // 1) direct trading instructions
    for (const re of DIRECT_TRADE) {
      const m = lower.match(re);
      if (m && !negatedBefore(lower, m.index ?? 0))
        add('trade_instruction', snippet(lower, m.index ?? 0));
    }
    const verb = findTradeVerbInstruction(lower);
    if (verb) add('trade_instruction', verb);
    // 1b) slang, bare verbs, prohibitions-as-advice, hype (a negator in the same clause cancels
    // the match: "bukan saran buy", "tidak ada rekomendasi hold")
    for (const re of ADVICE_SLANG) {
      const m = lower.match(re);
      if (m && !negatedBefore(lower, m.index ?? 0))
        add('trade_instruction', snippet(lower, m.index ?? 0));
    }
    const prohibition = lower.match(PROHIBITION_ADVICE);
    if (prohibition) add('trade_instruction', snippet(lower, prohibition.index ?? 0));
    const bare = lower.match(BARE_ENGLISH_VERB);
    if (bare && !negatedBefore(lower, bare.index ?? 0))
      add('trade_instruction', snippet(lower, bare.index ?? 0));
    if (HYPE_EMOJI.test(original)) add('trade_instruction', 'hype emoji');

    // 2) guarantees / certainty
    for (const m of lower.matchAll(GUARANTEE_WORDS)) {
      if (!negatedBefore(lower, m.index ?? 0)) add('guarantee', snippet(lower, m.index ?? 0));
    }
    for (const re of GUARANTEE_PHRASES) {
      const m = lower.match(re);
      if (m && !negatedBefore(lower, m.index ?? 0)) add('guarantee', snippet(lower, m.index ?? 0));
    }

    for (const sentence of splitSentences(lower)) {
      // 3) unsupported price predictions
      const fut = sentence.match(FUTURE_MARKER);
      if (fut && PRICE_NUMBER.test(sentence) && !negatedBefore(sentence, fut.index ?? 0)) {
        add('price_prediction', snippet(sentence, fut.index ?? 0));
      }
      const dir = sentence.match(DIRECTIONAL_FUTURE);
      if (dir && !HEDGES.test(sentence)) add('price_prediction', snippet(sentence, dir.index ?? 0));

      // 4) target prices generated by the local model
      const tgt = sentence.match(TARGET_RE);
      if (tgt && /\d/.test(sentence) && !SENTENCE_NEGATION.test(sentence)) {
        add('target_price', snippet(sentence, tgt.index ?? 0));
      }

      // 5) causes the data cannot support
      const cause = sentence.match(EXTERNAL_CAUSE);
      if (cause && !negatedBefore(sentence, cause.index ?? 0))
        add('external_cause', snippet(sentence, cause.index ?? 0));

      // 5b) inverted RSI zones (also in conceptual answers)
      for (const clause of sentence.split(CLAUSE_SPLIT)) {
        const ob = clause.match(OVERBOUGHT);
        const os = clause.match(OVERSOLD);
        if (RSI_LOW.test(clause) && ob && !negatedBefore(clause, ob.index ?? 0)) {
          add(
            'contradiction',
            snippet(clause, ob.index ?? 0),
            'RSI below 30 is oversold, not overbought',
          );
        }
        if (RSI_HIGH.test(clause) && os && !negatedBefore(clause, os.index ?? 0)) {
          add(
            'contradiction',
            snippet(clause, os.index ?? 0),
            'RSI above 70 is overbought, not oversold',
          );
        }
      }

      // 6) claims about data the application does not have
      if (ctx && !ctx.foreignFlowAvailable) {
        const f = sentence.match(FOREIGN_CLAIM);
        if (f && !UNAVAILABLE_WORDS.test(sentence))
          add('unsupported_data_claim', snippet(sentence, f.index ?? 0), 'foreign flow');
      }
      if (ctx && !ctx.brokerAvailable) {
        const b = sentence.match(BROKER_CLAIM);
        if (b && !UNAVAILABLE_WORDS.test(sentence))
          add('unsupported_data_claim', snippet(sentence, b.index ?? 0), 'broker data');
      }

      // 7) contradictions with the supplied data
      if (ctx) {
        if (ctx.priceChangePercent !== null && Math.abs(ctx.priceChangePercent) >= 0.05) {
          const subj = sentence.match(PRICE_SUBJECT);
          if (subj && !negatedBefore(sentence, subj.index ?? 0)) {
            const claimsUp = UP_WORDS.test(subj[0]);
            const mentionsBoth = UP_WORDS.test(sentence) && DOWN_WORDS.test(sentence);
            if (!mentionsBoth && claimsUp && ctx.priceChangePercent < 0) {
              add(
                'contradiction',
                snippet(sentence, subj.index ?? 0),
                'text says price rose, data says it fell',
              );
            }
            if (!mentionsBoth && !claimsUp && ctx.priceChangePercent > 0) {
              add(
                'contradiction',
                snippet(sentence, subj.index ?? 0),
                'text says price fell, data says it rose',
              );
            }
          }
        }
        if (ctx.trend) {
          const bull = sentence.match(
            /\b(tren|trend|bertren)\s+(?:\w+\s+){0,2}(bullish|naik|menguat)\b|\buptrend\b/,
          );
          const bear = sentence.match(
            /\b(tren|trend|bertren)\s+(?:\w+\s+){0,2}(bearish|turun|melemah)\b|\bdowntrend\b/,
          );
          if (ctx.trend === 'BEARISH' && bull && !negatedBefore(sentence, bull.index ?? 0)) {
            add(
              'contradiction',
              snippet(sentence, bull.index ?? 0),
              'calls trend bullish, data says bearish',
            );
          }
          if (ctx.trend === 'BULLISH' && bear && !negatedBefore(sentence, bear.index ?? 0)) {
            add(
              'contradiction',
              snippet(sentence, bear.index ?? 0),
              'calls trend bearish, data says bullish',
            );
          }
        }
      }
    }

    // 8) numbers that are not in the supplied data
    if (ctx?.checkNumbers) {
      const bad = findUngroundedNumbers(original, ctx.allowedNumbers);
      if (bad.length)
        add('ungrounded_number', bad.slice(0, 5).join(', '), 'not present in the supplied data');
    }
    if (ctx?.generalAnswer && /\brp\.?\s?\d/i.test(original)) {
      add('ungrounded_number', 'Rp amount', 'conceptual answers must not quote prices');
    }
  }
  return violations;
}

const ngrams = (words: string[], n: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(' '));
  return out;
};

/**
 * Checks model text against the policy. Layers, all deterministic:
 *  1. category rules on the plain text AND on its canonical form (disguises undone, canonical.ts);
 *  2. echo guard: the user's own sentence must not come back out as the model's answer;
 *  3. data-bound semantics: wording about RSI/MA/MACD/volume/support/resistance/daily change must
 *     agree with the computed values, and every number must have the right ROLE (semantic-checks.ts).
 */
export function checkTextPolicy(texts: readonly string[], ctx?: PolicyContext): PolicyViolation[] {
  const violations = checkNormalized(texts, ctx, normalize);
  const add = (v: PolicyViolation) => {
    if (!violations.some((x) => x.category === v.category && x.excerpt === v.excerpt)) {
      violations.push(v);
    }
  };
  for (const v of checkNormalized(texts, ctx, canonicalize)) add(v);

  const userGrams = ctx?.userText ? new Set(ngrams(wordsOf(ctx.userText), ECHO_WORDS)) : null;
  const appGrams = userGrams ? new Set(ngrams(wordsOf(ctx?.appText ?? ''), ECHO_WORDS)) : null;

  for (const original of texts) {
    if (!original || !original.trim()) continue;

    if (userGrams && appGrams) {
      for (const g of ngrams(wordsOf(original), ECHO_WORDS)) {
        if (userGrams.has(g) && !appGrams.has(g)) {
          add({ category: 'prompt_echo', excerpt: g, detail: "repeats the user's own wording" });
          break;
        }
      }
    }

    if (ctx?.facts) {
      for (const sentence of splitSentences(canonicalize(original))) {
        for (const s of semanticViolations(sentence, ctx.facts)) {
          add({ category: s.category, excerpt: s.excerpt, detail: s.detail });
        }
      }
    }
    if (ctx?.roles && ctx.facts) {
      for (const s of roleViolations(original, ctx.roles, ctx.facts)) {
        add({ category: s.category, excerpt: s.excerpt, detail: s.detail });
      }
    }
  }
  return violations;
}

/** Backward-compatible helper: first category violation (no data context), or null. */
export function findForbiddenPhrase(text: string): string | null {
  return checkTextPolicy([text])[0]?.excerpt ?? null;
}

/** Human-readable summary used in the correction prompt and logs (never shown to end users). */
export function describeViolations(violations: readonly PolicyViolation[]): string {
  return violations
    .slice(0, 4)
    .map((v) => `${v.category}${v.detail ? ` (${v.detail})` : ''}: "${v.excerpt}"`)
    .join('; ');
}

/* ------------------------------------------------------------------- context construction */

interface LooseContext {
  quote?: Record<string, unknown> & { changePercent?: number | null };
  technical?: {
    trend?: PolicyContext['trend'];
    rsi14?: number | null;
    macd?: { histogram?: number | null; value?: number | null; signal?: number | null };
    ma?: Record<string, number | null | undefined>;
    volumeRatioVs20DayAvg?: number | null;
    [k: string]: unknown;
  };
  priceStats?: Record<string, unknown>;
  support?: Array<{ price?: number }>;
  resistance?: Array<{ price?: number }>;
  fundamental?: Record<string, unknown> | null;
  foreignFlow?: unknown;
  brokerSummary?: unknown;
  facts?: unknown;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const numsOf = (...vs: unknown[]): number[] => vs.map(num).filter((v): v is number => v !== null);

/** Every string value in the context tree (facts, names, limitations), lower-cased. */
function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (v && typeof v === 'object')
    Object.values(v as object).forEach((x) => collectStrings(x, out));
  return out;
}

/** Facts the wording is compared against, taken from the structured context. */
function buildFacts(c: LooseContext): DataFacts | undefined {
  if (!c.quote || !c.technical) return undefined;
  const ma = c.technical.ma ?? {};
  return {
    price: num(c.quote.price),
    rsi: num(c.technical.rsi14),
    macdHistogram: num(c.technical.macd?.histogram),
    ma: {
      '20': num(ma.ma20),
      '50': num(ma.ma50),
      '100': num(ma.ma100),
      '200': num(ma.ma200),
    },
    volumeRatio: num(c.technical.volumeRatioVs20DayAvg),
    supports: numsOf(...(c.support ?? []).map((l) => l.price)),
    resistances: numsOf(...(c.resistance ?? []).map((l) => l.price)),
    changePercent: num(c.quote.changePercent),
    macd: num(c.technical.macd?.value),
    macdSignal: num(c.technical.macd?.signal),
    high52: num(c.quote.fiftyTwoWeekHigh),
    low52: num(c.quote.fiftyTwoWeekLow),
  };
}

/** Which numbers are prices, percentages, ratios or the RSI (a number from another role is a fabrication). */
function buildRoles(c: LooseContext): NumberRoles | undefined {
  if (!c.quote || !c.technical) return undefined;
  const q = c.quote;
  const t = c.technical;
  const price = numsOf(
    q.price,
    q.open,
    q.high,
    q.low,
    q.previousClose,
    q.fiftyTwoWeekHigh,
    q.fiftyTwoWeekLow,
    ...Object.values(t.ma ?? {}),
    ...(c.support ?? []).map((l) => l.price),
    ...(c.resistance ?? []).map((l) => l.price),
    t.atr14,
  );
  const percent = [
    ...numsOf(q.changePercent, t.priceVsMa20Percent, t.priceVsMa50Percent),
    ...numsOf(...Object.values(c.priceStats ?? {})),
  ];
  const ratio = numsOf(t.volumeRatioVs20DayAvg);
  // Anything the application already phrased in its facts/limitations keeps its stated role.
  // (claims are application-written too, including the fundamental, news and portfolio sentences)
  for (const s of [
    ...collectStrings(c.facts),
    ...collectStrings((c as { claims?: unknown }).claims),
  ]) {
    for (const m of s.matchAll(/(\d+(?:[.,]\d+)?)\s?%/g))
      percent.push(Number(m[1].replace(',', '.')));
    for (const m of s.matchAll(/(\d+(?:[.,]\d+)?)\s?x\b/gi))
      ratio.push(Number(m[1].replace(',', '.')));
    for (const m of s.matchAll(/rp\s?(\d[\d.]*(?:,\d+)?)/gi)) {
      price.push(Number(m[1].replace(/\./g, '').replace(',', '.')));
    }
  }
  // Fundamentals phrased as percentages/multiples keep their own roles.
  const f = c.fundamental ?? {};
  percent.push(
    ...numsOf((f as Record<string, unknown>).roe, (f as Record<string, unknown>).dividendYield),
  );
  const fr = f as Record<string, unknown>;
  percent.push(...numsOf(fr.netMargin, fr.revenueGrowth, fr.earningsGrowth));
  ratio.push(...numsOf(fr.per, fr.pbv, fr.forwardPer, fr.debtToEquity));
  return {
    price: price.map(Math.abs),
    current: numsOf(q.price).map(Math.abs),
    percent: percent.map(Math.abs),
    ratio: ratio.map(Math.abs),
    rsi: [...numsOf(t.rsi14), 30, 70, 50, 14],
  };
}

/** Builds the policy context from the exact object that is sent to the model (single source of truth). */
export function buildPolicyContext(context: unknown): PolicyContext {
  const c = (context ?? {}) as LooseContext;
  return {
    allowedNumbers: collectAllowedNumbers(context),
    priceChangePercent: typeof c.quote?.changePercent === 'number' ? c.quote.changePercent : null,
    trend: c.technical?.trend ?? null,
    foreignFlowAvailable: c.foreignFlow != null,
    brokerAvailable: c.brokerSummary != null,
    checkNumbers: true,
    appText: collectStrings(context).join(' '),
    facts: buildFacts(c),
    roles: buildRoles(c),
  };
}

/** Comparison input is an array of per-stock entries; every number there is allowed. */
export function buildComparisonPolicyContext(entries: unknown): PolicyContext {
  return {
    allowedNumbers: collectAllowedNumbers(entries),
    priceChangePercent: null,
    trend: null,
    foreignFlowAvailable: false,
    brokerAvailable: false,
    checkNumbers: true,
  };
}

export const GENERAL_ANSWER_POLICY: PolicyContext = {
  allowedNumbers: collectAllowedNumbers([]),
  priceChangePercent: null,
  trend: null,
  foreignFlowAvailable: false,
  brokerAvailable: false,
  checkNumbers: false,
  generalAnswer: true,
};
