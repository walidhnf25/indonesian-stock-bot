import { IntentName } from '../intent.types';

/**
 * What the bot remembers and what the user may change about it. Every match here is a plain,
 * explicit command; the language model never produces these intents (the state-changing ones are refused
 * by the validator when AI-sourced, and the read-only ones carry no parameters).
 */
const ME = String.raw`(?:saya|aku|gue|gw|ku)`;
const rx = {
  /** "hapus data saya", "hapus semua data pribadi saya", "lupakan saya", "hapus akun" */
  dataDelete: new RegExp(
    String.raw`\b(?:hapus|hapuskan|delete|musnahkan|bersihkan)\b[^?]{0,20}\b(?:semua\s+|seluruh\s+)?data\s+(?:pribadi\s+)?${ME}\b|\bhapus\s+akun\b|\blupakan\s+(?:saya|aku|diriku)\b|\bdata\s+${ME}\b[^?]{0,10}\b(?:dihapus|hapus)\b`,
    'i',
  ),
  dataDeleteConfirm: /\b(?:konfirmasi|confirm|ya,?\s*hapus)\b/i,
  /** "jawab ringkas", "balas yang lengkap", "mode singkat" */
  prefDetail:
    /\b(?:jawab|jawaban|balas|balasan|tampilan|format|mode|gaya)\b(?:\s+yang)?\s+(ringkas|singkat|pendek|lengkap|detail|panjang)\b|\b(ringkas|lengkap)\s+(?:saja|aja)\b/i,
  /** "hapus saham default", "reset saham utama" */
  prefClear:
    /\b(?:hapus|lepas|buang|reset|kosongkan|hilangkan|batalkan)\b[^?]{0,20}\bsaham\s+(?:default|utama|bawaan)\b/i,
  /** "set saham default BBCA", "saham default saya BBCA", "jadikan BBCA saham utama" */
  prefSet:
    /\b(?:set|atur|jadikan|pakai|gunakan|simpan|ubah|ganti)\b[^?]{0,30}\bsaham\s+(?:default|utama|bawaan)\b|\bsaham\s+(?:default|utama|bawaan)\b|\bdefault\s+(?:saham|ticker|symbol|simbol)\b/i,
  /** "pengaturan saya", "preferensi", "setelan bot" */
  prefView:
    /^(?:lihat\s+|tampilkan\s+|cek\s+)?(?:pengaturan|preferensi|setelan|setting(?:an)?)(?:\s+(?:saya|ku|aku|bot))?\s*[?!.]*$/i,
  /** "lupakan konteks", "reset obrolan", "mulai dari awal" */
  contextClear:
    /\b(?:lupakan|reset|hapus|bersihkan|kosongkan|mulai\s+ulang)\b[^?]{0,20}\b(?:konteks|obrolan|percakapan|ingatan|memori|chat|riwayat)\b|\b(?:konteks|obrolan|percakapan|ingatan)\b[^?]{0,10}\b(?:reset|dihapus|dilupakan)\b|\bmulai\s+dari\s+awal\b|\blupakan\s+(?:semua(?:nya)?|itu|saja|aja)\b/i,
  /** "apa yang tadi saya tanya?", "saham apa yang terakhir saya cek?", "riwayat obrolan", "konteks saat ini" */
  contextRecall: new RegExp(
    String.raw`\b(?:riwayat|histori|history)\s+(?:obrolan|percakapan|chat|pertanyaan|konteks)\b|\bkonteks\s+(?:saat\s+ini|sekarang|saya|obrolan)\b|\bapa\s+(?:saja\s+|aja\s+)?yang\s+kamu\s+ingat\b|\b(?:apa|saham\s+apa)\b[^?]{0,30}\b(?:tadi|terakhir|barusan|sebelumnya)\b[^?]{0,20}\b${ME}\s+(?:tanya|tanyakan|cek|lihat|bahas|cari|minta)\b|\b(?:tadi|terakhir|barusan)\b\s+${ME}\s+(?:tanya|tanyakan|cek|lihat|bahas)\s+(?:apa|saham\s+apa)\b|\bapa\s+(?:saja|aja)\s+yang\s+(?:sudah|udah|pernah|telah)\s+${ME}\s+(?:cek|tanya|lihat|bahas)\b`,
    'i',
  ),
};

export interface MemoryIntent {
  intent: IntentName;
  parameters: Record<string, unknown>;
  clarification?: string;
}

/**
 * Returns the memory/preference intent for `lower` (already normalized and lower-cased), or null when the
 * text is about something else. `symbols` are the tickers found in the text.
 */
export function parseMemory(lower: string, symbols: string[]): MemoryIntent | null {
  if (rx.dataDelete.test(lower)) {
    return { intent: 'DATA_DELETE', parameters: { confirm: rx.dataDeleteConfirm.test(lower) } };
  }
  const detail = lower.match(rx.prefDetail);
  if (detail) {
    const word = detail[1] ?? detail[2];
    return {
      intent: 'PREFERENCE_SET',
      parameters: { detail: /^(ringkas|singkat|pendek)$/.test(word) ? 'ringkas' : 'lengkap' },
    };
  }
  if (rx.prefClear.test(lower)) return { intent: 'PREFERENCE_CLEAR', parameters: {} };
  if (rx.prefSet.test(lower)) {
    return {
      intent: 'PREFERENCE_SET',
      parameters: {},
      clarification:
        symbols.length === 0
          ? 'Saham mana yang mau dijadikan default? Tulis mis. "saham default saya BBCA".'
          : undefined,
    };
  }
  if (symbols.length > 0) return null; // with a ticker the rest is a question about that stock
  if (rx.prefView.test(lower)) return { intent: 'PREFERENCE_VIEW', parameters: {} };
  if (rx.contextClear.test(lower)) return { intent: 'CONTEXT_CLEAR', parameters: {} };
  if (rx.contextRecall.test(lower)) return { intent: 'CONTEXT_RECALL', parameters: {} };
  return null;
}
