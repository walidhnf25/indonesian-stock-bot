import { Injectable, Logger } from '@nestjs/common';
import { Alert, AlertStatus, AlertType, Prisma, Stock } from '@prisma/client';
import { AccessService } from '../access/access.service';
import { Metrics } from '../common/metrics.service';
import { AppConfig } from '../config/app-config.service';
import { CallerContext } from '../common/caller-context';
import { AnalysisService } from '../analysis/analysis.service';
import { computeTechnical } from '../analysis/technical';
import { DailyCandle } from '../stock/stock.types';
import { InvalidTickerError, UserFacingError } from '../common/exceptions/app-errors';
import { formatNumber, formatRatio, formatRupiah } from '../common/utils/format';
import { safeErrorMessage } from '../common/utils/scrub';
import { PrismaService } from '../database/prisma.service';
import { alertTypeFor } from '../intent/intent-parser';
import { AlertCondition, AlertMetric } from '../intent/intent.types';
import { describePlausibility, referenceCloseFromCandles } from '../market/data-quality';
import { DataQualityService } from '../market/data-quality.service';
import { NotifierService } from '../notifier/notifier.service';
import { StockService } from '../stock/stock.service';
import { NormalizedQuote } from '../stock/stock.types';
import { formatAlertTriggered } from '../telegram/telegram-response';

export const MAX_ACTIVE_ALERTS = 20;
/** Lifecycle states that occupy one of the user's MAX_ACTIVE_ALERTS slots (paused alerts keep theirs). */
const LIVE_STATUSES: AlertStatus[] = ['ACTIVE', 'PAUSED'];

export type AlertWithStock = Alert & { stock: Stock };

/** Where an alert lives and is delivered: the chat it was created in. */
export interface AlertScope {
  chatId: number;
  /** "private" | "group" | "supergroup" */
  chatType: string;
}

export interface CreateAlertResult {
  alert: AlertWithStock;
  duplicate: boolean;
  /** Current observed value (price / RSI / ratio) if it could be read. */
  currentValue: number | null;
  /** True when the condition is already satisfied right now. */
  alreadySatisfied: boolean;
}

export interface CheckSummary {
  checked: number;
  triggered: number;
  /** Skipped because the data was STALE/UNKNOWN (never fire on old data). */
  skippedStale: number;
  /** Skipped because the price failed the sanity check (never fire on anomalous data). */
  skippedAnomaly: number;
  /** Skipped because the alert has no delivery chat (legacy rows); never guessed from user state. */
  skippedNoTarget: number;
  /** Skipped because the owner is no longer on the Telegram allowlist. */
  skippedUnauthorized: number;
  errors: number;
}

/**
 * Short label for the owner of a group alert. Only a well-formed Telegram username is used: a first name is
 * free text chosen by the user, and the bot would print it into the group under its own name.
 */
export function ownerLabel(user: { username: string | null; firstName?: string | null }): string {
  if (user.username && /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(user.username))
    return `@${user.username}`;
  return 'anggota grup';
}

/**
 * Identity of an ACTIVE alert. Stored in the UNIQUE `activeKey` column only while the alert is ACTIVE,
 * so two identical active alerts cannot exist even when created concurrently.
 */
/** Alert thresholds are stored with at most this many decimals, so JS and PostgreSQL format them identically. */
const THRESHOLD_DECIMALS = 6;
export const MAX_THRESHOLD = 1_000_000_000;

export function quantizeThreshold(v: number): number {
  const f = 10 ** THRESHOLD_DECIMALS;
  return Math.round(v * f) / f;
}

/** Plain decimal text without exponent or trailing zeros: 8500 -> "8500", 0.5 -> "0.5", 1e-5 -> "0.00001". */
export function canonicalThreshold(v: number): string {
  return v.toFixed(THRESHOLD_DECIMALS).replace(/\.?0+$/, '');
}

export function activeKeyOf(a: {
  userId: string;
  stockId: string;
  type: AlertType | string;
  threshold: number;
  chatId: bigint | number | null;
}): string {
  return `${a.userId}:${a.stockId}:${a.type}:${canonicalThreshold(a.threshold)}:${a.chatId === null ? '' : String(a.chatId)}`;
}

/** Which of the user's live alerts a command refers to (position, all, or by ticker). */
function selectAlerts<T extends { stock: { symbol: string } }>(
  rows: T[],
  sel: { index?: number; all?: boolean; symbols?: string[] },
): T[] {
  if (sel.all) return rows;
  if (sel.index !== undefined) return rows[sel.index - 1] ? [rows[sel.index - 1]] : [];
  if (sel.symbols && sel.symbols.length > 0) {
    return rows.filter((a) => sel.symbols!.includes(a.stock.symbol));
  }
  return [];
}

/**
 * MA20 - MA50 on the last session and on the session before it (both computed deterministically from the
 * same candles). A cross is a sign change between the two; the alert fires only on that session.
 */
export function maCross(candles: DailyCandle[]): { prev: number; now: number } | null {
  if (candles.length < 52) return null;
  const now = computeTechnical('x', candles).snapshot;
  const prev = computeTechnical('x', candles.slice(0, -1)).snapshot;
  if (now.sma20 === null || now.sma50 === null || prev.sma20 === null || prev.sma50 === null) {
    return null;
  }
  return { prev: prev.sma20 - prev.sma50, now: now.sma20 - now.sma50 };
}

const formatSignedRupiah = (v: number): string =>
  `${v < 0 ? '-' : '+'}${formatRupiah(Math.abs(v))}`;

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

export function describeAlert(a: {
  type: AlertType;
  threshold: number;
  stock: { symbol: string };
}): string {
  const s = a.stock.symbol;
  switch (a.type) {
    case 'PRICE_ABOVE':
      return `${s} harga di atas ${formatRupiah(a.threshold)}`;
    case 'PRICE_BELOW':
      return `${s} harga di bawah ${formatRupiah(a.threshold)}`;
    case 'RSI_ABOVE':
      return `${s} RSI di atas ${formatNumber(a.threshold, 1)}`;
    case 'RSI_BELOW':
      return `${s} RSI di bawah ${formatNumber(a.threshold, 1)}`;
    case 'VOLUME_MULTIPLIER':
      return `${s} volume lebih dari ${formatNumber(a.threshold, 1)}x rata-rata 20 hari`;
    case 'MA_CROSS_ABOVE':
      return `${s} MA20 memotong MA50 ke atas (golden cross)`;
    case 'MA_CROSS_BELOW':
      return `${s} MA20 memotong MA50 ke bawah (death cross)`;
    default:
      return `${s} ${a.type}`;
  }
}

/** Pure rule evaluation: does the observed value satisfy the alert? */
export function isTriggered(type: AlertType, threshold: number, observed: number): boolean {
  switch (type) {
    case 'PRICE_ABOVE':
    case 'RSI_ABOVE':
    case 'VOLUME_MULTIPLIER':
      return observed >= threshold;
    case 'PRICE_BELOW':
    case 'RSI_BELOW':
      return observed <= threshold;
    default:
      return false;
  }
}

@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);
  private readonly ttlDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stocks: StockService,
    private readonly analysis: AnalysisService,
    private readonly notifier: NotifierService,
    private readonly quality: DataQualityService,
    private readonly access: AccessService,
    private readonly metrics: Metrics,
    config: AppConfig,
  ) {
    this.ttlDays = config.get('ALERT_TTL_DAYS');
  }

  /* -------------------------------------------------------------- user ops */

  /**
   * The chat an alert belongs to. Defaults to the owner's private chat (private chat id == Telegram
   * user id), so callers that do not know about chats keep working and nothing is ever inferred from
   * mutable user state.
   */
  private async scopeOf(userId: string, scope?: AlertScope): Promise<AlertScope> {
    if (scope) return scope;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UserFacingError('Pengguna tidak ditemukan.');
    return { chatId: Number(user.telegramId), chatType: 'private' };
  }

  async create(
    userId: string,
    symbol: string,
    metric: AlertMetric,
    condition: AlertCondition,
    value: number,
    scopeIn?: AlertScope,
  ): Promise<CreateAlertResult> {
    const scope = await this.scopeOf(userId, scopeIn);
    if (metric === 'ma') {
      value = 0; // a crossover has no threshold
    } else {
      if (!Number.isFinite(value) || value <= 0 || value > MAX_THRESHOLD) {
        throw new UserFacingError(
          'Nilai alert tidak masuk akal. Gunakan angka positif yang wajar.',
        );
      }
      value = quantizeThreshold(value);
      if (value <= 0) throw new UserFacingError('Nilai alert terlalu kecil.');
    }
    if (metric === 'rsi' && (value <= 0 || value >= 100)) {
      throw new UserFacingError('Nilai RSI alert harus di antara 0 dan 100.');
    }
    if (metric === 'volume' && (value < 1 || value > 100)) {
      throw new UserFacingError('Pengali volume harus antara 1x dan 100x rata-rata.');
    }

    const verdict = await this.stocks.validateSymbol(symbol);
    if (verdict === 'invalid') throw new InvalidTickerError(symbol);

    const type = alertTypeFor(metric, condition) as AlertType;
    const q = await this.stocks.getQuote(symbol);
    const stockId = await this.stocks.ensureStock(symbol, q.available ? q.data.name : null);

    const currentValue = await this.observe(symbol, type, q.available ? q.data : null);
    const alreadySatisfied = currentValue !== null && isTriggered(type, value, currentValue);

    // Count + duplicate check + insert run under a per-user advisory lock, in one transaction: concurrent
    // creates from several chats of one account are serialised, so the cap and the no-duplicates rule hold
    // The UNIQUE activeKey is the backstop for anything that bypasses the lock.
    const key = activeKeyOf({
      userId,
      stockId,
      type,
      threshold: value,
      chatId: BigInt(scope.chatId),
    });
    const created = async () =>
      this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
          const existing = await tx.alert.findFirst({
            where: { activeKey: key },
            include: { stock: true },
          });
          if (existing) return { alert: existing, duplicate: true };
          if ((await this.countLive(tx, userId)) >= MAX_ACTIVE_ALERTS) {
            throw new UserFacingError(
              `Kamu sudah memiliki ${MAX_ACTIVE_ALERTS} alert aktif (batas maksimum). Hapus salah satu dengan "hapus alert BBCA" atau "hapus alert nomor 1".`,
              'ALERT_LIMIT',
            );
          }
          const alert = await tx.alert.create({
            data: {
              userId,
              stockId,
              type,
              threshold: value,
              chatId: BigInt(scope.chatId),
              chatType: scope.chatType,
              activeKey: key,
              expiresAt: new Date(Date.now() + this.ttlDays * 86_400_000),
            },
            include: { stock: true },
          });
          return { alert, duplicate: false };
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
    try {
      const r = await created();
      return { ...r, currentValue, alreadySatisfied };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const existing = await this.prisma.alert.findFirst({
        where: { activeKey: key },
        include: { stock: true },
      });
      if (!existing) throw e;
      return { alert: existing, duplicate: true, currentValue, alreadySatisfied };
    }
  }

  /** Active alerts oldest-first (stable numbering for "hapus alert nomor N") + a few recent triggers. */
  async list(
    userId: string,
    scope?: AlertScope,
  ): Promise<{
    active: AlertWithStock[];
    paused: AlertWithStock[];
    recentlyTriggered: AlertWithStock[];
  }> {
    // With a scope, only the alerts that belong to THIS chat are visible (a group never lists the
    // owner's private alerts, and the private chat never mixes in group alerts).
    const chat = scope ? { chatId: BigInt(scope.chatId) } : {};
    const [active, paused, recentlyTriggered] = await Promise.all([
      this.prisma.alert.findMany({
        where: { userId, status: 'ACTIVE', ...chat },
        include: { stock: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.alert.findMany({
        where: { userId, status: 'PAUSED', ...chat },
        include: { stock: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.alert.findMany({
        where: { userId, status: 'TRIGGERED', ...chat },
        include: { stock: true },
        orderBy: { triggeredAt: 'desc' },
        take: 3,
      }),
    ]);
    return { active, paused, recentlyTriggered };
  }

  /** Disables alerts (soft delete). Returns the disabled alerts. */
  async disable(
    userId: string,
    sel: { index?: number; all?: boolean; symbols?: string[] },
    scope?: AlertScope,
  ): Promise<AlertWithStock[]> {
    const { active, paused } = await this.list(userId, scope);
    const targets = selectAlerts([...active, ...paused], sel);
    if (targets.length === 0) return [];
    await this.prisma.alert.updateMany({
      where: {
        id: { in: targets.map((t) => t.id) },
        userId,
        status: { in: ['ACTIVE', 'PAUSED'] },
      },
      data: { status: AlertStatus.DISABLED, activeKey: null },
    });
    return targets;
  }

  /** Stops evaluating the selected ACTIVE alerts without losing them (they keep their slot and key). */
  async pause(
    userId: string,
    sel: { index?: number; all?: boolean; symbols?: string[] },
    scope?: AlertScope,
  ): Promise<AlertWithStock[]> {
    const { active } = await this.list(userId, scope);
    const targets = selectAlerts(active, sel);
    if (targets.length === 0) return [];
    await this.prisma.alert.updateMany({
      where: { id: { in: targets.map((t) => t.id) }, userId, status: 'ACTIVE' },
      data: { status: AlertStatus.PAUSED },
    });
    return targets;
  }

  /** Puts the selected PAUSED alerts back to ACTIVE (the index counts within the paused list). */
  async resume(
    userId: string,
    sel: { index?: number; all?: boolean; symbols?: string[] },
    scope?: AlertScope,
  ): Promise<AlertWithStock[]> {
    const { paused } = await this.list(userId, scope);
    const targets = selectAlerts(paused, sel);
    if (targets.length === 0) return [];
    await this.prisma.alert.updateMany({
      where: { id: { in: targets.map((t) => t.id) }, userId, status: 'PAUSED' },
      data: { status: AlertStatus.ACTIVE },
    });
    return targets;
  }

  /* ---------------------------------------------------------- scheduler job */

  /**
   * Evaluates all ACTIVE alerts once. Each alert is "claimed" atomically (ACTIVE -> TRIGGERED)
   * before notifying, so overlapping runs or restarts can never send the same alert twice.
   */
  async checkAll(): Promise<CheckSummary> {
    // Background evaluation is not a user: it has its own scheduling identity and is exempt from per-user quotas
    // (it still spends the global budget and its calls are queued fairly with everyone else's).
    return CallerContext.run('system:alerts', () => this.checkAllCore());
  }

  private async checkAllCore(): Promise<CheckSummary> {
    const summary: CheckSummary = {
      checked: 0,
      triggered: 0,
      skippedStale: 0,
      skippedAnomaly: 0,
      skippedNoTarget: 0,
      skippedUnauthorized: 0,
      errors: 0,
    };
    await this.expireOverdue();
    const all = await this.prisma.alert.findMany({
      where: { status: 'ACTIVE' },
      include: { stock: true, user: true },
    });
    // Fail closed: alerts of users who are no longer allowed to use the bot are not evaluated.
    const alerts = all.filter((a) => this.access.isAllowed(Number(a.user.telegramId)));
    summary.skippedUnauthorized = all.length - alerts.length;
    if (alerts.length === 0) return summary;

    const symbols = [...new Set(alerts.map((a) => a.stock.symbol))];
    const quotes = await this.stocks.getQuotes(symbols, { fallback: false });

    for (const symbol of symbols) {
      const quoteRes = quotes.get(symbol);
      const group = alerts.filter((a) => a.stock.symbol === symbol);
      if (!quoteRes?.available) {
        summary.errors += group.length;
        continue;
      }
      const quote = quoteRes.data;

      // Validation pipeline: fetched -> timestamp/freshness -> price sanity -> only then evaluate.
      const freshness = this.quality.freshnessOf(quote, { stale: quoteRes.stale });
      if (freshness.state === 'STALE' || freshness.state === 'UNKNOWN') {
        summary.skippedStale += group.length;
        this.logger.warn(
          JSON.stringify({
            evt: 'alert_skipped',
            symbol,
            reason: 'freshness',
            state: freshness.state,
            detail: freshness.reason,
          }),
        );
        continue;
      }
      // Trust gate: "numerically valid" is not "trusted enough to fire an alert". The quote is
      // checked on its own AND against the previous-session close from the stored daily candles (an
      // independent field of the data). Only `trusted` may trigger; `suspect` and `invalid` never do.
      const history = await this.stocks.getHistory(symbol, '1y');
      const referenceClose = history.available
        ? referenceCloseFromCandles(history.data, quote.timestamp)
        : null;
      const plausibility = this.quality.plausibilityOf(quote, referenceClose);
      // No stored previous-session close means the quote can only be checked against itself, and a
      // corrupt quote can be consistent with itself: an alert needs the independent reference.
      if (plausibility.quality !== 'trusted' || referenceClose === null) {
        summary.skippedAnomaly += group.length;
        this.logger.warn(
          JSON.stringify({
            evt: 'QUOTE_QUALITY_REJECTED',
            symbol,
            quality: plausibility.quality === 'trusted' ? 'unverified' : plausibility.quality,
            detail:
              plausibility.quality === 'trusted'
                ? 'tidak ada acuan penutupan tersimpan untuk memverifikasi harga'
                : describePlausibility(plausibility),
          }),
        );
        continue;
      }
      this.logger.debug(
        JSON.stringify({
          evt: 'alert_validation',
          symbol,
          freshness: freshness.state,
          plausible: true,
        }),
      );
      let report: Awaited<ReturnType<AnalysisService['tryGetReport']>> | undefined;

      for (const alert of group) {
        // Delivery target = the chat the alert was created in. A row without one is never guessed
        // from the user's last active chat (that is how private alerts used to leak into groups).
        if (alert.chatId === null) {
          summary.skippedNoTarget++;
          this.logger.warn(JSON.stringify({ evt: 'ALERT_SCOPE_REJECTED', alertId: alert.id }));
          continue;
        }
        summary.checked++;
        try {
          let observed: number | null = null;
          let fired = false;
          if (alert.type === 'PRICE_ABOVE' || alert.type === 'PRICE_BELOW') {
            observed = quote.price;
            fired = isTriggered(alert.type, alert.threshold, observed);
          } else {
            report ??= await this.analysis.tryGetReport(symbol);
            // Indicator alerts also need trustworthy history, not just a trustworthy quote.
            if (report && (report.historyStale || !report.plausibility.ok)) {
              summary[report.historyStale ? 'skippedStale' : 'skippedAnomaly']++;
              continue;
            }
            if (alert.type === 'MA_CROSS_ABOVE' || alert.type === 'MA_CROSS_BELOW') {
              const cross = report ? maCross(report.candles) : null;
              observed = cross?.now ?? null;
              fired =
                cross !== null &&
                (alert.type === 'MA_CROSS_ABOVE'
                  ? cross.prev <= 0 && cross.now > 0
                  : cross.prev >= 0 && cross.now < 0);
            } else {
              observed = report ? this.indicatorValue(alert.type, report.technical.snapshot) : null;
              fired = observed !== null && isTriggered(alert.type, alert.threshold, observed);
            }
          }
          if (observed === null || !fired) continue;

          const claimed = await this.prisma.alert.updateMany({
            where: { id: alert.id, status: 'ACTIVE' },
            data: {
              status: 'TRIGGERED',
              activeKey: null,
              triggeredAt: new Date(),
              triggeredValue: observed,
            },
          });
          if (claimed.count !== 1) continue; // another run already took it

          const text = formatAlertTriggered({
            symbol,
            label: `Kondisi terpenuhi: ${describeAlert(alert)}`,
            observed: this.formatObserved(alert.type, observed),
            quoteTime: quote.timestamp,
            // In a group the message says whose alert it is; a private chat needs no label.
            owner: alert.chatType === 'private' ? undefined : ownerLabel(alert.user),
          });
          const delivery = await this.notifier.send(Number(alert.chatId), text);
          if (delivery === 'sent') {
            await this.prisma.alert.updateMany({
              where: { id: alert.id, status: 'TRIGGERED' },
              data: { deliveredAt: new Date(), deliveryError: null },
            });
            summary.triggered++;
            this.metrics.inc('alert_deliveries_total', { outcome: 'sent' });
            this.logger.log(
              JSON.stringify({
                evt: 'alert_triggered',
                alertId: alert.id,
                symbol,
                type: alert.type,
                observed,
              }),
            );
          } else if (delivery === 'permanent') {
            // The chat will never accept messages (user blocked the bot): stop retrying.
            await this.prisma.alert.updateMany({
              where: { id: alert.id, status: 'TRIGGERED' },
              data: {
                status: 'DISABLED',
                deliveryError: (this.notifier.lastErrorMessage ?? 'undeliverable').slice(0, 200),
              },
            });
            summary.errors++;
            this.metrics.inc('alert_deliveries_total', { outcome: 'permanent' });
            this.logger.warn(
              JSON.stringify({ evt: 'alert_disabled_undeliverable', alertId: alert.id }),
            );
            // A group alert dies silently otherwise: tell the owner privately (best effort).
            if (alert.chatType !== 'private') {
              await this.notifier.notify(
                Number(alert.user.telegramId),
                `⚠️ Alert ${describeAlert(alert)} dinonaktifkan karena grup tujuannya tidak dapat dihubungi lagi. Buat ulang dari chat pribadi jika masih ingin dipantau.`,
                `alert-undeliverable:${alert.id}`,
              );
            }
          } else {
            // Transient delivery failure: put it back so the next run retries.
            const back = await this.reactivate(alert).catch((e: unknown) => {
              // The alert stays TRIGGERED (delivery is at-most-once by design); say so explicitly in the log.
              this.logger.error(
                JSON.stringify({
                  evt: 'ALERT_REACTIVATE_FAILED',
                  alertId: alert.id,
                  error: safeErrorMessage(e),
                }),
              );
              return 'gone' as const;
            });
            if (back === 'capped') {
              await this.notifier.notify(
                Number(alert.user.telegramId),
                `⚠️ Alert ${describeAlert(alert)} tidak diaktifkan kembali karena kamu sudah memiliki ${MAX_ACTIVE_ALERTS} alert aktif. Hapus salah satu lalu buat ulang jika masih perlu.`,
                `alert-capped:${alert.id}`,
              );
            }
            summary.errors++;
            this.metrics.inc('alert_deliveries_total', { outcome: 'transient' });
          }
        } catch (e) {
          summary.errors++;
          this.logger.error(`alert ${alert.id} check failed: ${safeErrorMessage(e)}`);
        }
      }
    }
    for (const [outcome, n] of Object.entries(summary)) {
      if (n > 0) this.metrics.inc('alert_evaluations_total', { outcome }, n);
    }
    return summary;
  }

  /* -------------------------------------------------------------- internals */

  /** How many slots of the user are taken; the ONE definition used by create() and reactivate(). */
  private countLive(tx: Prisma.TransactionClient, userId: string): Promise<number> {
    return tx.alert.count({ where: { userId, status: { in: LIVE_STATUSES } } });
  }

  /**
   * Puts a claimed alert back to ACTIVE after a transient delivery failure. It takes the same per-user lock
   * as create() and re-checks the cap, so a create that ran during delivery cannot push the user past
   * MAX_ACTIVE_ALERTS. If an identical active alert appeared meanwhile the unique key refuses and
   * the old one is disabled instead.
   */
  private async reactivate(alert: Alert): Promise<'reactivated' | 'capped' | 'duplicate' | 'gone'> {
    const back = { where: { id: alert.id, status: 'TRIGGERED' as const } };
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${alert.userId}, 0))`;
          const current = await tx.alert.findFirst(back);
          if (!current) return 'gone' as const;
          // the same rule as create(): ACTIVE and PAUSED both count (counting ACTIVE only let a user
          // with paused alerts end up above the cap)
          if ((await this.countLive(tx, alert.userId)) >= MAX_ACTIVE_ALERTS) {
            await tx.alert.updateMany({ ...back, data: { status: 'DISABLED' } });
            return 'capped' as const;
          }
          await tx.alert.updateMany({
            ...back,
            data: {
              status: 'ACTIVE',
              activeKey: activeKeyOf(alert),
              triggeredAt: null,
              triggeredValue: null,
            },
          });
          return 'reactivated' as const;
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      await this.prisma.alert.updateMany({ ...back, data: { status: 'DISABLED' } });
      return 'duplicate';
    }
  }

  private indicatorValue(
    type: AlertType,
    s: { rsi14: number | null; volumeRatio: number | null },
  ): number | null {
    if (type === 'RSI_ABOVE' || type === 'RSI_BELOW') return s.rsi14;
    if (type === 'VOLUME_MULTIPLIER') return s.volumeRatio;
    return null;
  }

  /** Marks ACTIVE/PAUSED alerts past their lifetime as EXPIRED and tells the owner once (queued, deduped). */
  private async expireOverdue(): Promise<void> {
    const overdue = await this.prisma.alert.findMany({
      where: { status: { in: ['ACTIVE', 'PAUSED'] }, expiresAt: { lt: new Date() } },
      include: { stock: true, user: true },
    });
    for (const alert of overdue) {
      const r = await this.prisma.alert.updateMany({
        where: { id: alert.id, status: { in: ['ACTIVE', 'PAUSED'] } },
        data: { status: 'EXPIRED', activeKey: null },
      });
      if (r.count !== 1) continue; // another run took it
      await this.notifier.notify(
        Number(alert.user.telegramId),
        `⌛ Alert ${describeAlert(alert)} sudah kedaluwarsa (${this.ttlDays} hari tanpa terpicu) dan tidak dipantau lagi. Buat ulang jika masih perlu.`,
        `alert-expired:${alert.id}`,
      );
    }
  }

  private formatObserved(type: AlertType, v: number): string {
    if (type === 'VOLUME_MULTIPLIER') return `${formatRatio(v)} rata-rata 20 hari`;
    if (type === 'MA_CROSS_ABOVE' || type === 'MA_CROSS_BELOW') {
      return `selisih MA20 - MA50 sekarang ${formatSignedRupiah(v)}`;
    }
    if (type === 'RSI_ABOVE' || type === 'RSI_BELOW') return `RSI ${formatNumber(v, 1)}`;
    return formatRupiah(v);
  }

  /** Reads the value an alert type watches, for "already satisfied" hints. */
  private async observe(
    symbol: string,
    type: AlertType,
    quote: NormalizedQuote | null,
  ): Promise<number | null> {
    if (type === 'PRICE_ABOVE' || type === 'PRICE_BELOW') return quote?.price ?? null;
    const report = await this.analysis.tryGetReport(symbol);
    return report ? this.indicatorValue(type, report.technical.snapshot) : null;
  }
}
