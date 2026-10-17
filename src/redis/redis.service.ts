import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { Metrics } from '../common/metrics.service';
import { safeErrorMessage } from '../common/utils/scrub';
import { AppConfig } from '../config/app-config.service';

export type RedisStatus = 'disabled' | 'connecting' | 'connected' | 'unavailable';

/**
 * The one Redis connection of the process. Redis is OPTIONAL and never the source of truth: it holds
 * caches, quotas, locks and queue state so that several processes can share them. When REDIS_URL is empty
 * everything that would use Redis runs on its in-process implementation; when Redis is configured but down,
 * callers fall back the same way and say so in metrics/health (degraded, not broken).
 *
 * Rules: every key carries the configured prefix; every key has a TTL; commands never wait on an offline
 * queue (a down Redis must fail fast, not hang a chat request).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client?: Redis;
  private current: RedisStatus = 'disabled';
  readonly prefix: string;

  constructor(
    private readonly config: AppConfig,
    private readonly metrics: Metrics,
  ) {
    this.prefix = config.get('REDIS_KEY_PREFIX');
    const url = config.get('REDIS_URL');
    if (url) this.connect(url);
  }

  get status(): RedisStatus {
    return this.current;
  }

  get enabled(): boolean {
    return this.client !== undefined;
  }

  /** The client when Redis is configured and currently connected, otherwise null (callers then fall back). */
  get(): Redis | null {
    return this.current === 'connected' && this.client ? this.client : null;
  }

  key(...parts: Array<string | number>): string {
    return `${this.prefix}${parts.join(':')}`;
  }

  /** Liveness probe with a bound, for /health. */
  async ping(timeoutMs = 1000): Promise<boolean> {
    const c = this.client;
    if (!c) return false;
    try {
      const pong = await Promise.race([
        c.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs),
        ),
      ]);
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  /** Counts a fallback to the in-process implementation (visible in /metrics). */
  noteFallback(what: string): void {
    this.metrics.inc('redis_fallback_total', { what });
  }

  async onModuleDestroy(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    this.current = 'disabled';
    if (!c) return;
    try {
      await Promise.race([c.quit(), new Promise((r) => setTimeout(r, 1000))]);
    } catch {
      /* shutting down */
    }
    c.disconnect();
  }

  private connect(url: string): void {
    this.current = 'connecting';
    const client = new Redis(url, {
      lazyConnect: true,
      connectTimeout: this.config.get('REDIS_CONNECT_TIMEOUT_MS'),
      // a down Redis must fail fast: no offline queue, one attempt per command
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)),
      reconnectOnError: () => true,
    });
    client.on('ready', () => {
      this.current = 'connected';
      this.metrics.setGauge('redis_connected', 1);
      this.logger.log('Redis connected');
    });
    client.on('end', () => {
      if (this.client) this.current = 'unavailable';
      this.metrics.setGauge('redis_connected', 0);
    });
    client.on('error', (e: Error) => {
      if (this.current === 'connected') this.logger.warn(`Redis error: ${safeErrorMessage(e)}`);
      this.current = 'unavailable';
      this.metrics.setGauge('redis_connected', 0);
      this.metrics.inc('redis_errors_total');
    });
    this.client = client;
    client.connect().catch((e: Error) => {
      this.current = 'unavailable';
      this.logger.warn(
        `Redis unreachable, running on in-process state until it comes back: ${safeErrorMessage(e)}`,
      );
    });
  }
}
