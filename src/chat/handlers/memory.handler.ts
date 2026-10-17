import { Injectable } from '@nestjs/common';
import { escapeHtml as h } from '../../common/utils/format';
import { ConversationService } from '../../conversation/conversation.service';
import { ConversationTurn, IntentName } from '../../intent/intent.types';
import { UserDataService } from '../../user/user-data.service';
import { readPreferences } from '../../user/user-preferences';
import { UserService } from '../../user/user.service';
import { HandlerContext } from '../chat.types';

/** Memory, preferences and deletion are personal: never shown or changed from a group. */
export const MEMORY_PRIVATE_ONLY =
  'Konteks, preferensi, dan penghapusan data bersifat pribadi: gunakan chat pribadi dengan bot ini.';

const INTENT_LABEL: Partial<Record<IntentName, string>> = {
  STOCK_QUOTE: 'harga',
  STOCK_HISTORICAL: 'riwayat harga',
  STOCK_TECHNICAL: 'teknikal',
  STOCK_ANALYSIS: 'analisis',
  STOCK_COMPARISON: 'perbandingan',
  STOCK_QUESTION: 'pertanyaan',
  STOCK_ADVICE: 'kebijakan',
  FOREIGN_FLOW: 'asing',
  BROKER_SUMMARY: 'broker',
  FUNDAMENTALS: 'fundamental',
  WATCHLIST_ADD: 'watchlist',
  ALERT_CREATE: 'alert',
  ALERT_PAUSE: 'alert',
  ALERT_RESUME: 'alert',
  ALERT_DELETE: 'alert',
  PORTFOLIO_RECORD: 'portofolio',
};

/**
 * What Indonesian Stock Bot remembers (and lets the user see, change or erase). Every answer is deterministic
 * text built from the user's own rows; nothing here reaches a data provider or the language model.
 */
@Injectable()
export class MemoryHandler {
  constructor(
    private readonly conversation: ConversationService,
    private readonly users: UserService,
    private readonly userData: UserDataService,
  ) {}

  async handle(ctx: HandlerContext): Promise<string[]> {
    switch (ctx.intent.intent) {
      case 'CONTEXT_RECALL':
        return this.recall(ctx);
      case 'CONTEXT_CLEAR':
        await this.conversation.clear(ctx.user.id, ctx.chat.id);
        return ['🧹 Konteks obrolan di chat ini sudah dilupakan.'];
      case 'PREFERENCE_VIEW':
        return [this.preferencesText(ctx)];
      case 'PREFERENCE_SET':
        if (
          ctx.intent.parameters.detail === 'ringkas' ||
          ctx.intent.parameters.detail === 'lengkap'
        ) {
          await this.users.setDetail(ctx.user.id, ctx.intent.parameters.detail);
          return [
            ctx.intent.parameters.detail === 'ringkas'
              ? '✅ Jawaban analisis dibuat ringkas: harga, tren, inti analisis, dan semua risiko. "jawab lengkap" untuk kembali.'
              : '✅ Jawaban analisis dibuat lengkap lagi.',
          ];
        }
        return this.setDefaultSymbol(ctx);
      case 'PREFERENCE_CLEAR': {
        await this.users.setDefaultSymbol(ctx.user.id, null);
        return ['✅ Saham default dihapus.'];
      }
      case 'DATA_DELETE':
        return this.deleteData(ctx);
      default:
        return [];
    }
  }

  private async recall(ctx: HandlerContext): Promise<string[]> {
    const turns = await this.conversation.recall(ctx.user.id, ctx.chat.id);
    const what = `Saya hanya menyimpan kode saham dan jenis permintaan (maks ${10} terakhir) selama ${this.conversation.ttlMinutes} menit per chat, bukan isi pesan.`;
    if (turns.length === 0) return [`Belum ada yang saya ingat di chat ini.\n\n${what}`];
    const lines = turns.map(
      (t) =>
        `• ${h(this.when(t, ctx.user.timezone))} — ${h(t.symbols.join(', '))} (${h(INTENT_LABEL[t.intent] ?? t.intent.toLowerCase())})`,
    );
    return [
      `🧠 <b>Yang saya ingat di chat ini</b>\n${lines.join('\n')}\n\n${what}\nKetik "lupakan konteks" untuk menghapusnya.`,
    ];
  }

  private preferencesText(ctx: HandlerContext): string {
    const prefs = readPreferences(ctx.user.preferences);
    return [
      '⚙️ <b>Pengaturan</b>',
      `• Saham default: ${prefs.defaultSymbol ? `<b>${h(prefs.defaultSymbol)}</b>` : 'belum ada'} — ubah dengan "saham default saya BBCA", hapus dengan "hapus saham default".`,
      `• Gaya jawaban analisis: <b>${prefs.detail === 'ringkas' ? 'ringkas' : 'lengkap'}</b> — ubah dengan "jawab ringkas" / "jawab lengkap".`,
      `• Konteks obrolan: disimpan ${this.conversation.ttlMinutes} menit per chat ("lupakan konteks" untuk menghapus).`,
      '• Semua data (watchlist, alert, portofolio, konteks, preferensi): "hapus data saya".',
    ].join('\n');
  }

  private async setDefaultSymbol(ctx: HandlerContext): Promise<string[]> {
    if (ctx.intent.symbols.length !== 1)
      return ['Sebutkan satu kode saham, mis. "saham default saya BBCA".'];
    const symbol = ctx.intent.symbols[0];
    await this.users.setDefaultSymbol(ctx.user.id, symbol);
    return [
      `✅ Saham default: <b>${h(symbol)}</b>. Pertanyaan tanpa kode saham (mis. "berapa RSI?") akan memakai ${h(symbol)} bila tidak ada konteks obrolan.`,
    ];
  }

  private async deleteData(ctx: HandlerContext): Promise<string[]> {
    const confirm = ctx.intent.parameters.confirm === true;
    if (!confirm) {
      const until = await this.conversation.markDeletionRequested(ctx.user.id, ctx.chat.id);
      ctx.log.deletionRequested = true;
      return [
        [
          '⚠️ Ini akan menghapus <b>permanen</b> semua data kamu di bot ini: watchlist, alert, catatan portofolio, catatan pribadi, analisis tersimpan, konteks obrolan, preferensi, dan profil.',
          '',
          `Untuk melanjutkan, kirim dalam ${Math.round((until.getTime() - Date.now()) / 60_000)} menit: "konfirmasi hapus data saya" (atau /hapusdata konfirmasi). Pesan lain membatalkan permintaan ini.`,
        ].join('\n'),
      ];
    }
    const pending = await this.conversation.takeDeletionRequest(ctx.user.id, ctx.chat.id);
    if (!pending) {
      return [
        'Tidak ada permintaan penghapusan yang menunggu. Kirim "hapus data saya" dulu, lalu konfirmasi dalam 5 menit.',
      ];
    }
    const s = await this.userData.deleteAll(ctx.user.id);
    ctx.log.dataDeleted = true;
    return [
      [
        '🗑️ Semua data kamu sudah dihapus:',
        `• watchlist: ${s.watchlistItems} saham`,
        `• alert: ${s.alerts}`,
        `• transaksi portofolio: ${s.portfolioTransactions}`,
        `• analisis tersimpan: ${s.analyses}`,
        `• konteks obrolan: ${s.contexts}`,
        `• catatan: ${s.notes}`,
        '',
        'Preferensi dan profil ikut terhapus. Profil dibuat lagi otomatis saat kamu mengirim pesan berikutnya.',
      ].join('\n'),
    ];
  }

  private when(turn: ConversationTurn, timezone: string): string {
    const d = new Date(turn.at);
    if (Number.isNaN(d.getTime())) return '–';
    try {
      return new Intl.DateTimeFormat('id-ID', {
        timeZone: timezone || 'Asia/Jakarta',
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: 'short',
      }).format(d);
    } catch {
      return d.toISOString().slice(0, 16).replace('T', ' ');
    }
  }
}
