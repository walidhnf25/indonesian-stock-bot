import { parseIntent } from './intent-parser';
import { STATE_CHANGING, validateIntent } from './intent-validator';
import { ParsedIntent } from './intent.types';
import { readPreferences } from '../user/user-preferences';

/** Memory, preference and deletion commands are explicit and never produced by the model. */
describe('Memory and preference intents', () => {
  it.each([
    ['apa yang tadi saya tanya?', 'CONTEXT_RECALL'],
    ['saham apa yang terakhir saya cek?', 'CONTEXT_RECALL'],
    ['tadi saya tanya apa', 'CONTEXT_RECALL'],
    ['apa saja yang sudah saya cek', 'CONTEXT_RECALL'],
    ['riwayat obrolan', 'CONTEXT_RECALL'],
    ['konteks saat ini', 'CONTEXT_RECALL'],
    ['apa yang kamu ingat?', 'CONTEXT_RECALL'],
    ['lupakan konteks', 'CONTEXT_CLEAR'],
    ['reset obrolan', 'CONTEXT_CLEAR'],
    ['mulai dari awal', 'CONTEXT_CLEAR'],
    ['lupakan semuanya', 'CONTEXT_CLEAR'],
    ['pengaturan saya', 'PREFERENCE_VIEW'],
    ['preferensi', 'PREFERENCE_VIEW'],
    ['lihat setelan bot', 'PREFERENCE_VIEW'],
    ['hapus saham default', 'PREFERENCE_CLEAR'],
    ['reset saham utama saya', 'PREFERENCE_CLEAR'],
    ['hapus data saya', 'DATA_DELETE'],
    ['Hapus semua data pribadi saya', 'DATA_DELETE'],
    ['lupakan saya', 'DATA_DELETE'],
    ['hapus akun', 'DATA_DELETE'],
    ['konfirmasi hapus data saya', 'DATA_DELETE'],
  ])('%s -> %s', (text, intent) => {
    const r = parseIntent(text);
    expect(r.intent).toBe(intent);
    expect(r.symbols).toEqual([]);
  });

  it('a deletion is only confirmed by an explicit confirmation word', () => {
    expect(parseIntent('hapus data saya').parameters.confirm).toBe(false);
    expect(parseIntent('konfirmasi hapus data saya').parameters.confirm).toBe(true);
    expect(parseIntent('ya, hapus semua data saya').parameters.confirm).toBe(true);
  });

  it.each([
    'saham default saya TSTA',
    'set saham default TSTA',
    'jadikan TSTA saham utama',
    'default saham: TSTA',
  ])('%s -> PREFERENCE_SET with the ticker', (text) => {
    const r = parseIntent(text);
    expect(r.intent).toBe('PREFERENCE_SET');
    expect(r.symbols).toEqual(['TSTA']);
    expect(r.clarification).toBeUndefined();
  });

  it('setting a default without a ticker asks for one instead of guessing', () => {
    const r = parseIntent('set saham default');
    expect(r.intent).toBe('PREFERENCE_SET');
    expect(r.clarification).toMatch(/Saham mana/);
    expect(r.confidence).toBe('low');
  });

  it.each([
    ['cek harga terakhir TSTA', 'STOCK_QUOTE'],
    ['harga TSTA tadi', 'STOCK_QUOTE'],
    ['TSTA kemarin naik ga', 'STOCK_HISTORICAL'],
    ['hapus TSTA', 'WATCHLIST_REMOVE'],
    ['hapus alert TSTA', 'ALERT_DELETE'],
    ['hapus TSTA dari watchlist', 'WATCHLIST_REMOVE'],
    ['data fundamental TSTA', 'FUNDAMENTALS'],
    ['apa itu RSI', 'GENERAL_QUESTION'],
    ['halo', 'SMALL_TALK'],
  ])('ordinary text is not caught: %s -> %s', (text, intent) => {
    expect(parseIntent(text).intent).toBe(intent);
  });

  it('state-changing memory intents are refused when the model produced them', () => {
    for (const intent of [
      'CONTEXT_CLEAR',
      'PREFERENCE_SET',
      'PREFERENCE_CLEAR',
      'DATA_DELETE',
    ] as const) {
      expect(STATE_CHANGING.has(intent)).toBe(true);
      const ai: ParsedIntent = {
        intent,
        symbols: ['TSTA'],
        parameters: { confirm: true },
        confidence: 'high',
        source: 'ai',
        text: 'x',
      };
      const out = validateIntent(ai);
      expect(out.intent).toBe('UNKNOWN');
      expect(out.parameters).toEqual({});
    }
  });

  it('read-only memory intents from the model carry no parameters', () => {
    const out = validateIntent({
      intent: 'CONTEXT_RECALL',
      symbols: [],
      parameters: { anything: 'goes' },
      confidence: 'high',
      source: 'ai',
      text: 'x',
    });
    expect(out.intent).toBe('CONTEXT_RECALL');
    expect(out.parameters).toEqual({});
  });
});

describe('ReadPreferences only keeps allowlisted, valid values', () => {
  it.each([
    [null, {}],
    ['{}', {}],
    [[], {}],
    [{ defaultSymbol: 'bbca' }, { defaultSymbol: 'BBCA' }],
    [{ defaultSymbol: 'BBCA.JK' }, { defaultSymbol: 'BBCA' }],
    [{ defaultSymbol: 'not a ticker' }, {}],
    [{ defaultSymbol: 42 }, {}],
    [{ defaultSymbol: 'BBCA', role: 'admin', __proto__: { x: 1 } }, { defaultSymbol: 'BBCA' }],
  ])('%j -> %j', (raw, expected) => {
    expect(readPreferences(raw)).toEqual(expected);
  });
});
