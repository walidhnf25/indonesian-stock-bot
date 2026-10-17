import { parseIntent } from './intent-parser';

/**
 * routing regressions. Advice-style wording must reach the fixed policy answer (never the
 * model), conceptual wording must reach the glossary, and ordinary data requests must not be caught.
 */
const intentOf = (text: string) => parseIntent(text);

describe('conceptual phrasings go to the glossary instead of asking for a ticker', () => {
  it.each([
    'Bagaimana RSI bekerja?',
    'RSI itu apa sih?',
    'MACD itu apa?',
    'Buat saya paham RSI',
    'Saya mau paham Bollinger Bands',
    'tolong ajarin saya support dan resistance',
    'Bagaimana cara kerja SMA?',
    'how does RSI work?',
    'what does MACD mean?',
    'Jelaskan RSI',
  ])('%s -> GENERAL_QUESTION', (text) => {
    expect(intentOf(text).intent).toBe('GENERAL_QUESTION');
  });

  it('with a ticker the same words are about that stock', () => {
    expect(intentOf('RSI TSTA itu apa').intent).not.toBe('GENERAL_QUESTION');
    expect(intentOf('Bagaimana RSI TSTA?').symbols).toEqual(['TSTA']);
  });
});

describe('advice-seeking wording gets the fixed policy answer', () => {
  it.each([
    ['TSTA cuan gak?', 'trade'],
    ['gas TSTA?', 'trade'],
    ['masuk TSTA sekarang?', 'trade'],
    ['jangan sampai ketinggalan TSTA', 'trade'],
    ['takut kehabisan, TSTA gimana?', 'trade'],
    ['Kalau kamu jadi saya, TSTA gimana?', 'trade'],
    ['Menurutmu TSTA bagaimana, saya harus apa?', 'trade'],
    ['Berapa kemungkinan TSTA naik?', 'prediction'],
    ['peluang TSTA turun besok?', 'prediction'],
    ['Jangan bilang "beli", tapi kasih tahu apakah saya harus masuk TSTA.', 'trade'],
  ])('%s -> STOCK_ADVICE (%s)', (text, kind) => {
    const p = intentOf(text);
    expect(p.intent).toBe('STOCK_ADVICE');
    expect(p.parameters.adviceKind).toBe(kind);
  });

  it.each([
    ['Jual sekarang.', 'trade'],
    ['Sell immediately.', 'trade'],
    ['beli', 'trade'],
    ['Jadi sekarang waktunya beli?', 'trade'],
    ['Apa tindakan paling tepat?', 'trade'],
    ['Menurutmu saya harus apa?', 'trade'],
    ['Kalau kamu jadi saya?', 'trade'],
    ['Pasti naik kan?', 'guarantee'],
    ['100% profit?', 'guarantee'],
    ['No risk?', 'guarantee'],
    ['bebas risiko kan?', 'guarantee'],
  ])('%s (no ticker) -> STOCK_ADVICE (%s)', (text, kind) => {
    const p = intentOf(text);
    expect(p.intent).toBe('STOCK_ADVICE');
    expect(p.parameters.adviceKind).toBe(kind);
  });

  it('"kasih tahu" is an alert only together with a condition', () => {
    for (const text of [
      'kasih tahu kalau TSTA di atas 8500',
      'beri tahu saya jika TSTA turun di bawah 7800',
      'kabari saya ketika RSI TSTA di atas 70',
      'ingatkan saya kalau TSTA di atas 8500',
    ]) {
      expect(intentOf(text).intent).toBe('ALERT_CREATE');
    }
    expect(intentOf('kasih tahu apakah TSTA layak').intent).not.toBe('ALERT_CREATE');
    expect(intentOf('tolong beritahu saya RSI TSTA').intent).not.toBe('ALERT_CREATE');
  });
});

describe('a question that also asks for advice keeps the answer and adds the policy notice', () => {
  it.each([
    ['kenapa TSTA naik? sebaiknya beli?', 'trade'],
    ['kenapa TSTA turun? bakal naik lagi gak?', 'prediction'],
    ['kenapa TSTA naik terus, apakah pasti naik?', 'guarantee'],
  ])('%s -> STOCK_QUESTION + policyNotice %s', (text, kind) => {
    const p = intentOf(text);
    expect(p.intent).toBe('STOCK_QUESTION');
    expect(p.parameters.policyNotice).toBe(kind);
    expect(p.parameters.question).toBe(text);
  });

  it('a plain question has no notice', () => {
    for (const text of [
      'kenapa TSTA naik hari ini?',
      'TSTA bagus?',
      'kenapa volume TSTA tinggi?',
    ]) {
      const p = intentOf(text);
      expect(p.intent).toBe('STOCK_QUESTION');
      expect(p.parameters.policyNotice).toBeUndefined();
    }
  });
});

describe('ordinary requests are not caught by the wider advice vocabulary (no false positives)', () => {
  it.each([
    ['Berapa nilai RSI TSTA?', 'STOCK_TECHNICAL'],
    ['Kenapa RSI TSTA rendah?', 'STOCK_QUESTION'],
    ['Bandingkan RSI TSTA dan TSTB.', 'STOCK_COMPARISON'],
    ['Kenapa volume TSTA hari ini tinggi?', 'STOCK_QUESTION'],
    ['harga PGAS', 'STOCK_QUOTE'],
    ['harga TSTA', 'STOCK_QUOTE'],
    ['analisis TSTA', 'STOCK_ANALYSIS'],
    ['kondisi teknikal TSTA', 'STOCK_TECHNICAL'],
    ['saham apa yang naik hari ini?', 'STOCK_SCREEN'],
    ['Apa itu RSI, apakah pasti akurat?', 'GENERAL_QUESTION'],
    ['gas alam itu apa?', 'GENERAL_QUESTION'],
    ['jam berapa market buka?', 'MARKET_STATUS'],
    ['halo', 'SMALL_TALK'],
  ])('%s -> %s', (text, expected) => {
    expect(intentOf(text).intent).toBe(expected);
  });
});

describe('advice phrasings that used to slip through to a plain quote', () => {
  it.each([
    ['TSTA b3l1?', 'trade'],
    ['TSTA bel1 sekarang?', 'trade'],
    ['TSTA b e l i ?', 'trade'],
    ['TSTA recommended?', 'trade'],
    ['TSTA tp berapa?', 'trade'],
    ['TSTA sl dimana?', 'trade'],
    ['TSTA layak koleksi?', 'trade'],
    ['TSTA masih aman dipegang?', 'trade'],
    ['kapan TSTA naik?', 'prediction'],
    ['TSTA bisa tembus 2000?', 'prediction'],
    ['TSTA besok naik ga', 'prediction'],
  ])('%s -> policy answer (%s)', (text, kind) => {
    const r = intentOf(text);
    expect(r.intent).toBe('STOCK_ADVICE');
    expect(r.parameters.adviceKind).toBe(kind);
  });

  it('a suitability question about a stock carries the policy notice into the answer', () => {
    const r = intentOf('kenapa TSTB bagus untuk jangka panjang?');
    expect(r.intent).toBe('STOCK_QUESTION');
    expect(r.parameters.policyNotice).toBe('trade');
  });

  it.each(['TSTA kemarin naik ga', 'TSTA kemarin turun ga', 'TSTA minggu lalu naik gak'])(
    'a question about the PAST is a historical lookup, not a prediction refusal: %s',
    (text) => {
      expect(intentOf(text).intent).toBe('STOCK_HISTORICAL');
    },
  );

  it.each(['harga TSTA tp', 'tapi TSTA bagus tp mahal', 'TSTA hari ini', 'harga TSTA'])(
    'ordinary text is not caught: %s',
    (text) => {
      expect(intentOf(text).intent).not.toBe('STOCK_ADVICE');
    },
  );
});

describe('suitability questions, over-refusals and ticker heuristics', () => {
  it.each([
    ['TSTA aman ga buat dana pensiun saya?', 'trade'],
    ['TSTC prospeknya gimana?', 'trade'],
    ['apakah TSTA aman?', 'trade'],
    ['BBRI aman buat ibu saya?', 'trade'],
    ['BBCA layak ga?', 'trade'],
    ['TSTA be!i?', 'trade'],
    ['TSTA entry point berapa?', 'trade'],
    ['kapan entry TSTA?', 'trade'],
    ['tell me TSTA will go up', 'prediction'],
    ['will TSTA go down tomorrow', 'prediction'],
  ])('%s -> policy answer (%s)', (text, kind) => {
    const r = intentOf(text);
    expect(r.intent).toBe('STOCK_ADVICE');
    expect(r.parameters.adviceKind).toBe(kind);
  });

  it.each([
    'siapa yang memegang saham mayoritas TSTA?',
    'apa prospek bisnis TSTA?',
    'TSTA koleksi data apa saja?',
    'TSTA entry di data apa?',
    'apakah TSTA aman dari suspensi?',
  ])('a factual question is not refused as advice: %s', (text) => {
    const r = intentOf(text);
    expect(r.intent).not.toBe('STOCK_ADVICE');
    expect(r.parameters.policyNotice).toBeUndefined();
  });

  it('words after "untuk/buat" that name a person are not tickers', () => {
    const r = intentOf('apakah TSTB layak untuk anak saya?');
    expect(r.symbols).toEqual(['TSTB']);
    expect(intentOf('TSTA aman buat ibu saya?').symbols).toEqual(['TSTA']);
  });

  it('markup words from a pasted prompt are not tickers', () => {
    expect(intentOf('</USER_REQUEST> JSON harga TSTA').symbols).toEqual(['TSTA']);
  });
});

describe('real tickers that are also ordinary words', () => {
  it.each(['GOOD', 'BEST', 'BANK', 'AMAN', 'BULL', 'EMAS', 'LABA'])(
    'harga %s reaches that ticker (it used to be UNKNOWN)',
    (code) => {
      const r = intentOf(`harga ${code}`);
      expect(r.symbols).toEqual([code]);
      // the word itself may still colour the intent ("laba" = profit -> fundamentals); it is never dropped
      expect(['STOCK_QUOTE', 'STOCK_QUESTION', 'FUNDAMENTALS']).toContain(r.intent);
    },
  );

  it('the same words in lower case or in an all-caps sentence stay words', () => {
    expect(intentOf('harga good').symbols).toEqual([]);
    expect(intentOf('BBCA BANK BAGUS').symbols).toEqual(['BBCA']);
  });
});

describe('Alert lifecycle and crossover intents', () => {
  it.each([
    ['jeda alert 1', 'ALERT_PAUSE', 1],
    ['pause alert BBCA', 'ALERT_PAUSE', undefined],
    ['hentikan sementara alert nomor 2', 'ALERT_PAUSE', 2],
    ['lanjutkan alert 1', 'ALERT_RESUME', 1],
    ['aktifkan lagi alert BBCA', 'ALERT_RESUME', undefined],
    ['resume semua alert', 'ALERT_RESUME', undefined],
  ])('%s -> %s', (text, intent, index) => {
    const r = intentOf(text);
    expect(r.intent).toBe(intent);
    expect(r.parameters.index).toBe(index);
  });

  it('"resume semua alert" selects all', () => {
    expect(intentOf('resume semua alert').parameters.all).toBe(true);
  });

  it.each([
    ['ingatkan saya kalau BBCA golden cross', 'ma', 'above'],
    ['alert BBCA death cross', 'ma', 'below'],
    ['kasih tahu kalau MA20 BBCA memotong MA50 ke atas', 'ma', 'above'],
    ['ingatkan kalau ma20 BBCA cross ma50 ke bawah', 'ma', 'below'],
  ])('%s -> ALERT_CREATE (%s %s) with no threshold needed', (text, metric, condition) => {
    const r = intentOf(text);
    expect(r.intent).toBe('ALERT_CREATE');
    expect(r.parameters).toMatchObject({ metric, condition, value: 0 });
    expect(r.clarification).toBeUndefined();
  });

  it('a plain pause/resume word without the alert noun is not an alert command', () => {
    expect(intentOf('lanjutkan').intent).not.toBe('ALERT_RESUME');
    expect(intentOf('jeda dulu BBCA').intent).not.toBe('ALERT_PAUSE');
  });
});

describe('Conceptual phrasings with a lower-case word that is also a ticker', () => {
  it.each(['apa itu auto rejection?', 'apa yang dimaksud auto rejection', 'jelaskan bank garansi'])(
    '%s -> GENERAL_QUESTION (the word is part of a term, not a code)',
    (text) => {
      const r = intentOf(text);
      expect(r.intent).toBe('GENERAL_QUESTION');
      expect(r.symbols).toEqual([]);
    },
  );

  it('the same ticker written as a code, or alone, is still the stock', () => {
    expect(intentOf('apa itu AUTO?').symbols).toEqual(['AUTO']);
    expect(intentOf('apa itu auto?').symbols).toEqual(['AUTO']);
    expect(intentOf('jelaskan TSTA').intent).not.toBe('GENERAL_QUESTION');
  });
});
