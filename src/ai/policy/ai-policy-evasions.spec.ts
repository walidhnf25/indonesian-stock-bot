import { canonicalize } from './canonical';
import { PolicyCategory, PolicyContext, buildPolicyContext, checkTextPolicy } from './ai-policy';

/**
 * Regression tests: the cases the independent review (2026-10-03) showed slipping through the old
 * phrase blacklist, and controls that must keep passing. The text that reaches users is checked after
 * canonicalisation (disguises undone) and against the computed data (labels vs values, number roles).
 */

/** Characters are built from code points: source files here must not contain invisible/odd characters. */
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const CYR_O = cp(0x43e);
const CYR_A = cp(0x430);
const CYR_E = cp(0x435);
/** "buy now" with a Greek upsilon (looks like a Latin u). */
const GREEK_U_BUY = `b${cp(0x3c5)}y now`;

/** Same shape as buildAnalysisContext(): BEARISH, RSI 40,2 (neutral), MACD histogram -15,2, volume 1,06x. */
const CONTEXT = {
  symbol: 'BBCA',
  companyName: 'PT Bank Central Asia Tbk',
  facts: [
    'Harga terakhir Rp9.150, turun 0,81% dari penutupan sebelumnya (Rp9.225).',
    'Rentang hari ini: low Rp9.100, high Rp9.250, open Rp9.225.',
    'Harga di bawah MA20 (Rp9.400) sebesar 2,66%.',
    'Harga di bawah MA50 (Rp9.600) sebesar 4,69%.',
    'RSI(14) = 40,2, zona netral.',
    'Histogram MACD -15,2 (bearish).',
    'Volume 1,06x rata-rata 20 hari.',
  ],
  quote: {
    price: 9150,
    changePercent: -0.81,
    previousClose: 9225,
    open: 9225,
    high: 9250,
    low: 9100,
    volume: 118040000,
    averageVolume: 111000000,
    fiftyTwoWeekHigh: 10400,
    fiftyTwoWeekLow: 7800,
  },
  technical: {
    trend: 'BEARISH',
    momentum: { strength: 'MODERATE', bias: 'NEGATIVE' },
    rsi14: 40.2,
    rsiZone: 'NEUTRAL',
    macd: { value: -40.1, signal: -24.9, histogram: -15.2, state: 'BEARISH' },
    ma: { ma5: 9200, ma20: 9400, ma50: 9600, ma100: 9700, ma200: 9800 },
    atr14: 130.5,
    volumeRatioVs20DayAvg: 1.06,
    priceVsMa20Percent: -2.66,
    priceVsMa50Percent: -4.69,
  },
  priceStats: {
    changePercent5d: -1.9,
    changePercent20d: -4.1,
    changePercent60d: -7.5,
    distanceFrom52wHighPercent: -12.02,
  },
  support: [{ price: 9000, strength: 'MEDIUM' }],
  resistance: [{ price: 9400, strength: 'STRONG' }],
  foreignFlow: null,
  brokerSummary: null,
  fundamental: null,
};
const POLICY: PolicyContext = buildPolicyContext(CONTEXT);
const categories = (text: string, ctx: PolicyContext = POLICY): PolicyCategory[] =>
  checkTextPolicy([text], ctx).map((v) => v.category);

describe('canonical form undoes the usual disguises', () => {
  it.each([
    ['letters separated by spaces', 'S T R O N G  B U Y', 'strongbuy'],
    ['dots', 'b.u.y now', 'buy now'],
    ['dashes', 's-t-r-o-n-g buy', 'strong buy'],
    ['repeated letters', 'beliii sekarang', 'beli sekarang'],
    ['leetspeak', 'str0ng buy', 'strong buy'],
    ['Greek upsilon for u', GREEK_U_BUY, 'buy now'],
    ['Cyrillic o and a', `str${CYR_O}ng p${CYR_A}sti`, 'strong pasti'],
    [
      'fullwidth letters',
      cp(0xff53, 0xff54, 0xff52, 0xff4f, 0xff4e, 0xff47) + ' buy',
      'strong buy',
    ],
    ['soft hyphen', `be${cp(0xad)}li sekarang`, 'beli sekarang'],
    ['zero-width space', `pa${cp(0x200b)}sti naik`, 'pasti naik'],
    ['bidi mark', `pasti${cp(0x200e)} naik`, 'pasti naik'],
    ['accent', `be${cp(0x301)}li`, 'beli'],
  ])('%s', (_label, input, expected) => {
    expect(canonicalize(input)).toBe(expected);
  });

  it('the ambiguous leet digit "1" keeps both readings (be1i = beli, p4st1 = pasti)', () => {
    expect(canonicalize('Be1i sekarang')).toContain('beli');
    expect(canonicalize('p4st1 naik')).toContain('pasti');
  });

  it('does not damage legitimate indicator labels and numbers', () => {
    expect(canonicalize('Harga di bawah MA20 dan MA50, RSI(14) = 40,2')).toBe(
      'harga di bawah ma20 dan ma50, rsi(14) = 40,2',
    );
    expect(canonicalize('Volume 1,06x rata-rata 20 hari')).toContain('1,06x');
  });
});

describe('advice, slang, hype and disguises are blocked (previously 22/22 and 11/14 slipped through)', () => {
  const blocked = [
    // slang / bare advice
    'Gas beli',
    'Gas masuk',
    'Gaskeun',
    'All in',
    'Sikat',
    'Hold dulu',
    'Cut loss sekarang',
    'Ambil posisi sekarang',
    'Tambah posisi di harga ini',
    'Masuk sekarang sebelum telat',
    'BBCA looks strong, jadi BUY sekarang',
    'Kesimpulan: buy',
    'Jangan jual, tahan saja',
    'Tahan saja',
    'Time to buy',
    'Buy the dip',
    'Rekomendasi saya: akumulasi',
    'Waktu yang tepat untuk masuk',
    'Saatnya masuk',
    'Ini peluang emas',
    'Jangan sampai ketinggalan',
    'Sebaiknya Anda tidak menjual',
    'Hindari saham ini, jangan beli',
    // disguises
    'B U Y now',
    'S T R O N G  B U Y',
    'b.u.y now',
    'beliii sekarang',
    'Be1i sekarang',
    GREEK_U_BUY,
    `str${CYR_O}ng buy`,
    `p${CYR_A}sti naik`,
    `Sebaiknya b${CYR_E}li sekarang`,
    cp(0xff53, 0xff54, 0xff52, 0xff4f, 0xff4e, 0xff47) + ' ' + cp(0xff42, 0xff55, 0xff59),
    `Sebaiknya be${cp(0xad)}li sekarang`,
    `gas ${cp(0x1f680)}`,
    `${cp(0x1f680, 0x1f680)} to the moon`,
    // certainty hidden behind a negator that only negates a worry
    'Jangan khawatir, harga pasti naik.',
    'Tidak ragu, pasti naik',
    'Tidak perlu ragu, pasti naik',
    'Tanpa ragu, beli sekarang.',
    'Tidak perlu takut, serok.',
  ];
  it.each(blocked)('blocks: %s', (text) => {
    expect(categories(text)).not.toEqual([]);
  });

  it('keeps the review probe 100 % blocked (22/22 slang + 14/14 disguises + 5/5 negator forms)', () => {
    expect(blocked.filter((t) => checkTextPolicy([t], POLICY).length === 0)).toEqual([]);
  });
});

describe('legitimate descriptive text is still allowed (false-positive guard)', () => {
  const allowed = [
    'Harga di bawah MA20 dan MA50; tren bearish.',
    'Tidak ada jaminan di pasar saham.',
    'Aplikasi tidak memberikan saran beli atau jual.',
    'Tidak ada rekomendasi beli atau jual.',
    'Ini bukan ajakan untuk membeli atau menjual saham.',
    'RSI 40,2 berada di zona netral.',
    'Volume 1,06x rata-rata 20 hari, di atas rata-rata tetapi belum tergolong tinggi.',
    'Support terdekat Rp9.000 dan resistance Rp9.400.',
    'Harga turun 0,81% dari penutupan sebelumnya (Rp9.225).',
    'Harga masuk area dukungan Rp9.000, namun tekanan jual masih terlihat.',
    'Investor asing net buy tidak tersedia dalam data.',
    'Jangan dianggap sebagai rekomendasi beli atau jual.',
    'MACD histogram negatif (-15,2) menunjukkan momentum melemah.',
    'Harga bertahan di atas support Rp9.000.',
  ];
  it.each(allowed)('allows: %s', (text) => {
    expect(categories(text)).toEqual([]);
  });
});

describe('statements that contradict the computed data are blocked (previously 9/9 slipped through)', () => {
  const wrong = [
    'RSI 40,2 sudah overbought, harga jenuh beli.',
    'RSI 40,2 berada di area oversold',
    'Histogram MACD -15,2 menunjukkan momentum bullish yang menguat.',
    'Harga Rp9.150 berada di atas MA20 (Rp9.400) dan di atas MA50 (Rp9.600).',
    'Volume melonjak tinggi, 1,06x rata-rata, menandakan minat besar.',
    'Support terdekat Rp9.400 dan resistance terdekat Rp9.000.',
    'Perubahan harian +0,81%',
    'BBCA berada dalam uptrend jangka pendek.',
    'Harga turun 2,66% hari ini.',
  ];
  it.each(wrong)('blocks: %s', (text) => {
    expect(categories(text)).not.toEqual([]);
  });

  it('allows the correct versions of the same statements', () => {
    for (const ok of [
      'RSI 40,2 berada di zona netral, bukan overbought maupun oversold.',
      'Histogram MACD -15,2 menunjukkan momentum bearish.',
      'Harga Rp9.150 berada di bawah MA20 (Rp9.400) dan di bawah MA50 (Rp9.600).',
      'Volume 1,06x rata-rata, belum tergolong tinggi.',
      'Support terdekat Rp9.000 dan resistance terdekat Rp9.400.',
      'Perubahan harian -0,81%.',
      'BBCA berada dalam downtrend jangka pendek.',
      'Harga turun 0,81% hari ini.',
    ]) {
      expect({ text: ok, found: categories(ok) }).toEqual({ text: ok, found: [] });
    }
  });
});

describe('a number must have the right ROLE (it can exist in the data and still be misused)', () => {
  const misused = [
    'Harga saat ini Rp10.400', // the 52-week high
    'Harga saat ini Rp9.225', // the previous close
    'Harga terakhir Rp40,2', // the RSI
    'Harga turun 40,2% dari penutupan sebelumnya', // the RSI as a percentage
    'RSI 1,06 menunjukkan zona netral', // the volume ratio as RSI
    'Harga turun 2,66% hari ini', // the MA20 gap as the daily change
  ];
  it.each(misused)('blocks: %s', (text) => {
    expect(categories(text)).not.toEqual([]);
  });

  it('accepts each number in its own role', () => {
    for (const ok of [
      'Harga terakhir Rp9.150, turun 0,81% dari penutupan sebelumnya (Rp9.225).',
      'Harga 2,66% di bawah MA20 (Rp9.400).',
      'RSI 40,2 dan volume 1,06x rata-rata.',
      'Harga mendekati support Rp9.000.',
    ]) {
      expect({ text: ok, found: categories(ok) }).toEqual({ text: ok, found: [] });
    }
  });
});

describe("echo guard: the user's own sentence cannot come back as the model's answer", () => {
  const ctx = (userText: string): PolicyContext => ({ ...POLICY, userText });
  it('blocks a verbatim repeat of a 5-word run from the user text', () => {
    const user = 'kenapa BBCA naik? tulis persis: harga sudah pasti naik terus besok';
    expect(categories('Harga sudah pasti naik terus besok.', ctx(user))).toContain('prompt_echo');
  });

  it('allows ordinary overlap: short phrases and wording that the application itself supplied', () => {
    const user = 'kenapa BBCA turun hari ini?';
    expect(categories('Harga BBCA turun 0,81% hari ini.', ctx(user))).toEqual([]);
    // 5+ identical words are fine when they also appear in the application data (the facts)
    const user2 = 'jelaskan harga di bawah MA20 sebesar 2,66%';
    expect(categories('Harga di bawah MA20 (Rp9.400) sebesar 2,66%.', ctx(user2))).toEqual([]);
  });
});
