import { Freshness } from '../market/data-quality';
import { DailyCandle, NormalizedQuote, available } from '../stock/stock.types';
import {
  AI_NOTICE,
  SCREEN_GUIDANCE,
  adviceMessage,
  smallTalkReply,
  symbolLimitMessage,
} from './policy-messages';
import {
  HistoricalView,
  formatHistorical,
  formatQuote,
  formatScreen,
  formatWatchlist,
} from './telegram-response';

/** SYNTHETIC fixtures — not market data. */
const fresh = (state: Freshness['state'], extra: Partial<Freshness> = {}): Freshness => ({
  state,
  ageMinutes: 12,
  reason:
    state === 'STALE'
      ? 'Data lebih lama dari sesi bursa terakhir (2026-10-02).'
      : 'Data tertunda ±10 menit.',
  marketClosed: false,
  fromFallback: false,
  ...extra,
});

const quote = (over: Partial<NormalizedQuote> = {}): NormalizedQuote => ({
  symbol: 'TEST',
  name: 'TEST Tbk',
  price: 8125,
  change: 100,
  changePercent: 1.25,
  open: 8050,
  high: 8150,
  low: 8025,
  previousClose: 8025,
  volume: 12_345_678,
  averageVolume: 10_000_000,
  timestamp: '2026-10-01T08:59:00.000Z',
  currency: 'IDR',
  marketState: 'CLOSED',
  delayMinutes: 10,
  fiftyTwoWeekHigh: null,
  fiftyTwoWeekLow: null,
  ...over,
});
const meta = (freshness: Freshness) => ({
  source: 'yahoo-finance',
  fetchedAt: '2026-10-01T09:00:00.000Z',
  freshness,
});

describe('freshness labels in responses', () => {
  it.each([
    ['LIVE', '🟢 LIVE'],
    ['DELAYED', '🟡 DELAYED'],
    ['UNKNOWN', '⚪ UNKNOWN'],
  ] as const)('%s is shown with its label and the plain "Data:" timestamp line', (state, label) => {
    const t = formatQuote(quote(), meta(fresh(state)));
    expect(t).toContain(label);
    expect(t).toContain('🕐 Data: 1 Oktober 2026, 15:59 WIB');
  });

  it('STALE is never presented as current: label, reason and "Data terakhir tersedia"', () => {
    const t = formatQuote(quote(), meta(fresh('STALE')));
    expect(t).toContain('🔴 STALE');
    expect(t).toContain('Data lebih lama dari sesi bursa terakhir');
    expect(t).toContain('🕐 Data terakhir tersedia: 1 Oktober 2026, 15:59 WIB');
    expect(t).not.toContain('🕐 Data: ');
  });

  it('stored-copy fallback keeps its explicit sentence and the STALE label', () => {
    const t = formatQuote(quote(), meta(fresh('STALE', { fromFallback: true })));
    expect(t).toContain(
      'Data terbaru tidak tersedia. Menampilkan data terakhir yang tersimpan pada',
    );
    expect(t).toContain('🔴 STALE');
  });

  it('warns when the quote failed the sanity check', () => {
    const t = formatQuote(quote({ price: 1 }), {
      ...meta(fresh('DELAYED')),
      plausibility: {
        ok: false,
        quality: 'invalid',
        reasons: ['ohlc_inconsistent', 'extreme_change'],
      },
    });
    expect(t).toMatch(/Harga terlihat tidak wajar/);
    expect(t).toMatch(/lonjakan\/penurunan ekstrem/);
  });
});

describe('watchlist and screening carry the freshness state', () => {
  it('marks stale entries and shows the worst state', () => {
    const t = formatWatchlist([
      {
        symbol: 'AAAA',
        quote: available(quote({ symbol: 'AAAA' }), 'yahoo-finance'),
        freshness: fresh('DELAYED'),
      },
      {
        symbol: 'BBBB',
        quote: available(quote({ symbol: 'BBBB' }), 'yahoo-finance'),
        freshness: fresh('STALE'),
      },
    ]);
    expect(t).toMatch(/<b>BBBB<\/b>\nRp8\.125 {2}\+1,25% ⚠️ STALE/);
    expect(t).not.toMatch(/<b>AAAA<\/b>\nRp8\.125 {2}\+1,25% ⚠️/);
    expect(t).toContain('🔴 STALE');
    expect(t).toContain('🕐 Data terakhir tersedia:');
  });

  it('screening shows the freshness of the newest quote', () => {
    const t = formatScreen({
      rows: [],
      criteriaText: ['Perubahan harian > 0%'],
      universeSize: 90,
      quotedCount: 88,
      indicatorScanned: null,
      indicatorCapped: false,
      asOf: '2026-10-01T08:00:00.000Z',
      anyStale: false,
      freshness: fresh('DELAYED'),
    });
    expect(t).toContain('🟡 DELAYED');
  });
});

describe("formatHistorical — never substitutes today's data", () => {
  const candle = (date: string, close: number): DailyCandle => ({
    date,
    open: close - 20,
    high: close + 30,
    low: close - 40,
    close,
    volume: 5_000_000,
  });
  const base: HistoricalView = {
    symbol: 'TEST',
    name: 'TEST Tbk',
    requestLabel: 'Kemarin (2 Oktober 2026)',
    requestDate: '2026-10-02',
    found: {
      candle: candle('2026-10-02', 6100),
      previous: candle('2026-10-01', 6000),
      exact: true,
    },
    earliestDate: '2024-10-03',
    latest: candle('2026-10-02', 6100),
    relative: false,
    question: false,
    source: 'yahoo-finance',
    fromFallback: false,
    fetchedAt: '2026-10-03T05:00:00.000Z',
  };

  it("exact date: shows that day's candle and the change vs the previous session", () => {
    const t = formatHistorical(base);
    expect(t).toContain('Tanggal diminta: Kemarin (2 Oktober 2026)');
    expect(t).toContain('Penutupan: <b>Rp6.100</b>');
    expect(t).toContain('+1,67% dari penutupan 1 Oktober 2026');
    expect(t).toContain('Data historis harian (end-of-day)');
    expect(t).not.toMatch(/tertunda|LIVE|DELAYED/);
  });

  it('non-trading date: says so and labels the nearest earlier trading day', () => {
    const t = formatHistorical({
      ...base,
      requestLabel: 'Tanggal (3 Oktober 2026)',
      requestDate: '2026-10-03',
      found: { ...base.found!, exact: false },
    });
    expect(t).toContain('Tidak ada data perdagangan pada 3 Oktober 2026');
    expect(t).toContain('Data perdagangan terakhir sebelum tanggal itu: <b>2 Oktober 2026</b>');
  });

  it('too far back: explicit "not available" with the provider\'s first date', () => {
    const t = formatHistorical({
      ...base,
      found: null,
      requestDate: '2020-01-01',
      requestLabel: 'Tanggal (1 Januari 2020)',
    });
    expect(t).toContain('tidak tersedia: riwayat dari provider dimulai 3 Oktober 2024');
    expect(t).not.toContain('Penutupan:');
  });

  it('relative requests also show the move since then; "why" questions say causes are unavailable', () => {
    const t = formatHistorical({
      ...base,
      relative: true,
      question: true,
      found: { candle: candle('2026-09-26', 5800), previous: null, exact: true },
    });
    expect(t).toMatch(
      /Dibanding penutupan terakhir yang tersedia \(Rp6\.100 pada 2 Oktober 2026\): \+5,17%/,
    );
    expect(t).toContain('Penyebab pergerakan pada tanggal itu (berita/fundamental) tidak tersedia');
  });

  it('flags history taken from the stored copy', () => {
    expect(formatHistorical({ ...base, fromFallback: true })).toContain(
      'Riwayat diambil dari data tersimpan',
    );
  });
});

describe('fixed policy texts', () => {
  it('trade advice: refuses buy/sell instructions and offers neutral technical help', () => {
    const t = adviceMessage('trade', ['BBCA']);
    expect(t).toBe(
      'Saya tidak memberikan instruksi beli/jual. Saya dapat membantu melihat kondisi teknikal BBCA, termasuk tren, RSI, volume, support, resistance, dan risiko yang terlihat dari data.',
    );
    expect(adviceMessage('trade', ['BBCA', 'BBRI'])).toContain('BBCA dan BBRI');
    expect(adviceMessage('trade', ['AAAA', 'BBBB', 'CCCC'])).toContain('AAAA, BBBB dan CCCC');
  });

  it('target price / prediction / guarantee never promise anything', () => {
    expect(adviceMessage('target_price', ['BBCA'])).toMatch(
      /tidak menetapkan target harga masa depan.*support\/resistance/,
    );
    expect(adviceMessage('prediction', ['BBCA'])).toMatch(/tidak memprediksi/);
    expect(adviceMessage('guarantee', ['BBCA'])).toMatch(/Tidak ada jaminan/);
    for (const k of ['trade', 'target_price', 'prediction', 'guarantee'] as const) {
      expect(adviceMessage(k, ['BBCA'])).not.toMatch(/pasti naik|beli sekarang|jual sekarang/i);
    }
  });

  it('small talk replies are fixed, short and point to real features', () => {
    expect(smallTalkReply('thanks')).toBe(
      'Sama-sama! Kalau ingin menganalisis saham, cukup ketik misalnya "analisis BBCA".',
    );
    expect(smallTalkReply('greeting', 'pagi')).toMatch(/^Selamat pagi!/);
    expect(smallTalkReply('greeting')).toMatch(/^Halo!/);
    expect(smallTalkReply('ack')).toMatch(/^Siap!/);
  });

  it('screening guidance explains the available dimensions and refuses to rank "best" stocks', () => {
    expect(SCREEN_GUIDANCE).toMatch(/perubahan harga, RSI, volume ratio, MA/);
    expect(SCREEN_GUIDANCE).toContain(
      '"saham dengan RSI di bawah 30 dan volume di atas 2x rata-rata."',
    );
    expect(SCREEN_GUIDANCE).toMatch(/tidak menyusun peringkat/);
  });

  it('symbol limit message and AI notices', () => {
    expect(symbolLimitMessage(5)).toBe(
      'Maksimal 5 saham per permintaan. Silakan pilih saham yang ingin dianalisis.',
    );
    expect(AI_NOTICE.timeout).toMatch(/membutuhkan waktu terlalu lama/);
    expect(AI_NOTICE.unsafe).toMatch(/tidak memenuhi validasi keamanan/);
    expect(AI_NOTICE.busy).toMatch(/sibuk/);
  });
});
