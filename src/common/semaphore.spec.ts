import { Semaphore, SemaphoreFullError, SemaphoreTimeoutError } from './utils/semaphore';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Semaphore', () => {
  it('limits concurrency to the number of permits and serves waiters FIFO', async () => {
    const s = new Semaphore(2);
    let active = 0;
    let max = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map(async (n) => {
        const release = await s.acquire();
        order.push(n);
        active++;
        max = Math.max(max, active);
        await sleep(15);
        active--;
        release();
      }),
    );
    expect(max).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects with SemaphoreFullError when the wait queue is full', async () => {
    const s = new Semaphore(1, 1);
    const r1 = await s.acquire(); // running
    const waiting = s.acquire(); // queued (1/1)
    await expect(s.acquire()).rejects.toBeInstanceOf(SemaphoreFullError);
    expect(s.waiting).toBe(1);
    r1();
    const r2 = await waiting;
    r2();
  });

  it('times out waiters, removes them from the queue and does not leak a slot', async () => {
    const s = new Semaphore(1, 5);
    const r1 = await s.acquire();
    await expect(s.acquire({ timeoutMs: 30 })).rejects.toBeInstanceOf(SemaphoreTimeoutError);
    expect(s.waiting).toBe(0);
    r1();
    // The slot is genuinely free again.
    const r2 = s.tryAcquire();
    expect(r2).not.toBeNull();
    r2?.();
  });

  it('tryAcquire never queues', async () => {
    const s = new Semaphore(1);
    const r = s.tryAcquire();
    expect(r).not.toBeNull();
    expect(s.tryAcquire()).toBeNull();
    expect(s.waiting).toBe(0);
    r?.();
    expect(s.hasFreeSlot).toBe(true);
  });

  it('release is idempotent (a double release cannot create a phantom slot)', async () => {
    const s = new Semaphore(1);
    const release = await s.acquire();
    release();
    release();
    const a = s.tryAcquire();
    expect(a).not.toBeNull();
    expect(s.tryAcquire()).toBeNull();
    a?.();
  });

  it('hands a freed slot straight to the next waiter (no race with tryAcquire)', async () => {
    const s = new Semaphore(1, 5);
    const r1 = await s.acquire();
    const waiter = s.acquire();
    r1();
    expect(s.tryAcquire()).toBeNull(); // the slot already belongs to the waiter
    (await waiter)();
  });
});
