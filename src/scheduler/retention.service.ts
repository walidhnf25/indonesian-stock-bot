import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { safeErrorMessage } from '../common/utils/scrub';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../database/prisma.service';
import { QUEUES, QueueService } from '../queue/queue.service';
import { isTestRuntime } from '../telegram/runtime-guard';

const JOB_NAME = 'retention';
const DAY_MS = 86_400_000;

export interface RetentionSummary {
  fetchLogs: number;
  aiAnalyses: number;
  alertHistory: number;
  fundamentalSnapshots: number;
  newsArticles: number;
  conversationContexts: number;
}

/**
 * Bounds the tables a public bot would otherwise grow without limit.
 *
 * Deleted: rows STRICTLY older than their retention window (a row exactly at the boundary is kept).
 *  - DataFetchLog         : provider-call log, `FETCH_LOG_RETENTION_DAYS` (default 7)
 *  - AIAnalysis           : stored analyses with their input snapshot, `AI_ANALYSIS_RETENTION_DAYS` (30)
 *  - Alert                : only TRIGGERED / DISABLED alerts, `ALERT_HISTORY_RETENTION_DAYS` (30) after
 *                           their last status change. ACTIVE alerts are NEVER deleted.
 *  - ConversationContext  : expired rows (short-lived by design)
 * Never touched: users, watchlists, stocks, quote snapshots and daily candles (bounded by the number of
 * users/tickers, and needed as the last-known-data fallback).
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly registry: SchedulerRegistry,
    private readonly queues: QueueService,
  ) {}

  onModuleInit(): void {
    if (isTestRuntime() || this.config.get('NODE_ENV') === 'test') return;
    const everyMs = this.config.get('RETENTION_INTERVAL_HOURS') * 3_600_000;
    if (this.queues.enabled) {
      void this.startQueued(everyMs);
      return;
    }
    const handle = setInterval(() => void this.runSafely(), everyMs);
    handle.unref();
    this.registry.addInterval(JOB_NAME, handle);
    // One pass shortly after start so a long-stopped bot does not wait a whole interval.
    setTimeout(() => void this.runSafely(), 60_000).unref();
    this.logger.log(
      `Retention job scheduled every ${this.config.get('RETENTION_INTERVAL_HOURS')}h`,
    );
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
        await this.queues.scheduleEvery(QUEUES.maintenance, 'retention', everyMs);
      if (this.queues.runsWorkers) {
        this.queues.registerJob(QUEUES.maintenance, 'retention', () => this.runSafely(), {
          concurrency: 1,
          timeoutMs: 600_000,
        });
      }
      this.logger.log(`Retention: BullMQ job every ${everyMs / 3_600_000}h`);
    } catch (e) {
      this.logger.warn(`Queue scheduling failed, using in-process timer: ${safeErrorMessage(e)}`);
      const handle = setInterval(() => void this.runSafely(), everyMs);
      handle.unref();
      this.registry.addInterval(JOB_NAME, handle);
    }
  }

  /** Never throws and never overlaps itself. */
  async runSafely(now: Date = new Date()): Promise<RetentionSummary | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.run(now);
    } catch (e) {
      this.logger.error(`retention failed: ${safeErrorMessage(e)}`);
      return null;
    } finally {
      this.running = false;
    }
  }

  async run(now: Date = new Date()): Promise<RetentionSummary> {
    const before = (days: number) => new Date(now.getTime() - days * DAY_MS);

    const fetchLogs = await this.prisma.dataFetchLog.deleteMany({
      where: { createdAt: { lt: before(this.config.get('FETCH_LOG_RETENTION_DAYS')) } },
    });
    const aiAnalyses = await this.prisma.aIAnalysis.deleteMany({
      where: { createdAt: { lt: before(this.config.get('AI_ANALYSIS_RETENTION_DAYS')) } },
    });
    const alertHistory = await this.prisma.alert.deleteMany({
      where: {
        status: { in: ['TRIGGERED', 'DISABLED', 'EXPIRED'] }, // ACTIVE is excluded on purpose
        updatedAt: { lt: before(this.config.get('ALERT_HISTORY_RETENTION_DAYS')) },
      },
    });
    const conversationContexts = await this.prisma.conversationContext.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    const fundamentalSnapshots = await this.prisma.fundamentalSnapshot.deleteMany({
      where: { asOf: { lt: before(this.config.get('FUNDAMENTAL_SNAPSHOT_RETENTION_DAYS')) } },
    });

    const newsArticles = await this.prisma.newsArticle.deleteMany({
      where: { publishedAt: { lt: before(this.config.get('NEWS_RETENTION_DAYS')) } },
    });

    const summary: RetentionSummary = {
      fetchLogs: fetchLogs.count,
      aiAnalyses: aiAnalyses.count,
      alertHistory: alertHistory.count,
      conversationContexts: conversationContexts.count,
      fundamentalSnapshots: fundamentalSnapshots.count,
      newsArticles: newsArticles.count,
    };
    if (Object.values(summary).some((n) => n > 0)) {
      this.logger.log(JSON.stringify({ evt: 'retention_run', ...summary }));
    }
    return summary;
  }
}
