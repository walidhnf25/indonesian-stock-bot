import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Job, JobsOptions, Queue, UnrecoverableError, Worker } from 'bullmq';
import { Metrics } from '../common/metrics.service';
import { safeErrorMessage } from '../common/utils/scrub';
import { AppConfig } from '../config/app-config.service';

/** The queues Indonesian Stock Bot uses. Names are also the Redis key namespace under the configured prefix. */
export const QUEUES = {
  /** Periodic alert evaluation (one repeatable job; never more than one run at a time). */
  alerts: 'alerts',
  /** Retention, portfolio snapshots and other housekeeping. */
  maintenance: 'maintenance',
  /** Proactive messages that may be retried (owner notices, undeliverable-group notices). */
  notifications: 'notifications',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export type BotRole = 'all' | 'gateway' | 'worker';

export type JobProcessor = (job: Job) => Promise<unknown>;

export interface JobHandlerOptions {
  /** A job running longer than this is failed and its lock released. */
  timeoutMs?: number;
}

export interface WorkerOptionsLite extends JobHandlerOptions {
  concurrency?: number;
}

export interface EnqueueOptions {
  /** Same id = same job: a second enqueue while the first is waiting/active is ignored (idempotency). */
  jobId?: string;
  attempts?: number;
  backoffMs?: number;
  correlationId?: string;
}

const ANY_JOB = '*';
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Thin, opinionated wrapper around BullMQ. Only active when REDIS_URL is set; otherwise `enabled` is false and
 * every caller keeps its in-process path (interval timers, direct sends).
 *
 * ONE worker per queue: handlers are registered per job name (`registerJob`) and the queue's worker dispatches
 * by `job.name`, so several services can share a queue (retention and portfolio snapshots both live in
 * `maintenance`) without a job ever landing in the wrong processor. Every queue keeps bounded retention of
 * finished jobs, every worker has bounded concurrency and a per-job timeout, every job carries a correlation
 * id. Jobs that fail their last attempt stay in the failed set (the dead-letter view) up to a bound.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();
  private readonly handlers = new Map<
    string,
    Map<string, { processor: JobProcessor; timeoutMs: number }>
  >();
  private readonly connection: Record<string, unknown> | null;
  private readonly prefix: string;
  private gaugeTimer?: NodeJS.Timeout;
  readonly role: BotRole;
  private closing = false;

  constructor(
    private readonly config: AppConfig,
    private readonly metrics: Metrics,
  ) {
    this.role = config.get('BOT_ROLE');
    this.prefix = `${config.get('REDIS_KEY_PREFIX')}bull`;
    const url = config.get('REDIS_URL');
    this.connection = url ? connectionFromUrl(url, config.get('REDIS_CONNECT_TIMEOUT_MS')) : null;
  }

  /** True when queues are backed by Redis (REDIS_URL set). */
  get enabled(): boolean {
    return this.connection !== null;
  }

  /** True when this process should run workers (role all/worker) and queues are enabled. */
  get runsWorkers(): boolean {
    return this.enabled && this.role !== 'gateway';
  }

  /** True when this process should schedule repeatable jobs (idempotent, any role may do it). */
  get schedules(): boolean {
    return this.enabled;
  }

  queue(name: QueueName): Queue {
    if (!this.connection) throw new Error('queues are disabled (REDIS_URL empty)');
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection as never,
        prefix: this.prefix,
        defaultJobOptions: {
          removeOnComplete: { count: 200, age: 24 * 3600 },
          removeOnFail: { count: 1000, age: 7 * 24 * 3600 }, // the dead-letter view, bounded
          attempts: 1,
        },
      });
      q.on('error', (e: Error) => this.logger.warn(`queue ${name}: ${safeErrorMessage(e)}`));
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue<T extends object>(
    name: QueueName,
    jobName: string,
    data: T,
    opts: EnqueueOptions = {},
  ): Promise<string | null> {
    const q = this.queue(name);
    const options: JobsOptions = {
      jobId: opts.jobId,
      attempts: opts.attempts ?? 1,
      backoff: opts.backoffMs ? { type: 'exponential', delay: opts.backoffMs } : undefined,
    };
    const correlationId = opts.correlationId ?? `${jobName}-${Date.now().toString(36)}`;
    const job = await q.add(jobName, { ...data, correlationId }, options);
    this.metrics.inc('queue_jobs_total', { queue: name, outcome: 'enqueued' });
    return job.id ?? null;
  }

  /**
   * Registers (or updates) a repeatable job. BullMQ keys it by name + pattern, so calling this from several
   * processes yields one schedule, and only one run of it is active at a time with a concurrency-1 worker.
   */
  async scheduleEvery(name: QueueName, jobName: string, everyMs: number): Promise<void> {
    const q = this.queue(name);
    // drop stale schedules of the same job with another interval (config changed)
    const existing = await q.getJobSchedulers();
    for (const s of existing) {
      if (s.name === jobName && s.every !== everyMs && s.key) await q.removeJobScheduler(s.key);
    }
    await q.upsertJobScheduler(`${jobName}-every`, { every: everyMs }, { name: jobName, data: {} });
  }

  /**
   * Registers the processor for `jobName` on `queue` and makes sure the queue's single worker runs. Jobs
   * whose name has no handler fail with a clear error (and are visible in the failed set).
   */
  registerJob(
    queue: QueueName,
    jobName: string,
    processor: JobProcessor,
    opts: WorkerOptionsLite = {},
  ): void {
    if (!this.connection) throw new Error('queues are disabled (REDIS_URL empty)');
    let byName = this.handlers.get(queue);
    if (!byName) {
      byName = new Map();
      this.handlers.set(queue, byName);
    }
    byName.set(jobName, { processor, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    this.ensureWorker(queue, opts.concurrency ?? 1);
  }

  /** One processor for every job of the queue (tests, simple queues). */
  startWorker(name: QueueName, processor: JobProcessor, opts: WorkerOptionsLite = {}): Worker {
    this.registerJob(name, ANY_JOB, processor, opts);
    return this.workers.get(name) as Worker;
  }

  /** Waiting/active/failed counts of a queue (health and metrics). */
  async counts(
    name: QueueName,
  ): Promise<{ waiting: number; active: number; failed: number; delayed: number }> {
    const c = await this.queue(name).getJobCounts('waiting', 'active', 'failed', 'delayed');
    return {
      waiting: c.waiting ?? 0,
      active: c.active ?? 0,
      failed: c.failed ?? 0,
      delayed: c.delayed ?? 0,
    };
  }

  async refreshGauges(): Promise<void> {
    for (const name of this.queues.keys()) {
      try {
        const c = await this.counts(name as QueueName);
        this.metrics.setGauge('queue_waiting', c.waiting + c.delayed, { queue: name });
        this.metrics.setGauge('queue_active', c.active, { queue: name });
        this.metrics.setGauge('queue_failed', c.failed, { queue: name });
      } catch {
        /* redis down: gauges keep their last value */
      }
    }
  }

  /** Graceful shutdown: workers finish the job they hold, then connections close. */
  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
    await Promise.allSettled([...this.workers.values()].map((w) => w.close()));
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }

  /* ---------------------------------------------------------------- internals */

  private ensureWorker(name: QueueName, concurrency: number): void {
    if (this.workers.has(name)) return;
    const worker = new Worker(name, (job) => this.dispatch(name, job), {
      connection: this.connection as never,
      prefix: this.prefix,
      concurrency,
      // the lock must outlive the longest registered timeout; handlers are registered before jobs run
      lockDuration: Math.max(30_000, this.longestTimeout(name) + 5_000),
    });
    worker.on('error', (e: Error) => {
      if (!this.closing) this.logger.warn(`worker ${name}: ${safeErrorMessage(e)}`);
    });
    this.workers.set(name, worker);
    this.startGauges();
  }

  private longestTimeout(name: QueueName): number {
    let max = DEFAULT_TIMEOUT_MS;
    for (const h of this.handlers.get(name)?.values() ?? []) max = Math.max(max, h.timeoutMs);
    return max;
  }

  private async dispatch(name: QueueName, job: Job): Promise<unknown> {
    const byName = this.handlers.get(name);
    const handler = byName?.get(job.name) ?? byName?.get(ANY_JOB);
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      if (!handler)
        throw new Error(`no handler registered for job "${job.name}" on queue "${name}"`);
      const result = await Promise.race([
        handler.processor(job),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`job timed out after ${handler.timeoutMs} ms`)),
            handler.timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
      this.metrics.inc('queue_jobs_total', { queue: name, outcome: 'completed' });
      return result;
    } catch (e) {
      // an UnrecoverableError is never retried by BullMQ, whatever the configured attempts
      const last =
        e instanceof UnrecoverableError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      this.metrics.inc('queue_jobs_total', { queue: name, outcome: last ? 'failed' : 'retried' });
      if (last) {
        this.logger.error(
          JSON.stringify({
            evt: 'JOB_FAILED',
            queue: name,
            job: job.name,
            correlationId: (job.data as { correlationId?: string })?.correlationId,
            attempts: job.attemptsMade + 1,
            error: safeErrorMessage(e),
          }),
        );
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      this.metrics.inc('queue_job_ms_total', { queue: name }, Date.now() - started);
      this.metrics.observe('queue_job_ms', Date.now() - started, { queue: name });
    }
  }

  private startGauges(): void {
    if (this.gaugeTimer) return;
    this.gaugeTimer = setInterval(() => void this.refreshGauges(), 15_000);
    this.gaugeTimer.unref?.();
  }
}

/** BullMQ gets its own connection (it needs `maxRetriesPerRequest: null`); parsed from the same REDIS_URL. */
export function connectionFromUrl(url: string, connectTimeout: number): Record<string, unknown> {
  const u = new URL(url);
  const db = Number(u.pathname.replace('/', '') || '0');
  return {
    host: u.hostname,
    port: Number(u.port || '6379'),
    db: Number.isFinite(db) ? db : 0,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    connectTimeout,
  };
}
