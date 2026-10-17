import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config.service';
import { formatWib, jakartaParts } from '../common/utils/format';

export type MarketState =
  'OPEN' | 'LUNCH_BREAK' | 'PRE_CLOSING' | 'BEFORE_OPEN' | 'AFTER_CLOSE' | 'WEEKEND' | 'HOLIDAY';

export interface MarketStatus {
  state: MarketState;
  /** True during continuous trading sessions (session 1 and 2). */
  isTrading: boolean;
  label: string;
  /** Next time continuous trading starts (ISO), if currently not trading. */
  nextOpen: string | null;
  checkedAt: string;
}

/**
 * IDX regular-hours schedule (Asia/Jakarta, UTC+7, no DST):
 *   Mon-Thu: session 1 09:00-12:00, session 2 13:30-15:50, pre-closing 15:50-16:00
 *   Fri:     session 1 09:00-11:30, session 2 14:00-15:50, pre-closing 15:50-16:00
 * Exchange holidays vary by year; configure them via MARKET_HOLIDAYS (YYYY-MM-DD, comma separated).
 */
const OPEN_MIN = 9 * 60;
const SESSION1_END = { weekday: 12 * 60, friday: 11 * 60 + 30 };
const SESSION2_START = { weekday: 13 * 60 + 30, friday: 14 * 60 };
const SESSION2_END = 15 * 60 + 50;
const CLOSE_MIN = 16 * 60;

function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

@Injectable()
export class MarketService {
  constructor(private readonly config: AppConfig) {}

  getStatus(now: Date = new Date()): MarketStatus {
    const p = jakartaParts(now);
    const minutes = p.hour * 60 + p.minute;
    const base = { checkedAt: now.toISOString() };

    if (p.weekday === 0 || p.weekday === 6) {
      return this.closed('WEEKEND', 'Bursa tutup (akhir pekan).', now, base);
    }
    if (this.config.holidays.includes(p.isoDate)) {
      return this.closed('HOLIDAY', 'Bursa tutup (hari libur bursa).', now, base);
    }

    const fri = p.weekday === 5;
    const s1End = fri ? SESSION1_END.friday : SESSION1_END.weekday;
    const s2Start = fri ? SESSION2_START.friday : SESSION2_START.weekday;

    if (minutes < OPEN_MIN) return this.closed('BEFORE_OPEN', 'Bursa belum buka.', now, base);
    if (minutes < s1End)
      return {
        ...base,
        state: 'OPEN',
        isTrading: true,
        label: 'Bursa sedang buka (Sesi 1).',
        nextOpen: null,
      };
    if (minutes < s2Start) return this.closed('LUNCH_BREAK', 'Istirahat siang.', now, base);
    if (minutes < SESSION2_END)
      return {
        ...base,
        state: 'OPEN',
        isTrading: true,
        label: 'Bursa sedang buka (Sesi 2).',
        nextOpen: null,
      };
    if (minutes < CLOSE_MIN) return this.closed('PRE_CLOSING', 'Sesi pra-penutupan.', now, base);
    return this.closed('AFTER_CLOSE', 'Bursa sudah tutup.', now, base);
  }

  /**
   * ISO date (WIB) of the most recent trading session that has already started: today if it is a
   * trading day and 09:00 has passed, otherwise the previous trading day. Holidays come from
   * MARKET_HOLIDAYS, so an unconfigured holiday is treated as a trading day.
   */
  lastTradingDate(now: Date = new Date()): string {
    const p = jakartaParts(now);
    const started = p.hour * 60 + p.minute >= OPEN_MIN;
    let iso = p.isoDate;
    if (this.isTradingDay(iso) && started) return iso;
    for (let i = 0; i < 14; i++) {
      iso = shiftIsoDate(iso, -1);
      if (this.isTradingDay(iso)) return iso;
    }
    return iso;
  }

  isTradingDay(isoDate: string): boolean {
    const weekday = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
    return weekday !== 0 && weekday !== 6 && !this.config.holidays.includes(isoDate);
  }

  /** Human description incl. schedule and next opening, for "jam berapa market buka?". */
  describe(now: Date = new Date()): string {
    const s = this.getStatus(now);
    const lines = [s.label];
    if (s.nextOpen) lines.push(`Pembukaan berikutnya: ${formatWib(s.nextOpen)}.`);
    lines.push(
      'Jam perdagangan reguler (WIB):',
      '• Senin–Kamis: 09:00–12:00 dan 13:30–15:50 (pra-penutupan 15:50–16:00)',
      '• Jumat: 09:00–11:30 dan 14:00–15:50 (pra-penutupan 15:50–16:00)',
    );
    return lines.join('\n');
  }

  private closed(
    state: MarketState,
    label: string,
    now: Date,
    base: { checkedAt: string },
  ): MarketStatus {
    return {
      ...base,
      state,
      isTrading: false,
      label,
      nextOpen: this.nextOpen(now, state)?.toISOString() ?? null,
    };
  }

  private nextOpen(now: Date, state: MarketState): Date | null {
    const p = jakartaParts(now);
    const minutes = p.hour * 60 + p.minute;
    const fri = p.weekday === 5;

    // Same-day reopening (before open or lunch break) when today is a trading day.
    if (state === 'BEFORE_OPEN') return this.jakartaDate(p.year, p.month, p.day, OPEN_MIN);
    if (state === 'LUNCH_BREAK') {
      const s2 = fri ? SESSION2_START.friday : SESSION2_START.weekday;
      if (minutes < s2) return this.jakartaDate(p.year, p.month, p.day, s2);
    }

    // Otherwise the next trading day at 09:00.
    for (let i = 1; i <= 14; i++) {
      const d = new Date(Date.UTC(p.year, p.month - 1, p.day + i, 12));
      const wd = d.getUTCDay();
      const iso = d.toISOString().slice(0, 10);
      if (wd === 0 || wd === 6 || this.config.holidays.includes(iso)) continue;
      return this.jakartaDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), OPEN_MIN);
    }
    return null;
  }

  private jakartaDate(y: number, m: number, d: number, minutesOfDay: number): Date {
    return new Date(Date.UTC(y, m - 1, d, 0, minutesOfDay - 7 * 60));
  }
}
