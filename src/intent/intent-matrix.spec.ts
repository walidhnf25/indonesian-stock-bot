import { parseIntent } from './intent-parser';
import { AI_STATE_CHANGE_REFUSED, validateIntent } from './intent-validator';
import { IntentService } from './intent.service';
import { IntentName, ParsedIntent } from './intent.types';
import { matchSmallTalk } from './parsers/conversational-parser';
import { parseTemporal, shiftDays, shiftMonths } from './parsers/temporal-parser';

/** Saturday 2026-10-03 12:00 WIB. */
const NOW = new Date('2026-10-03T05:00:00.000Z');
const parse = (text: string, now = NOW) => validateIntent(parseIntent(text, now));

type Row = [text: string, intent: IntentName, symbols: string[]];

describe('intent matrix (brief §30) — every category has an explicit expected behaviour', () => {
  const table: Record<string, Row[]> = {
    quote: [
      ['BBCA', 'STOCK_QUOTE', ['BBCA']],
      ['harga BBCA', 'STOCK_QUOTE', ['BBCA']],
      ['berapa harga BBCA', 'STOCK_QUOTE', ['BBCA']],
      ['BBCA sekarang', 'STOCK_QUOTE', ['BBCA']],
    ],
    technical: [
      ['RSI BBCA', 'STOCK_TECHNICAL', ['BBCA']],
      ['berapa RSI BBCA', 'STOCK_TECHNICAL', ['BBCA']],
      ['bagaimana teknikal BBCA', 'STOCK_TECHNICAL', ['BBCA']],
      ['average volume BBCA', 'STOCK_TECHNICAL', ['BBCA']],
    ],
    analysis: [
      ['analisis BBCA', 'STOCK_ANALYSIS', ['BBCA']],
      ['tolong analisis BBCA', 'STOCK_ANALYSIS', ['BBCA']],
      ['BBCA bagus?', 'STOCK_QUESTION', ['BBCA']],
    ],
    'multiple symbols (never silently reduced to one)': [
      ['analisis BBCA BBRI', 'STOCK_ANALYSIS', ['BBCA', 'BBRI']],
      ['analisis BBCA dan BBRI', 'STOCK_ANALYSIS', ['BBCA', 'BBRI']],
      ['analisis BBCA, BBRI, BMRI', 'STOCK_ANALYSIS', ['BBCA', 'BBRI', 'BMRI']],
      ['bandingkan BBCA dengan BBRI', 'STOCK_COMPARISON', ['BBCA', 'BBRI']],
      ['bandingkan BBCA BBRI BMRI', 'STOCK_COMPARISON', ['BBCA', 'BBRI', 'BMRI']],
      ['PTBA dan ADRO mana yang lebih bagus', 'STOCK_COMPARISON', ['PTBA', 'ADRO']],
      ['RSI BBCA dan BBRI', 'STOCK_TECHNICAL', ['BBCA', 'BBRI']],
      [
        'harga BBCA BBRI BMRI BBNI TLKM ASII',
        'STOCK_QUOTE',
        ['BBCA', 'BBRI', 'BMRI', 'BBNI', 'TLKM', 'ASII'],
      ],
    ],
    watchlist: [
      ['tambahkan BBCA', 'WATCHLIST_ADD', ['BBCA']],
      ['tambahkan BBCA ke watchlist', 'WATCHLIST_ADD', ['BBCA']],
      ['hapus BBCA', 'WATCHLIST_REMOVE', ['BBCA']],
      ['lihat watchlist', 'WATCHLIST_LIST', []],
    ],
    alert: [
      ['ingatkan saya kalau BBCA di atas 8500', 'ALERT_CREATE', ['BBCA']],
      ['kasih tahu kalau BBCA turun di bawah 7800', 'ALERT_CREATE', ['BBCA']],
    ],
    "temporal (past -> historical lookup, never today's price)": [
      ['harga BBCA kemarin', 'STOCK_HISTORICAL', ['BBCA']],
      ['harga BBCA minggu lalu', 'STOCK_HISTORICAL', ['BBCA']],
      ['harga BBCA tanggal 1 Oktober 2026', 'STOCK_HISTORICAL', ['BBCA']],
      ['harga BBCA 3 hari lalu', 'STOCK_HISTORICAL', ['BBCA']],
      ['harga BBCA 2026-09-30', 'STOCK_HISTORICAL', ['BBCA']],
      ['harga BBCA 01/10/2026', 'STOCK_HISTORICAL', ['BBCA']],
      ['kenapa BBCA turun kemarin?', 'STOCK_HISTORICAL', ['BBCA']],
    ],
    'temporal (future -> prediction policy)': [
      ['harga BBCA besok', 'STOCK_ADVICE', ['BBCA']],
      ['berapa harga BBCA minggu depan?', 'STOCK_ADVICE', ['BBCA']],
    ],
    conversational: [
      ['halo', 'SMALL_TALK', []],
      ['hai', 'SMALL_TALK', []],
      ['hello', 'SMALL_TALK', []],
      ['selamat pagi', 'SMALL_TALK', []],
      ['Selamat Malam!', 'SMALL_TALK', []],
      ['terima kasih', 'SMALL_TALK', []],
      ['makasih', 'SMALL_TALK', []],
      ['thanks', 'SMALL_TALK', []],
      ['thx', 'SMALL_TALK', []],
      ['oke', 'SMALL_TALK', []],
      ['ok', 'SMALL_TALK', []],
      ['sip', 'SMALL_TALK', []],
      ['baik', 'SMALL_TALK', []],
      ['mantap', 'SMALL_TALK', []],
      ['terima kasih banyak kak', 'SMALL_TALK', []],
    ],
    'unsafe / advice-seeking (fixed policy answer, never the LLM)': [
      ['beli BBCA sekarang', 'STOCK_ADVICE', ['BBCA']],
      ['jual BBCA sekarang', 'STOCK_ADVICE', ['BBCA']],
      ['strong buy BBCA', 'STOCK_ADVICE', ['BBCA']],
      ['BBCA pasti naik', 'STOCK_ADVICE', ['BBCA']],
      ['BBCA akan naik ke 9000', 'STOCK_ADVICE', ['BBCA']],
      ['100% cuan BBCA', 'STOCK_ADVICE', ['BBCA']],
      ['apa target harga BBCA?', 'STOCK_ADVICE', ['BBCA']],
      ['prediksi BBCA besok', 'STOCK_ADVICE', ['BBCA']],
      ['BBCA naik gak?', 'STOCK_ADVICE', ['BBCA']],
      ['sebaiknya beli?', 'STOCK_ADVICE', []],
    ],
    screening: [
      ['saham apa yang naik hari ini?', 'STOCK_SCREEN', []],
      ['saham dengan RSI di bawah 30', 'STOCK_SCREEN', []],
      ['saham apa yang cocok dibeli', 'STOCK_SCREEN', []],
      ['saham apa yang bagus', 'STOCK_SCREEN', []],
      ['saham mana yang menarik', 'STOCK_SCREEN', []],
      ['rekomendasi saham', 'STOCK_SCREEN', []],
    ],
  };

  for (const [group, rows] of Object.entries(table)) {
    describe(group, () => {
      it.each(rows)('%s -> %s %j', (text, intent, symbols) => {
        const r = parse(text);
        expect(r.intent).toBe(intent);
        expect(r.symbols).toEqual(symbols);
      });
    });
  }

  it('advice kinds are classified with the right precedence', () => {
    const kind = (t: string) => parse(t).parameters.adviceKind;
    expect(kind('beli BBCA sekarang')).toBe('trade');
    expect(kind('apa target harga BBCA?')).toBe('target_price');
    expect(kind('BBCA pasti naik')).toBe('guarantee');
    expect(kind('100% cuan BBCA')).toBe('guarantee');
    expect(kind('strong buy BBCA')).toBe('guarantee');
    expect(kind('prediksi BBCA besok')).toBe('prediction');
    expect(kind('harga BBCA besok')).toBe('prediction');
  });

  it('an explicit analysis request containing advice wording still gets the analysis (with a policy notice)', () => {
    const r = parse('analisis BBCA, layak beli?');
    expect(r.intent).toBe('STOCK_ANALYSIS');
    expect(r.parameters.policyNotice).toBe('trade');
  });

  it('advice-like words that are not advice stay out of the advice path', () => {
    expect(parse('average volume BBCA').intent).toBe('STOCK_TECHNICAL');
    expect(parse('cara beli saham di aplikasi').intent).not.toBe('STOCK_ADVICE');
    expect(parse('kenapa BBCA turun hari ini').intent).toBe('STOCK_QUESTION');
  });

  it('screening with vague wording has EMPTY criteria (guidance, not a ranking)', () => {
    for (const t of [
      'saham apa yang cocok dibeli',
      'saham apa yang bagus',
      'saham mana yang menarik',
      'rekomendasi saham',
    ]) {
      expect(parse(t).parameters.criteria).toEqual({});
    }
  });

  it('supports combined deterministic criteria', () => {
    expect(
      parse('saham dengan RSI di bawah 30 dan volume di atas 2x rata-rata').parameters.criteria,
    ).toMatchObject({
      rsi: { lt: 30 },
      volumeRatio: { gt: 2 },
    });
  });
});

describe("time-scoped questions are never answered with today's data", () => {
  it('past date + technical/analysis/screen/etc. -> explicit "only current data" reply', () => {
    for (const t of [
      'RSI BBCA kemarin',
      'analisis BBCA minggu lalu',
      'saham apa yang naik kemarin',
      'bandingkan BBCA BBRI kemarin',
      'PER BBCA tahun lalu',
    ]) {
      const r = parse(t);
      expect(r.clarification).toMatch(/hanya menampilkan .* berdasarkan data terkini/);
    }
  });

  it('invalid dates are reported as invalid', () => {
    for (const t of [
      'harga BBCA 31 Februari 2026',
      'harga BBCA 30/02/2026',
      'harga BBCA 2026-13-01',
    ]) {
      expect(parse(t).clarification).toMatch(/tidak valid/);
    }
  });

  it('future date wording becomes a prediction-policy request', () => {
    const r = parse('harga BBCA 1 Januari 2027');
    expect(r.intent).toBe('STOCK_ADVICE');
    expect(r.parameters.adviceKind).toBe('prediction');
  });

  it('temporal words do not hijack alerts, watchlist or numbers like 8.500', () => {
    expect(parse('ingatkan saya kalau BBCA di atas 8500 besok').intent).toBe('ALERT_CREATE');
    expect(parse('ingatkan saya kalau BBCA di atas 8.500').parameters.value).toBe(8500);
    expect(parse('tambahkan BBCA ke watchlist kemarin').intent).toBe('WATCHLIST_ADD');
    expect(parseTemporal('harga BBCA 8.500')).toBeNull();
    expect(parseTemporal('harga BBCA')).toBeNull();
  });
});

describe('parseTemporal — calendar arithmetic (Asia/Jakarta)', () => {
  const at = (iso: string) => new Date(iso);
  const dateOf = (text: string, now: Date) => {
    const t = parseTemporal(text, now);
    return t && t.kind === 'date' ? t.date : t?.kind;
  };

  it('yesterday and N days ago', () => {
    expect(dateOf('kemarin', NOW)).toBe('2026-10-02');
    expect(dateOf('kemarin lusa', NOW)).toBe('2026-10-01');
    expect(dateOf('5 hari lalu', NOW)).toBe('2026-09-28');
    expect(dateOf('minggu lalu', NOW)).toBe('2026-09-26');
    expect(dateOf('2 minggu lalu', NOW)).toBe('2026-09-19');
  });

  it('uses the WIB calendar, not UTC (UTC evening is already the next day in Jakarta)', () => {
    // 2026-10-03T18:00Z == Sunday 2026-10-04 01:00 WIB
    expect(dateOf('kemarin', at('2026-10-03T18:00:00.000Z'))).toBe('2026-10-03');
  });

  it('month and year boundaries, clamping and leap years', () => {
    expect(dateOf('kemarin', at('2026-03-01T05:00:00.000Z'))).toBe('2026-02-28');
    expect(dateOf('kemarin', at('2028-03-01T05:00:00.000Z'))).toBe('2028-02-29'); // leap year
    expect(dateOf('bulan lalu', at('2026-03-31T05:00:00.000Z'))).toBe('2026-02-28'); // clamped
    expect(dateOf('1 tahun lalu', at('2028-02-29T05:00:00.000Z'))).toBe('2027-02-28');
    expect(dateOf('kemarin', at('2027-01-01T05:00:00.000Z'))).toBe('2026-12-31');
    expect(shiftDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftMonths('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('explicit dates in several formats (month names, ISO, dd/mm/yyyy, abbreviations)', () => {
    expect(dateOf('tanggal 1 Oktober 2026', NOW)).toBe('2026-10-01');
    expect(dateOf('1 okt 2026', NOW)).toBe('2026-10-01');
    expect(dateOf('17 Agustus 2026', NOW)).toBe('2026-08-17');
    expect(dateOf('2026-09-30', NOW)).toBe('2026-09-30');
    expect(dateOf('30/09/2026', NOW)).toBe('2026-09-30');
    expect(dateOf('30-09-2026', NOW)).toBe('2026-09-30');
    expect(dateOf('5 mei', NOW)).toBe('2026-05-05'); // default: current year
  });

  it('future dates and wording are "future"; impossible dates are "invalid"', () => {
    expect(dateOf('besok', NOW)).toBe('future');
    expect(dateOf('lusa', NOW)).toBe('future');
    expect(dateOf('bulan depan', NOW)).toBe('future');
    expect(dateOf('1 Desember 2026', NOW)).toBe('future'); // later this year
    expect(dateOf('1 Januari 2027', NOW)).toBe('future');
    expect(dateOf('29 Februari 2027', NOW)).toBe('invalid'); // 2027 is not a leap year
    expect(dateOf('31 April 2026', NOW)).toBe('invalid');
  });
});

describe('small talk matching', () => {
  it('matches whole-message greetings/thanks/acks only', () => {
    expect(matchSmallTalk('terima kasih')).toEqual({ kind: 'thanks' });
    expect(matchSmallTalk('makasiii')).toEqual({ kind: 'thanks' });
    expect(matchSmallTalk('selamat siang')).toEqual({ kind: 'greeting', daypart: 'siang' });
    expect(matchSmallTalk('oke deh')).toEqual({ kind: 'ack' });
  });

  it('never swallows a real request', () => {
    for (const t of [
      'halo BBCA',
      'terima kasih, analisis BBCA',
      'ok analisis BBCA',
      'oke BBCA bagus?',
      'halo bisa bantu analisis saham BBRI hari ini ya',
    ]) {
      expect(parse(t).intent).not.toBe('SMALL_TALK');
    }
  });
});

describe('robustness', () => {
  it('stays linear on hostile input (no ReDoS)', () => {
    const inputs = [
      'ingatkan BBCA ' + 'di atas '.repeat(5000),
      'ingatkan BBCA di atas ' + '1.'.repeat(10000),
      'harga BBCA ' + 'kemarin '.repeat(5000),
      '1 '.repeat(20000) + 'okt',
      'x'.repeat(100000),
    ];
    for (const text of inputs) {
      const t0 = Date.now();
      parseIntent(text, NOW);
      expect(Date.now() - t0).toBeLessThan(1000);
    }
  });
});

describe('validateIntent — AI-produced parameters are sanitised', () => {
  const ai = (
    intent: IntentName,
    parameters: Record<string, unknown>,
    symbols: string[] = [],
  ): ParsedIntent => ({
    intent,
    symbols,
    parameters,
    confidence: 'low',
    source: 'ai',
    text: 'x',
  });

  it('drops malformed screening criteria instead of passing them to the screener', () => {
    expect(
      validateIntent(ai('STOCK_SCREEN', { criteria: { rsi: { lt: 'banyak' }, sort: 'DROP' } }))
        .parameters,
    ).toEqual({ criteria: {} });
    expect(
      validateIntent(ai('STOCK_SCREEN', { criteria: { rsi: { lt: 30 } } })).parameters,
    ).toEqual({ criteria: { rsi: { lt: 30 } } });
    expect(
      validateIntent(ai('STOCK_SCREEN', { criteria: { unknownField: 1 } })).parameters,
    ).toEqual({ criteria: {} });
  });

  it('keeps only known technical topics, valid delete indexes and known advice kinds', () => {
    expect(
      validateIntent(ai('STOCK_TECHNICAL', { topics: ['rsi', 'rm -rf', 5] }, ['BBCA'])).parameters,
    ).toEqual({ topics: ['rsi'] });
    expect(validateIntent(ai('STOCK_ADVICE', { adviceKind: 'hack' }, ['BBCA'])).parameters).toEqual(
      { adviceKind: 'trade' },
    );
  });

  it('never lets the model supply dates for a historical lookup', () => {
    const r = validateIntent(
      ai('STOCK_HISTORICAL', { temporal: { kind: 'date', date: '2020-01-01' } }, ['BBCA']),
    );
    expect(r.parameters).toEqual({});
  });

  it('still drops invented tickers and caps the symbol count', () => {
    const r = validateIntent(
      ai('STOCK_COMPARISON', {}, [
        'bbca',
        'TOOLONG',
        '1234',
        ...Array.from(
          { length: 30 },
          (_, i) =>
            `AA${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`,
        ),
      ]),
    );
    expect(r.symbols[0]).toBe('BBCA');
    expect(r.symbols.length).toBeLessThanOrEqual(20);
    expect(r.symbols).not.toContain('TOOLONG');
  });
});

describe("the AI classifier can never change the user's data", () => {
  const ai = (intent: IntentName, parameters: Record<string, unknown>, symbols: string[] = []) => ({
    intent,
    symbols,
    parameters,
    confidence: 'low' as const,
    source: 'ai' as const,
    text: 'tolong rapikan semuanya ya',
  });

  it.each([
    ['ALERT_DELETE', { all: true }, []],
    ['ALERT_DELETE', { index: 1 }, []],
    ['ALERT_CREATE', { metric: 'price', condition: 'above', value: 100 }, ['BBCA']],
    ['WATCHLIST_ADD', {}, ['BBCA']],
    ['WATCHLIST_REMOVE', {}, ['BBCA']],
  ] as const)(
    'AI-classified %s is turned into a clarification, not an action',
    (name, params, syms) => {
      const r = validateIntent(ai(name, { ...params }, [...syms]));
      expect(r.intent).toBe('UNKNOWN');
      expect(r.parameters).toEqual({});
      expect(r.clarification).toBe(AI_STATE_CHANGE_REFUSED);
    },
  );

  it('read-only AI intents still work', () => {
    expect(validateIntent(ai('STOCK_QUOTE', {}, ['BBCA'])).intent).toBe('STOCK_QUOTE');
    expect(validateIntent(ai('WATCHLIST_LIST', {})).intent).toBe('WATCHLIST_LIST');
  });

  it('the same intents from the deterministic rules are untouched', () => {
    expect(parseIntent('hapus alert 1').intent).toBe('ALERT_DELETE');
    expect(parseIntent('tambahkan BBCA ke watchlist').intent).toBe('WATCHLIST_ADD');
  });

  it('filling a missing ticker from the conversation does not launder an AI guess into a trusted source', () => {
    const svc = new IntentService({} as never, {} as never);
    const filled = svc.applyContext(ai('WATCHLIST_ADD', {}), {
      lastSymbols: ['BBCA'],
      updatedAt: new Date().toISOString(),
    });
    expect(filled.source).toBe('ai');
    expect(validateIntent(filled).intent).toBe('UNKNOWN');
  });
});
