import { IntentName } from '../intent.types';

/**
 * Personal notes ("catat: ..."), the one place Indonesian Stock Bot stores text a user wrote, on explicit
 * request only. Every form is an explicit command; the model never produces these intents.
 */
export const NOTE_MAX_CHARS = 500;

const WATCHLIST_WORD = /\b(watch\s?list|daftar pantau|pantauan)\b/i;
/** "catat: ...", "catatan: ...", "simpan catatan ...", "buat catatan ...", "note: ..." */
const ADD =
  /^(?:(?:tolong\s+)?(?:simpan|buat|tambah(?:kan)?)\s+catatan(?:\s+(?:baru|saya|ku))?\s*[:-]?\s*|(?:catat|catatan|note)\s*[:-]\s*)(.+)$/i;
const LIST =
  /^(?:lihat\s+|tampilkan\s+|cek\s+|buka\s+)?(?:semua\s+)?catatan(?:\s+saya|\s*ku)?\s*[?!.]*$/i;
const DELETE =
  /^(?:hapus|buang|hilangkan|delete)\s+(?:(semua|seluruh)\s+)?catatan(?:\s+(?:saya|ku))?(?:\s+(?:nomor|no\.?|#))?\s*(\d{1,3})?\s*[?!.]*$/i;
const SEARCH =
  /^(?:cari\s+(?:di\s+)?catatan(?:\s+(?:saya|ku))?(?:\s+(?:tentang|soal|mengenai|untuk))?\s+(.+)|catatan(?:\s+(?:saya|ku))?\s+(?:tentang|soal|mengenai)\s+(.+)|apa\s+catatan(?:\s+(?:saya|ku))?\s+(?:tentang|soal|mengenai)\s+(.+))$/i;

export interface NoteIntent {
  intent: IntentName;
  parameters: Record<string, unknown>;
  clarification?: string;
}

/** `text` is the normalized original (case kept, for the note body); returns null when it is not a note command. */
export function parseNote(text: string): NoteIntent | null {
  if (WATCHLIST_WORD.test(text)) return null; // "catat BBCA ke watchlist" is a watchlist command
  const add = text.match(ADD);
  if (add) {
    const body = add[1].trim();
    if (body.length < 3) {
      return {
        intent: 'NOTE_ADD',
        parameters: {},
        clarification: 'Tulis isi catatannya, mis. "catat: BBCA cum date 20 Mei".',
      };
    }
    if (body.length > NOTE_MAX_CHARS) {
      return {
        intent: 'NOTE_ADD',
        parameters: {},
        clarification: `Catatan maksimal ${NOTE_MAX_CHARS} karakter; yang ini ${body.length}.`,
      };
    }
    return { intent: 'NOTE_ADD', parameters: { text: body } };
  }
  if (LIST.test(text)) return { intent: 'NOTE_LIST', parameters: {} };
  const del = text.match(DELETE);
  if (del) {
    const index = del[2] ? Number(del[2]) : undefined;
    const all = Boolean(del[1]);
    if (!all && index === undefined) {
      return {
        intent: 'NOTE_DELETE',
        parameters: {},
        clarification:
          'Catatan nomor berapa yang dihapus? Mis. "hapus catatan 2" atau "hapus semua catatan".',
      };
    }
    return { intent: 'NOTE_DELETE', parameters: { all, index } };
  }
  const search = text.match(SEARCH);
  if (search) {
    const query = (search[1] ?? search[2] ?? search[3] ?? '').trim();
    if (query.length >= 2) return { intent: 'NOTE_SEARCH', parameters: { query } };
  }
  return null;
}
