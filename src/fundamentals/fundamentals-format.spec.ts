import { GENERAL_ANSWER_POLICY, checkTextPolicy } from '../ai/policy/ai-policy';
import { Fundamentals } from '../stock/stock.types';
import { deriveFields, markStale, missingMetrics } from './derive';
import {
  formatFundamentalsComparison,
  formatFundamentalsReport,
  FUNDAMENTALS_NOTE,
  PROVENANCE_LEGEND,
} from './fundamentals-format';
import { FundamentalsReport } from './fundamentals.types';

const plain = (html: string) => html.replace(/<[^>]+>/g, '');
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
  extra: Partial<FundamentalsReport> = {},
): FundamentalsReport => {
  const fields = deriveFields({ ...empty, ...raw }, 2000);
  return {
    symbol: 'TSTA',
    name: 'Test A',
    fields,
    missing: missingMetrics(fields),
    asOf: new Date('2026-10-01T03:00:00Z'),
    ageDays: 3,
    fromSnapshot: false,
    stale: false,
    source: 'fixture',
    ...extra,
  };
};

describe('Fundamentals card', () => {
  it('shows each metric with its provenance mark, lists what is missing, and explains the marks', () => {
    const t = plain(
      formatFundamentalsReport(report({ per: 12.5, forwardPer: 10, eps: 160, marketCap: 1.2e12 })),
    );
    expect(t).toContain('PER: 12,50x');
    expect(t).toContain('PER forward: 10,00x (estimasi)');
    expect(t).toContain('EPS: Rp160');
    expect(t).toContain('Kapitalisasi pasar: Rp1,20 T');
    expect(t).not.toMatch(/PBV:/); // no book value per share -> not derived, listed as missing instead
  });

  it('a derived P/E is marked, a reported one is not', () => {
    const derived = plain(formatFundamentalsReport(report({ eps: 100 })));
    expect(derived).toContain('PER: 20,00x (turunan)');
    expect(derived).toContain(PROVENANCE_LEGEND);
    const reported = plain(formatFundamentalsReport(report({ per: 20 })));
    expect(reported).toContain('PER: 20,00x');
    expect(reported).not.toContain('(turunan)');
    expect(reported).not.toContain(PROVENANCE_LEGEND);
  });

  it('names the missing metrics explicitly instead of hiding or inventing them', () => {
    const t = plain(formatFundamentalsReport(report({ per: 12 })));
    expect(t).toMatch(/Tidak tersedia: .*pbv.*total utang.*pertumbuhan laba/);
    expect(t).not.toMatch(/PBV: /);
  });

  it('a snapshot is announced with its date; a stale one is marked on the header and on every value', () => {
    const fresh = plain(
      formatFundamentalsReport(
        report({ per: 12 }, { fromSnapshot: true, stale: false, ageDays: 2 }),
      ),
    );
    expect(fresh).toMatch(
      /Provider fundamental tidak tersedia; angka di bawah dari snapshot .*\(2 hari\)/,
    );
    expect(fresh).not.toContain('(basi)');
    const r = report({ per: 12 }, { fromSnapshot: true, stale: true, ageDays: 30 });
    r.fields = markStale(r.fields);
    const stale = plain(formatFundamentalsReport(r));
    expect(stale).toContain('⚠️');
    expect(stale).toContain('(30 hari, basi)');
    expect(stale).toContain('PER: 12,00x (basi)');
  });

  it('with nothing available it says so', () => {
    const t = plain(formatFundamentalsReport(report({})));
    expect(t).toContain('Tidak ada metrik fundamental yang tersedia dari provider.');
  });

  it('the explanatory sentences pass the AI output policy and no card carries advice wording', () => {
    // the card itself is a data card (rupiah figures are expected there); the policy applies to its prose
    expect(checkTextPolicy([PROVENANCE_LEGEND, FUNDAMENTALS_NOTE], GENERAL_ANSWER_POLICY)).toEqual(
      [],
    );
    for (const r of [report({ per: 12, eps: 100, revenue: 10, netIncome: 2 }), report({})]) {
      expect(plain(formatFundamentalsReport(r))).not.toMatch(
        /\b(beli|jual|target harga|pasti|dijamin|rekomendasi|akan naik|akan turun)\b/i,
      );
    }
  });
});

describe('Fundamentals comparison', () => {
  it('puts the stocks side by side with "–" for a missing value and marks non-reported figures', () => {
    const a = report({ per: 12, eps: 100 });
    const b = { ...report({ eps: 50 }), symbol: 'TSTB' };
    const t = plain(formatFundamentalsComparison([a, b]));
    expect(t).toContain('Perbandingan fundamental: TSTA vs TSTB');
    expect(t).toContain('PER: TSTA 12,00x | TSTB 40,00x (turunan)');
    expect(t).toContain('EPS: TSTA Rp100 | TSTB Rp50');
    expect(t).not.toMatch(/PBV:/); // missing for both -> row omitted
    expect(t).toContain(PROVENANCE_LEGEND);
  });

  it('says so when neither stock has any fundamentals', () => {
    const t = plain(formatFundamentalsComparison([report({}), { ...report({}), symbol: 'TSTB' }]));
    expect(t).toContain('Tidak ada metrik fundamental yang tersedia');
  });
});
