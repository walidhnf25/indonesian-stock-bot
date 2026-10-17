import { Injectable } from '@nestjs/common';
import { AlertService, MAX_ACTIVE_ALERTS, describeAlert } from '../../alert/alert.service';
import { UserFacingError } from '../../common/exceptions/app-errors';
import {
  escapeHtml as h,
  formatNumber,
  formatRatio,
  formatRupiah,
  formatWib,
} from '../../common/utils/format';
import { AlertDeleteParameters, AlertParameters } from '../../intent/intent.types';
import { DataQualityService } from '../../market/data-quality.service';
import { MarketService } from '../../market/market.service';
import { formatWatchlist } from '../../telegram/telegram-response';
import { WatchlistService } from '../../watchlist/watchlist.service';
import { HandlerContext } from '../chat.types';

const ASK_SYMBOL = 'Saham mana yang kamu maksud? Sebutkan kode sahamnya, mis. "BBCA".';

@Injectable()
export class WatchlistAlertHandler {
  constructor(
    private readonly watchlist: WatchlistService,
    private readonly alerts: AlertService,
    private readonly market: MarketService,
    private readonly quality: DataQualityService,
  ) {}

  /* ---------------------------------------------------------- watchlist */

  async watchlistAdd(ctx: HandlerContext): Promise<string[]> {
    const symbols = ctx.intent.symbols;
    if (symbols.length === 0) return [ASK_SYMBOL];
    const r = await this.watchlist.add(ctx.user.id, symbols);
    const lines: string[] = [];
    if (r.added.length)
      lines.push(`✅ Ditambahkan ke watchlist: <b>${r.added.map(h).join(', ')}</b>`);
    if (r.alreadyThere.length)
      lines.push(`ℹ️ Sudah ada di watchlist: ${r.alreadyThere.map(h).join(', ')}`);
    if (r.invalid.length) lines.push(`❌ Ticker tidak ditemukan: ${r.invalid.map(h).join(', ')}`);
    if (r.unverified.length)
      lines.push(
        `⚠️ ${r.unverified.map(h).join(', ')} belum dapat diverifikasi (provider data tidak terjangkau), tetap disimpan.`,
      );
    if (r.limitReached.length)
      lines.push(
        `⚠️ Batas watchlist tercapai; tidak ditambahkan: ${r.limitReached.map(h).join(', ')}`,
      );
    if (r.added.length) lines.push('', 'Ketik "lihat watchlist" untuk melihat harga terbaru.');
    return [lines.join('\n')];
  }

  async watchlistRemove(ctx: HandlerContext): Promise<string[]> {
    const symbols = ctx.intent.symbols;
    if (symbols.length === 0) return [ASK_SYMBOL];
    const r = await this.watchlist.remove(ctx.user.id, symbols);
    const lines: string[] = [];
    if (r.removed.length)
      lines.push(`🗑️ Dihapus dari watchlist: <b>${r.removed.map(h).join(', ')}</b>`);
    if (r.notFound.length) lines.push(`ℹ️ Tidak ada di watchlist: ${r.notFound.map(h).join(', ')}`);
    return [lines.join('\n')];
  }

  async watchlistList(ctx: HandlerContext): Promise<string[]> {
    const entries = await this.watchlist.list(ctx.user.id);
    return [
      formatWatchlist(
        entries.map((e) => ({
          ...e,
          freshness:
            e.quote && e.quote.available
              ? this.quality.freshnessOf(e.quote.data, { stale: e.quote.stale })
              : null,
        })),
      ),
    ];
  }

  /* ------------------------------------------------------------- alerts */

  async alertCreate(ctx: HandlerContext): Promise<string[]> {
    if (ctx.intent.clarification) return [h(ctx.intent.clarification)];
    if (ctx.intent.symbols.length === 0) return [ASK_SYMBOL];
    const p = ctx.intent.parameters as AlertParameters;
    if (!p.metric || !p.condition || p.value === undefined) {
      throw new UserFacingError(
        'Mohon lengkapi alert, mis. "ingatkan saya kalau BBCA di atas 8500".',
      );
    }
    const symbol = ctx.intent.symbols[0];
    const r = await this.alerts.create(ctx.user.id, symbol, p.metric, p.condition, p.value, {
      chatId: ctx.chat.id,
      chatType: ctx.chat.type,
    });

    const lines: string[] = [];
    if (r.duplicate) lines.push('ℹ️ Alert yang sama sudah aktif:');
    else lines.push('🔔 <b>Alert dibuat</b>');
    lines.push(h(describeAlert(r.alert)));

    if (r.currentValue !== null) {
      const now =
        r.alert.type === 'VOLUME_MULTIPLIER'
          ? formatRatio(r.currentValue)
          : r.alert.type.startsWith('RSI')
            ? formatNumber(r.currentValue, 1)
            : formatRupiah(r.currentValue);
      lines.push('', `Nilai saat ini: ${now}`);
    }
    if (r.alreadySatisfied && !r.duplicate) {
      lines.push(
        '⚠️ Kondisi ini sudah terpenuhi sekarang, jadi alert akan terpicu pada pengecekan berikutnya.',
      );
    }
    lines.push(
      '',
      ctx.chat.type === 'private'
        ? '📍 Notifikasi dikirim ke chat pribadimu.'
        : '📍 Alert ini milik grup ini: notifikasinya dikirim ke grup ini, bukan ke chat pribadimu.',
    );
    const status = this.market.getStatus();
    lines.push('', 'Alert bersifat sekali pakai dan dicek berkala saat bursa buka (WIB).');
    if (!status.isTrading) {
      lines.push(
        `Bursa sedang tutup${status.nextOpen ? `; pengecekan dimulai ${formatWib(status.nextOpen)}` : ''}.`,
      );
    }
    return [lines.join('\n')];
  }

  async alertList(ctx: HandlerContext): Promise<string[]> {
    // Only the alerts that belong to THIS chat: a group never lists private alerts, and vice versa.
    const { active, paused, recentlyTriggered } = await this.alerts.list(ctx.user.id, {
      chatId: ctx.chat.id,
      chatType: ctx.chat.type,
    });
    if (active.length === 0 && paused.length === 0 && recentlyTriggered.length === 0) {
      return ['🔔 Kamu belum punya alert. Coba: "ingatkan saya kalau BBCA di atas 8500".'];
    }
    const lines = [
      `🔔 <b>ALERT AKTIF</b> (${active.length + paused.length}/${MAX_ACTIVE_ALERTS})`,
      '',
    ];
    if (active.length === 0) lines.push('Tidak ada alert aktif.');
    active.forEach((a, i) => lines.push(`${i + 1}. ${h(describeAlert(a))}`));
    if (paused.length) {
      lines.push('', `⏸️ <b>DIJEDA</b> (${paused.length})`);
      paused.forEach((a, i) => lines.push(`${i + 1}. ${h(describeAlert(a))}`));
      lines.push('Lanjutkan dengan: "lanjutkan alert nomor 1" atau "lanjutkan alert BBCA".');
    }
    if (recentlyTriggered.length) {
      lines.push('', '✅ <b>Terpicu baru-baru ini</b>');
      for (const a of recentlyTriggered) {
        lines.push(
          `• ${h(describeAlert(a))}${a.triggeredAt ? ` — ${formatWib(a.triggeredAt)}` : ''}`,
        );
      }
    }
    if (active.length)
      lines.push(
        '',
        'Hapus dengan: "hapus alert BBCA", "hapus alert nomor 1", atau "hapus semua alert".',
      );
    return [lines.join('\n')];
  }

  async alertPause(ctx: HandlerContext): Promise<string[]> {
    const p = ctx.intent.parameters as AlertDeleteParameters;
    if (!(p.all || p.index !== undefined || ctx.intent.symbols.length > 0)) {
      return [
        'Alert mana yang ingin dijeda? Sebutkan kode saham atau nomornya.',
        ...(await this.alertList(ctx)),
      ];
    }
    const paused = await this.alerts.pause(
      ctx.user.id,
      { all: p.all, index: p.index, symbols: ctx.intent.symbols },
      { chatId: ctx.chat.id, chatType: ctx.chat.type },
    );
    if (paused.length === 0) return ['ℹ️ Tidak ada alert aktif yang cocok.'];
    return [
      `⏸️ Alert dijeda (${paused.length}):\n${paused.map((a) => `• ${h(describeAlert(a))}`).join('\n')}\n\nLanjutkan kapan saja dengan "lanjutkan alert".`,
    ];
  }

  async alertResume(ctx: HandlerContext): Promise<string[]> {
    const p = ctx.intent.parameters as AlertDeleteParameters;
    if (!(p.all || p.index !== undefined || ctx.intent.symbols.length > 0)) {
      return [
        'Alert mana yang ingin dilanjutkan? Sebutkan kode saham atau nomornya.',
        ...(await this.alertList(ctx)),
      ];
    }
    const resumed = await this.alerts.resume(
      ctx.user.id,
      { all: p.all, index: p.index, symbols: ctx.intent.symbols },
      { chatId: ctx.chat.id, chatType: ctx.chat.type },
    );
    if (resumed.length === 0) return ['ℹ️ Tidak ada alert yang dijeda yang cocok.'];
    return [
      `▶️ Alert diaktifkan lagi (${resumed.length}):\n${resumed.map((a) => `• ${h(describeAlert(a))}`).join('\n')}`,
    ];
  }

  async alertDelete(ctx: HandlerContext): Promise<string[]> {
    const p = ctx.intent.parameters as AlertDeleteParameters;
    const hasSelector = p.all || p.index !== undefined || ctx.intent.symbols.length > 0;
    if (!hasSelector) {
      const list = await this.alertList(ctx);
      return ['Alert mana yang ingin dihapus? Sebutkan kode saham atau nomornya.', ...list];
    }
    const removed = await this.alerts.disable(
      ctx.user.id,
      { all: p.all, index: p.index, symbols: ctx.intent.symbols },
      { chatId: ctx.chat.id, chatType: ctx.chat.type },
    );
    if (removed.length === 0)
      return [
        'ℹ️ Tidak ada alert aktif yang cocok. Ketik "lihat alert saya" untuk melihat daftarnya.',
      ];
    return [
      `🗑️ Alert dihapus (${removed.length}):\n${removed.map((a) => `• ${h(describeAlert(a))}`).join('\n')}`,
    ];
  }
}
