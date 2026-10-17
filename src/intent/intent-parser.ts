import { sanitizeInput } from '../ai/policy/canonical';
import {
  AlertDeleteParameters,
  IntentName,
  ParsedIntent,
  TechnicalTopic,
  TemporalRef,
} from './intent.types';
import { alertTypeFor, isAlertRequest, parseAlert } from './parsers/alert-parser';
import { parseMemory } from './parsers/memory-parser';
import { parseNote } from './parsers/note-parser';
import { parsePortfolio } from './parsers/portfolio-parser';
import { detectAdviceKind, matchSmallTalk } from './parsers/conversational-parser';
import { isEmptyCriteria, isScreenRequest, parseScreen } from './parsers/screen-parser';
import { incompleteTimeReference, parseTemporal } from './parsers/temporal-parser';
import { extractSymbols } from './parsers/ticker-extractor';

/** Normalizes chat text for matching: trims, collapses whitespace, strips bot mentions. */
export function normalizeText(text: string): string {
  return sanitizeInput(text)
    .replace(/@\w+bot\b/gi, ' ')
    .replace(/[“”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const rx = {
  help: /^(help|bantuan|menu|tolong bantu|bisa apa(?: saja)?|apa (?:saja )?(?:yang )?bisa (?:kamu|anda|kau)|cara (?:pakai|menggunakan|penggunaan)|panduan)\b[\s?!.]*$/i,
  watchlist: /\b(watch\s?list|daftar pantau|pantauan|favorit)\b/i,
  wlRemove: /\b(hapus|hapuskan|buang|keluarkan|hilangkan|remove|delete|lepas|cabut)\b/i,
  wlAdd: /\b(tambah(?:kan|in)?|masukkan|masukin|simpan|add|pantau|catat|taruh)\b/i,
  wlList: /\b(lihat|tampilkan|tunjukkan|show|isi|apa saja|apa aja|cek|list|daftar|view|buka)\b/i,
  alertWord: /\b(alert|pengingat|notifikasi|notif|alarm|peringatan)\b/i,
  alertPause:
    /\b(jeda|pause|tahan\s+dulu|hentikan\s+sementara|stop\s+sementara|matikan\s+sementara)\b/i,
  alertResume:
    /\b(lanjutkan|resume|aktifkan\s+(?:lagi|kembali)|nyalakan\s+(?:lagi|kembali)|teruskan|unpause)\b/i,
  alertList: /\b(lihat|tampilkan|tunjukkan|show|daftar|list|apa saja|apa aja|cek|aktif|saya|ku)\b/i,
  alertDelete:
    /\b(hapus|hapuskan|batalkan|batal|matikan|nonaktifkan|cancel|delete|remove|buang|stop)\b/i,
  market:
    /(\b(jam|pukul|kapan)\b.{0,60}\b(buka|tutup|mulai)\b)|(\b(market|bursa|pasar|idx|bei)\b.{0,60}\b(buka|tutup|libur|status|hari ini|sekarang)\b)|(\b(status|kondisi)\b.{0,60}\b(market|bursa|pasar)\b)|(\b(apakah|apa)\b.{0,60}\b(market|bursa|pasar)\b.{0,60}\b(buka|tutup)\b)/i,
  ihsg: /\b(ihsg|indeks harga saham gabungan|composite|jci)\b/i,
  whyQuestion: /\b(kenapa|mengapa|kok|penyebab|alasan|why|sebabnya|gara-gara|akibat)\b/i,
  weakQuestion:
    /\b(bagus|jelek|prospek|layak|worth|aman|menarik|sebaiknya|apakah|gimana|bagaimana|menurut|risiko|bahaya|oke|mahal|murah|wajar|potensi|peluang)\b/i,
  general:
    /\b(apa itu|apa yang dimaksud|apa maksud|jelaskan|jelasin|apa arti|pengertian|bedanya|perbedaan|cara (?:membaca|menghitung|kerja|baca)|definisi|maksud dari|apa (?:fungsi|kegunaan|manfaat|guna|tujuan)|fungsi(?:nya)?|kegunaan(?:nya)?|gunanya|untuk apa|what is|what's|explain|define|meaning of|(?:bekerja|cara kerjanya?)|\w+ itu apa|(?:paham|mengerti|memahami|pelajari|belajar|ajari|ajarin)\b.{0,40}\b(?:rsi|macd|sma|ema|bollinger|atr|support|resistance|volume|moving average|indikator)|how (?:does|do) .{1,40} work|what does .{1,40} mean)\b/i,
  compare:
    /\b(bandingkan|banding|membandingkan|compare|komparasi|versus|vs|dibanding|dibandingkan|lawan)\b/i,
  analysis:
    /\b(analisis|analisa|menganalisis|analyze|analyse|analysis|ulas|ulasan|review|outlook|breakdown|evaluasi)\b/i,
  foreign: /\b(foreign|asing|net\s?(?:buy|sell)|nbs|investor asing)\b/i,
  broker: /\b(broker|bandar|top buyer|top seller|broksum|broker summary)\b/i,
  news: /\b(berita|news|headline|kabar terbaru|artikel)\b/i,
  fundamental:
    /\b(fundamental|per|pbv|pbr|roe|eps|dividen|dividend|market\s?cap|kapitalisasi|laba|valuasi|pendapatan|revenue|profit)\b/i,
  technical:
    /\b(rsi|macd|bollinger|bb|atr|ma\s?-?\d+|sma\s?-?\d*|ema\s?-?\d*|moving average|support|suport|resistance|resisten|teknikal|technical|indikator|indicator|volume ratio|rasio volume|oversold|overbought|jenuh|volume|volumenya|supportnya|resistancenya)\b/i,
  quoteWord:
    /\b(harga|price|quote|kuotasi|berapa|sekarang|kini|terkini|terbaru|hari ini|posisi|info|data|kabar|update|cek)\b/i,
};

function topicsOf(text: string): TechnicalTopic[] {
  const t = text.toLowerCase();
  const topics: TechnicalTopic[] = [];
  if (/\brsi\b|oversold|overbought|jenuh/.test(t)) topics.push('rsi');
  if (/\bmacd\b/.test(t)) topics.push('macd');
  if (/\b(ma|sma|ema)\s?-?\d*\b|moving average/.test(t)) topics.push('ma');
  if (/\bbollinger\b|\bbb\b/.test(t)) topics.push('bollinger');
  if (/\batr\b/.test(t)) topics.push('atr');
  if (/\bvolume/.test(t) || /rasio volume/.test(t)) topics.push('volume');
  if (/\b(support|suport)/.test(t)) topics.push('support');
  if (/\b(resistance|resisten)/.test(t)) topics.push('resistance');
  return topics;
}

function make(
  intent: IntentName,
  text: string,
  symbols: string[],
  parameters: Record<string, unknown> = {},
  extra: Partial<ParsedIntent> = {},
): ParsedIntent {
  return {
    intent,
    symbols,
    parameters,
    confidence: intent === 'UNKNOWN' ? 'low' : 'high',
    source: 'rules',
    text,
    ...extra,
  };
}

/**
 * Deterministic natural-language parser. Returns UNKNOWN (never throws) when nothing matches,
 * so callers can decide whether to ask the AI for help. `now` is injectable for tests.
 */
export function parseIntent(rawText: string, now: Date = new Date()): ParsedIntent {
  return applyTemporal(parseCore(rawText), now);
}

/**
 * A question about a stock. When it also asks for a buy/sell opinion, target or prediction
 * ("kenapa BBCA naik? sebaiknya beli?"), the fixed policy notice is shown above the data-based
 * answer, exactly as for an analysis request.
 */
function stockQuestion(text: string, lower: string, symbols: string[]): ParsedIntent {
  const advice = symbols.length > 0 ? detectAdviceKind(lower, true) : null;
  return make(
    'STOCK_QUESTION',
    text,
    symbols,
    { question: text, ...(advice ? { policyNotice: advice } : {}) },
    { confidence: symbols.length > 0 ? 'high' : 'low' },
  );
}

/** Every symbol was typed in lower case and is directly followed by another word ("auto rejection"). */
function isLowerCaseTerm(text: string, symbols: string[]): boolean {
  const lower = text.toLowerCase();
  return symbols.every(
    (s) => !text.includes(s) && new RegExp(`\\b${s.toLowerCase()}\\s+\\p{L}{2,}`, 'u').test(lower),
  );
}

function parseCore(rawText: string): ParsedIntent {
  const text = normalizeText(rawText);
  const lower = text.toLowerCase();

  if (text.length === 0) return make('UNKNOWN', text, []);
  if (rx.help.test(lower)) return make('HELP', text, []);

  // ---- Greetings / thanks / acknowledgements: answered deterministically, never by the LLM.
  const smallTalk = matchSmallTalk(lower);
  if (smallTalk) return make('SMALL_TALK', text, [], { ...smallTalk });

  const symbols = extractSymbols(text);

  // ---- Memory, preferences, data deletion: explicit commands, checked before anything that
  // could read "hapus" or "lupakan" as a watchlist or alert verb
  const memory = parseMemory(lower, symbols);
  if (memory) {
    // only the default-ticker setting takes a ticker; "hapus akun" must not carry AKUN into the handler or the context
    const kept = memory.intent === 'PREFERENCE_SET' && !memory.parameters.detail ? symbols : [];
    return make(memory.intent, text, kept, memory.parameters, {
      clarification: memory.clarification,
      confidence: memory.clarification ? 'low' : 'high',
    });
  }

  // ---- Personal notes: explicit commands only; "catat BBCA ke watchlist" stays a watchlist command
  const note = parseNote(text);
  if (note) {
    return make(note.intent, text, [], note.parameters, {
      clarification: note.clarification,
      confidence: note.clarification ? 'low' : 'high',
    });
  }

  // ---- Watchlist
  if (rx.watchlist.test(lower)) {
    if (rx.wlRemove.test(lower)) return make('WATCHLIST_REMOVE', text, symbols);
    if (rx.wlAdd.test(lower) && symbols.length > 0) return make('WATCHLIST_ADD', text, symbols);
    if (rx.wlAdd.test(lower)) return make('WATCHLIST_ADD', text, symbols);
    return make('WATCHLIST_LIST', text, []);
  }

  // ---- Alerts
  if (rx.alertWord.test(lower) && rx.alertPause.test(lower)) {
    return make('ALERT_PAUSE', text, symbols, { ...parseAlertDelete(lower) });
  }
  if (rx.alertWord.test(lower) && rx.alertResume.test(lower)) {
    return make('ALERT_RESUME', text, symbols, { ...parseAlertDelete(lower) });
  }
  if (isAlertRequest(text)) {
    if (rx.alertWord.test(lower) && rx.alertDelete.test(lower)) {
      return make('ALERT_DELETE', text, symbols, { ...parseAlertDelete(lower) });
    }
    const a = parseAlert(text);
    const hasCondition = a.condition !== undefined || a.metric === 'volume';
    if (symbols.length === 0 && !hasCondition && rx.alertWord.test(lower)) {
      return make('ALERT_LIST', text, []);
    }
    if (rx.alertWord.test(lower) && rx.alertList.test(lower) && !hasCondition) {
      return make('ALERT_LIST', text, symbols);
    }
    const params = { metric: a.metric, condition: a.condition, value: a.value };
    const clarification =
      a.missing.length === 0
        ? undefined
        : 'Mohon lengkapi alert: sebutkan kondisi dan angkanya, mis. "ingatkan saya kalau BBCA di atas 8500".';
    return make('ALERT_CREATE', text, symbols, params, {
      clarification,
      confidence: a.missing.length === 0 ? 'high' : 'low',
    });
  }
  if (rx.alertWord.test(lower) && rx.alertDelete.test(lower)) {
    return make('ALERT_DELETE', text, symbols, { ...parseAlertDelete(lower) });
  }
  if (
    rx.alertWord.test(lower) &&
    /\b(lihat|tampilkan|daftar|list|apa|cek|aktif|saya|show)\b/.test(lower)
  ) {
    return make('ALERT_LIST', text, symbols);
  }

  // ---- Portfolio bookkeeping: "beli 10 lot BBCA di 9000", "setor 10 juta", "portofolio saya".
  // Needs a quantity (and a price) to count as a record, so "beli BBCA?" still reaches the advice policy.
  const portfolio = parsePortfolio(lower, symbols);
  if (portfolio) {
    if (portfolio.intent === 'PORTFOLIO_RECORD') {
      return make(
        'PORTFOLIO_RECORD',
        text,
        symbols,
        { ...portfolio.parameters },
        {
          clarification: portfolio.clarification,
          confidence: portfolio.clarification ? 'low' : 'high',
        },
      );
    }
    return make(portfolio.intent, text, symbols);
  }

  // ---- Implicit watchlist verbs: "tambahkan BBCA", "hapus BBRI"
  if (symbols.length > 0) {
    if (/^(hapus|hapuskan|buang|keluarkan|hilangkan|remove|delete)\b/.test(lower)) {
      return make('WATCHLIST_REMOVE', text, symbols);
    }
    if (/^(tambah(?:kan|in)?|masukkan|masukin|add|simpan|pantau)\b/.test(lower)) {
      return make('WATCHLIST_ADD', text, symbols);
    }
  }

  // ---- Market status / IHSG
  if (rx.market.test(lower) && symbols.length === 0) return make('MARKET_STATUS', text, []);
  if (rx.ihsg.test(lower) && symbols.length === 0) {
    return make('MARKET_STATUS', text, [], { includeIndex: true });
  }

  // ---- Conceptual / educational questions (no ticker). "apa itu auto rejection?": AUTO is a real ticker,
  // but typed in lower case and followed by another word it is part of a term, not a code.
  if (rx.general.test(lower) && (symbols.length === 0 || isLowerCaseTerm(text, symbols))) {
    return make('GENERAL_QUESTION', text, [], { question: text });
  }

  // ---- "Why" questions about a stock
  if (rx.whyQuestion.test(lower) && (symbols.length > 0 || !isScreenRequest(text))) {
    return stockQuestion(text, lower, symbols);
  }

  // ---- Comparison
  if (rx.compare.test(lower)) {
    return make(
      'STOCK_COMPARISON',
      text,
      symbols,
      // "bandingkan fundamental BBCA BBRI" compares the fundamentals card instead of the technical one
      rx.fundamental.test(lower) ? { fundamental: true } : {},
      {
        clarification:
          symbols.length < 2
            ? 'Sebutkan minimal dua saham, mis. "bandingkan BBCA BBRI".'
            : undefined,
        confidence: symbols.length >= 2 ? 'high' : 'low',
      },
    );
  }

  // ---- Screening (no explicit tickers). An empty criteria set ("saham apa yang bagus?") is NOT
  // turned into a ranking; the handler answers with the available screening dimensions.
  if (symbols.length === 0 && isScreenRequest(text)) {
    const criteria = parseScreen(text);
    return make(
      'STOCK_SCREEN',
      text,
      [],
      { criteria },
      { confidence: isEmptyCriteria(criteria) ? 'low' : 'high' },
    );
  }

  // ---- Data-specific questions
  if (rx.news.test(lower)) return make('STOCK_NEWS', text, symbols);
  if (rx.foreign.test(lower)) return make('FOREIGN_FLOW', text, symbols);
  if (rx.broker.test(lower)) return make('BROKER_SUMMARY', text, symbols);

  // ---- Advice-style questions: buy/sell, target price, prediction, guarantees.
  const advice = detectAdviceKind(lower, symbols.length > 0);
  if (advice) {
    // An explicit analysis request still gets the analysis, prefixed with the policy notice.
    if (rx.analysis.test(lower) && symbols.length > 0) {
      return make('STOCK_ANALYSIS', text, symbols, { policyNotice: advice });
    }
    return make('STOCK_ADVICE', text, symbols, { adviceKind: advice });
  }

  if (rx.technical.test(lower) && !rx.analysis.test(lower)) {
    return make('STOCK_TECHNICAL', text, symbols, { topics: topicsOf(text) });
  }
  if (
    rx.fundamental.test(lower) &&
    (symbols.length > 0 || /\b(per|pbv|roe|eps|dividen)\b/.test(lower))
  ) {
    return make('FUNDAMENTALS', text, symbols);
  }

  // ---- Analysis
  if (rx.analysis.test(lower)) {
    if (rx.technical.test(lower) && /\b(teknikal|technical|indikator)\b/.test(lower)) {
      return make('STOCK_TECHNICAL', text, symbols, { topics: [] });
    }
    return make('STOCK_ANALYSIS', text, symbols);
  }

  // ---- Judgement-style questions ("BBCA bagus?"). Two or more tickers = a factual comparison.
  if (rx.weakQuestion.test(lower) && (symbols.length > 0 || text.endsWith('?'))) {
    if (symbols.length >= 2) return make('STOCK_COMPARISON', text, symbols);
    return stockQuestion(text, lower, symbols);
  }

  // ---- Quote (all mentioned tickers are kept; the request-size limit is enforced explicitly later)
  const wordCount = text.split(/\s+/).length;
  if (symbols.length > 0 && (rx.quoteWord.test(lower) || wordCount <= symbols.length + 1)) {
    return make('STOCK_QUOTE', text, symbols);
  }
  if (symbols.length > 0) {
    // A ticker plus words we don't understand: answer with a quote but keep it low-confidence
    // so the AI fallback may reinterpret it.
    return make('STOCK_QUOTE', text, symbols, {}, { confidence: 'low' });
  }

  return make('UNKNOWN', text, []);
}

/* ------------------------------------------------------------------------------ temporal */

const NO_TEMPORAL = new Set<IntentName>([
  'HELP',
  'SMALL_TALK',
  'WATCHLIST_ADD',
  'WATCHLIST_REMOVE',
  'WATCHLIST_LIST',
  'ALERT_CREATE',
  'ALERT_LIST',
  'ALERT_DELETE',
  'MARKET_STATUS',
  'GENERAL_QUESTION',
  'STOCK_ADVICE',
  'STOCK_HISTORICAL',
  'PORTFOLIO_RECORD',
  'PORTFOLIO_VIEW',
  'PORTFOLIO_HISTORY',
  'PORTFOLIO_UNDO',
  'UNKNOWN',
]);

const WHAT: Partial<Record<IntentName, string>> = {
  STOCK_TECHNICAL: 'indikator teknikal',
  STOCK_ANALYSIS: 'analisis',
  STOCK_COMPARISON: 'perbandingan',
  STOCK_SCREEN: 'screening',
  FUNDAMENTALS: 'data fundamental',
  FOREIGN_FLOW: 'foreign flow',
  BROKER_SUMMARY: 'broker summary',
};

/**
 * A message that refers to another point in time is never answered with today's data.
 * Past date + quote/question -> historical lookup; future -> prediction policy message; anything
 * else -> an explicit "only current data is supported" reply.
 */
function applyTemporal(r: ParsedIntent, now: Date): ParsedIntent {
  if (NO_TEMPORAL.has(r.intent)) return r;
  if (r.symbols.length === 0 && r.intent !== 'STOCK_SCREEN') return r;
  const temporal =
    parseTemporal(r.text, now) ??
    // a quote-like question must not silently fall back to today's price because of "2/10" or "2025"
    (r.intent === 'STOCK_QUOTE' || r.intent === 'STOCK_QUESTION'
      ? incompleteTimeReference(r.text)
      : null);
  if (!temporal) return r;

  if (temporal.kind === 'unsupported') {
    return { ...r, clarification: unsupportedTimeMessage(temporal) };
  }
  if (temporal.kind === 'invalid') {
    return {
      ...r,
      clarification: `Tanggal "${temporal.label}" tidak valid. Contoh: "harga BBCA tanggal 1 Oktober 2026" atau "harga BBCA kemarin".`,
    };
  }
  if (temporal.kind === 'future') {
    if (r.intent === 'STOCK_SCREEN') {
      return {
        ...r,
        clarification:
          'Saya tidak memprediksi pergerakan harga. Screening hanya memakai data terkini, mis. "saham dengan RSI di bawah 30".',
      };
    }
    return make('STOCK_ADVICE', r.text, r.symbols, { adviceKind: 'prediction', temporal });
  }
  // past date or trading session
  if (r.intent === 'STOCK_QUOTE' || r.intent === 'STOCK_QUESTION') {
    return make('STOCK_HISTORICAL', r.text, r.symbols, {
      temporal,
      question: r.intent === 'STOCK_QUESTION',
    });
  }
  const what = WHAT[r.intent] ?? 'data ini';
  return {
    ...r,
    clarification: `Saya hanya menampilkan ${what} berdasarkan data terkini. Untuk harga pada tanggal tertentu, tanyakan mis. "harga BBCA kemarin" atau "harga BBCA tanggal 1 Oktober 2026".`,
  };
}

/** Why a time reference cannot be answered (daily closes only), with what to ask instead. */
function unsupportedTimeMessage(t: Extract<TemporalRef, { kind: 'unsupported' }>): string {
  const examples = 'Contoh: "harga BBCA kemarin" atau "harga BBCA tanggal 1 Oktober 2026".';
  if (t.reason === 'intraday') {
    return `Saya hanya punya harga penutupan harian, bukan data per jam/menit ("${t.label}"). ${examples}`;
  }
  if (t.reason === 'incomplete') {
    return `Tanggal "${t.label}" belum lengkap (bulan atau tahunnya tidak disebut). Tulis mis. "harga BBCA tanggal 2 Oktober 2026" atau "harga BBCA 2026-10-02".`;
  }
  return `Saya menjawab untuk satu tanggal tertentu, bukan satu periode ("${t.label}"). Sebutkan tanggal lengkapnya. ${examples}`;
}

function parseAlertDelete(lower: string): AlertDeleteParameters {
  const all = /\b(semua|seluruh|all)\b/.test(lower);
  const idx = lower.match(/(?:nomor|no\.?|#|alert|ke)\s*(\d{1,3})\b/);
  return { all, index: idx ? Number(idx[1]) : undefined };
}

export { alertTypeFor };
