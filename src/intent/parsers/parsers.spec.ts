import {
  normalizeTicker,
  isValidTicker,
  toYahooSymbol,
  fromYahooSymbol,
} from '../../common/utils/ticker';
import { parseAlert } from './alert-parser';
import { parseIdNumber } from './number-parser';
import { extractSymbols } from './ticker-extractor';

describe('ticker normalization', () => {
  it.each([
    ['bbca', 'BBCA'],
    ['BBCA', 'BBCA'],
    ['BbCa', 'BBCA'],
    [' bbca ', 'BBCA'],
    ['BBCA.JK', 'BBCA'],
    ['bbca.jk', 'BBCA'],
    ['IDX:TLKM', 'TLKM'],
  ])('normalizes %s -> %s', (input, expected) => {
    expect(normalizeTicker(input)).toBe(expected);
  });

  it.each(['', 'BBC', 'BBCAA', 'BB1A', '1234', 'BBCA!', 'BB CA'])('rejects %j', (input) => {
    expect(normalizeTicker(input)).toBeNull();
    expect(isValidTicker(input)).toBe(false);
  });

  it('converts to and from Yahoo symbols', () => {
    expect(toYahooSymbol('BBCA')).toBe('BBCA.JK');
    expect(fromYahooSymbol('bbca.jk')).toBe('BBCA');
  });
});

describe('extractSymbols', () => {
  it('finds multiple tickers in order and removes duplicates', () => {
    expect(extractSymbols('bandingkan BBCA, BBRI dan BMRI lalu BBCA lagi')).toEqual([
      'BBCA',
      'BBRI',
      'BMRI',
    ]);
  });
  it('ignores stopwords and indicator names', () => {
    expect(extractSymbols('RSI dan MACD hari ini naik atau turun')).toEqual([]);
    expect(extractSymbols('IHSG')).toEqual([]);
  });
  it('accepts a bare lower-case ticker as the only word', () => {
    expect(extractSymbols('antm')).toEqual(['ANTM']);
  });
  it('accepts unknown lower-case tickers only when positioned like one', () => {
    expect(extractSymbols('analisis mlbi')).toEqual(['MLBI']);
    expect(extractSymbols('besok mlbi mungkin')).toEqual([]);
  });
  it('does not mistake upper-case chat abbreviations for tickers', () => {
    expect(extractSymbols('analisis BBCA ASAP')).toEqual(['BBCA']);
    expect(extractSymbols('Tolong analisis BBCA dan BBRI ASAP')).toEqual(['BBCA', 'BBRI']);
    expect(extractSymbols('Apakah BBCA FOMO atau YOLO')).toEqual(['BBCA']);
  });
});

describe('parseIdNumber', () => {
  it.each([
    ['8500', 8500],
    ['8.500', 8500],
    ['8,500', 8500],
    ['1.250.000', 1250000],
    ['8.500,5', 8500.5],
    ['70,5', 70.5],
    ['70.5', 70.5],
    ['8rb', 8000],
    ['8,5rb', 8500],
    ['8 ribu', 8000],
    ['8k', 8000],
    ['2jt', 2000000],
    ['Rp8.500', 8500],
  ])('%s -> %d', (raw, expected) => {
    expect(parseIdNumber(raw)).toBeCloseTo(expected, 6);
  });
  it('returns null for non-numbers', () => {
    expect(parseIdNumber('abc')).toBeNull();
    expect(parseIdNumber('')).toBeNull();
  });
});

describe('parseAlert', () => {
  it('parses price above/below', () => {
    expect(parseAlert('ingatkan saya kalau BBCA di atas 8500')).toMatchObject({
      metric: 'price',
      condition: 'above',
      value: 8500,
      missing: [],
    });
    expect(parseAlert('kasih tahu kalau BBCA turun di bawah 7800')).toMatchObject({
      metric: 'price',
      condition: 'below',
      value: 7800,
    });
    expect(parseAlert('alert BBCA kalau harga menembus 9000')).toMatchObject({
      condition: 'above',
      value: 9000,
    });
    expect(parseAlert('kabari kalau BBCA kurang dari Rp7.500')).toMatchObject({
      condition: 'below',
      value: 7500,
    });
  });
  it('parses RSI alerts', () => {
    expect(parseAlert('alert BBCA kalau RSI di atas 70')).toMatchObject({
      metric: 'rsi',
      condition: 'above',
      value: 70,
    });
    expect(parseAlert('alert BBCA kalau RSI di bawah 30')).toMatchObject({
      metric: 'rsi',
      condition: 'below',
      value: 30,
    });
  });
  it('parses volume multiplier alerts', () => {
    expect(parseAlert('beri tahu kalau volume BBCA lebih dari 2x rata-rata')).toMatchObject({
      metric: 'volume',
      condition: 'above',
      value: 2,
    });
    expect(parseAlert('alert volume BBCA 3 kali rata-rata')).toMatchObject({
      metric: 'volume',
      value: 3,
    });
  });
  it('reports what is missing', () => {
    expect(parseAlert('ingatkan saya BBCA').missing).toEqual(['condition', 'value']);
    expect(parseAlert('ingatkan BBCA di atas').missing).toContain('value');
  });
  it('picks the condition that appears first when both phrases occur', () => {
    expect(parseAlert('kasih tahu kalau BBCA turun di bawah 7800')).toMatchObject({
      condition: 'below',
    });
  });
});
