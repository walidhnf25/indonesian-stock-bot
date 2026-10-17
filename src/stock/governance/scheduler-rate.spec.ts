import { ProviderScheduler } from './provider-scheduler';

/**
 * The provider start rate is capped GLOBALLY by `minIntervalMs`, whatever the number of workers or callers: with the
 * production 150 ms that is at most 400 provider calls a minute. (The 2026-10-07 audit estimated ~1 181/min from a
 * test that divided by the wrong window; this test pins the real, structural bound.)
 */
describe('ProviderScheduler start rate', () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('never starts two calls closer than minIntervalMs, however many workers and callers there are', async () => {
    const s = new ProviderScheduler({
      concurrency: 5,
      minIntervalMs: 100,
      queuePerUser: 50,
      queueGlobal: 500,
      queueWaitMs: 20_000,
      taskTimeoutMs: 5_000,
    });
    const starts: number[] = [];
    const work = Array.from({ length: 24 }, (_, i) =>
      s.run(`tg:${i % 6}`, async () => {
        starts.push(Date.now());
        await delay(5);
      }),
    );
    await Promise.all(work);
    s.close();
    const sorted = [...starts].sort((a, b) => a - b);
    const gaps = sorted.slice(1).map((t, i) => t - sorted[i]);
    // timer jitter allowance of 15 ms below the configured interval
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(85);
    // 24 starts need at least 23 intervals: the rate is bounded by 60 000 / minIntervalMs per minute
    expect(sorted[sorted.length - 1] - sorted[0]).toBeGreaterThanOrEqual(23 * 85);
  }, 20_000);
});

/**
 * system jobs and users have separate waiting-room bounds. Neither class can take the other's slots, and the
 * system bound is global to the class (several system jobs together cannot grow it without limit).
 */
describe('ProviderScheduler queue classes', () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const make = (over: Partial<ConstructorParameters<typeof ProviderScheduler>[0]> = {}) =>
    new ProviderScheduler({
      concurrency: 1,
      minIntervalMs: 0,
      queuePerUser: 10,
      queueGlobal: 4,
      queueSystem: 3,
      queueWaitMs: 5000,
      taskTimeoutMs: 5000,
      isPrivileged: (k) => k.startsWith('system:'),
      ...over,
    });

  it("waiting system jobs do not use up the users' waiting room", async () => {
    const s = make();
    const hold = s.run('tg:holder', () => delay(60));
    const sys = ['system:a', 'system:b', 'system:c'].map((k) => s.run(k, async () => 'sys'));
    const users = Array.from({ length: 4 }, (_, i) => s.run(`tg:${i}`, async () => 'user'));
    const overflow = await s.run('tg:overflow', async () => 'user').catch((e: Error) => e);
    expect(overflow).toBeInstanceOf(Error); // the user room (4) is full...
    const results = await Promise.all([hold, ...sys, ...users]);
    expect(results.slice(1, 4)).toEqual(['sys', 'sys', 'sys']); // ...but all 3 system jobs AND all 4 users were queued
    expect(results.slice(4)).toEqual(['user', 'user', 'user', 'user']);
    s.close();
  });

  it('the system waiting room is bounded for the class as a whole, not only per system caller', async () => {
    const s = make({ queueSystem: 3 });
    const hold = s.run('system:holder', () => delay(60));
    const ok = ['system:a', 'system:b', 'system:c'].map((k) => s.run(k, async () => 'sys'));
    const over = await s.run('system:d', async () => 'sys').catch((e: Error) => e);
    expect(over).toBeInstanceOf(Error); // 4th distinct system caller: the class bound (3) is spent
    await Promise.all([hold, ...ok]);
    s.close();
  });
});
