import { Logger } from '@nestjs/common';
import { AccessService } from '../../src/access/access.service';
import { AlertService } from '../../src/alert/alert.service';
import { Metrics } from '../../src/common/metrics.service';
import { NotifierService } from '../../src/notifier/notifier.service';
import { QUEUES, QueueService } from '../../src/queue/queue.service';
import { UserService } from '../../src/user/user.service';
import { createTestApp, flushBackground, resetCaches, sleep, TestApp } from '../setup/test-app';

/**
 * A queued notification is untrusted input (Redis is not a trusted place). The worker validates every job it
 * consumes — shape, recipient, authorization, length, markup — and a bad job fails ONCE, is dropped from Redis, and
 * can never make the bot send an arbitrary message to an arbitrary recipient.
 */
const redisIt = process.env.REDIS_URL ? it : it.skip;
const GOOD = '⚠️ <b>Alert</b> TSTA harga di atas Rp1.500 sudah terpenuhi.';

describe('notification payload validation', () => {
  let t: TestApp;
  let queues: QueueService;
  let metrics: Metrics;
  let users: UserService;
  let owner: number;
  let jobSeq = 0;

  const enqueue = (data: object, jobId?: string) =>
    queues.enqueue(QUEUES.notifications, 'send', data, {
      attempts: 5,
      backoffMs: 50,
      jobId: jobId ?? `aud02-${Date.now()}-${++jobSeq}`,
    });
  /** Waits until nothing is waiting, running or scheduled for retry. */
  const drain = async (ms = 15_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const c = await queues.counts(QUEUES.notifications);
      if (c.waiting + c.active + c.delayed === 0) return c;
      if (Date.now() > end) throw new Error(`queue did not drain: ${JSON.stringify(c)}`);
      await sleep(40);
    }
  };
  const failedJobs = () => queues.queue(QUEUES.notifications).getFailed(0, 100);

  beforeAll(async () => {
    t = await createTestApp(
      undefined,
      {},
      {
        // user 76_002 is no longer allowed to use the bot
        access: {
          isAllowed: (id: unknown) => id !== 76_002,
          isConfigured: true,
          noteRejection: () => ({ shouldLog: false, shouldReply: false }),
        } as unknown as AccessService,
      },
    );
    queues = t.app.get(QueueService);
    metrics = t.app.get(Metrics);
    users = t.app.get(UserService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await flushBackground(t);
    await t.prisma.$executeRawUnsafe('TRUNCATE "User","Alert" RESTART IDENTITY CASCADE');
    owner = 76_001;
    await users.upsertFromTelegram({ telegramId: owner, chatId: owner });
    await users.upsertFromTelegram({ telegramId: 76_002, chatId: 76_002 });
    resetCaches(t);
    metrics.reset();
    t.sent.length = 0;
    t.failNotifications.value = false;
    if (queues.enabled) {
      const q = queues.queue(QUEUES.notifications);
      await q.drain(true);
      for (const state of ['failed', 'completed'] as const) await q.clean(0, 10_000, state);
    }
  });

  describe('producer side (works with or without Redis)', () => {
    it('a malformed notice is dropped and counted, never sent or queued', async () => {
      const notifier = t.app.get(NotifierService);
      await notifier.notify(owner, '<script>alert(1)</script>');
      await notifier.notify(owner, '<b>unclosed');
      await notifier.notify(owner, 'x'.repeat(5000));
      await notifier.notify(-100123, GOOD); // a group id: owner notices are private
      await notifier.notify(1.5 as number, GOOD);
      expect(t.sent).toHaveLength(0);
      expect(metrics.total('notifications_rejected_total')).toBe(5);
    });

    it('a valid notice is still delivered (with or without queues)', async () => {
      const notifier = t.app.get(NotifierService);
      await notifier.notify(owner, GOOD, `aud02-valid-${Date.now()}`);
      if (queues.enabled) await drain();
      else await sleep(20);
      expect(t.sent.filter((m) => m.chatId === owner && m.text === GOOD)).toHaveLength(1);
    });

    it('every notice Indonesian Stock Bot itself produces (expiry, capped, undeliverable group) passes the validator', async () => {
      const alerts = t.app.get(AlertService);
      const u = (await users.upsertFromTelegram({ telegramId: 76_010, chatId: 76_010 })).id;
      const made = await alerts.create(u, 'TSTA', 'price', 'above', 99_999);
      await t.prisma.alert.update({
        where: { id: made.alert.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await alerts.checkAll();
      if (queues.enabled) await drain();
      else await sleep(20);
      expect(t.sent.filter((m) => /kedaluwarsa/.test(m.text))).toHaveLength(1);
      expect(metrics.total('notifications_rejected_total')).toBe(0);
    });
  });

  describe('consumer side (Redis mode)', () => {
    redisIt(
      'refuses every malformed or hostile payload exactly once and delivers nothing',
      async () => {
        const bad: Array<[string, object]> = [
          ['missing chatId', { html: GOOD }],
          ['string chatId', { chatId: String(owner), html: GOOD }],
          ['fractional chatId', { chatId: 76_001.5, html: GOOD }],
          ['negative chatId', { chatId: -100123, html: GOOD }],
          ['missing html', { chatId: owner }],
          ['numeric html', { chatId: owner, html: 12345 }],
          ['oversized html', { chatId: owner, html: 'A'.repeat(5 * 1024 * 1024) }],
          ['malformed html', { chatId: owner, html: '<b>unclosed' }],
          ['script', { chatId: owner, html: '<script>alert("TOPSECRET")</script>' }],
          ['img onerror', { chatId: owner, html: '<img src=x onerror=alert(1)>' }],
          [
            'phishing link (https)',
            { chatId: owner, html: '<a href="https://evil.example/login">verifikasi</a>' },
          ],
          ['javascript link', { chatId: owner, html: '<a href="javascript:alert(1)">x</a>' }],
          ['unexpected property', { chatId: owner, html: GOOD, parse_mode: 'MarkdownV2' }],
          ['extra recipients', { chatId: owner, html: GOOD, chatIds: [1, 2, 3] }],
          ['empty object', {}],
          ['unknown recipient', { chatId: 424_242, html: GOOD }],
          ['disallowed recipient', { chatId: 76_002, html: GOOD }],
        ];
        const warn = jest.spyOn(Logger.prototype, 'warn');
        const error = jest.spyOn(Logger.prototype, 'error');
        try {
          for (const [, data] of bad) await enqueue(data);
          const counts = await drain();
          await sleep(400); // longer than the backoff: a wrongly retried job would run again now
          expect(t.sent).toHaveLength(0); // NOTHING reached a recipient
          expect(counts.failed).toBe(bad.length);
          expect(metrics.total('notifications_rejected_total')).toBe(bad.length); // one attempt each, no retries
          // the hostile payload is not copied into logs
          const logged = [...warn.mock.calls, ...error.mock.calls]
            .map((c) => String(c[0]))
            .join('\n');
          expect(logged).not.toMatch(/TOPSECRET|onerror|javascript:|AAAAAAAA/);
          // and the 5 MB body no longer sits in Redis
          const failed = await failedJobs();
          expect(failed).toHaveLength(bad.length);
          for (const j of failed) {
            expect(JSON.stringify(j.data).length).toBeLessThan(2000);
            expect(j.attemptsMade).toBe(1);
          }
        } finally {
          warn.mockRestore();
          error.mockRestore();
        }
      },
      90_000,
    );

    redisIt(
      'a poison job does not block the valid ones before and after it',
      async () => {
        await enqueue({ chatId: owner, html: `${GOOD} 1` });
        await enqueue({ chatId: owner, html: '<script>x</script>' });
        await enqueue({ chatId: 999_999_999, html: GOOD });
        await enqueue({ chatId: owner, html: `${GOOD} 2` });
        await drain();
        expect(t.sent.map((m) => m.text).sort()).toEqual([`${GOOD} 1`, `${GOOD} 2`]);
        expect(t.sent.every((m) => m.chatId === owner)).toBe(true);
      },
      60_000,
    );

    redisIt(
      'de-duplicates: the same job id delivers once, also after a failure of an earlier different job',
      async () => {
        const id = `aud02-dedupe-${Date.now()}`;
        for (let i = 0; i < 4; i++) await enqueue({ chatId: owner, html: GOOD }, id);
        await drain();
        expect(t.sent).toHaveLength(1);
      },
      30_000,
    );

    redisIt(
      'a rejected job is not retried even though the queue allows 5 attempts',
      async () => {
        await enqueue({ chatId: owner, html: '<b onclick="x()">x</b>' });
        await drain();
        await sleep(600);
        const [job] = await failedJobs();
        expect(job.attemptsMade).toBe(1);
        expect(
          metrics.counter('queue_jobs_total', { queue: 'notifications', outcome: 'failed' }),
        ).toBe(1);
        expect(
          metrics.counter('queue_jobs_total', { queue: 'notifications', outcome: 'retried' }),
        ).toBe(0);
      },
      30_000,
    );

    redisIt(
      'a legitimate delivery failure is still retried (the validation did not break retries)',
      async () => {
        t.failNotifications.value = true;
        await enqueue({ chatId: owner, html: GOOD });
        await sleep(250);
        t.failNotifications.value = false;
        await drain(20_000);
        expect(t.sent.filter((m) => m.text === GOOD).length).toBe(1);
      },
      60_000,
    );

    redisIt(
      'worker restart: jobs written while no worker runs (poison and valid) are handled when the worker comes back',
      async () => {
        // stop the notification worker (as a crashed or redeployed process would)
        const internals = queues as unknown as { workers: Map<string, { close(): Promise<void> }> };
        await internals.workers.get(QUEUES.notifications)?.close();
        internals.workers.delete(QUEUES.notifications);
        await enqueue({ chatId: owner, html: '<iframe src="https://x"></iframe>' });
        await enqueue({ chatId: 31_337, html: GOOD });
        await enqueue({ chatId: owner, html: `${GOOD} (after restart)` });
        await sleep(300);
        expect(t.sent).toHaveLength(0); // nobody is consuming
        expect((await queues.counts(QUEUES.notifications)).waiting).toBe(3);
        t.app.get(NotifierService).onModuleInit(); // the worker starts again
        await drain();
        expect(t.sent.map((m) => m.text)).toEqual([`${GOOD} (after restart)`]);
        expect(metrics.total('notifications_rejected_total')).toBe(2);
      },
      90_000,
    );
  });
});
