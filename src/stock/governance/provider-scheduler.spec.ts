import {
  ProviderBusyError,
  ProviderScheduler,
  ProviderSchedulerOptions,
  ProviderTimeoutError,
} from './provider-scheduler';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const base: ProviderSchedulerOptions = {
  concurrency: 1,
  minIntervalMs: 0,
  queuePerUser: 5,
  queueGlobal: 50,
  queueWaitMs: 5000,
  taskTimeoutMs: 5000,
};

/** A task that records when it started and runs for `ms`. */
function recorder() {
  const started: string[] = [];
  const task =
    (label: string, ms = 20) =>
    async () => {
      started.push(label);
      await delay(ms);
      return label;
    };
  return { started, task };
}

describe('ProviderScheduler', () => {
  describe('fairness', () => {
    it('serves callers round-robin: a caller with a backlog does not make another wait for all of it', async () => {
      const s = new ProviderScheduler({ ...base, queuePerUser: 10 });
      const { started, task } = recorder();
      const a = Array.from({ length: 6 }, (_, i) => s.run('A', task(`A${i}`)));
      // run() queues synchronously: A0 is running and A1..A5 are queued by now, no waiting needed
      const b = s.run('B', task('B0'));
      await Promise.all([...a, b]);
      // B queued after A1..A5 but is served right after the call that was already running
      expect(started.indexOf('B0')).toBeLessThanOrEqual(2);
      expect(started.slice(0, 3)).toEqual(['A0', 'A1', 'B0']);
    });

    it('three callers interleave one call each per turn', async () => {
      const s = new ProviderScheduler({ ...base, queuePerUser: 10 });
      const { started, task } = recorder();
      const jobs = [
        ...['A0', 'A1', 'A2'].map((l) => s.run('A', task(l, 5))),
        ...['B0', 'B1', 'B2'].map((l) => s.run('B', task(l, 5))),
        ...['C0', 'C1', 'C2'].map((l) => s.run('C', task(l, 5))),
      ];
      await Promise.all(jobs);
      // A0 starts at once on the idle scheduler; from then on the callers take turns
      expect(started).toEqual(['A0', 'A1', 'B0', 'C0', 'A2', 'B1', 'C1', 'B2', 'C2']);
    });

    it('one caller cannot starve another however many calls it sends', async () => {
      const s = new ProviderScheduler({ ...base, queuePerUser: 5, queueGlobal: 100 });
      const { started, task } = recorder();
      const flood = Array.from({ length: 60 }, (_, i) =>
        s.run('flooder', task(`F${i}`, 10)).catch(() => 'rejected'),
      );
      const victim = s.run('victim', task('V0', 10));
      await victim;
      expect(started.indexOf('V0')).toBeLessThanOrEqual(2);
      await Promise.all(flood);
    });
  });

  describe('bounded queues (backpressure)', () => {
    it('rejects a caller beyond its own queue, at once, and keeps serving the accepted ones', async () => {
      const s = new ProviderScheduler({ ...base, queuePerUser: 2 });
      const { task } = recorder();
      const running = s.run('A', task('A0', 50)); // starts immediately
      const q1 = s.run('A', task('A1'));
      const q2 = s.run('A', task('A2'));
      await expect(s.run('A', task('A3'))).rejects.toMatchObject({ reason: 'user_queue_full' });
      await expect(Promise.all([running, q1, q2])).resolves.toEqual(['A0', 'A1', 'A2']);
    });

    it('rejects beyond the global bound even for a caller with room', async () => {
      const s = new ProviderScheduler({ ...base, queuePerUser: 5, queueGlobal: 3 });
      const { task } = recorder();
      const running = s.run('A', task('A0', 50));
      const queued = ['B', 'C', 'D'].map((u) => s.run(u, task(`${u}0`)));
      await expect(s.run('E', task('E0'))).rejects.toMatchObject({ reason: 'global_queue_full' });
      await Promise.all([running, ...queued]);
    });

    it('the queue never grows past its bounds under a flood', async () => {
      const s = new ProviderScheduler({ ...base, queuePerUser: 4, queueGlobal: 10 });
      const { task } = recorder();
      let peak = 0;
      const jobs = Array.from({ length: 500 }, (_, i) =>
        s.run(`u${i % 7}`, task(`x${i}`, 1)).catch(() => 'rejected'),
      );
      peak = Math.max(peak, s.stats.queued);
      await Promise.all(jobs);
      expect(peak).toBeLessThanOrEqual(10);
      expect(s.stats).toEqual({ active: 0, queued: 0, callersWaiting: 0 });
    });

    it('a privileged caller (background job) may queue up to the global bound', async () => {
      const s = new ProviderScheduler({
        ...base,
        queuePerUser: 1,
        queueGlobal: 20,
        isPrivileged: (k) => k.startsWith('system:'),
      });
      const { task } = recorder();
      const first = s.run('system:alerts', task('S0', 30));
      const rest = Array.from({ length: 10 }, (_, i) =>
        s.run('system:alerts', task(`S${i + 1}`, 1)),
      );
      await expect(Promise.all([first, ...rest])).resolves.toHaveLength(11);
      const u0 = s.run('user', task('U0', 30));
      const u1 = s.run('user', task('U1', 1));
      await expect(s.run('user', task('U2', 1))).rejects.toMatchObject({
        reason: 'user_queue_full',
      });
      await Promise.all([u0, u1]);
    });
  });

  describe('slots are always released', () => {
    it('a task that throws releases its slot', async () => {
      const s = new ProviderScheduler(base);
      await expect(
        s.run('A', async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      await expect(s.run('A', async () => 'next')).resolves.toBe('next');
      expect(s.stats.active).toBe(0);
    });

    it('a task that throws synchronously releases its slot', async () => {
      const s = new ProviderScheduler(base);
      await expect(
        s.run('A', (() => {
          throw new Error('sync boom');
        }) as () => Promise<string>),
      ).rejects.toThrow('sync boom');
      await expect(s.run('A', async () => 'next')).resolves.toBe('next');
    });

    it('a task that never settles is released by the timeout, and the next call proceeds', async () => {
      const s = new ProviderScheduler({ ...base, taskTimeoutMs: 40 });
      const hung = s.run('A', () => new Promise<string>(() => undefined));
      const next = s.run('B', async () => 'served');
      await expect(hung).rejects.toBeInstanceOf(ProviderTimeoutError);
      await expect(next).resolves.toBe('served');
      expect(s.stats.active).toBe(0);
    });

    it('a late result of a timed-out task changes nothing (no double release)', async () => {
      const s = new ProviderScheduler({ ...base, concurrency: 1, taskTimeoutMs: 20 });
      const slow = s.run('A', async () => {
        await delay(60);
        return 'late';
      });
      await expect(slow).rejects.toBeInstanceOf(ProviderTimeoutError);
      await delay(80); // the slow task finishes now
      expect(s.stats.active).toBe(0);
      const a = s.run('A', async () => delay(5).then(() => 'a'));
      const b = s.run('B', async () => 'b');
      await Promise.all([a, b]);
      expect(s.stats.active).toBe(0);
    });

    it('a call that waits too long in the queue is rejected and leaves the queue', async () => {
      const s = new ProviderScheduler({ ...base, queueWaitMs: 30 });
      const blocker = s.run('A', () => delay(120).then(() => 'a'));
      const waiter = s.run('B', async () => 'b');
      await expect(waiter).rejects.toMatchObject({ reason: 'queue_timeout' });
      expect(s.stats.queued).toBe(0);
      await blocker;
    });

    it('an aborted waiting call leaves the queue; an aborted running call releases its slot', async () => {
      const s = new ProviderScheduler(base);
      const running = new AbortController();
      const r = s.run('A', () => new Promise<string>(() => undefined), running.signal);
      const waiting = new AbortController();
      const w = s.run('B', async () => 'b', waiting.signal);
      waiting.abort();
      await expect(w).rejects.toMatchObject({ reason: 'aborted' });
      expect(s.stats.queued).toBe(0);
      running.abort();
      await expect(r).rejects.toMatchObject({ reason: 'aborted' });
      expect(s.stats.active).toBe(0);
      await expect(s.run('C', async () => 'c')).resolves.toBe('c');
    });

    it('an already aborted signal is rejected without queueing', async () => {
      const s = new ProviderScheduler(base);
      const c = new AbortController();
      c.abort();
      await expect(s.run('A', async () => 'x', c.signal)).rejects.toBeInstanceOf(ProviderBusyError);
      expect(s.stats.queued).toBe(0);
    });
  });

  describe('concurrency and pacing', () => {
    it('never runs more than `concurrency` calls at once', async () => {
      const s = new ProviderScheduler({
        ...base,
        concurrency: 3,
        queuePerUser: 50,
        queueGlobal: 100,
      });
      let running = 0;
      let peak = 0;
      const jobs = Array.from({ length: 20 }, (_, i) =>
        s.run(`u${i % 4}`, async () => {
          running++;
          peak = Math.max(peak, running);
          await delay(10);
          running--;
        }),
      );
      await Promise.all(jobs);
      expect(peak).toBe(3);
    });

    it('keeps at least minIntervalMs between two starts', async () => {
      const s = new ProviderScheduler({ ...base, concurrency: 5, minIntervalMs: 40 });
      const starts: number[] = [];
      await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          s.run(`u${i}`, async () => {
            starts.push(Date.now());
          }),
        ),
      );
      for (let i = 1; i < starts.length; i++)
        expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(35);
    });
  });

  it('close() rejects everything waiting and refuses new work', async () => {
    const s = new ProviderScheduler(base);
    const running = s.run('A', () => delay(30).then(() => 'a'));
    const waiting = s.run('B', async () => 'b');
    s.close();
    await expect(waiting).rejects.toMatchObject({ reason: 'aborted' });
    await expect(s.run('C', async () => 'c')).rejects.toMatchObject({ reason: 'aborted' });
    await running;
  });

  it('reports its numbers through onChange', async () => {
    const seen: number[] = [];
    const s = new ProviderScheduler({ ...base, onChange: (st) => seen.push(st.queued) });
    const a = s.run('A', () => delay(20).then(() => 1));
    const b = s.run('B', async () => 2);
    await Promise.all([a, b]);
    expect(Math.max(...seen)).toBe(1);
    expect(seen[seen.length - 1]).toBe(0);
  });
});

describe('scheduler: system callers are served first and keep their own queue slots', () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const make = (over: Partial<ConstructorParameters<typeof ProviderScheduler>[0]> = {}) =>
    new ProviderScheduler({
      concurrency: 1,
      minIntervalMs: 0,
      queuePerUser: 5,
      queueGlobal: 10,
      queueSystem: 3,
      queueWaitMs: 5000,
      taskTimeoutMs: 5000,
      isPrivileged: (k) => k.startsWith('system:'),
      ...over,
    });

  it('a system caller that arrives behind a crowd of users is started before every waiting user', async () => {
    const s = make();
    const order: string[] = [];
    const hold = s.run('tg:holder', async () => {
      await delay(30);
    });
    const crowd = Array.from({ length: 8 }, (_, i) =>
      s.run(`tg:${i}`, async () => {
        order.push(`u${i}`);
      }),
    );
    const sys = s.run('system:alerts', async () => {
      order.push('system');
    });
    await Promise.all([hold, ...crowd, sys]);
    expect(order[0]).toBe('system');
    s.close();
  });

  it('users filling the whole user queue cannot make the system caller wait for a slot or be rejected', async () => {
    const s = make({ queueGlobal: 4, queuePerUser: 4 });
    const hold = s.run('tg:holder', () => delay(40));
    const users = Array.from({ length: 4 }, (_, i) => s.run(`tg:${i}`, async () => i));
    const overflow = await s.run('tg:overflow', async () => 1).catch((e: Error) => e);
    expect(overflow).toBeInstanceOf(ProviderBusyError); // the user queue is full for users...
    const sys = await s.run('system:alerts', async () => 'served'); // ...but not for the system caller
    expect(sys).toBe('served');
    await Promise.all([hold, ...users]);
    s.close();
  });

  it('the system queue is bounded too (queueSystem), so a runaway job cannot grow it without limit', async () => {
    const s = make({ queueSystem: 2 });
    const hold = s.run('system:a', () => delay(40));
    const waiting = [s.run('system:a', async () => 1), s.run('system:a', async () => 2)];
    const over = await s.run('system:a', async () => 3).catch((e: Error) => e);
    expect(over).toBeInstanceOf(ProviderBusyError);
    await Promise.all([hold, ...waiting]);
    s.close();
  });

  it('users keep being served in round-robin order while the system caller is also active', async () => {
    const s = make();
    const order: string[] = [];
    const hold = s.run('tg:holder', () => delay(30));
    const work = [
      s.run('tg:a', async () => void order.push('a1')),
      s.run('tg:a', async () => void order.push('a2')),
      s.run('tg:b', async () => void order.push('b1')),
      s.run('system:alerts', async () => void order.push('s')),
    ];
    await Promise.all([hold, ...work]);
    expect(order).toEqual(['s', 'a1', 'b1', 'a2']);
    s.close();
  });
});
