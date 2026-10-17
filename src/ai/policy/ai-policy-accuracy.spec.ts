import { canonicalize } from './canonical';
import { buildPolicyContext, checkTextPolicy } from './ai-policy';

/**
 * Follow-ups for the output policy. Since the claims catalogue the policy no
 * longer guards model prose (the model writes none); it still guards application-authored text and the
 * glossary, so its accuracy in both directions still matters.
 */
const cp = (...c: number[]) => String.fromCodePoint(...c);

const context = (rsi = 58.4, zone = 'NEUTRAL') => ({
  symbol: 'T',
  companyName: 'T',
  facts: [
    'Harga terakhir Rp6.100, naik 1,67% dari penutupan sebelumnya (Rp6.000).',
    'Harga di atas MA20 (Rp6.020) sebesar 1,33%.',
    `RSI(14) = ${String(rsi).replace('.', ',')}, zona netral.`,
    'MACD (12,3) di atas garis signal (9,8); histogram positif (2,5).',
    'Volume hari ini 3,40 jt lembar = 1,12x rata-rata 20 hari sebelumnya (di atas rata-rata).',
    'Support terdekat Rp6.000 (-1,64% dari harga, kekuatan MEDIUM).',
    'Resistance terdekat Rp6.250 (+2,46% dari harga, kekuatan STRONG).',
  ],
  quote: {
    price: 6100,
    changePercent: 1.67,
    open: 6020,
    high: 6150,
    low: 6050,
    previousClose: 6000,
    volume: 3400000,
    fiftyTwoWeekHigh: 6800,
    fiftyTwoWeekLow: 4900,
  },
  technical: {
    trend: 'BULLISH',
    rsi14: rsi,
    rsiZone: zone,
    macd: { value: 12.3, signal: 9.8, histogram: 2.5, state: 'BULLISH' },
    ma: { ma5: 6080, ma20: 6020, ma50: 5950, ma100: 5800, ma200: 5700 },
    atr14: 120,
    volumeRatioVs20DayAvg: 1.12,
  },
  support: [{ price: 6000, strength: 'MEDIUM' }],
  resistance: [{ price: 6250, strength: 'STRONG' }],
  knownDataLimitations: [],
});
const flagged = (text: string, ctx = context()) =>
  checkTextPolicy([text], buildPolicyContext(ctx)).length > 0;

describe('disguised spelling the canonicaliser used to miss', () => {
  it.each([
    'b,u,y sekarang',
    'b+u+y now',
    'b~u~y now',
    'B:U:Y sekarang',
    'b;u;y sekarang',
    'b!u!y sekarang',
    'b(u)y sekarang',
    'b_u_y sekarang',
    'b e l i sekarang',
    'be li sekarang',
    'bu y now',
    'b3l1 sekarang',
    'bbeellii sekarang',
    'S;E;R;O;K sekarang',
    'j,u,a,l sekarang',
    `b${cp(0)}u${cp(0)}y now`,
    `b${cp(0x1b)}u${cp(0x1b)}y now`,
    cp(0x1f1e7, 0x1f1fa, 0x1f1fe) + ' now', // regional-indicator "BUY"
    `${cp(0x1f1e7)} ${cp(0x1f1ea)} ${cp(0x1f1f1)} ${cp(0x1f1ee)} sekarang`,
  ])('is still read as an instruction: %s', (text) => {
    expect(checkTextPolicy([text])).not.toEqual([]);
  });

  it('canonical forms', () => {
    expect(canonicalize('b,u,y')).toBe('buy');
    expect(canonicalize('be li')).toBe('beli');
    expect(canonicalize('b3l1')).toContain('beli');
    expect(canonicalize(cp(0x1f1e7, 0x1f1fa, 0x1f1fe))).toBe('buy');
    expect(canonicalize('bbeellii')).toBe('beli');
  });

  it.each([
    'Support Rp6.000, resistance Rp6.250, MA20 Rp6.020.',
    'a, b, c adalah contoh urutan.',
    'RSI 14, MA 20 dan MA 50 dipakai.',
    'Tekanan beli terlihat dari volume yang berada di atas rata-rata.',
    'Data volume jual dan beli per pelaku tidak tersedia.',
    'Harga naik, dan volume juga naik.',
    'Terdapat be-berapa level penting.',
    'Rabu, 1 Oktober 2026: harga ditutup naik.',
    'Bank Central Asia (BBCA): RSI netral.',
  ])('ordinary text is not caught by the wider separators: %s', (text) => {
    expect(checkTextPolicy([text])).toEqual([]);
  });
});

describe('numbers that look like harmless constants', () => {
  it.each([
    'Harga sempat menyentuh 5.000 minggu ini.',
    'Level 3.000 terlihat penting.',
    'Level 9.000 terlihat penting.',
    'Harga sempat menyentuh 1.000 minggu ini.',
    'Harga sempat 12.000 kemarin.',
  ])('a round thousands figure that is not in the data is ungrounded: %s', (text) => {
    expect(checkTextPolicy([text], buildPolicyContext(context())).map((v) => v.category)).toContain(
      'ungrounded_number',
    );
  });

  it.each([
    'Harga terakhir Rp6.100.',
    'Harga terakhir 6100.',
    'Support Rp6.000 dan resistance Rp6.250.',
    'Harga di atas MA20 (Rp6.020).',
    'RSI(14) 58,4 berada di zona netral.',
    'Harga naik 1,67% dari Rp6.000.',
  ])('figures that ARE in the data remain accepted: %s', (text) => {
    expect(flagged(text)).toBe(false);
  });
});

describe('statements about the data that are false', () => {
  it.each([
    'MACD berada di bawah garis signal.',
    'Harga menembus resistance Rp6.250.',
    'Harga jatuh di bawah support Rp6.000.',
    'Harga sudah berada di atas level tertinggi 52 minggu.',
    'Harga mendekati level terendah 52 minggu.',
    'Harga naik 5 hari berturut-turut.',
    'Volume hari ini adalah yang tertinggi tahun ini.',
    'Harga mencetak rekor tertinggi baru.',
  ])('is flagged: %s', (text) => {
    expect(flagged(text)).toBe(true);
  });

  it.each([
    'MACD berada di atas garis signal.',
    'Harga masih di bawah resistance Rp6.250.',
    'Harga belum menembus resistance Rp6.250.',
    'Harga di atas support Rp6.000.',
    'Harga berada di bawah level tertinggi 52 minggu.',
    'Harga masih jauh di atas level terendah 52 minggu.',
    'Harga mendekati level tertinggi 52 minggu.', // 10 % below the high: "near" is a judgement, flagged below
  ])('true or negated statements stay accepted: %s', (text) => {
    // the last item is deliberately borderline and is asserted separately
    if (text.includes('mendekati level tertinggi')) return;
    expect(flagged(text)).toBe(false);
  });

  it('"near the 52-week high" is checked against the distance (6.800 vs 6.100 is 10 % away)', () => {
    expect(flagged('Harga mendekati level tertinggi 52 minggu.')).toBe(true);
    const near = context();
    near.quote.price = 6750;
    expect(flagged('Harga mendekati level tertinggi 52 minggu.', near)).toBe(false);
  });

  it('level-break claims are judged against the levels in the data', () => {
    const above = context();
    above.quote.price = 6300; // above the 6.250 resistance
    expect(flagged('Harga menembus resistance Rp6.250.', above)).toBe(false);
    const below = context();
    below.quote.price = 5900; // below the 6.000 support
    below.quote.changePercent = -1.7; // and it did fall today ("jatuh" is also checked against the day's change)
    expect(flagged('Harga jatuh di bawah support Rp6.000.', below)).toBe(false);
  });
});

describe('accuracy of the checks themselves (no false alarm on true statements)', () => {
  it.each([
    'RSI belum berada di area jenuh beli maupun jenuh jual.',
    'RSI tidak berada di area jenuh beli atau jenuh jual.',
    'RSI belum jenuh beli.',
    'RSI(14) 58,4 berada di zona netral.',
  ])('is accepted for RSI 58,4: %s', (text) => {
    expect(flagged(text)).toBe(false);
  });

  it('the zone words get one display decimal of slack: RSI 69.996 prints as 70,0 and is "netral"', () => {
    const edge = context(69.996);
    expect(flagged('RSI(14) = 70,0, zona netral atas.', edge)).toBe(false);
    expect(flagged('RSI berada di area jenuh beli.', edge)).toBe(false);
    // clearly overbought still contradicts "netral"; clearly neutral still contradicts "jenuh beli"
    expect(flagged('RSI(14) 75,0 berada di zona netral.', context(75, 'OVERBOUGHT'))).toBe(true);
    expect(flagged('RSI berada di area jenuh beli.', context(58.4))).toBe(true);
  });
});
