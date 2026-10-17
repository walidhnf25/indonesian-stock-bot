import { parseIntent } from '../intent-parser';
import { TemporalRef } from '../intent.types';
import { parseTemporal, shiftDays } from './temporal-parser';

/** Saturday 3 October 2026, 12:00 WIB. Every expectation below is relative to this fixed instant. */
const NOW = new Date('2026-10-03T05:00:00.000Z');
const date = (text: string, now = NOW) => {
  const r = parseTemporal(text, now);
  return r && r.kind === 'date' ? r.date : r;
};

describe('parseTemporal: a time reference is never silently treated as "now"', () => {
  it('returns null only for messages that are about the present', () => {
    expect(parseTemporal('harga BBCA', NOW)).toBeNull();
    expect(parseTemporal('harga BBCA hari ini', NOW)).toBeNull();
    expect(parseTemporal('harga BBCA sekarang', NOW)).toBeNull();
    expect(parseTemporal('analisis BBCA lalu bandingkan dengan BBRI', NOW)).toBeNull(); // "lalu" = "then"
  });

  describe('relative days, weeks, months, years (Indonesian)', () => {
    it.each([
      ['harga BBCA kemarin', '2026-10-02'],
      ['harga BBCA kemarin lusa', '2026-10-01'],
      ['harga BBCA semalam', '2026-10-02'],
      ['harga BBCA minggu lalu', '2026-09-26'],
      ['harga BBCA seminggu lalu', '2026-09-26'],
      ['harga BBCA minggu kemarin', '2026-09-26'], // used to resolve to yesterday
      ['harga BBCA pekan lalu', '2026-09-26'],
      ['harga BBCA bulan lalu', '2026-09-03'],
      ['harga BBCA bulan kemarin', '2026-09-03'], // used to resolve to yesterday
      ['harga BBCA tahun lalu', '2025-10-03'],
      ['harga BBCA tahun kemarin', '2025-10-03'],
      ['harga BBCA 7 hari lalu', '2026-09-26'],
      ['harga BBCA 7 hari yang lalu', '2026-09-26'],
      ['harga BBCA dua hari lalu', '2026-10-01'], // number words were not understood
      ['harga BBCA tiga hari yang lalu', '2026-09-30'],
      ['harga BBCA sehari lalu', '2026-10-02'],
      ['harga BBCA 3 minggu lalu', '2026-09-12'],
      ['harga BBCA 2 bulan lalu', '2026-08-03'],
      ['harga BBCA 1 tahun lalu', '2025-10-03'],
    ])('%s -> %s', (text, expected) => {
      expect(date(text)).toBe(expected);
    });

    it('large offsets still resolve to a date (the handler then says it is outside the history)', () => {
      expect(date('harga BBCA 1000 hari lalu')).toBe(shiftDays('2026-10-03', -1000));
    });
  });

  describe('English', () => {
    it.each([
      ['BBCA price yesterday', '2026-10-02'],
      ['BBCA last week', '2026-09-26'],
      ['BBCA last month', '2026-09-03'],
      ['BBCA last year', '2025-10-03'],
      ['BBCA 3 days ago', '2026-09-30'],
      ['BBCA two weeks ago', '2026-09-19'],
    ])('%s -> %s', (text, expected) => {
      expect(date(text)).toBe(expected);
    });
  });

  describe('weekday names (today is a Saturday)', () => {
    it.each([
      ['harga BBCA Jumat lalu', '2026-10-02'],
      ['harga BBCA Jumat', '2026-10-02'],
      ['harga BBCA Sabtu', '2026-10-03'], // today itself: a non-trading day, handled explicitly later
      ['harga BBCA Sabtu lalu', '2026-09-26'], // "last Saturday" said on a Saturday is a week ago
      ['harga BBCA hari Minggu', '2026-09-27'],
      ['harga BBCA Senin', '2026-09-28'],
      ['harga BBCA Rabu kemarin', '2026-09-30'],
    ])('%s -> %s', (text, expected) => {
      expect(date(text)).toBe(expected);
    });

    it('"minggu" alone is a WEEK ("minggu lalu"), never the weekday Sunday', () => {
      expect(date('harga BBCA minggu lalu')).toBe('2026-09-26');
    });
  });

  describe('explicit dates', () => {
    it.each([
      ['harga BBCA tanggal 25 September 2026', '2026-09-25'],
      ['harga BBCA 25/09/2026', '2026-09-25'],
      ['harga BBCA 25-09-2026', '2026-09-25'],
      ['harga BBCA 2026-09-25', '2026-09-25'],
      ['harga BBCA pada 2026-09-30', '2026-09-30'],
      ['harga BBCA 25 Sep', '2026-09-25'], // year defaults to the current one
    ])('%s -> %s', (text, expected) => {
      expect(date(text)).toBe(expected);
    });

    it('a non-trading date (weekend) is still returned as that date: the handler states the fallback', () => {
      expect(date('harga BBCA 2026-09-27')).toBe('2026-09-27'); // a Sunday
      expect(date('harga BBCA 17 Agustus 2026')).toBe('2026-08-17'); // a public holiday
    });
  });

  describe('future and malformed', () => {
    it.each([
      'harga BBCA besok',
      'harga BBCA tomorrow',
      'harga BBCA minggu depan',
      'harga BBCA next week',
      'harga BBCA Jumat depan', // used to be read as the PAST Friday
      'harga BBCA 25 Desember 2026',
      'harga BBCA 2026-12-31',
    ])('%s is a future reference', (text) => {
      expect(parseTemporal(text, NOW)?.kind).toBe('future');
    });

    it.each([
      'harga BBCA 31 Februari 2026',
      'harga BBCA 2026-02-30',
      'harga BBCA 32/01/2026',
      'harga BBCA 29/02/2027',
    ])('%s is invalid (never coerced into another date)', (text) => {
      expect(parseTemporal(text, NOW)?.kind).toBe('invalid');
    });
  });

  describe('references a daily close cannot answer are "unsupported", not answered with today\'s price', () => {
    it.each([
      ['harga BBCA tahun 2025', 'period'],
      ['harga BBCA di 2025', 'period'],
      ['harga BBCA Agustus 2026', 'period'],
      ['harga BBCA bulan Agustus', 'period'],
      ['harga BBCA kuartal 2', 'period'],
      ['harga BBCA akhir bulan', 'period'],
      ['harga BBCA tadi pagi', 'intraday'],
      ['harga BBCA jam 10', 'intraday'],
      ['harga BBCA 2 jam lalu', 'intraday'],
      ['harga BBCA 15 menit lalu', 'intraday'],
      ['harga BBCA pas buka', 'intraday'],
      ['BBCA this morning', 'intraday'],
    ])('%s -> unsupported (%s)', (text, reason) => {
      expect(parseTemporal(text, NOW)).toMatchObject({ kind: 'unsupported', reason });
    });
  });

  describe('trading-session references are resolved against the real candles later', () => {
    it.each([
      ['harga BBCA last trading day', 0],
      ['harga BBCA hari bursa terakhir', 0],
      ['harga BBCA penutupan terakhir', 0],
      ['harga BBCA previous trading day', -1],
      ['harga BBCA hari bursa sebelumnya', -1],
    ])('%s -> session %i', (text, offset) => {
      expect(parseTemporal(text, NOW)).toMatchObject({ kind: 'session', offset });
    });
  });

  describe('Asia/Jakarta calendar boundary', () => {
    it('one second before midnight WIB "kemarin" is still the previous WIB day', () => {
      // 2026-10-02T16:59:59Z = 2026-10-02 23:59:59 WIB
      expect(date('harga BBCA kemarin', new Date('2026-10-02T16:59:59.000Z'))).toBe('2026-10-01');
    });
    it('at midnight WIB the day has rolled over', () => {
      // 2026-10-02T17:00:00Z = 2026-10-03 00:00:00 WIB
      expect(date('harga BBCA kemarin', new Date('2026-10-02T17:00:00.000Z'))).toBe('2026-10-02');
    });
  });
});

describe('parseIntent with time references (end to end through the parser)', () => {
  const p = (text: string) => parseIntent(text, NOW);

  it.each([
    ['harga BBCA kemarin', 'STOCK_HISTORICAL'],
    ['harga BBCA yesterday', 'STOCK_HISTORICAL'],
    ['harga BBCA dua hari lalu', 'STOCK_HISTORICAL'],
    ['harga BBCA Jumat lalu', 'STOCK_HISTORICAL'],
    ['harga BBCA minggu kemarin', 'STOCK_HISTORICAL'],
    ['harga BBCA last trading day', 'STOCK_HISTORICAL'],
    ['harga BBCA hari bursa sebelumnya', 'STOCK_HISTORICAL'],
    ['harga BBCA 2026-09-30', 'STOCK_HISTORICAL'],
    ['harga BBCA Sabtu', 'STOCK_HISTORICAL'],
    ['harga BBCA Minggu lalu'.replace('Minggu lalu', 'hari Minggu'), 'STOCK_HISTORICAL'],
  ])('%s -> %s (a lookup of THAT day, not the current quote)', (text, intent) => {
    expect(p(text).intent).toBe(intent);
  });

  it('a future date becomes the prediction policy answer, never a price', () => {
    const r = p('harga BBCA besok');
    expect(r).toMatchObject({ intent: 'STOCK_ADVICE' });
    expect(r.parameters).toMatchObject({ adviceKind: 'prediction' });
  });

  it.each([
    'harga BBCA tahun 2025',
    'harga BBCA tadi pagi',
    'harga BBCA 2 jam lalu',
    'harga BBCA Agustus 2026',
    'analisis BBCA tahun 2025',
    'RSI BBCA tadi pagi',
  ])('%s gets an explicit clarification and no data lookup', (text) => {
    const r = p(text);
    expect(r.clarification).toBeDefined();
    expect(r.clarification).toMatch(/penutupan harian|satu tanggal tertentu/);
  });

  it.each(['harga BBCA 31 Februari 2026', 'harga BBCA 2026-02-30'])(
    '%s is rejected as an invalid date',
    (text) => {
      expect(p(text).clarification).toMatch(/tidak valid/);
    },
  );

  it('current-data requests are unchanged', () => {
    expect(p('harga BBCA').intent).toBe('STOCK_QUOTE');
    expect(p('harga BBCA hari ini').intent).toBe('STOCK_QUOTE');
    expect(p('analisis BBCA').intent).toBe('STOCK_ANALYSIS');
    expect(p('analisis BBCA').clarification).toBeUndefined();
  });

  it('every reference in this file resolves to something explicit (never "null" for a time word)', () => {
    const refs: TemporalRef['kind'][] = ['date', 'session', 'future', 'invalid', 'unsupported'];
    for (const text of [
      'kemarin',
      'yesterday',
      'dua hari lalu',
      'tahun 2025',
      'tadi pagi',
      'besok',
      '2026-02-30',
      'hari bursa terakhir',
    ]) {
      expect(refs).toContain(parseTemporal(`harga BBCA ${text}`, NOW)?.kind);
    }
  });
});

describe("no silent fall-through to today's price", () => {
  it.each([
    'harga BBCA pukul 09.15 kemarin', // used to answer with yesterday's close and drop the time
    'harga BBCA pukul 9 kemarin',
    'harga BBCA 2026-10-01 jam 10:00',
    'harga BBCA tanggal 1 Oktober 2026 pukul 14.30',
    'harga BBCA saat pembukaan',
    'harga BBCA pas pembukaan kemarin',
    'harga BBCA waktu opening',
  ])('%s -> intraday (a time of day wins over any date next to it)', (text) => {
    expect(parseTemporal(text, NOW)).toMatchObject({ kind: 'unsupported', reason: 'intraday' });
  });

  it.each([
    'harga BBCA kuartal lalu',
    'harga BBCA kuartal ini',
    'harga BBCA triwulan 3',
    'harga BBCA semester lalu',
    'harga BBCA semester ini',
  ])('%s -> period', (text) => {
    expect(parseTemporal(text, NOW)).toMatchObject({ kind: 'unsupported', reason: 'period' });
  });

  it('"penutupan kemarin" (yesterday\'s close) is still a normal historical request', () => {
    expect(parseTemporal('harga BBCA penutupan kemarin', NOW)).toMatchObject({
      kind: 'date',
      date: '2026-10-02',
    });
  });

  describe('lone years and day/month without a year, for quote-like questions', () => {
    it.each([
      ['harga BBCA 2025', 'period'],
      ['BBCA 2024', 'period'],
      ['bagaimana BBCA 1999', 'period'],
      ['harga BBCA 2/10', 'incomplete'],
      ['BBCA 02-10', 'incomplete'],
      ['harga BBCA 31/12', 'incomplete'],
    ])("%s is not answered with today's price", (text, reason) => {
      const p = parseIntent(text, NOW);
      expect(['STOCK_QUOTE', 'STOCK_QUESTION']).toContain(p.intent);
      expect(p.clarification).toBeDefined();
      expect(p.clarification).toMatch(
        reason === 'incomplete' ? /belum lengkap/ : /satu tanggal tertentu/,
      );
    });

    it.each([
      'harga BBCA hari ini',
      'harga BBCA 2.025', // a price written with a thousands separator
      'harga BBCA Rp2025',
      'harga BBCA 20/50', // not a date: month > 12
      'harga BBCA 12.30',
      'BBCA',
    ])('%s is left alone (no false clarification)', (text) => {
      expect(parseIntent(text, NOW).clarification).toBeUndefined();
    });

    it('alerts and analysis keep their numbers: a threshold that looks like a year is a threshold', () => {
      const alert = parseIntent('ingatkan saya kalau BBCA di atas 2025', NOW);
      expect(alert.intent).toBe('ALERT_CREATE');
      expect(alert.clarification).toBeUndefined();
      expect(alert.parameters).toMatchObject({ metric: 'price', condition: 'above', value: 2025 });
    });

    it('a complete date still wins', () => {
      const p = parseIntent('harga BBCA 2/10/2026', NOW);
      expect(p.intent).toBe('STOCK_HISTORICAL');
    });
  });
});

describe('temporal parser edge cases', () => {
  const intent = (text: string, now = NOW) => parseIntent(text, now);

  it.each([
    'harga TSTA 5 marketing',
    'kenapa TSTA naik 2 sepanjang minggu',
    'TSTA 3 desimal',
    '1 apresiasi TSTA',
    'TSTA 10 jantung',
  ])('a word that merely starts like a month is not a date: %s', (text) => {
    expect(parseTemporal(text, NOW)).toBeNull();
    expect(intent(text).intent).not.toBe('STOCK_HISTORICAL');
  });

  it.each([
    ['5 mar', '2026-03-05'],
    ['5 maret', '2026-03-05'],
    ['5 mar.', '2026-03-05'],
    ['5 march 2026', '2026-03-05'],
    ['3 sep', '2026-09-03'],
    ['3 sept', '2026-09-03'],
    ['3 september', '2026-09-03'],
    ['17 agu 2026', '2026-08-17'],
    ['1 Mei', '2026-05-01'],
    ['9 Dec 2025', '2025-12-09'],
  ])('real month spellings still work: %s', (text, iso) => {
    expect(date(`harga TSTA ${text}`)).toBe(iso);
  });

  it('a date without a year means its most recent PAST occurrence, never "the future"', () => {
    expect(date('TSTA 31 desember', new Date('2026-01-01T00:30:00+07:00'))).toBe('2025-12-31');
    expect(date('TSTA 5 november')).toBe('2025-11-05'); // 3 Oct 2026: 5 Nov 2026 has not happened yet
    expect(date('TSTA 2 oktober')).toBe('2026-10-02');
    expect(date('TSTA 3 oktober')).toBe('2026-10-03'); // today itself
    expect(date('TSTA 29 februari')).toBe('2024-02-29'); // 2026 is not a leap year: the last real 29 February
    expect(date('TSTA 31 februari')).toMatchObject({ kind: 'invalid' }); // never a real date
  });

  it('an explicit future year stays a future date', () => {
    expect(parseTemporal('TSTA 5 november 2026', NOW)).toMatchObject({ kind: 'future' });
  });

  it.each(['harga TSTA tanggal 1', 'TSTA tgl 15', 'TSTA tanggal ke-3'])(
    '"%s" asks for the month instead of silently answering with today\'s price',
    (text) => {
      expect(parseTemporal(text, NOW)).toMatchObject({ kind: 'unsupported', reason: 'incomplete' });
      const r = intent(text);
      expect(r.intent).toBe('STOCK_QUOTE');
      expect(r.clarification).toMatch(/belum lengkap/);
    },
  );

  it('"tanggal 5 oktober" is a complete date and wins over the day-only rule', () => {
    expect(parseTemporal('TSTA tanggal 5 oktober', NOW)).toMatchObject({ kind: 'future' }); // two days ahead
  });

  it.each([
    'TSTA bisa tembus 2000?',
    'TSTA di atas 2100 gak',
    'TSTA ke 2050',
    'TSTA target 2000',
    'TSTA rp 2000',
  ])('a price level is not a year: %s', (text) => {
    const r = intent(text);
    expect(r.clarification ?? '').not.toMatch(/periode/);
  });

  it.each(['harga TSTA 2025', 'TSTA 2024', 'TSTA tahun 2023', 'TSTA di 2022'])(
    'a lone year after the ticker is still asked about: %s',
    (text) => {
      expect(intent(text).clarification).toMatch(/periode|tanggal/i);
    },
  );

  it.each(['9999 tahun lalu', '5000 bulan lalu', '99999 hari lalu', '500 tahun lalu'])(
    '"%s" is reported as an invalid date, with a printable label',
    (text) => {
      const r = parseTemporal(`harga TSTA ${text}`, NOW);
      expect(r).toMatchObject({ kind: 'invalid' });
      expect(JSON.stringify(r)).not.toMatch(/undefined|NaN/);
    },
  );

  it('ordinary relative dates are unaffected', () => {
    expect(date('harga TSTA 3 hari lalu')).toBe('2026-09-30');
    expect(date('harga TSTA 2 tahun lalu')).toBe('2024-10-03');
    expect(date('harga TSTA 1 minggu lalu')).toBe('2026-09-26');
  });
});

describe('temporal residuals', () => {
  const intent = (text: string, now = NOW) => parseIntent(text, now);

  it.each([
    'harga TSTA mei',
    'harga TSTA mei lalu',
    'harga TSTA awal mei',
    'harga TSTA juli kemarin',
    'harga TSTA pas lebaran',
    'harga TSTA waktu itu',
    'harga TSTA sebelum pandemi',
    'harga TSTA zaman dulu',
  ])('a vague or month-only period is never answered with the current price: %s', (text) => {
    const r = intent(text);
    expect(r.intent).toBe('STOCK_QUOTE');
    expect(r.clarification).toMatch(/satu tanggal tertentu/);
  });

  it('a date in the next few days is the future, not last year', () => {
    expect(parseTemporal('TSTA 5 oktober', NOW)).toMatchObject({ kind: 'future' });
    expect(intent('harga TSTA 5 oktober').intent).toBe('STOCK_ADVICE'); // the prediction policy
    expect(date('TSTA 25 september')).toBe('2026-09-25'); // past dates are unchanged
  });

  it('29 February resolves to the last real leap day, also from the first days of a leap year', () => {
    expect(date('TSTA 29 februari', new Date('2028-01-01T00:30:00+07:00'))).toBe('2024-02-29');
    expect(date('TSTA 29 februari', new Date('2028-03-10T10:00:00+07:00'))).toBe('2028-02-29');
  });

  it.each(['TSTA di harga 2000 masih murah?', 'TSTA harga 2050 wajar?', 'TSTA tembus 2000 gak?'])(
    'a number after "harga"/"tembus" is a price: %s',
    (text) => {
      expect(intent(text).clarification ?? '').not.toMatch(/satu tanggal tertentu/);
    },
  );

  it('with a price and a year in one message, the year is still found', () => {
    expect(intent('TSTA tembus 2000 2025?').clarification).toMatch(/satu tanggal tertentu/);
  });

  it('"tanggal N bulan lalu / ini" is resolved', () => {
    expect(date('harga TSTA tanggal 15 bulan lalu')).toBe('2026-09-15');
    expect(date('harga TSTA tgl 3 bulan ini')).toBe('2026-10-03');
    expect(parseTemporal('harga TSTA tanggal 31 bulan lalu', NOW)).toMatchObject({
      kind: 'invalid',
    }); // 31 September
  });

  it('ordinary requests that merely contain "dulu" are not period questions', () => {
    expect(intent('cek TSTA dulu').clarification).toBeUndefined();
    expect(intent('harga TSTA dulu').clarification).toBeUndefined();
  });
});
