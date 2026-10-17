import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { safeErrorMessage } from '../common/utils/scrub';
import { AppConfig } from '../config/app-config.service';
import { QUEUES, QueueService } from '../queue/queue.service';
import { isTestRuntime } from '../telegram/runtime-guard';
import { PortfolioService } from './portfolio.service';

const EVERY_MS = 3_600_000;
/** Snapshots describe the close: they are taken from this Jakarta hour onwards (IDX closes 16:00). */
const FROM_HOUR = 16;

/**
 * Writes one valuation snapshot per portfolio per Asia/Jakarta calendar day, after the market close. Runs
 * hourly (BullMQ repeatable job with Redis, in-process timer otherwise); the upsert makes reruns harmless.
 */
@Injectable()
export class PortfolioSnapshotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PortfolioSnapshotService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly portfolio: PortfolioService,
    private readonly queues: QueueService,
    private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (isTestRuntime() || this.config.get('NODE_ENV') === 'test') return;
    if (this.queues.enabled) {
      void this.startQueued();
      return;
    }
    this.timer = setInterval(() => void this.tick(), EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass: after the close, snapshot every portfolio. Never throws, never overlaps itself. */
  async tick(now = new Date()): Promise<number> {
    if (this.running) return 0;
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jakarta',
        hour: '2-digit',
        hour12: false,
      }).format(now),
    );
    if (hour < FROM_HOUR) return 0;
    this.running = true;
    try {
      const n = await this.portfolio.snapshotAll(now);
      if (n > 0) this.logger.log(JSON.stringify({ evt: 'portfolio_snapshot', portfolios: n }));
      return n;
    } catch (e) {
      this.logger.error(`portfolio snapshot failed: ${safeErrorMessage(e)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async startQueued(): Promise<void> {
    try {
      if (this.queues.schedules) {
        await this.queues.scheduleEvery(QUEUES.maintenance, 'portfolio-snapshot', EVERY_MS);
      }
      if (this.queues.runsWorkers) {
        // the maintenance queue is shared with retention; the queue's single worker dispatches by job name
        this.queues.registerJob(QUEUES.maintenance, 'portfolio-snapshot', () => this.tick(), {
          timeoutMs: 600_000,
        });
      }
    } catch (e) {
      this.logger.warn(`Queue scheduling failed, using in-process timer: ${safeErrorMessage(e)}`);
      this.timer = setInterval(() => void this.tick(), EVERY_MS);
      this.timer.unref();
    }
  }
}
