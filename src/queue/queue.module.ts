import { Global, Module } from '@nestjs/common';
import { QueueService } from './queue.service';

/** BullMQ queues, active only with REDIS_URL. Global: schedulers, alerts and the notifier use it. */
@Global()
@Module({ providers: [QueueService], exports: [QueueService] })
export class QueueModule {}
