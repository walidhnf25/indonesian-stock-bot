import { parseIntent } from './intent-parser';
import { readPreferences } from '../user/user-preferences';

describe('Presentation preference and portfolio summary intents', () => {
  it.each([
    ['jawab ringkas', 'ringkas'],
    ['balas yang singkat saja', 'ringkas'],
    ['mode pendek', 'ringkas'],
    ['jawab lengkap', 'lengkap'],
    ['format detail', 'lengkap'],
    ['lengkap saja', 'lengkap'],
  ])('%s -> PREFERENCE_SET detail=%s with no ticker', (text, detail) => {
    const r = parseIntent(text);
    expect(r.intent).toBe('PREFERENCE_SET');
    expect(r.parameters).toEqual({ detail });
    expect(r.symbols).toEqual([]);
    expect(r.clarification).toBeUndefined();
  });

  it('the default-ticker form is unchanged', () => {
    expect(parseIntent('saham default saya TSTA').parameters).toEqual({});
    expect(parseIntent('saham default saya TSTA').symbols).toEqual(['TSTA']);
  });

  it.each([
    'ringkas portofolio saya',
    'bagaimana portofolio saya?',
    'analisis porto saya',
    'portofolio saya gimana',
    'evaluasi portfolio',
  ])('%s -> PORTFOLIO_SUMMARY', (text) => {
    expect(parseIntent(text).intent).toBe('PORTFOLIO_SUMMARY');
  });

  it.each([
    ['portofolio saya', 'PORTFOLIO_VIEW'],
    ['riwayat transaksi', 'PORTFOLIO_HISTORY'],
    ['beli 10 lot TSTA di 1000', 'PORTFOLIO_RECORD'],
    ['analisis TSTA', 'STOCK_ANALYSIS'],
  ])('%s stays %s', (text, intent) => {
    expect(parseIntent(text).intent).toBe(intent);
  });

  it('readPreferences keeps only a valid detail value', () => {
    expect(readPreferences({ detail: 'ringkas' })).toEqual({ detail: 'ringkas' });
    expect(readPreferences({ detail: 'lengkap' })).toEqual({ detail: 'lengkap' });
    expect(readPreferences({ detail: 'verbose' })).toEqual({});
  });
});
