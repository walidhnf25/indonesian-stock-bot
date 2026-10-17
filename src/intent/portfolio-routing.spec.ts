import { parseIntent } from './intent-parser';
import { AI_STATE_CHANGE_REFUSED, validateIntent } from './intent-validator';

const route = (text: string) => validateIntent(parseIntent(text));

describe('Portfolio bookkeeping intents (deterministic only)', () => {
  it.each([
    ['beli 10 lot BBCA di 9000', 'BUY', 1000, 9000, undefined],
    ['sudah beli BBCA 5 lot harga 9.250', 'BUY', 500, 9250, undefined],
    ['catat beli 200 lembar BBRI @ 4500 fee 1500', 'BUY', 200, 4500, 1500],
    ['jual 3 lot TLKM di 3.100', 'SELL', 300, 3100, undefined],
    ['tadi jual BBCA 2 lot seharga 9500 biaya 10rb', 'SELL', 200, 9500, 10_000],
    ['beli 1,5 lot ANTM di 2000', 'BUY', 150, 2000, undefined],
  ])('%s -> PORTFOLIO_RECORD %s', (text, type, qty, price, fees) => {
    const r = route(text);
    expect(r.intent).toBe('PORTFOLIO_RECORD');
    expect(r.parameters).toMatchObject({ txType: type, quantity: qty, price, fees });
    expect(r.clarification).toBeUndefined();
    expect(r.symbols).toHaveLength(1);
  });

  it.each([
    ['setor 10 juta', 'DEPOSIT', 10_000_000],
    ['deposit 2.500.000', 'DEPOSIT', 2_500_000],
    ['tarik 5jt', 'WITHDRAWAL', 5_000_000],
    ['dividen BBCA 150000', 'DIVIDEND', 150_000],
    ['terima dividen 75rb dari TLKM', 'DIVIDEND', 75_000],
  ])('%s -> PORTFOLIO_RECORD %s', (text, type, amount) => {
    const r = route(text);
    expect(r.intent).toBe('PORTFOLIO_RECORD');
    expect(r.parameters).toMatchObject({ txType: type, amount });
  });

  it('a buy with a quantity but no price asks for the price instead of guessing', () => {
    const r = route('beli 10 lot BBCA');
    expect(r.intent).toBe('PORTFOLIO_RECORD');
    expect(r.clarification).toMatch(/harga per lembar/);
  });

  it('a deposit without an amount asks for it', () => {
    const r = route('setor dana');
    expect(r.intent).toBe('PORTFOLIO_RECORD');
    expect(r.clarification).toMatch(/jumlah/);
  });

  it.each([
    ['beli BBCA?', 'STOCK_ADVICE'],
    ['sebaiknya beli 10 lot BBCA di 9000?', 'STOCK_ADVICE'],
    ['jual BBCA sekarang', 'STOCK_ADVICE'],
    ['dividen BBCA berapa?', 'FUNDAMENTALS'],
  ])('advice-seeking or question wording is never a bookkeeping entry: %s', (text, intent) => {
    expect(route(text).intent).toBe(intent);
  });

  it('a question that mentions a lot size is a stock question, never a bookkeeping entry', () => {
    const r = route('apakah 10 lot BBCA di 9000 bagus?');
    expect(r.intent).toBe('STOCK_QUESTION');
    expect(r.symbols).toEqual(['BBCA']);
  });

  it.each([
    'portofolio saya',
    'porto',
    'berapa untung saya?',
    'cuan saya gimana',
    'posisi saya',
    'holding saya',
  ])('%s -> PORTFOLIO_VIEW', (text) => {
    expect(route(text).intent).toBe('PORTFOLIO_VIEW');
  });

  it.each(['riwayat transaksi', 'transaksi saya', 'history portofolio'])(
    '%s -> PORTFOLIO_HISTORY',
    (text) => {
      expect(route(text).intent).toBe('PORTFOLIO_HISTORY');
    },
  );

  it.each(['batalkan transaksi terakhir', 'undo', 'batal pembelian tadi'])(
    '%s -> PORTFOLIO_UNDO',
    (text) => {
      expect(route(text).intent).toBe('PORTFOLIO_UNDO');
    },
  );

  it('date words do not reroute a bookkeeping entry', () => {
    expect(route('kemarin beli 10 lot BBCA di 9000').intent).toBe('PORTFOLIO_RECORD');
  });

  it('the AI classifier can view but never record or undo', () => {
    const ai = (intent: 'PORTFOLIO_RECORD' | 'PORTFOLIO_UNDO' | 'PORTFOLIO_VIEW') =>
      validateIntent({
        intent,
        symbols: ['BBCA'],
        parameters: { txType: 'BUY', quantity: 100, price: 9000 },
        confidence: 'low',
        source: 'ai',
        text: 'x',
      });
    expect(ai('PORTFOLIO_RECORD')).toMatchObject({
      intent: 'UNKNOWN',
      clarification: AI_STATE_CHANGE_REFUSED,
    });
    expect(ai('PORTFOLIO_UNDO')).toMatchObject({ intent: 'UNKNOWN' });
    expect(ai('PORTFOLIO_VIEW').intent).toBe('PORTFOLIO_VIEW');
  });
});

describe('signed numbers are refused, never absolutised', () => {
  it.each(['beli -5 lot TSTA di 1000', 'jual 5 lot TSTA di -1000', 'beli - 5 lot TSTA di 1000'])(
    '%s -> clarification, nothing recorded',
    (text) => {
      const r = parseIntent(text);
      expect(r.intent).toBe('PORTFOLIO_RECORD');
      expect(r.clarification).toMatch(/tidak boleh negatif/);
      expect(r.parameters.quantity).toBeUndefined();
    },
  );

  it('a hyphen inside a word or a range is not a sign', () => {
    expect(parseIntent('beli 5 lot TSTA di 1000 fee 10rb').clarification).toBeUndefined();
  });
});
