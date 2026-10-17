import { Global, Module } from '@nestjs/common';
import { QUOTA_STORE } from '../stock/governance/market-data-governor';
import { RedisQuotaStore } from './redis-quota-store';
import { RedisService } from './redis.service';

/**
 * Shared ephemeral state. Global so that governance code anywhere can inject QUOTA_STORE; the store
 * is Redis-backed when REDIS_URL is set and transparently in-process otherwise.
 */
@Global()
@Module({
  providers: [
    RedisService,
    RedisQuotaStore,
    { provide: QUOTA_STORE, useExisting: RedisQuotaStore },
  ],
  exports: [RedisService, QUOTA_STORE],
})
export class RedisModule {}
