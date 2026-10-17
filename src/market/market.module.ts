import { Module } from '@nestjs/common';
import { DataQualityService } from './data-quality.service';
import { MarketService } from './market.service';

@Module({
  providers: [MarketService, DataQualityService],
  exports: [MarketService, DataQualityService],
})
export class MarketModule {}
