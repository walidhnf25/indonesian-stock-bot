import { parseNote } from './note-parser';

describe('Note parser', () => {
  it.each([
    ['catat: BBCA cum date 20 Mei', 'BBCA cum date 20 Mei'],
    ['Catatan: TLKM RUPS Juni', 'TLKM RUPS Juni'],
    ['simpan catatan beli di area support', 'beli di area support'],
    ['buat catatan baru: cek laporan Q2', 'cek laporan Q2'],
    ['note: watch volume', 'watch volume'],
    ['catat - hal penting', 'hal penting'],
  ])('%s -> NOTE_ADD', (text, body) => {
    expect(parseNote(text)).toEqual({ intent: 'NOTE_ADD', parameters: { text: body } });
  });

  it('an empty or over-long note asks instead of storing', () => {
    expect(parseNote('catat: ab')).toMatchObject({
      intent: 'NOTE_ADD',
      clarification: /isi catatannya/,
    });
    expect(parseNote(`catat: ${'x'.repeat(501)}`)).toMatchObject({
      intent: 'NOTE_ADD',
      clarification: /maksimal 500/,
    });
  });

  it.each(['catatan saya', 'lihat catatan', 'catatanku', 'semua catatan saya?', 'cek catatan'])(
    '%s -> NOTE_LIST',
    (text) => expect(parseNote(text)).toEqual({ intent: 'NOTE_LIST', parameters: {} }),
  );

  it.each([
    ['hapus catatan 2', { all: false, index: 2 }],
    ['hapus catatan nomor 10', { all: false, index: 10 }],
    ['hapus semua catatan', { all: true, index: undefined }],
    ['buang seluruh catatan saya', { all: true, index: undefined }],
  ])('%s -> NOTE_DELETE %j', (text, params) => {
    expect(parseNote(text)).toEqual({ intent: 'NOTE_DELETE', parameters: params });
  });

  it('a delete without a number asks which one', () => {
    expect(parseNote('hapus catatan')).toMatchObject({
      intent: 'NOTE_DELETE',
      clarification: /nomor/,
    });
  });

  it.each([
    ['cari catatan BBCA', 'BBCA'],
    ['cari di catatan saya tentang dividen', 'dividen'],
    ['catatan saya tentang TLKM', 'TLKM'],
    ['apa catatan saya soal RUPS?', 'RUPS?'],
  ])('%s -> NOTE_SEARCH', (text, query) => {
    expect(parseNote(text)).toEqual({ intent: 'NOTE_SEARCH', parameters: { query } });
  });

  it.each([
    'catat BBCA ke watchlist',
    'catat beli 10 lot BBCA di 9000',
    'harga BBCA',
    'catatan kaki laporan keuangan itu apa',
    'hapus BBCA',
    'hapus data saya',
  ])('not a note command: %s', (text) => {
    expect(parseNote(text)).toBeNull();
  });
});
