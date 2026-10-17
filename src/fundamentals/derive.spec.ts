import { Fundamentals } from '../stock/stock.types';
import { deriveFields, markStale, missingMetrics } from './derive';

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

describe('Fundamentals provenance and derivation', () => {
  it('reported values stay reported, forward figures are estimates, absent ones are missing', () => {
    const f = deriveFields({ ...empty, per: 12, forwardPer: 10, forwardEps: 150 }, null);
    expect(f.per).toEqual({ value: 12, status: 'reported' });
    expect(f.forwardPer).toEqual({ value: 10, status: 'estimated' });
    expect(f.forwardEps).toEqual({ value: 150, status: 'estimated' });
    expect(f.pbv).toEqual({ value: null, status: 'missing' });
    expect(missingMetrics(f)).toContain('pbv');
    expect(missingMetrics(f)).not.toContain('per');
  });

  it('derives P/E, P/BV, dividend yield, net margin, D/E and ROE from reported inputs only', () => {
    const f = deriveFields(
      {
        ...empty,
        eps: 100,
        bookValuePerShare: 500,
        dividendRate: 40,
        revenue: 1000,
        netIncome: 250,
        totalDebt: 300,
        totalEquity: 600,
      },
      2000,
    );
    expect(f.per).toEqual({ value: 20, status: 'derived' });
    expect(f.pbv).toEqual({ value: 4, status: 'derived' });
    expect(f.dividendYield).toEqual({ value: 2, status: 'derived' });
    expect(f.netMargin).toEqual({ value: 25, status: 'derived' });
    expect(f.debtToEquity).toEqual({ value: 0.5, status: 'derived' });
    expect(f.roe.status).toBe('derived');
    expect(f.roe.value).toBeCloseTo(41.6667, 3);
  });

  it('never overrides a reported figure with a derivation and never derives from estimates', () => {
    const f = deriveFields({ ...empty, per: 15, eps: 100, forwardEps: 50 }, 2000);
    expect(f.per).toEqual({ value: 15, status: 'reported' }); // not 20
    const g = deriveFields({ ...empty, forwardEps: 50 }, 2000);
    expect(g.per.status).toBe('missing'); // forward EPS is an estimate, not an input
  });

  it('refuses nonsensical inputs instead of producing a number', () => {
    expect(deriveFields({ ...empty, eps: -5 }, 1000).per.status).toBe('missing'); // negative EPS
    expect(deriveFields({ ...empty, eps: 0 }, 1000).per.status).toBe('missing');
    expect(deriveFields({ ...empty, eps: 100 }, 0).per.status).toBe('missing'); // no price
    expect(deriveFields({ ...empty, eps: 100 }, Number.NaN).per.status).toBe('missing');
    expect(deriveFields({ ...empty, revenue: 0, netIncome: 1 }, null).netMargin.status).toBe(
      'missing',
    );
    expect(
      deriveFields({ ...empty, totalDebt: 1, totalEquity: -3 }, null).debtToEquity.status,
    ).toBe('missing');
    expect(deriveFields({ ...empty, eps: Number.POSITIVE_INFINITY }, 100).eps.status).toBe(
      'missing',
    );
  });

  it('markStale keeps values but flags them, leaving missing as missing', () => {
    const f = markStale(deriveFields({ ...empty, per: 12 }, null));
    expect(f.per).toEqual({ value: 12, status: 'stale' });
    expect(f.pbv).toEqual({ value: null, status: 'missing' });
  });
});
