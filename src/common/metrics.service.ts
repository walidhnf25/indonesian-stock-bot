import { Injectable } from '@nestjs/common';

/**
 * Minimal in-process metrics registry: counters, gauges and histograms with fixed buckets.
 * It is a seam, not a monitoring product: the API is small enough to be backed by a real exporter later.
 * Label values must come from a small fixed set (outcomes, reasons, provider names, intent names) and
 * NEVER contain user ids, chat ids or message text: that would leak personal data and make cardinality
 * unbounded.
 */
export interface HistogramSnapshot {
  count: number;
  sum: number;
  /** Cumulative counts per upper bound, in bucket order (last = +Inf). */
  buckets: Array<{ le: number; count: number }>;
}

/** Latency buckets in milliseconds, from "cache hit" to "model timed out". */
export const LATENCY_BUCKETS_MS: readonly number[] = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000,
];

@Injectable()
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<
    string,
    { name: string; labels: Record<string, string>; counts: number[]; sum: number; count: number }
  >();

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    this.gauges.set(this.key(name, labels), value);
  }

  /** Records one observation (e.g. a latency in ms) into the fixed latency buckets. */
  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    if (!Number.isFinite(value)) return;
    const key = this.key(name, labels);
    let h = this.histograms.get(key);
    if (!h) {
      h = {
        name,
        labels,
        counts: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      this.histograms.set(key, h);
    }
    let i = LATENCY_BUCKETS_MS.findIndex((b) => value <= b);
    if (i < 0) i = LATENCY_BUCKETS_MS.length;
    h.counts[i]++;
    h.sum += value;
    h.count++;
  }

  /** Times an async operation into a histogram, whatever its outcome. */
  async time<T>(name: string, labels: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      this.observe(name, Date.now() - started, labels);
    }
  }

  counter(name: string, labels: Record<string, string> = {}): number {
    return this.counters.get(this.key(name, labels)) ?? 0;
  }

  gauge(name: string, labels: Record<string, string> = {}): number {
    return this.gauges.get(this.key(name, labels)) ?? 0;
  }

  histogram(name: string, labels: Record<string, string> = {}): HistogramSnapshot | null {
    const h = this.histograms.get(this.key(name, labels));
    if (!h) return null;
    let cumulative = 0;
    const buckets = [...LATENCY_BUCKETS_MS, Number.POSITIVE_INFINITY].map((le, i) => {
      cumulative += h.counts[i];
      return { le, count: cumulative };
    });
    return { count: h.count, sum: h.sum, buckets };
  }

  /** Sum of a counter over all label sets. */
  total(name: string): number {
    let sum = 0;
    for (const [k, v] of this.counters) if (k === name || k.startsWith(`${name}{`)) sum += v;
    return sum;
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  /** Prometheus text exposition format. */
  toPrometheus(): string {
    const lines: string[] = [];
    for (const [k, v] of [...this.counters].sort()) lines.push(`${k} ${v}`);
    for (const [k, v] of [...this.gauges].sort()) lines.push(`${k} ${v}`);
    for (const [, h] of [...this.histograms].sort(([a], [b]) => a.localeCompare(b))) {
      let cumulative = 0;
      [...LATENCY_BUCKETS_MS, Number.POSITIVE_INFINITY].forEach((le, i) => {
        cumulative += h.counts[i];
        const labels = { ...h.labels, le: le === Number.POSITIVE_INFINITY ? '+Inf' : String(le) };
        lines.push(`${this.key(`${h.name}_bucket`, labels)} ${cumulative}`);
      });
      lines.push(`${this.key(`${h.name}_sum`, h.labels)} ${h.sum}`);
      lines.push(`${this.key(`${h.name}_count`, h.labels)} ${h.count}`);
    }
    return `${lines.join('\n')}\n`;
  }

  private key(name: string, labels: Record<string, string>): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return name;
    return `${name}{${entries.map(([k, v]) => `${k}="${v.replace(/[^A-Za-z0-9_.:+-]/g, '_')}"`).join(',')}}`;
  }
}
