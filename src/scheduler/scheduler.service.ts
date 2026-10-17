import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AlertService } from '../alert/alert.service';
import { safeErrorMessage } from '../common/utils/scrub';
import { AppConfig } from '../config/app-config.service';
import { MarketService } from '../market/market.service';
import { QUEUES, QueueService } from '../queue/queue.service';

const JOB_NAME = 'alert-check';

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private running = false;

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly alerts: AlertService,
    private readonly market: MarketService,
    private readonly config: AppConfig,
    private readonly queues: QueueService,
  ) {}

  onModuleInit(): void {
    if (this.config.get('NODE_ENV') === 'test') return;
    const everyMs = this.config.get('ALERT_CHECK_INTERVAL_SECONDS') * 1000;
    if (this.queues.enabled) {
      // With Redis the check is a repeatable BullMQ job: one schedule for all processes, one run at a time,
      // executed by whichever process runs workers.
      void this.startQueued(everyMs);
      return;
    }
    const handle = setInterval(() => void this.tick(), everyMs);
    handle.unref();
    this.registry.addInterval(JOB_NAME, handle);
    this.logger.log(`Alert checker scheduled every ${everyMs / 1000}s`);
  }

  onModuleDestroy(): void {
    try {
      this.registry.deleteInterval(JOB_NAME);
    } catch {
      /* not registered */
    }
  }

  private async startQueued(everyMs: number): Promise<void> {
    try {
      if (this.queues.schedules)
        await this.queues.scheduleEvery(QUEUES.alerts, 'alert-check', everyMs);
      if (this.queues.runsWorkers) {
        this.queues.registerJob(QUEUES.alerts, 'alert-check', () => this.tick(), {
          concurrency: 1,
          timeoutMs: 300_000,
        });
      }
      this.logger.log(
        `Alert checker: BullMQ job every ${everyMs / 1000}s (${this.queues.runsWorkers ? 'worker here' : 'workers elsewhere'})`,
      );
    } catch (e) {
      // Redis unreachable at start: fall back to the in-process timer so alerts are still evaluated
      this.logger.warn(`Queue scheduling failed, using in-process timer: ${safeErrorMessage(e)}`);
      const handle = setInterval(() => void this.tick(), everyMs);
      handle.unref();
      this.registry.addInterval(JOB_NAME, handle);
    }
  }

  /** One scheduler tick. Skips when the market is closed (unless configured otherwise) or already running. */
  async tick(): Promise<{ ran: boolean; reason?: string }> {
    if (this.running) return { ran: false, reason: 'previous run still in progress' };
    const status = this.market.getStatus();
    if (!status.isTrading && !this.config.get('ALERT_CHECK_WHEN_CLOSED')) {
      return { ran: false, reason: `market ${status.state}` };
    }
    this.running = true;
    const started = Date.now();
    try {
      const summary = await this.alerts.checkAll();
      if (summary.checked > 0 || summary.errors > 0) {
        this.logger.log(
          JSON.stringify({ evt: 'alert_check', ...summary, latencyMs: Date.now() - started }),
        );
      }
      return { ran: true };
    } catch (e) {
      this.logger.error(`alert check failed: ${safeErrorMessage(e)}`);
      return { ran: false, reason: 'error' };
    } finally {
      this.running = false;
    }
  }
}
