import { Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { InMemoryQuotaStore, QuotaResult, QuotaStore } from '../stock/governance/quota-store';
import { RedisService } from './redis.service';

/**
 * Sliding-window quota shared by every process, atomically, in one Lua script. Each consumed unit is a member
 * of a sorted set scored by its timestamp; the set expires with the window. When Redis is not configured or is
 * down, the in-process store answers instead (per-process limits are still enforced; the fallback is counted).
 */
const CONSUME = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local tag = ARGV[5]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local used = redis.call('ZCARD', key)
if used + cost > limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = window
  if oldest[2] then retry = tonumber(oldest[2]) + window - now end
  return {0, retry, 0}
end
for i = 1, cost do
  redis.call('ZADD', key, now, tag .. ':' .. i)
end
redis.call('PEXPIRE', key, window)
return {1, 0, limit - used - cost}
`;

type ConsumeClient = Redis & {
  quotaConsume?: (
    key: string,
    now: number,
    window: number,
    limit: number,
    cost: number,
    tag: string,
  ) => Promise<[number, number, number]>;
};

@Injectable()
export class RedisQuotaStore implements QuotaStore {
  private readonly local = new InMemoryQuotaStore();
  private seq = 0;

  /** Overridable in tests; not a constructor parameter so that Nest can construct the service. */
  now: () => number = Date.now;

  constructor(private readonly redis: RedisService) {}

  async consume(
    scope: string,
    key: string,
    limit: number,
    windowMs: number,
    cost = 1,
  ): Promise<QuotaResult> {
    const client = this.redis.get() as ConsumeClient | null;
    if (!client) {
      if (this.redis.enabled) this.redis.noteFallback('quota');
      return this.local.consume(scope, key, limit, windowMs, cost);
    }
    try {
      if (!client.quotaConsume) {
        client.defineCommand('quotaConsume', { numberOfKeys: 1, lua: CONSUME });
      }
      const tag = `${process.pid}:${this.now()}:${++this.seq}`;
      const [allowed, retryMs, remaining] = await (client as Required<ConsumeClient>).quotaConsume(
        this.redis.key('quota', scope, key),
        this.now(),
        windowMs,
        limit,
        cost,
        tag,
      );
      return {
        allowed: allowed === 1,
        retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, Math.ceil(retryMs / 1000)),
        remaining: Math.max(0, remaining),
      };
    } catch {
      this.redis.noteFallback('quota');
      return this.local.consume(scope, key, limit, windowMs, cost);
    }
  }

  reset(): void {
    this.local.reset();
    const client = this.redis.get();
    if (!client) return;
    // best effort, tests only: drop this process's quota keys
    void client
      .keys(this.redis.key('quota', '*'))
      .then((keys) => (keys.length ? client.del(...keys) : 0))
      .catch(() => undefined);
  }
}
