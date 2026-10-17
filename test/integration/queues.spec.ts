import Redis from 'ioredis';
import { Metrics } from '../../src/common/metrics.service';
import { AppConfig } from '../../src/config/app-config.service';
import { QUEUES, QueueService, connectionFromUrl } from '../../src/queue/queue.service';

/**
 * BullMQ queues on the compose Redis (database 3, prefix `stockbottest:`). Skipped with a visible warning
 * when Redis is not reachable.
 */
const URL = process.env.TEST_REDIS_URL_QUEUES ?? 'redis://127.0.0.1:6380/3';

async function reachable(): Promise<boolean> {
  const probe = new Redis(URL, {
    lazyConnect: true,
    connectTimeout: 1500,
    maxRetriesPerRequest: 0,
  });
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

function config(over: Record<string, unknown> = {}): AppConfig {
  const values: Record<string, unknown> = {
    REDIS_URL: URL,
    REDIS_CONNECT_TIMEOUT_MS: 1500,
    REDIS_KEY_PREFIX: 'stockbottest:',
    BOT_ROLE: 'all',
    ...over,
  };
  return { get: (k: string) => values[k] } as unknown as AppConfig;
}

const waitFor = async (cond: () => boolean, ms = 10_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('BullMQ queues', () => {
  let up = false;
  let raw: Redis;
  const flush = async () => {
    const keys = await raw.keys('stockbottest:bull*');
    if (keys.length) await raw.del(...keys);
  };
  beforeAll(async () => {
    up = await reachable();
    if (!up) {
      console.warn(`[queues.spec] Redis not reachable at ${URL}: integration tests SKIPPED`);
      return;
    }
    raw = new Redis(URL);
    await flush();
  });
  afterAll(async () => {
    if (raw) {
      await flush();
      raw.disconnect();
    }
  });
  const it_ = (name: string, fn: () => Promise<void>, timeout = 20_000) =>
    it(name, async () => (up ? fn() : undefined), timeout);

  it('connectionFromUrl parses host, port, db and credentials and forces maxRetriesPerRequest null', () => {
    const c = connectionFromUrl('rediss://user:p%40ss@redis.local:6390/4', 1234);
    expect(c).toMatchObject({
      host: 'redis.local',
      port: 6390,
      db: 4,
      username: 'user',
      password: 'p@ss',
      maxRetriesPerRequest: null,
      connectTimeout: 1234,
    });
    expect(c.tls).toBeDefined();
    expect(connectionFromUrl('redis://127.0.0.1:6380', 1)).toMatchObject({ port: 6380, db: 0 });
  });

  it('without REDIS_URL the service is disabled and refuses to build queues', () => {
    const q = new QueueService(config({ REDIS_URL: undefined }), new Metrics());
    expect(q.enabled).toBe(false);
    expect(q.runsWorkers).toBe(false);
    expect(() => q.queue(QUEUES.notifications)).toThrow(/disabled/);
  });

  it('the gateway role never runs workers', () => {
    const q = new QueueService(config({ BOT_ROLE: 'gateway' }), new Metrics());
    expect(q.enabled).toBe(true);
    expect(q.runsWorkers).toBe(false);
    expect(q.schedules).toBe(true);
  });

  it_('processes a job and counts it', async () => {
    const metrics = new Metrics();
    const q = new QueueService(config(), metrics);
    const seen: string[] = [];
    q.startWorker(QUEUES.notifications, async (job) => {
      seen.push(job.data.html);
      return 'sent';
    });
    await q.enqueue(QUEUES.notifications, 'send', { chatId: 1, html: 'halo' });
    await waitFor(() => seen.length === 1, 10_000, 'the job to run');
    expect(
      metrics.counter('queue_jobs_total', { queue: 'notifications', outcome: 'enqueued' }),
    ).toBe(1);
    expect(
      metrics.counter('queue_jobs_total', { queue: 'notifications', outcome: 'completed' }),
    ).toBe(1);
    await q.onModuleDestroy();
  });

  it_(
    'a failing job is retried with backoff and lands in the failed set (dead letter) after the last attempt',
    async () => {
      const metrics = new Metrics();
      const q = new QueueService(config(), metrics);
      let attempts = 0;
      const stamps: number[] = [];
      q.startWorker(QUEUES.notifications, async () => {
        attempts++;
        stamps.push(Date.now());
        throw new Error('telegram down');
      });
      await q.enqueue(
        QUEUES.notifications,
        'send',
        { chatId: 1, html: 'x' },
        { attempts: 3, backoffMs: 200 },
      );
      await waitFor(() => attempts === 3, 15_000, 'three attempts');
      await waitFor(
        () =>
          metrics.counter('queue_jobs_total', { queue: 'notifications', outcome: 'failed' }) === 1,
        5_000,
        'the final failure',
      );
      expect(
        metrics.counter('queue_jobs_total', { queue: 'notifications', outcome: 'retried' }),
      ).toBe(2);
      expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(150); // exponential backoff from 200 ms
      expect(stamps[2] - stamps[1]).toBeGreaterThanOrEqual(350);
      // the failed set is written just after the processor rejects: poll it rather than sleep
      let c = await q.counts(QUEUES.notifications);
      const deadline = Date.now() + 5000;
      while (c.failed !== 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        c = await q.counts(QUEUES.notifications);
      }
      expect(c.failed).toBe(1);
      expect(c.waiting + c.active + c.delayed).toBe(0);
      await q.onModuleDestroy();
    },
  );

  it_('the same jobId is not executed twice while the first is still pending', async () => {
    const q = new QueueService(config(), new Metrics());
    let runs = 0;
    q.startWorker(QUEUES.notifications, async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 300));
    });
    await Promise.all([
      q.enqueue(QUEUES.notifications, 'send', { chatId: 2, html: 'a' }, { jobId: 'notice:2:same' }),
      q.enqueue(QUEUES.notifications, 'send', { chatId: 2, html: 'a' }, { jobId: 'notice:2:same' }),
      q.enqueue(QUEUES.notifications, 'send', { chatId: 2, html: 'a' }, { jobId: 'notice:2:same' }),
    ]);
    await new Promise((r) => setTimeout(r, 1200));
    expect(runs).toBe(1);
    await q.onModuleDestroy();
  });

  it_(
    'a repeatable job runs again and again on its schedule, and only one schedule exists per job',
    async () => {
      const q = new QueueService(config(), new Metrics());
      let runs = 0;
      q.startWorker(QUEUES.maintenance, async () => {
        runs++;
      });
      await q.scheduleEvery(QUEUES.maintenance, 'retention', 1000);
      await q.scheduleEvery(QUEUES.maintenance, 'retention', 1000); // idempotent
      await q.scheduleEvery(QUEUES.maintenance, 'retention', 500); // config changed: replaces the old one
      const schedulers = await q.queue(QUEUES.maintenance).getJobSchedulers();
      expect(schedulers.filter((s) => s.name === 'retention')).toHaveLength(1);
      await waitFor(() => runs >= 3, 15_000, 'three repeated runs');
      await q.onModuleDestroy();
    },
  );

  it_('a job that exceeds its timeout fails and the worker takes the next job', async () => {
    const metrics = new Metrics();
    const q = new QueueService(config(), metrics);
    const done: string[] = [];
    q.startWorker(
      QUEUES.notifications,
      async (job) => {
        if (job.data.html === 'hang') await new Promise(() => undefined);
        done.push(job.data.html);
      },
      { timeoutMs: 300 },
    );
    await q.enqueue(QUEUES.notifications, 'send', { chatId: 3, html: 'hang' });
    await q.enqueue(QUEUES.notifications, 'send', { chatId: 3, html: 'next' });
    await waitFor(() => done.includes('next'), 15_000, 'the next job after a timeout');
    expect(metrics.counter('queue_jobs_total', { queue: 'notifications', outcome: 'failed' })).toBe(
      1,
    );
    await q.onModuleDestroy();
  });

  it_(
    'one worker per queue dispatches by job name: two services can share a queue safely',
    async () => {
      const metrics = new Metrics();
      const q = new QueueService(config(), metrics);
      const seen: string[] = [];
      q.registerJob(QUEUES.maintenance, 'retention', async () => {
        seen.push('retention');
      });
      q.registerJob(QUEUES.maintenance, 'portfolio-snapshot', async () => {
        seen.push('snapshot');
      });
      await q.enqueue(QUEUES.maintenance, 'portfolio-snapshot', {});
      await q.enqueue(QUEUES.maintenance, 'retention', {});
      await q.enqueue(QUEUES.maintenance, 'nobody-handles-this', {});
      await waitFor(() => seen.length === 2, 10_000, 'both handled jobs');
      expect(seen.sort()).toEqual(['retention', 'snapshot']);
      await waitFor(
        () =>
          metrics.counter('queue_jobs_total', { queue: 'maintenance', outcome: 'failed' }) === 1,
        5_000,
        'the unhandled job to fail',
      );
      await q.onModuleDestroy();
    },
  );

  it_('graceful shutdown lets the running job finish', async () => {
    const q = new QueueService(config(), new Metrics());
    let finished = false;
    q.startWorker(QUEUES.notifications, async () => {
      await new Promise((r) => setTimeout(r, 400));
      finished = true;
    });
    await q.enqueue(QUEUES.notifications, 'send', { chatId: 4, html: 'slow' });
    await new Promise((r) => setTimeout(r, 100));
    await q.onModuleDestroy();
    expect(finished).toBe(true);
  });
});
