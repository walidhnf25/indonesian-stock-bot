import { FullTechnicalReport } from '../analysis/analysis.types';
import { computeTechnical } from '../analysis/technical';
import { Freshness } from '../market/data-quality';
import { DailyCandle, NormalizedQuote, available, unavailable } from '../stock/stock.types';
import {
  chunkMessage,
  formatAlertTriggered,
  formatAnalysis,
  formatComparison,
  formatForeignFlow,
  formatQuote,
  formatScreen,
  formatTechnical,
  formatWatchlist,
  HELP_TEXT,
  START_TEXT,
} from './telegram-response';

/** SYNTHETIC fixtures — not market data. */
const DELAYED: Freshness = {
  state: 'DELAYED',
  ageMinutes: 12,
  reason: 'Data tertunda ±10 menit.',
  marketClosed: false,
  fromFallback: false,
};
const STALE_COPY: Freshness = {
  state: 'STALE',
  ageMinutes: 600,
  reason: 'Data terbaru tidak tersedia; ini data tersimpan terakhir.',
  marketClosed: false,
  fromFallback: true,
};

const quote = (over: Partial<NormalizedQuote> = {}): NormalizedQuote => ({
  symbol: 'TEST',
  name: 'TEST <Fixture> & Co',
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
  fiftyTwoWeekHigh: 9000,
  fiftyTwoWeekLow: 7000,
  ...over,
});

function report(over: Partial<FullTechnicalReport> = {}): FullTechnicalReport {
  const candles: DailyCandle[] = Array.from({ length: 120 }, (_, i) => {
    const c = 7000 + i * 9 + Math.sin(i / 4) * 30;
    return {
      date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      open: c,
      high: c + 20,
      low: c - 20,
      close: c,
      volume: 1_000_000,
    };
  });
  return {
    symbol: 'TEST',
    quote: quote(),
    quoteSource: 'yahoo-finance',
    quoteStale: false,
    quoteFetchedAt: '2026-10-01T09:00:00.000Z',
    freshness: DELAYED,
    plausibility: { ok: true, quality: 'trusted', reasons: [] },
    technical: computeTechnical('TEST', candles),
    candles,
    historyStale: false,
    ...over,
  };
}

describe('formatQuote', () => {
  const text = formatQuote(quote(), {
    source: 'yahoo-finance',
    freshness: DELAYED,
    fetchedAt: '2026-10-01T09:00:00.000Z',
  });

  it('matches the specified layout with Indonesian number formats', () => {
    expect(text).toContain('📊 <b>TEST</b> — TEST Fixture &amp; Co'); // markup characters are dropped, & is escaped
    expect(text).toContain('Rp8.125');
    expect(text).toContain('+100 (+1,25%)');
    expect(text).toContain('Open: Rp8.050');
    expect(text).toContain('High: Rp8.150');
    expect(text).toContain('Low: Rp8.025');
    expect(text).toContain('Volume: 12,35 jt lembar');
  });
  it('shows the real data timestamp (WIB) and source, and flags delayed data', () => {
    expect(text).toContain('🕐 Data: 1 Oktober 2026, 15:59 WIB');
    expect(text).toContain('Sumber: Yahoo Finance — tertunda ±10 menit');
  });
  it('escapes provider-supplied text so Telegram HTML cannot break', () => {
    expect(text).not.toContain('<Fixture>');
  });
  it('clearly marks stale data with when it was stored', () => {
    const stale = formatQuote(quote(), {
      source: 'yahoo-finance (tersimpan)',
      freshness: STALE_COPY,
      fetchedAt: '2026-10-01T08:00:00.000Z',
    });
    expect(stale).toContain(
      'Data terbaru tidak tersedia. Menampilkan data terakhir yang tersimpan pada 1 Oktober 2026, 15:00 WIB',
    );
    expect(stale).toContain('data tersimpan');
  });
  it('shows "-" instead of inventing missing fields', () => {
    const t = formatQuote(quote({ open: null, high: null, volume: null, previousClose: null }), {
      source: 'x',
      freshness: DELAYED,
      fetchedAt: '',
    });
    expect(t).toContain('Open: -');
    expect(t).toContain('Volume: - lembar');
  });
});

describe('formatTechnical', () => {
  it('lists every section for a general technical question', () => {
    const t = formatTechnical(report());
    for (const needle of [
      'Kondisi teknikal:',
      'MA20:',
      'MA50:',
      'MA200:',
      'RSI (14):',
      'MACD:',
      'Volume:',
      'Support:',
      'Resistance:',
      '🕐 Data:',
    ]) {
      expect(t).toContain(needle);
    }
    expect(t).toMatch(/Kondisi teknikal: <b>(Bullish|Netral|Bearish)<\/b>/);
  });
  it('shows only the requested topic for a specific question', () => {
    const t = formatTechnical(report(), ['rsi']);
    expect(t).toContain('RSI (14):');
    expect(t).not.toContain('MACD:');
    expect(t).not.toContain('MA20:');
  });
  it('uses cautious wording, never certainty', () => {
    expect(formatTechnical(report())).not.toMatch(/pasti|dijamin|beli sekarang/i);
  });
});

describe('formatAnalysis', () => {
  const ai = {
    summary: 'Harga bergerak di atas MA20 dengan momentum positif.',
    trend: 'Bullish',
    momentum: 'Moderat',
    technical_observations: ['RSI 58,4'],
    risk_factors: ['Dekat resistance'],
    data_limitations: ['Foreign flow tidak tersedia'],
  };
  it('contains the sections of the spec and the disclaimer', () => {
    const t = formatAnalysis(report(), ai, { foreignFlow: unavailable('x', 'UNSUPPORTED') });
    for (const needle of [
      '🤖 <b>AI ANALYSIS — TEST</b>',
      '💰 <b>Harga</b>',
      '📈 <b>Kondisi Teknikal</b>',
      '📊 <b>Volume</b>',
      '🎯 <b>Level Teknis</b>',
      '🧠 <b>Analisis</b>',
      '⚠️ <b>Risiko</b>',
      '🕐 Data:',
    ]) {
      expect(t).toContain(needle);
    }
    expect(t).toContain('bukan rekomendasi investasi');
    expect(t).toContain('Foreign flow tidak tersedia');
  });
  it('falls back to deterministic observations (and says so) when AI output is missing', () => {
    const t = formatAnalysis(report(), null);
    expect(t).toContain('Analisis AI sedang tidak tersedia');
    expect(t).toContain('Harga di atas MA20');
    expect(t).toContain('bukan rekomendasi investasi');
  });
  it('escapes AI text', () => {
    const t = formatAnalysis(report(), {
      ...ai,
      summary: 'x <script>alert(1)</script> panjang sekali teks',
    });
    expect(t).not.toContain('<script>');
  });
  it('does not duplicate overlapping limitation lines', () => {
    const t = formatAnalysis(
      report(),
      {
        ...ai,
        data_limitations: [
          'Data foreign flow tidak tersedia dari provider.',
          'Berita tidak tersedia',
        ],
      },
      { foreignFlow: unavailable('x', 'UNSUPPORTED') },
    );
    expect(t.match(/foreign flow/gi)).toHaveLength(1);
  });
});

describe('formatComparison', () => {
  const a = report();
  const b = report({
    symbol: 'TESB',
    quote: quote({ symbol: 'TESB', price: 4320, changePercent: -0.46 }),
  });
  it('renders a monospaced table and never ranks stocks', () => {
    const t = formatComparison([a, b], {
      summary: 'Perbedaan momentum terlihat jelas pada data.',
      differences: ['RSI berbeda'],
      considerations: ['Pertimbangan'],
      data_limitations: [],
    });
    expect(t).toContain('<pre>');
    expect(t).toMatch(/Harga\s+Rp8\.125\s+Rp4\.320/);
    expect(t).toMatch(/Perubahan\s+\+1,25%\s+-0,46%/);
    expect(t).toContain('tidak menyatakan saham terbaik/terburuk');
    expect(t).not.toMatch(/pemenang|terbaik:|winner/i);
  });
  it('splits wide comparisons into tables of at most three symbols', () => {
    const many = ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE'].map((s) =>
      report({ symbol: s, quote: quote({ symbol: s }) }),
    );
    expect(formatComparison(many, null).match(/<pre>/g)).toHaveLength(2);
  });
  it('works without AI', () => {
    expect(formatComparison([a, b], null)).toContain('Penjelasan AI tidak tersedia');
  });
});

describe('watchlist / alert / misc formatters', () => {
  it('formats the watchlist per spec and shows the freshest timestamp', () => {
    const t = formatWatchlist([
      {
        symbol: 'BBCA',
        quote: available(
          quote({ symbol: 'BBCA', price: 8125, changePercent: 1.25 }),
          'yahoo-finance',
        ),
      },
      {
        symbol: 'BBRI',
        quote: available(
          quote({ symbol: 'BBRI', price: 4320, changePercent: -0.46 }),
          'yahoo-finance',
        ),
      },
      { symbol: 'GONE', quote: null },
    ]);
    expect(t).toContain('📋 <b>WATCHLIST</b>');
    expect(t).toContain('Rp8.125  +1,25%');
    expect(t).toContain('Rp4.320  -0,46%');
    expect(t).toContain('Data belum tersedia');
    expect(t).toContain('🕐 Data: 1 Oktober 2026');
  });
  it('explains an empty watchlist', () => {
    expect(formatWatchlist([])).toContain('masih kosong');
  });
  it('formats a triggered alert', () => {
    const t = formatAlertTriggered({
      symbol: 'BBCA',
      label: 'Kondisi terpenuhi: BBCA harga di atas Rp8.500',
      observed: 'Rp8.525',
      quoteTime: '2026-10-01T08:00:00.000Z',
    });
    expect(t).toContain('🔔 <b>ALERT — BBCA</b>');
    expect(t).toContain('Rp8.525');
    expect(t).toContain('🕐 Data:');
  });
  it('states unavailable foreign flow plainly', () => {
    expect(formatForeignFlow('BBCA', unavailable('x', 'UNSUPPORTED'))).toContain(
      'Data foreign flow tidak tersedia dari provider saat ini',
    );
  });
  it('screening output states the universe is not the whole exchange', () => {
    const t = formatScreen({
      rows: [
        {
          symbol: 'TEST',
          name: null,
          price: 100,
          changePercent: 3,
          volumeRatio: 2.5,
          rsi: null,
          trend: null,
        },
      ],
      criteriaText: ['Perubahan harian > 0%'],
      universeSize: 90,
      quotedCount: 88,
      indicatorScanned: null,
      indicatorCapped: false,
      asOf: '2026-10-01T08:00:00.000Z',
      anyStale: false,
      freshness: null,
    });
    expect(t).toContain('bukan seluruh saham IDX');
    expect(t).toContain('88 berhasil diambil');
  });
});

describe('static texts and chunking', () => {
  it('/help and /start follow the spec', () => {
    expect(HELP_TEXT).toContain('Kamu tidak perlu menghafal command.');
    expect(HELP_TEXT).toContain('"ingatkan saya kalau BBCA di atas 8500"');
    expect(START_TEXT).toContain('Selamat datang di <b>AI Indonesian Stock Bot</b>');
    expect(START_TEXT).toContain('Gunakan /help untuk bantuan.');
  });
  it('splits long text under the Telegram limit on paragraph boundaries', () => {
    const para = 'x'.repeat(1000);
    const chunks = chunkMessage(Array(10).fill(para).join('\n\n'), 3800);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 3800)).toBe(true);
    expect(chunks.join('\n\n').replace(/\n\n/g, '')).toBe(para.repeat(10));
  });
  it('hard-splits a single oversized paragraph', () => {
    expect(chunkMessage('y'.repeat(9000), 3800).every((c) => c.length <= 3800)).toBe(true);
  });
  it('leaves short text untouched', () => {
    expect(chunkMessage('halo')).toEqual(['halo']);
  });
});

describe('provider names are cleaned at the last step before Telegram', () => {
  const cp = (...codes: number[]) => String.fromCodePoint(...codes);
  it('bidi and control characters in a stored company name never reach the message', () => {
    const evil = `PT Contoh${cp(0x202e)} Tbk${cp(0)}${cp(0x200b)}`;
    const html = formatQuote(quote({ name: evil }), {
      source: 'yahoo-finance',
      freshness: DELAYED,
      fetchedAt: '2026-10-01T09:00:00.000Z',
    });
    expect(html).toContain('PT Contoh Tbk');
    for (const code of [0x202e, 0x200b, 0x2066, 0]) expect(html).not.toContain(cp(code));
  });
});

describe('the technical card shows the volume its ratio is computed from', () => {
  it('prints the last daily candle volume, naming the session when it is not the quote day', () => {
    const r = report();
    const last = r.candles[r.candles.length - 1];
    const live = { ...r.quote, volume: 987_654, timestamp: '2099-01-01T08:00:00.000Z' };
    const text = formatTechnical({ ...r, quote: live }, ['volume']);
    expect(text).not.toContain('987.654');
    expect(text).not.toMatch(/987,65/);
    expect(text).toMatch(/^Volume: .* lembar \(sesi \d{1,2} \w+ \d{4}\)$/m);
    expect(text).toContain(`Rasio volume:`);
    expect(last.volume).toBeGreaterThan(0);
  });

  it('has no session note when the candle is from the quote day', () => {
    const r = report();
    const last = r.candles[r.candles.length - 1];
    const text = formatTechnical(
      { ...r, quote: { ...r.quote, timestamp: `${last.date}T08:00:00.000Z` } },
      ['volume'],
    );
    expect(text).not.toMatch(/\(sesi /);
  });
});
