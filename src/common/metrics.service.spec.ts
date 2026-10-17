import { LATENCY_BUCKETS_MS, Metrics } from './metrics.service';

describe('Metrics histograms', () => {
  it('buckets observations cumulatively, keeps sum and count, and exposes Prometheus lines', () => {
    const m = new Metrics();
    m.observe('chat_latency_ms', 3, { intent: 'STOCK_QUOTE' });
    m.observe('chat_latency_ms', 40, { intent: 'STOCK_QUOTE' });
    m.observe('chat_latency_ms', 999_999, { intent: 'STOCK_QUOTE' });
    m.observe('chat_latency_ms', Number.NaN, { intent: 'STOCK_QUOTE' }); // ignored
    const h = m.histogram('chat_latency_ms', { intent: 'STOCK_QUOTE' })!;
    expect(h.count).toBe(3);
    expect(h.sum).toBe(1_000_042);
    expect(h.buckets[0]).toEqual({ le: 5, count: 1 });
    expect(h.buckets.find((b) => b.le === 50)!.count).toBe(2);
    expect(h.buckets[h.buckets.length - 1]).toEqual({ le: Number.POSITIVE_INFINITY, count: 3 });
    const text = m.toPrometheus();
    expect(text).toContain('chat_latency_ms_bucket{intent="STOCK_QUOTE",le="5"} 1');
    expect(text).toContain('chat_latency_ms_bucket{intent="STOCK_QUOTE",le="+Inf"} 3');
    expect(text).toContain('chat_latency_ms_sum{intent="STOCK_QUOTE"} 1000042');
    expect(text).toContain('chat_latency_ms_count{intent="STOCK_QUOTE"} 3');
    expect(LATENCY_BUCKETS_MS[0]).toBe(5);
  });

  it('time() records the duration whether the operation succeeds or throws', async () => {
    const m = new Metrics();
    await m.time('op_ms', { kind: 'a' }, async () => 1);
    await expect(
      m.time('op_ms', { kind: 'a' }, async () => Promise.reject(new Error('x'))),
    ).rejects.toThrow('x');
    expect(m.histogram('op_ms', { kind: 'a' })!.count).toBe(2);
    expect(m.histogram('op_ms', { kind: 'none' })).toBeNull();
  });

  it('label values are sanitised so a stray character cannot break the exposition format', () => {
    const m = new Metrics();
    m.inc('x_total', { reason: 'bad "value"\n' });
    expect(m.toPrometheus()).toContain('x_total{reason="bad__value__"} 1');
  });

  it('reset clears histograms too', () => {
    const m = new Metrics();
    m.observe('a_ms', 1);
    m.reset();
    expect(m.histogram('a_ms')).toBeNull();
  });
});
