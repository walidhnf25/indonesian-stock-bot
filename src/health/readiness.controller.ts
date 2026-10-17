import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { TtlCache } from '../common/cache/ttl-cache';
import { PrismaService } from '../database/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RedisService } from '../redis/redis.service';

export interface ReadinessReport {
  ready: boolean;
  checks: {
    database: 'ok' | 'unavailable';
    /** 'ok' when every migration folder on disk is applied; 'pending' lists what is missing. */
    migrations: 'ok' | 'pending' | 'unknown';
    /** 'disabled' when REDIS_URL is empty (then in-process fallbacks are the design, not a failure). */
    redis: 'ok' | 'unavailable' | 'disabled';
    queues: 'ok' | 'unavailable' | 'disabled';
  };
  pendingMigrations: string[];
  role: string;
  timestamp: string;
}

export interface LivenessReport {
  alive: true;
  uptimeSeconds: number;
  /** p99 event-loop delay (ms) over the last window: a stuck process shows here before it stops answering. */
  eventLoopDelayP99Ms: number;
  memoryRssMb: number;
  timestamp: string;
}

/** The migrations folder, next to the compiled code (dist/health -> prisma/migrations) or under the cwd. */
function migrationsDir(): string {
  const candidates = [
    join(__dirname, '..', '..', 'prisma', 'migrations'),
    join(process.cwd(), 'prisma', 'migrations'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/**
 * Kubernetes-style probes next to the richer /health.
 *
 *  - GET /live  : the process is up and its event loop turns (never touches a dependency).
 *  - GET /ready : the process may receive traffic: PostgreSQL answers, every migration on disk is
 *                 applied, and Redis/queues work when they are configured. 503 otherwise.
 */
@Controller()
export class ReadinessController {
  private readonly cache = new TtlCache<ReadinessReport>(5_000, 1);
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 20 });
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queues: QueueService,
  ) {
    this.loopDelay.enable();
  }

  @Get('live')
  live(): LivenessReport {
    const p99 = this.loopDelay.percentile(99) / 1e6;
    this.loopDelay.reset();
    return {
      alive: true,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      eventLoopDelayP99Ms: Number.isFinite(p99) ? Math.round(p99 * 10) / 10 : 0,
      memoryRssMb: Math.round(process.memoryUsage().rss / 1_048_576),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.cache.getOrLoad('ready', () => this.build());
    if (!report.ready) res.status(503);
    return report;
  }

  private async build(): Promise<ReadinessReport> {
    const db = await this.prisma.ping();
    const { status: migrations, pending } = db
      ? await this.migrationStatus()
      : { status: 'unknown' as const, pending: [] };
    let redis: ReadinessReport['checks']['redis'] = 'disabled';
    let queues: ReadinessReport['checks']['queues'] = 'disabled';
    if (this.redis.enabled) {
      redis = (await this.redis.ping()) ? 'ok' : 'unavailable';
      if (this.queues.enabled) {
        queues = redis === 'ok' && (await this.queuesAnswer()) ? 'ok' : 'unavailable';
      }
    }
    // 'unknown' (folder not readable from this deployment) must not fail readiness: only a known pending
    // migration or a dead dependency does
    const ready =
      db && migrations !== 'pending' && redis !== 'unavailable' && queues !== 'unavailable';
    return {
      ready,
      checks: { database: db ? 'ok' : 'unavailable', migrations, redis, queues },
      pendingMigrations: pending,
      role: this.queues.role,
      timestamp: new Date().toISOString(),
    };
  }

  /** Folders under prisma/migrations that have no finished row in _prisma_migrations. */
  private async migrationStatus(): Promise<{
    status: 'ok' | 'pending' | 'unknown';
    pending: string[];
  }> {
    try {
      const onDisk = readdirSync(migrationsDir(), {
        withFileTypes: true,
      })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      const rows = await this.prisma.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
      const applied = new Set(rows.map((r) => r.migration_name));
      const pending = onDisk.filter((m) => !applied.has(m));
      return { status: pending.length === 0 ? 'ok' : 'pending', pending };
    } catch {
      return { status: 'unknown', pending: [] };
    }
  }

  private async queuesAnswer(): Promise<boolean> {
    try {
      await this.queues.counts('alerts');
      return true;
    } catch {
      return false;
    }
  }
}
