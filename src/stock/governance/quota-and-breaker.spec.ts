import { CircuitBreaker } from './circuit-breaker';
import { InMemoryQuotaStore } from './quota-store';
import { Metrics } from '../../common/metrics.service';

describe('InMemoryQuotaStore', () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('allows up to the limit inside the window and then denies with a retry hint', async () => {
    const c = clock();
    const q = new InMemoryQuotaStore(c.now);
    for (let i = 0; i < 3; i++) {
      expect((await q.consume('user', 'a', 3, 60_000)).allowed).toBe(true);
      c.advance(2000);
    }
    const denied = await q.consume('user', 'a', 3, 60_000);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(50);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('frees units as the window slides', async () => {
    const c = clock();
    const q = new InMemoryQuotaStore(c.now);
    await q.consume('user', 'a', 2, 60_000);
    c.advance(30_000);
    await q.consume('user', 'a', 2, 60_000);
    expect((await q.consume('user', 'a', 2, 60_000)).allowed).toBe(false);
    c.advance(31_000); // the first unit is now older than the window
    expect((await q.consume('user', 'a', 2, 60_000)).allowed).toBe(true);
  });

  it('keys and scopes are independent', async () => {
    const q = new InMemoryQuotaStore();
    expect((await q.consume('user', 'a', 1, 60_000)).allowed).toBe(true);
    expect((await q.consume('user', 'a', 1, 60_000)).allowed).toBe(false);
    expect((await q.consume('user', 'b', 1, 60_000)).allowed).toBe(true);
    expect((await q.consume('global', 'a', 1, 60_000)).allowed).toBe(true);
  });

  it('a denied request does not consume anything', async () => {
    const c = clock();
    const q = new InMemoryQuotaStore(c.now);
    await q.consume('user', 'a', 1, 60_000);
    for (let i = 0; i < 50; i++) await q.consume('user', 'a', 1, 60_000);
    c.advance(61_000);
    expect((await q.consume('user', 'a', 1, 60_000)).allowed).toBe(true);
  });

  it('honours a cost greater than one', async () => {
    const q = new InMemoryQuotaStore();
    expect((await q.consume('g', 'k', 5, 60_000, 3)).allowed).toBe(true);
    expect((await q.consume('g', 'k', 5, 60_000, 3)).allowed).toBe(false);
    expect((await q.consume('g', 'k', 5, 60_000, 2)).allowed).toBe(true);
  });

  it('keeps memory bounded: many keys and many hits', async () => {
    const q = new InMemoryQuotaStore(Date.now, 100);
    for (let i = 0; i < 1000; i++) await q.consume('user', `k${i}`, 5, 60_000);
    // the oldest keys were forgotten (they get a fresh window), recent ones are still counted
    for (let i = 0; i < 5; i++) await q.consume('user', 'recent', 5, 60_000);
    expect((await q.consume('user', 'recent', 5, 60_000)).allowed).toBe(false);
  });

  it('reset() forgets everything', async () => {
    const q = new InMemoryQuotaStore();
    await q.consume('user', 'a', 1, 60_000);
    q.reset();
    expect((await q.consume('user', 'a', 1, 60_000)).allowed).toBe(true);
  });
});

describe('CircuitBreaker', () => {
  const make = () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 }, () => t);
    return { b, advance: (ms: number) => (t += ms) };
  };

  it('stays closed below the failure threshold and a success resets the count', () => {
    const { b } = make();
    b.onFailure();
    b.onFailure();
    b.onSuccess();
    b.onFailure();
    b.onFailure();
    expect(b.state).toBe('CLOSED');
    expect(b.allow()).toBe(true);
  });

  it('opens after consecutive failures and refuses calls during the cooldown', () => {
    const { b } = make();
    for (let i = 0; i < 3; i++) b.onFailure();
    expect(b.state).toBe('OPEN');
    expect(b.blocked()).toBe(true);
    expect(b.allow()).toBe(false);
  });

  it('after the cooldown allows exactly one probe; success closes it', () => {
    const { b, advance } = make();
    for (let i = 0; i < 3; i++) b.onFailure();
    advance(1000);
    expect(b.blocked()).toBe(false);
    expect(b.allow()).toBe(true); // the probe
    expect(b.state).toBe('HALF_OPEN');
    expect(b.allow()).toBe(false); // nobody else while the probe runs
    b.onSuccess();
    expect(b.state).toBe('CLOSED');
    expect(b.allow()).toBe(true);
  });

  it('a failed probe re-opens the breaker for another full cooldown', () => {
    const { b, advance } = make();
    for (let i = 0; i < 3; i++) b.onFailure();
    advance(1000);
    expect(b.allow()).toBe(true);
    b.onFailure();
    expect(b.state).toBe('OPEN');
    advance(500);
    expect(b.allow()).toBe(false);
    advance(500);
    expect(b.allow()).toBe(true);
  });
});

describe('Metrics', () => {
  it('counts, sums over labels, exposes gauges and Prometheus text', () => {
    const m = new Metrics();
    m.inc('provider_throttled_total', { reason: 'user_quota' });
    m.inc('provider_throttled_total', { reason: 'user_quota' });
    m.inc('provider_throttled_total', { reason: 'global_budget' });
    m.setGauge('provider_queue_depth', 4);
    expect(m.counter('provider_throttled_total', { reason: 'user_quota' })).toBe(2);
    expect(m.total('provider_throttled_total')).toBe(3);
    expect(m.gauge('provider_queue_depth')).toBe(4);
    const text = m.toPrometheus();
    expect(text).toContain('provider_throttled_total{reason="user_quota"} 2');
    expect(text).toContain('provider_queue_depth 4');
  });

  it('sanitises label values so they cannot inject text', () => {
    const m = new Metrics();
    m.inc('x', { reason: 'a"b\nc' });
    expect(m.toPrometheus()).not.toMatch(/\n[^x]/);
    expect(m.toPrometheus()).toContain('x{reason="a_b_c"} 1');
  });
});
