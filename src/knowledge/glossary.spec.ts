import { GENERAL_ANSWER_POLICY, checkTextPolicy } from '../ai/policy/ai-policy';
import { GLOSSARY, GLOSSARY_FALLBACK, findGlossaryEntries } from './glossary';

describe('deterministic glossary (conceptual questions never need the model)', () => {
  it('has an entry for every indicator Indonesian Stock Bot computes', () => {
    const ids = GLOSSARY.map((e) => e.id);
    for (const required of [
      'rsi',
      'macd',
      'sma',
      'ema',
      'ma',
      'bollinger',
      'atr',
      'support',
      'resistance',
      'volume',
      'volume_ratio',
      'volatility',
      'trend',
    ]) {
      expect(ids).toContain(required);
    }
  });

  it.each(GLOSSARY.map((e) => [e.id, e.text] as const))(
    '%s: the text itself passes the AI output policy (no advice, guarantees, targets or prices)',
    (_id, text) => {
      expect(checkTextPolicy([text], GENERAL_ANSWER_POLICY)).toEqual([]);
      expect(text).not.toMatch(/\bRp\s?\d/);
      expect(text).not.toMatch(/\b(beli sekarang|jual sekarang|pasti naik|dijamin|all in|gas)\b/i);
    },
  );

  it('the fallback text passes the policy too', () => {
    expect(checkTextPolicy([GLOSSARY_FALLBACK], GENERAL_ANSWER_POLICY)).toEqual([]);
  });

  it('the RSI definition has the zones the right way round (a live 4B model once inverted them)', () => {
    const rsi = GLOSSARY.find((e) => e.id === 'rsi')!.text;
    expect(rsi).toMatch(/di atas 70 dianggap zona jenuh beli \(overbought\)/);
    expect(rsi).toMatch(/di bawah 30 dianggap zona jenuh jual \(oversold\)/);
  });

  it('the volume-ratio thresholds in the text match the ones the validator uses', () => {
    const t = GLOSSARY.find((e) => e.id === 'volume_ratio')!.text;
    expect(t).toMatch(/1,5x/);
    expect(t).toMatch(/0,8x/);
  });

  it.each([
    ['Apa itu RSI?', ['rsi']],
    ['jelaskan MACD', ['macd']],
    ['Apa fungsi SMA?', ['sma']],
    ['apa itu EMA', ['ema']],
    ['Apa itu Bollinger Bands?', ['bollinger']],
    ['Apa kegunaan ATR?', ['atr']],
    ['Apa arti volume ratio?', ['volume_ratio']],
    ['apa arti volume tinggi?', ['volume']],
    ['apa arti support?', ['support']],
    ['apa arti resistance?', ['resistance']],
    ['apa itu moving average?', ['ma']],
    ['apa itu volatilitas?', ['volatility']],
    ['apa arti RSI 70?', ['rsi']],
    ['apa itu overbought?', ['rsi']],
    ['bedanya SMA dan EMA apa?', ['sma', 'ema']],
  ])('"%s" -> %j', (q, ids) => {
    expect(findGlossaryEntries(q).map((e) => e.id)).toEqual(ids);
  });

  it('is robust to disguised spelling of the topic', () => {
    expect(findGlossaryEntries('apa itu R S I ?').map((e) => e.id)).toContain('rsi');
    expect(findGlossaryEntries('apa itu MACD???').map((e) => e.id)).toEqual(['macd']);
  });

  it('returns nothing for topics it does not cover (the handler then lists what it can explain)', () => {
    expect(findGlossaryEntries('apa itu stop loss?')).toEqual([]);
    expect(findGlossaryEntries('apa itu inflasi')).toEqual([]);
    expect(findGlossaryEntries('')).toEqual([]);
    expect(GLOSSARY_FALLBACK).toMatch(/RSI, MACD/);
  });

  it('answers at most three topics per question', () => {
    expect(
      findGlossaryEntries('jelaskan RSI MACD SMA EMA ATR Bollinger').length,
    ).toBeLessThanOrEqual(3);
  });
});
