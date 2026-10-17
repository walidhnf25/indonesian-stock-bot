import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppConfig } from '../config/app-config.service';
import { AIService } from '../ai/ai.service';
import { PrismaService } from '../database/prisma.service';
import { StockService } from '../stock/stock.service';
import { TelegramService } from '../telegram/telegram.service';
import { TtlCache } from '../common/cache/ttl-cache';
import { QUEUES, QueueService } from '../queue/queue.service';
import { RedisService, RedisStatus } from '../redis/redis.service';
import { Metrics } from '../common/metrics.service';

export interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  database: 'connected' | 'unavailable';
  telegram: 'connected' | 'disabled' | 'error';
  stockProvider: 'available' | 'unavailable';
  ai: 'available' | 'unavailable';
  /** Optional dependency: `disabled` when not configured (not a problem), `unavailable` degrades. */
  redis: RedisStatus;
  details: Record<string, string>;
  timestamp: string;
}

@Controller('health')
export class HealthController {
  /** External probes are cached briefly so /health cannot be used to hammer providers. */
  private readonly cache = new TtlCache<HealthReport>(15_000, 1);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly stocks: StockService,
    private readonly ai: AIService,
    private readonly config: AppConfig,
    private readonly redis: RedisService,
    private readonly queues: QueueService,
    private readonly metrics: Metrics,
  ) {}

  /** 503 when PostgreSQL (the only critical dependency) is down, so a monitor sees it; 200 otherwise. */
  @Get()
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthReport> {
    const report = await this.cache.getOrLoad('health', () => this.build());
    if (report.status === 'error') res.status(503);
    return report;
  }

  private async queueSummary(redisUp: boolean): Promise<string> {
    if (!this.queues.enabled) return 'nonaktif (tanpa Redis): timer dalam proses';
    if (!redisUp) return 'Redis tidak tersambung';
    try {
      const parts: string[] = [];
      for (const name of Object.values(QUEUES)) {
        const c = await this.queues.counts(name);
        parts.push(
          `${name}: waiting ${c.waiting + c.delayed}, active ${c.active}, failed ${c.failed}`,
        );
      }
      return `${parts.join('; ')} (peran ${this.queues.role})`;
    } catch {
      return 'tidak dapat dibaca';
    }
  }

  /** Dependency latency as a gauge: a slow database shows up before it is a dead one. */
  private async timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      this.metrics.setGauge(name, Date.now() - started);
    }
  }

  private async build(): Promise<HealthReport> {
    const [db, provider, ai, redisUp] = await Promise.all([
      this.timed('db_ping_ms', () => this.prisma.ping()),
      this.stocks.healthCheck().catch(() => ({ ok: false, detail: 'probe failed' })),
      this.ai.checkHealth(true).catch(() => ({ available: false, detail: 'probe failed' })),
      this.redis.enabled
        ? this.timed('redis_ping_ms', () => this.redis.ping())
        : Promise.resolve(false),
    ]);
    const redisOk = !this.redis.enabled || redisUp;
    const tg = this.telegram.health;
    // A bot that is supposed to run (token set, TELEGRAM_ENABLED) but is not connected is a failure, not
    // "intentionally disabled" (e.g. a production process wrongly started with NODE_ENV=test).
    const telegramExpected =
      Boolean(this.config.get('TELEGRAM_BOT_TOKEN')) && this.config.get('TELEGRAM_ENABLED');
    const telegramOk = tg.status === 'connected' || (!telegramExpected && tg.status === 'disabled');

    const status: HealthReport['status'] = !db
      ? 'error' // PostgreSQL is the only critical dependency
      : provider.ok && ai.available && telegramOk && redisOk
        ? 'ok'
        : 'degraded';

    return {
      status,
      database: db ? 'connected' : 'unavailable',
      telegram: tg.status,
      stockProvider: provider.ok ? 'available' : 'unavailable',
      ai: ai.available ? 'available' : 'unavailable',
      redis: !this.redis.enabled ? 'disabled' : redisUp ? 'connected' : 'unavailable',
      details: {
        database: db ? 'PostgreSQL OK' : 'PostgreSQL tidak dapat dihubungi',
        telegram: tg.detail,
        stockProvider: provider.ok ? this.stocks.providerName : (provider.detail ?? 'unavailable'),
        ai: `${this.ai.providerName}${this.ai.modelName ? ` / ${this.ai.modelName}` : ''}: ${ai.detail}`,
        // never the URL: it may carry a password
        redis: !this.redis.enabled
          ? 'REDIS_URL kosong: kuota dan antrean berjalan di dalam proses'
          : redisUp
            ? 'Redis OK'
            : 'Redis tidak dapat dihubungi: berjalan di dalam proses sampai tersambung lagi',
        queues: await this.queueSummary(redisUp),
      },
      timestamp: new Date().toISOString(),
    };
  }
}
