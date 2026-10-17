import { FairGate, GateFullError, GateTimeoutError, GateUserLimitError } from './utils/fair-gate';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const gate = (o: Partial<ConstructorParameters<typeof FairGate>[0]> = {}) =>
  new FairGate({ permits: 2, perUser: 1, maxQueue: 20, maxQueuePerUser: 20, ...o });

/** Runs `job` as `user`: waits for a slot, holds it for `ms`, records start/finish order. */
function job(
  g: FairGate,
  log: string[],
  user: string,
  name: string,
  ms = 20,
  opts: { timeoutMs?: number; fail?: boolean } = {},
) {
  return g.acquire(user, { timeoutMs: opts.timeoutMs }).then(async (release) => {
    log.push(`start:${name}`);
    try {
      await sleep(ms);
      if (opts.fail) throw new Error('boom');
    } finally {
      release();
      log.push(`end:${name}`);
    }
  });
}

describe('FairGate', () => {
  it('preserves the GLOBAL limit', async () => {
    const g = gate({ permits: 2, perUser: 2 });
    let active = 0;
    let max = 0;
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map(async (u) => {
        const r = await g.acquire(u);
        active++;
        max = Math.max(max, active);
        await sleep(15);
        active--;
        r();
      }),
    );
    expect(max).toBe(2);
    expect(g.inUse).toBe(0);
    expect(g.waiting).toBe(0);
  });

  it('enforces the PER-USER limit: one user never holds more than its share', async () => {
    const g = gate({ permits: 3, perUser: 1 });
    let active = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        const r = await g.acquire('same');
        active++;
        max = Math.max(max, active);
        await sleep(10);
        active--;
        r();
      }),
    );
    expect(max).toBe(1);
  });

  it("A1..A5 + B1 + C1: B and C are NOT stuck behind A's queue (global 2, per-user 1)", async () => {
    const g = gate({ permits: 2, perUser: 1 });
    const log: string[] = [];
    const jobs = [
      job(g, log, 'A', 'A1', 60),
      job(g, log, 'A', 'A2', 60),
      job(g, log, 'A', 'A3', 60),
      job(g, log, 'A', 'A4', 60),
      job(g, log, 'A', 'A5', 60),
    ];
    await sleep(5);
    jobs.push(job(g, log, 'B', 'B1', 60), job(g, log, 'C', 'C1', 60));
    await Promise.all(jobs);

    const started = log.filter((l) => l.startsWith('start:')).map((l) => l.slice(6));
    // B starts immediately (second free slot); C starts as soon as one slot frees up, before A2.
    expect(started.indexOf('B1')).toBeLessThanOrEqual(1);
    expect(started.indexOf('C1')).toBeLessThan(started.indexOf('A2'));
    expect(started.indexOf('C1')).toBeLessThan(started.indexOf('A5'));
    expect(started).toHaveLength(7);
  });

  it('serves waiting users in round-robin order, not first-come-first-served', async () => {
    const g = gate({ permits: 1, perUser: 1 });
    const log: string[] = [];
    const first = job(g, log, 'A', 'A1', 40);
    await sleep(5);
    const rest = [
      job(g, log, 'A', 'A2', 10),
      job(g, log, 'A', 'A3', 10),
      job(g, log, 'B', 'B1', 10),
      job(g, log, 'C', 'C1', 10),
    ];
    await Promise.all([first, ...rest]);
    const started = log.filter((l) => l.startsWith('start:')).map((l) => l.slice(6));
    expect(started[0]).toBe('A1');
    // after A1, the users that have waited without being served (B, C) go before A's second item
    expect(started.indexOf('B1')).toBeLessThan(started.indexOf('A3'));
    expect(started.indexOf('C1')).toBeLessThan(started.indexOf('A3'));
  });

  it('bounds how many requests one user can queue, and the total queue', async () => {
    const g = gate({ permits: 1, perUser: 1, maxQueue: 3, maxQueuePerUser: 1 });
    const hold = await g.acquire('A'); // A runs
    const w1 = g.acquire('A'); // A waits (its 1 allowed)
    await expect(g.acquire('A')).rejects.toBeInstanceOf(GateUserLimitError);
    const w2 = g.acquire('B');
    const w3 = g.acquire('C');
    await expect(g.acquire('D')).rejects.toBeInstanceOf(GateFullError); // total queue = 3
    hold();
    // Service order is by fairness, not arrival: release each as it is granted (never wait in a fixed order).
    await Promise.all([w1, w2, w3].map(async (w) => (await w)()));
    expect(g.inUse).toBe(0);
    expect(g.waiting).toBe(0);
  });

  it('a request that times out in the queue is removed and does not block others', async () => {
    const g = gate({ permits: 1, perUser: 1 });
    const hold = await g.acquire('A');
    const timedOut = g.acquire('B', { timeoutMs: 30 });
    await expect(timedOut).rejects.toBeInstanceOf(GateTimeoutError);
    expect(g.waiting).toBe(0);
    const next = g.acquire('C');
    hold();
    (await next)();
    expect(g.inUse).toBe(0);
  });

  it('release is idempotent and counters never go negative or leak (double release, release after failure)', async () => {
    const g = gate({ permits: 2, perUser: 2 });
    const r1 = await g.acquire('A');
    r1();
    r1();
    r1();
    expect(g.inUse).toBe(0);
    expect(g.runningFor('A')).toBe(0);
    // capacity is exactly 2 afterwards, not 3 or more
    const a = g.tryAcquire('A');
    const b = g.tryAcquire('B');
    const c = g.tryAcquire('C');
    expect([a, b, c].filter(Boolean)).toHaveLength(2);
    a?.();
    b?.();
  });

  it('a failing holder releases its slot (finally) and the next user proceeds', async () => {
    const g = gate({ permits: 1, perUser: 1 });
    const log: string[] = [];
    const failing = job(g, log, 'A', 'A1', 5, { fail: true }).catch(() => undefined);
    const next = job(g, log, 'B', 'B1', 5);
    await Promise.all([failing, next]);
    expect(log).toEqual(['start:A1', 'end:A1', 'start:B1', 'end:B1']);
    expect(g.inUse).toBe(0);
  });

  it('tryAcquire never queues and respects both limits', async () => {
    const g = gate({ permits: 2, perUser: 1 });
    const a = g.tryAcquire('A');
    expect(a).not.toBeNull();
    expect(g.tryAcquire('A')).toBeNull(); // per-user
    const b = g.tryAcquire('B');
    expect(b).not.toBeNull();
    expect(g.tryAcquire('C')).toBeNull(); // global
    expect(g.waiting).toBe(0);
    a?.();
    expect(g.tryAcquire('C')).not.toBeNull();
    b?.();
  });

  it('random stress: invariants hold, everyone finishes, nothing leaks, no deadlock', async () => {
    const permits = 3;
    const perUser = 2;
    const g = new FairGate({ permits, perUser, maxQueue: 12, maxQueuePerUser: 4 });
    let active = 0;
    const perUserActive = new Map<string, number>();
    let violations = 0;
    let served = 0;
    let rejected = 0;
    let timedOut = 0;
    await Promise.all(
      Array.from({ length: 300 }, async (_, i) => {
        await sleep(Math.floor(Math.random() * 200));
        const user = `u${i % 7}`;
        try {
          const release = await g.acquire(user, { timeoutMs: 20 + Math.floor(Math.random() * 80) });
          active++;
          perUserActive.set(user, (perUserActive.get(user) ?? 0) + 1);
          if (active > permits || (perUserActive.get(user) ?? 0) > perUser) violations++;
          try {
            await sleep(Math.floor(Math.random() * 15));
            if (Math.random() < 0.2) throw new Error('holder failure');
          } catch {
            /* the job failed; the slot must still be released */
          } finally {
            active--;
            perUserActive.set(user, (perUserActive.get(user) ?? 1) - 1);
            release();
            if (Math.random() < 0.3) release(); // accidental double release
          }
          served++;
        } catch (e) {
          if (e instanceof GateTimeoutError) timedOut++;
          else rejected++;
        }
      }),
    );
    await sleep(50);
    expect(violations).toBe(0);
    expect(served + rejected + timedOut).toBe(300);
    expect(served).toBeGreaterThan(0);
    expect(g.inUse).toBe(0);
    expect(g.waiting).toBe(0);
    // full capacity is available again, and not more than configured
    const held = Array.from({ length: permits * 2 }, (_, i) => g.tryAcquire(`x${i}`)).filter(
      Boolean,
    );
    expect(held).toHaveLength(permits);
    held.forEach((r) => r?.());
  });
});
