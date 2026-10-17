import { Prisma } from '@prisma/client';
import { deriveFields, markStale, missingMetrics } from '../fundamentals/derive';
import { FundamentalsReport } from '../fundamentals/fundamentals.types';
import { NewsReport } from '../news/news.types';
import { PortfolioView } from '../portfolio/portfolio.types';
import { Fundamentals } from '../stock/stock.types';
import {
  fundamentalClaims,
  holdingClaims,
  newsClaims,
  portfolioClaims,
  watchlistClaims,
} from './extra-claims';

const ADVICE = /\b(beli|jual|target|pasti|dijamin|rekomendasi|akan naik|akan turun|sebaiknya)\b/i;
const empty: Fundamentals = {
  marketCap: null,
  per: null,
  pbv: null,
  roe: null,
  eps: null,
  dividendYield: null,
  revenue: null,
  netIncome: null,
};
const report = (
  raw: Partial<Fundamentals>,
  over: Partial<FundamentalsReport> = {},
): FundamentalsReport => {
  const fields = deriveFields({ ...empty, ...raw }, 2000);
  return {
    symbol: 'TSTA',
    name: null,
    fields,
    missing: missingMetrics(fields),
    asOf: new Date(),
    ageDays: 0,
    fromSnapshot: false,
    stale: false,
    source: 'fixture',
    ...over,
  };
};

describe('Fundamental claims', () => {
  it('writes one descriptive sentence per usable metric with its provenance and quotes its numbers', () => {
    const c = fundamentalClaims(
      report({ per: 12.5, forwardPer: 9, eps: 160, roe: 18.2, debtToEquity: 0.8 }),
    );
    expect(c.observations).toEqual([
      'PER 12,5x: harga sekitar 12,5 kali laba per lembar.',
      'ROE 18,2%.',
      'DER 0,80x: utang 0,80 kali ekuitas.',
    ]);
    expect(c.numbers).toEqual([12.5, 18.2, 0.8]);
    expect(c.risks).toEqual([]);
    for (const s of c.observations) expect(s).not.toMatch(ADVICE);
  });

  it('marks derived and estimated figures; forward metrics are not observations by themselves', () => {
    const c = fundamentalClaims(report({ eps: 100 })); // PER derived from price 2000
    expect(c.observations[0]).toBe('PER 20,0x (turunan): harga sekitar 20,0 kali laba per lembar.');
  });

  it('turns leverage, falling earnings, losses and extreme valuation into data-derived risks', () => {
    const c = fundamentalClaims(
      report({ per: 60, debtToEquity: 2.5, earningsGrowth: -35, netMargin: -4 }),
    );
    expect(c.risks).toEqual([
      'Utang lebih dari dua kali ekuitas (DER 2,50x).',
      'Laba turun 35,0% dibanding periode sebelumnya.',
      'Margin bersih negatif (-4,0%): perusahaan mencatat rugi.',
      'PER 60,0x: harga lebih dari 50 kali laba per lembar.',
    ]);
    expect(c.numbers).toEqual(expect.arrayContaining([2.5, 35, -4, 60, 50]));
  });

  it('a stale snapshot or nothing usable yields no claims at all', () => {
    const stale = report({ per: 12 }, { stale: true, fromSnapshot: true });
    stale.fields = markStale(stale.fields);
    expect(fundamentalClaims(stale)).toEqual({ observations: [], risks: [], numbers: [] });
    expect(fundamentalClaims(report({}))).toEqual({ observations: [], risks: [], numbers: [] });
    expect(fundamentalClaims(null)).toEqual({ observations: [], risks: [], numbers: [] });
  });
});

describe('News claims (no headline text ever)', () => {
  const now = new Date('2026-10-05T10:00:00Z');
  const news = (over: Partial<NewsReport> = {}): NewsReport => ({
    symbol: 'TSTA',
    fromArchive: false,
    maxAgeDays: 14,
    fetchedAt: now,
    articles: [
      {
        externalId: '1',
        title: 'RAHASIA judul tidak boleh bocor',
        source: 'Kontan',
        url: null,
        publishedAt: new Date(now.getTime() - 3 * 3_600_000),
        symbols: ['TSTA'],
        events: ['dividend'],
        relevance: 'direct',
      },
      {
        externalId: '2',
        title: 'suspensi RAHASIA',
        source: 'Bisnis',
        url: null,
        publishedAt: new Date(now.getTime() - 2 * 86_400_000),
        symbols: ['TSTA'],
        events: ['suspension'],
        relevance: 'direct',
      },
      {
        externalId: '3',
        title: 'sektor',
        source: 'X',
        url: null,
        publishedAt: now,
        symbols: ['TSTB'],
        events: [],
        relevance: 'related',
      },
    ],
    ...over,
  });

  it('counts, ages, sources and literal event tags only; a suspension/UMA becomes a risk', () => {
    const c = newsClaims(news(), now);
    expect(c.observations).toEqual([
      'Ada 2 berita tentang saham ini dalam 14 hari terakhir; terbaru 3 jam lalu (Kontan); kejadian yang disebut: dividen, suspensi.',
    ]);
    expect(c.risks).toEqual(['Ada berita suspensi tentang saham ini (Bisnis, 2 hari lalu).']);
    expect(JSON.stringify(c)).not.toContain('RAHASIA');
    expect(c.numbers).toEqual([2, 14, 3, 2]);
  });

  it('archived, empty or related-only news yields nothing', () => {
    expect(newsClaims(news({ fromArchive: true }), now).observations).toEqual([]);
    expect(newsClaims(news({ articles: [] }), now).observations).toEqual([]);
    expect(newsClaims(news({ articles: [news().articles[2]] }), now).observations).toEqual([]);
    expect(newsClaims(null).observations).toEqual([]);
  });
});

describe('Holding, watchlist and portfolio claims', () => {
  it("describes the user's own position and watchlist membership", () => {
    expect(holdingClaims({ lots: 10, avgPrice: 9000, unrealizedPct: 3.456 })).toEqual({
      observations: [
        'Kamu memegang 10 lot dengan harga rata-rata Rp9.000; posisi saat ini +3,46%.',
      ],
      risks: [],
      numbers: [10, 9000, 3.46],
    });
    expect(holdingClaims({ lots: 2, avgPrice: 500, unrealizedPct: null }).observations[0]).toBe(
      'Kamu memegang 2 lot dengan harga rata-rata Rp500.',
    );
    expect(holdingClaims(null).observations).toEqual([]);
    expect(watchlistClaims(true).observations).toEqual(['Saham ini ada di watchlist kamu.']);
    expect(watchlistClaims(false).observations).toEqual([]);
  });

  it('summarises a portfolio with concentration, unpriced and stale risks', () => {
    const D = (v: number) => new Prisma.Decimal(v);
    const view: PortfolioView = {
      name: 'Utama',
      holdings: [
        {
          symbol: 'TSTA',
          quantity: D(1000),
          avgCost: D(1000),
          price: D(1300),
          costBasis: D(1_000_000),
          marketValue: D(1_300_000),
          unrealizedPnl: D(300_000),
          unrealizedPct: D(30),
          realizedPnl: D(0),
        },
        {
          symbol: 'TSTB',
          quantity: D(100),
          avgCost: D(1000),
          price: D(900),
          costBasis: D(100_000),
          marketValue: D(90_000),
          unrealizedPnl: D(-10_000),
          unrealizedPct: D(-10),
          realizedPnl: D(0),
        },
      ],
      totals: {
        costBasis: D(1_100_000),
        marketValue: D(1_390_000),
        unrealizedPnl: D(290_000),
        unrealizedPct: D(26.36),
        realizedPnl: D(50_000),
        dividends: D(12_000),
        cash: D(100_000),
        equity: D(1_490_000),
        unpriced: 1,
        allocation: [
          { symbol: 'TSTA', percent: D(87.2) },
          { symbol: 'TSTB', percent: D(6) },
        ],
      },
      unpriced: [{ symbol: 'TSTB', reason: 'stale' }],
      newestQuoteAt: null,
      anyStale: true,
    };
    const c = portfolioClaims(view);
    expect(c.observations).toEqual([
      'Nilai portofolio Rp1.490.000: 2 saham senilai Rp1.390.000 dan kas Rp100.000.',
      'Laba/rugi mengambang +26,36% (Rp290.000) terhadap modal Rp1.100.000.',
      'Laba/rugi terealisasi Rp50.000.',
      'Dividen yang diterima Rp12.000.',
      'Porsi terbesar TSTA, 87,2% dari ekuitas.',
      'Posisi terbaik TSTA (+30,00%), terlemah TSTB (-10,00%).',
    ]);
    expect(c.risks).toEqual([
      'Konsentrasi tinggi: TSTA 87,2% dari ekuitas.',
      '1 saham dinilai pada harga perolehan karena kutipan harganya tidak tepercaya.',
      'Sebagian harga yang dipakai tidak terkini.',
    ]);
    for (const s of [...c.observations, ...c.risks]) expect(s).not.toMatch(ADVICE);
  });
});
