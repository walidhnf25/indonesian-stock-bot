import { AdviceKind, SmallTalkKind } from '../intent/intent.types';

/**
 * Fixed, deterministic user-facing texts for policy situations. None of these are ever produced by
 * the LLM, so they cannot be talked out of the rules.
 */

const joinSymbols = (symbols: readonly string[]): string => {
  if (symbols.length === 0) return 'saham ini';
  if (symbols.length === 1) return symbols[0];
  return `${symbols.slice(0, -1).join(', ')} dan ${symbols[symbols.length - 1]}`;
};

/** Advice-style message with no ticker named: the policy answer stands on its own, plus how to get data. */
const NO_SYMBOL_HINT = ' Sebutkan kode sahamnya (mis. "analisis BBCA") untuk melihat datanya.';

export function adviceMessage(kind: AdviceKind, symbols: readonly string[]): string {
  const text = adviceText(kind, symbols);
  if (symbols.length > 0) return text;
  return text.replace(/:$/, '.') + NO_SYMBOL_HINT;
}

function adviceText(kind: AdviceKind, symbols: readonly string[]): string {
  switch (kind) {
    case 'target_price':
      return 'Saya tidak menetapkan target harga masa depan. Saya dapat menampilkan level teknikal seperti support/resistance berdasarkan data historis yang tersedia.';
    case 'prediction':
      return 'Saya tidak memprediksi pergerakan harga di masa depan, dan tidak ada yang bisa memastikannya. Berikut kondisi teknikal terkini sebagai gambaran saja.';
    case 'guarantee':
      return 'Tidak ada jaminan di pasar saham, dan saya tidak memberikan kepastian untung maupun rugi. Berikut kondisi teknikal yang terlihat dari data:';
    case 'trade':
    default:
      return `Saya tidak memberikan instruksi beli/jual. Saya dapat membantu melihat kondisi teknikal ${joinSymbols(symbols)}, termasuk tren, RSI, volume, support, resistance, dan risiko yang terlihat dari data.`;
  }
}

/** Prefix for an explicit analysis request that also contained advice-style wording. */
export const POLICY_NOTICE =
  'ℹ️ Saya tidak memberikan instruksi beli/jual, target harga, atau prediksi. Berikut analisis berbasis data.';

export function smallTalkReply(kind: SmallTalkKind | undefined, daypart?: string): string {
  switch (kind) {
    case 'thanks':
      return 'Sama-sama! Kalau ingin menganalisis saham, cukup ketik misalnya "analisis BBCA".';
    case 'greeting':
      return `${daypart ? `Selamat ${daypart}!` : 'Halo!'} Saya bisa membantu data saham IDX. Coba ketik "BBCA" atau "analisis BBCA". Ketik /help untuk contoh lengkap.`;
    case 'ack':
    default:
      return 'Siap! Kalau butuh data saham, ketik misalnya "BBCA" atau "analisis BBCA".';
  }
}

export const SCREEN_GUIDANCE = [
  'Saya bisa membantu menyaring saham berdasarkan kriteria yang terukur, seperti perubahan harga, RSI, volume ratio, MA, atau kombinasi indikator. Contoh: "saham dengan RSI di bawah 30 dan volume di atas 2x rata-rata."',
  '',
  'Saya tidak menyusun peringkat "saham terbaik" dan tidak menyarankan saham untuk dibeli. Contoh lain:',
  '• "saham apa yang naik hari ini?"',
  '• "saham dengan harga di atas MA50"',
  '• "tampilkan saham dengan momentum positif"',
].join('\n');

export const inputTooLongMessage = (max: number): string =>
  `Pesanmu terlalu panjang (maksimal ${max} karakter). Tulis lebih singkat, mis. "analisis BBCA" atau "apa itu RSI?".`;

export const symbolLimitMessage = (max: number): string =>
  `Maksimal ${max} saham per permintaan. Silakan pilih saham yang ingin dianalisis.`;

export const SINGLE_SYMBOL_MESSAGE: Record<'alert' | 'question', string> = {
  alert:
    'Alert dibuat per saham. Sebutkan satu saham saja, mis. "ingatkan saya kalau BBCA di atas 8500".',
  question:
    'Pertanyaan ini hanya bisa untuk satu saham per pesan. Sebutkan satu saham, atau gunakan "bandingkan BBCA BBRI" untuk perbandingan.',
};

export const AI_NOTICE = {
  unavailable: 'Analisis AI sedang tidak tersedia. Berikut pengamatan dari perhitungan teknikal:',
  timeout:
    'Analisis AI sedang membutuhkan waktu terlalu lama. Silakan coba lagi beberapa saat lagi. Berikut data teknikal yang tersedia:',
  busy: 'AI sedang sibuk melayani permintaan lain. Silakan coba lagi sebentar lagi. Berikut data teknikal yang tersedia:',
  userBusy:
    'Permintaan AI sebelumnya darimu masih diproses. Tunggu sampai selesai, lalu coba lagi. Berikut data teknikal yang tersedia:',
  invalidData:
    'Analisis AI dilewati karena data harga yang diterima tidak valid atau mencurigakan. Berikut data yang tersedia (periksa di sumber lain sebelum dipakai):',
  quota:
    'Batas penggunaan AI per menit tercapai; coba lagi sekitar satu menit lagi. Berikut data teknikal yang tersedia:',
  invalid:
    'Hasil model AI tidak dapat diproses (format tidak valid). Berikut data teknikal yang tersedia:',
  unsafe:
    'Analisis AI tidak dapat ditampilkan karena hasil model tidak memenuhi validasi keamanan. Berikut data teknikal yang tersedia:',
} as const;

export type AiNoticeKind = keyof typeof AI_NOTICE;
