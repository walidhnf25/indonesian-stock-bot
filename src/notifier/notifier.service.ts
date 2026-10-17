import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { AccessService } from '../access/access.service';
import { Metrics } from '../common/metrics.service';
import { safeErrorMessage } from '../common/utils/scrub';
import { PrismaService } from '../database/prisma.service';
import { QUEUES, QueueService } from '../queue/queue.service';
import { parseNotification } from './notification-payload';

export type NotificationSender = (chatId: number, htmlText: string) => Promise<void>;

/** sent = delivered; retry = transient failure; permanent = the chat will never accept messages (blocked/deleted). */
export type DeliveryResult = 'sent' | 'retry' | 'permanent';

/** Telegram says 403 when the user blocked the bot / deactivated, 400 "chat not found" for unknown chats. */
export function isPermanentDeliveryError(error: unknown): boolean {
  const e = error as { error_code?: number; description?: string; message?: string };
  const text = `${e?.description ?? ''} ${e?.message ?? ''}`;
  return (
    e?.error_code === 403 ||
    (e?.error_code === 400 && /chat not found|user is deactivated/i.test(text))
  );
}

/**
 * Decouples "something needs to notify a user" (alerts) from the delivery channel (Telegram),
 * so the alert engine has no dependency on the Telegram module.
 */
@Injectable()
export class NotifierService implements OnModuleInit {
  private readonly logger = new Logger(NotifierService.name);
  private sender?: NotificationSender;
  /** Scrubbed message of the last delivery failure (for delivery tracking); null after a success. */
  lastErrorMessage: string | null = null;

  constructor(
    private readonly queues: QueueService,
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly metrics: Metrics,
  ) {}

  onModuleInit(): void {
    if (!this.queues.runsWorkers) return;
    this.queues.registerJob(
      QUEUES.notifications,
      'send',
      async (job) => {
        // Redis is not a trusted place: the payload is validated here, at the consumer, whoever produced it.
        const parsed = parseNotification(job.data);
        if (!parsed.ok) return this.reject(job, parsed.reason);
        const { chatId, html } = parsed.value;
        const refusal = await this.recipientRefusal(chatId);
        if (refusal) return this.reject(job, refusal);
        const r = await this.send(chatId, html);
        if (r === 'retry') throw new Error('transient delivery failure');
        return r;
      },
      { concurrency: 2, timeoutMs: 30_000 },
    );
  }

  /**
   * A job that must never be delivered: it fails ONCE (no retries), the hostile payload is dropped from Redis (a
   * 5 MB body would otherwise sit in the failed set for days), and only the reason code is logged and counted.
   */
  private async reject(
    job: { id?: string; updateData: (d: unknown) => Promise<void> },
    reason: string,
  ): Promise<never> {
    this.metrics.inc('notifications_rejected_total', { reason: reason.slice(0, 40) });
    this.logger.warn(JSON.stringify({ evt: 'NOTIFICATION_REJECTED', reason, job: job.id }));
    await job.updateData({ rejected: reason }).catch(() => undefined);
    throw new UnrecoverableError(`notification rejected: ${reason}`);
  }

  /**
   * Who may receive a queued notification: a known user, still allowed to use the bot, addressed by their own
   * private chat. Queued notices are owner notices; groups never receive them through the queue.
   */
  private async recipientRefusal(chatId: number): Promise<string | null> {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ telegramId: BigInt(chatId) }, { chatId: BigInt(chatId) }] },
      select: { telegramId: true },
    });
    if (!user) return 'unknown_recipient';
    if (!this.access.isAllowed(Number(user.telegramId))) return 'recipient_not_allowed';
    return null;
  }

  /**
   * A proactive message that may be retried (owner notices). With queues it is delivered by a worker with
   * backoff and de-duplicated by `dedupeKey`; without queues it is sent right away. NOT used for triggered
   * alerts, whose at-most-once delivery (claim, then send) stays in AlertService.
   */
  async notify(chatId: number, htmlText: string, dedupeKey?: string): Promise<void> {
    // The producer applies the same checks, so a malformed notice is dropped (and logged) instead of queued.
    const checked = parseNotification({ chatId, html: htmlText });
    if (!checked.ok) {
      this.metrics.inc('notifications_rejected_total', { reason: checked.reason.slice(0, 40) });
      this.logger.error(JSON.stringify({ evt: 'NOTIFICATION_NOT_QUEUED', reason: checked.reason }));
      return;
    }
    if (this.queues.enabled) {
      try {
        await this.queues.enqueue(
          QUEUES.notifications,
          'send',
          { chatId, html: htmlText },
          { jobId: dedupeKey, attempts: 5, backoffMs: 5_000 },
        );
        return;
      } catch (e) {
        this.logger.warn(
          `notification queue unavailable, sending directly: ${safeErrorMessage(e)}`,
        );
      }
    }
    await this.send(chatId, htmlText);
  }

  register(sender: NotificationSender): void {
    this.sender = sender;
  }

  get isReady(): boolean {
    return this.sender !== undefined;
  }

  async send(chatId: number, htmlText: string): Promise<DeliveryResult> {
    if (!this.sender) {
      this.logger.warn('No notification channel registered; message not delivered.');
      return 'retry';
    }
    try {
      await this.sender(chatId, htmlText);
      this.lastErrorMessage = null;
      return 'sent';
    } catch (e) {
      const permanent = isPermanentDeliveryError(e);
      this.lastErrorMessage = safeErrorMessage(e);
      this.logger.error(
        `Notification ${permanent ? 'permanently ' : ''}failed: ${safeErrorMessage(e)}`,
      );
      return permanent ? 'permanent' : 'retry';
    }
  }
}
