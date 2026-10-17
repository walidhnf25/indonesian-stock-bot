import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AlertModule } from '../alert/alert.module';
import { MarketModule } from '../market/market.module';
import { RetentionService } from './retention.service';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [ScheduleModule.forRoot(), AlertModule, MarketModule],
  providers: [SchedulerService, RetentionService],
  exports: [SchedulerService, RetentionService],
})
export class SchedulerModule {}
