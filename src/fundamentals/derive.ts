import { Fundamentals } from '../stock/stock.types';
import { FUNDAMENTAL_METRICS, FundamentalFields, FundamentalMetric } from './fundamentals.types';

/** Metrics that are analyst estimates by definition whenever the provider supplies them. */
const ESTIMATED: ReadonlySet<FundamentalMetric> = new Set<FundamentalMetric>([
  'forwardPer',
  'forwardEps',
]);

const finite = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/**
 * Turns raw provider fundamentals into fields with provenance and fills what can be computed from
 * other REPORTED figures. Each derivation is a textbook identity, uses only reported inputs (never an
 * estimate, never another derivation) and is marked 'derived'. Nothing is invented: a metric without
 * reported inputs stays 'missing'.
 *
 *   P/E            = price / EPS (trailing)          needs price > 0, EPS > 0
 *   P/BV           = price / book value per share    needs price > 0, BVPS > 0
 *   dividend yield = dividend per share / price      needs price > 0, dividend per share >= 0
 *   net margin     = net income / revenue            needs revenue > 0
 *   D/E            = total debt / total equity       needs equity > 0
 *   ROE            = net income / total equity       needs equity > 0
 */
export function deriveFields(raw: Fundamentals, price: number | null): FundamentalFields {
  const fields = {} as FundamentalFields;
  for (const m of FUNDAMENTAL_METRICS) {
    const v = raw[m];
    fields[m] = finite(v)
      ? { value: v, status: ESTIMATED.has(m) ? 'estimated' : 'reported' }
      : { value: null, status: 'missing' };
  }
  const reported = (m: FundamentalMetric) =>
    fields[m].status === 'reported' ? fields[m].value : null;
  const set = (m: FundamentalMetric, value: number | null) => {
    if (fields[m].status === 'missing' && finite(value)) fields[m] = { value, status: 'derived' };
  };
  const p = finite(price) && price > 0 ? price : null;
  const eps = reported('eps');
  const bvps = finite(raw.bookValuePerShare) ? raw.bookValuePerShare : null;
  const dps = finite(raw.dividendRate) ? raw.dividendRate : null;
  const revenue = reported('revenue');
  const netIncome = reported('netIncome');
  const debt = reported('totalDebt');
  const equity = finite(raw.totalEquity) ? raw.totalEquity : null;

  if (p !== null && eps !== null && eps > 0) set('per', p / eps);
  if (p !== null && bvps !== null && bvps > 0) set('pbv', p / bvps);
  if (p !== null && dps !== null && dps >= 0) set('dividendYield', (dps / p) * 100);
  if (revenue !== null && revenue > 0 && netIncome !== null)
    set('netMargin', (netIncome / revenue) * 100);
  if (equity !== null && equity > 0 && debt !== null) set('debtToEquity', debt / equity);
  if (equity !== null && equity > 0 && netIncome !== null) set('roe', (netIncome / equity) * 100);
  return fields;
}

/** Marks every present value 'stale' (served from an old snapshot); 'missing' stays 'missing'. */
export function markStale(fields: FundamentalFields): FundamentalFields {
  const out = {} as FundamentalFields;
  for (const m of FUNDAMENTAL_METRICS) {
    const f = fields[m];
    out[m] = f.status === 'missing' ? f : { value: f.value, status: 'stale' };
  }
  return out;
}

export function missingMetrics(fields: FundamentalFields): FundamentalMetric[] {
  return FUNDAMENTAL_METRICS.filter((m) => fields[m].status === 'missing');
}
